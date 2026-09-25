# Database

Phase 1 piece 1. Tasks 1.x in [phase-1-tasks.md](phase-1-tasks.md). Why the
tables exist: [backend-architecture.md](backend-architecture.md).

**Done when:** empty DB migrates; you can insert a `queued` run. Do not invent
tables that are not below. Do not wait for Electron OAuth.

---

## What we use

| Piece             | Choice                                     | Notes                                                 |
| ----------------- | ------------------------------------------ | ----------------------------------------------------- |
| Database          | PostgreSQL 16                              | One local instance via Compose                        |
| ORM               | Drizzle                                    | Schema in TypeScript; SQL migrations checked in       |
| Driver            | `pg`                                       | Same pool for API, worker, and LangGraph checkpointer |
| Job queue         | `graphile-worker`                          | **Replaces** the `jobs` table in the architecture ERD |
| Graph checkpoints | `@langchain/langgraph-checkpoint-postgres` | Library tables; `thread_id = run_id`                  |

Run state lives in `runs`. Queue state lives in graphile-worker's own schema. Do not create
`jobs`.

---

## What not to build

- A hand-rolled `jobs` table (`kind`, `locked_by`, `available_at`, …). graphile-worker already
  does `SKIP LOCKED` + `LISTEN/NOTIFY`.
- Columns for GitHub installation tokens, OAuth access tokens, or raw `Authorization`
  secrets. Mint installation tokens per call; store only `sessions.token_hash`, never the
  bearer or a GitHub user token.
- Failure fingerprints, monthly budgets, `.adamant.yml`, or review-memory
  tables. Those are later, not Phase 1.
- Soft-delete. We do not delete runs.
- A second database for the agent. API, worker, and checkpointer share one `DATABASE_URL`.

---

## Package layout

Schema, API, worker, agent, and sandbox share one package, `@adamant/server`
(`server/package.json`). `server/db` is a directory in that package. It must
not import `hono` or `server/agent`. `server/api` must not import
`server/agent` either.

```
server/                      @adamant/server
  package.json
  tsconfig.json
  api/                       Hono
  worker/                    graphile-worker
  agent/                     LangGraph
  sandbox/                   docker CLI runner
  db/
    drizzle.config.ts
    client.ts                createDb(DATABASE_URL) — one Pool
    schema/
      index.ts               re-export every table
      users.ts               users, sessions
      github.ts              installations, repositories
      webhooks.ts
      runs.ts
      sandbox.ts
      triage.ts
      hitl.ts
      publication.ts
      audit.ts
    drizzle/                 generated SQL — commit this
```

`server` is the backend package in `pnpm-workspace.yaml`.

Scripts on `@adamant/server`:

| Script        | Command                                                         |
| ------------- | --------------------------------------------------------------- |
| `db:generate` | `drizzle-kit generate --config db/drizzle.config.ts`            |
| `db:migrate`  | `drizzle-kit migrate --config db/drizzle.config.ts`             |
| `db:studio`   | `drizzle-kit studio --config db/drizzle.config.ts` (local only) |

`server/db/drizzle.config.ts` points at `db/schema/index.ts` and `db/drizzle`,
resolved from `server/`. It reads `process.env.DATABASE_URL` and fails if the
URL is missing. Run the scripts from the repo root with
`pnpm --filter @adamant/server db:migrate`.

---

## Local Postgres

R1 lands this first so R2 can migrate. Root `docker-compose.yml`:

```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: adamant
      POSTGRES_PASSWORD: adamant
      POSTGRES_DB: adamant
    ports:
      - '5432:5432'
    volumes:
      - adamant-pg:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U adamant -d adamant']
      interval: 2s
      timeout: 5s
      retries: 10

volumes:
  adamant-pg:
```

Env (`.env` is gitignored; commit `.env.example` at the repo root):

```
DATABASE_URL=postgres://adamant:adamant@localhost:5432/adamant
```

Do not give the API its own env file for secrets the worker also needs. One root
`DATABASE_URL` is enough for local work.

```bash
docker compose up -d postgres
pnpm --filter @adamant/server db:migrate
```

Done when `psql "$DATABASE_URL" -c '\dt'` lists the Adamant tables below.

---

## Enums

Use Drizzle `pgEnum` so the database rejects illegal values. R10 copies these strings into
`@adamant/contract` zod enums — do not invent a second set.

### `run_status`

From the [run state machine](backend-architecture.md#run-state):

| Value             | Who writes it                  | Meaning                                       |
| ----------------- | ------------------------------ | --------------------------------------------- |
| `queued`          | API on `POST /runs` or webhook | Job not yet claimed                           |
| `running`         | Graph worker                   | Retrieve / triage / diagnose / plan / patch   |
| `sandboxing`      | Graph worker                   | Waiting on a `sandbox_exec` job               |
| `awaiting_hitl`   | unused in Phase 1              | Later: wait for a human before merge          |
| `opening_pr`      | Graph worker                   | Sandbox passed; creating the PR               |
| `awaiting_github` | Graph worker                   | PR open; merge in flight                      |
| `merged`          | Graph worker (merge API)       | This run's PR was merged. Webhook may confirm |
| `failed`          | Worker or API                  | Terminal error (403, attempts exhausted, …)   |
| `aborted`         | API                            | Later: HITL abort                             |

Legal transitions (enforce in application code, not CHECK constraints beyond the enum):

```
queued → running
running → sandboxing | failed
sandboxing → running | opening_pr | failed
opening_pr → awaiting_github | failed
awaiting_github → merged | failed
```

Phase 1 never enters `awaiting_hitl`. Keep the enum value so later HITL
does not need a migration.

### `hitl_decision`

`approve` | `request_changes` | `abort`

### `sandbox_verdict`

`pass` | `fail`

Timeouts are `fail`. There is no `error` verdict — treat infra failure as `fail` and fail the run.

### `tool_result_status`

`ok` | `error` | `denied`

`denied` is the fail-closed path (unknown tool, out-of-repo, force-push).

---

## Tables

Types match the architecture ERD. Extra columns are marked **(exec)** — they are for migrate /
debug / the agreed timing work, not a new product idea.

UUID primary keys: `uuid().primaryKey().defaultRandom()`.
Timestamps: `timestamptz`.
Never store secrets in `jsonb`.

### `users`

| Column       | Type        | Constraints                        |
| ------------ | ----------- | ---------------------------------- |
| `id`         | uuid        | PK                                 |
| `github_id`  | bigint      | unique, not null                   |
| `created_at` | timestamptz | not null, default now() **(exec)** |

### `sessions`

The client holds an unguessable secret (Electron: `Authorization: Bearer`;
browser: `HttpOnly` cookie). Postgres stores only `token_hash`. `id` is a
lookup key, not the bearer. See [backend-architecture.md](backend-architecture.md#user-authentication).

| Column       | Type        | Constraints                                  |
| ------------ | ----------- | -------------------------------------------- |
| `id`         | uuid        | PK                                           |
| `user_id`    | uuid        | not null, FK → `users.id` on delete cascade  |
| `token_hash` | text        | unique, not null (hash of the bearer secret) |
| `expires_at` | timestamptz | not null                                     |
| `created_at` | timestamptz | not null, default now() **(exec)**           |

Indexes: `sessions_expires_at_idx` on `expires_at`; unique on `token_hash`.
Never log the raw secret. Never store GitHub user access tokens here.

### `installations`

GitHub App installation. Tokens are minted per call and **must not** appear here.

| Column                   | Type        | Constraints                        |
| ------------------------ | ----------- | ---------------------------------- |
| `id`                     | uuid        | PK                                 |
| `github_installation_id` | bigint      | unique, not null                   |
| `created_at`             | timestamptz | not null, default now() **(exec)** |

### `repo_bindings`

Phase 1: bind the eval repo to the GitHub App installation. Webhook and
`POST /runs` both need this row. Collaborator checks wait for OAuth.

| Column            | Type        | Constraints                                |
| ----------------- | ----------- | ------------------------------------------ |
| `id`              | uuid        | PK                                         |
| `installation_id` | uuid        | not null, FK → `installations.id` restrict |
| `github_repo_id`  | bigint      | unique, not null                           |
| `full_name`       | text        | not null (`owner/repo`)                    |
| `created_at`      | timestamptz | not null, default now() **(exec)**         |

Index: `repo_bindings_installation_id_idx` on `installation_id`.

### `runs`

| Column              | Type         | Constraints                                                     |
| ------------------- | ------------ | --------------------------------------------------------------- |
| `id`                | uuid         | PK                                                              |
| `actor_user_id`     | uuid         | not null, FK → `users.id` restrict (seed user in Phase 1)       |
| `repo_binding_id`   | uuid         | not null, FK → `repo_bindings.id` restrict                      |
| `status`            | `run_status` | not null, default `queued`                                      |
| `version`           | integer      | not null, default `0`                                           |
| `diagnose_attempts` | integer      | not null, default `0`                                           |
| `base_sha`          | text         | not null (failing commit)                                       |
| `agent_branch`      | text         | not null, `adamant/{run_id}` — adapter sets this, not the model |
| `pr_number`         | integer      | nullable until a PR exists                                      |
| `idempotency_key`   | text         | unique, not null                                                |
| `created_at`        | timestamptz  | not null, default now() **(exec)**                              |
| `updated_at`        | timestamptz  | not null, default now() **(exec)**                              |

`idempotency_key` is `webhook:{delivery_id}` or the client `Idempotency-Key`.

`version` is for later HITL (`UPDATE … WHERE version = $2` → 409). Phase 1
does not need it to merge.

Merge without a passing `sandbox_results` row is rejected in the worker, not
by a DB trigger.

Indexes:

- unique `runs_idempotency_key_uidx` on `idempotency_key`
- `runs_repo_binding_id_idx` on `repo_binding_id`
- `runs_status_idx` on `status`

Cap `diagnose_attempts` in the worker (product default: small integer, e.g. 3). The column is a
counter, not the cap.

### `webhook_deliveries`

Duplicate GitHub deliveries ACK and do not start a second run. The CLI
`watch` feed reads this table (`GET /activity`).

| Column        | Type        | Constraints                                                                  |
| ------------- | ----------- | ---------------------------------------------------------------------------- |
| `delivery_id` | text        | PK (GitHub `X-GitHub-Delivery`)                                              |
| `run_id`      | uuid        | nullable, FK → `runs.id` on delete set null                                  |
| `event`       | text        | not null **(exec)** — `workflow_run`, `pull_request`, `ping`, `installation` |
| `action`      | text        | nullable **(exec)** — `completed`, `closed`, …                               |
| `pr_number`   | integer     | nullable **(exec)** — set on pull_request                                    |
| `summary`     | text        | not null **(exec)** — short, no tokens                                       |
| `received_at` | timestamptz | not null, default now() **(exec)**                                           |

`run_id` is null when we ACK a delivery we do not turn into a run (ping,
someone else's merge, ignored event). Insert the delivery row **before**
creating the run; on unique-violation, return the existing row and stop.

Merged PRs that are not ours still get a row (`event = pull_request`,
`action = closed`, `pr_number` set). That is how the CLI lists every merge
without a new table.

Index: `webhook_deliveries_received_at_idx` on `received_at` (for
`GET /activity`).

### `sandbox_results`

| Column         | Type              | Constraints                                 |
| -------------- | ----------------- | ------------------------------------------- |
| `id`           | uuid              | PK                                          |
| `run_id`       | uuid              | not null, FK → `runs.id` restrict           |
| `verdict`      | `sandbox_verdict` | not null                                    |
| `artifact_key` | text              | not null (log object key; not the log body) |
| `created_at`   | timestamptz       | not null, default now() **(exec)**          |

A run may have many rows (one per attempt). Open and merge only when the
**latest** row is `pass`. Index: `sandbox_results_run_id_idx` on `run_id`.

Do not put sandbox stdout in this table. Artifacts are files (or object storage later).

### `hitl_decisions`

| Column          | Type            | Constraints                        |
| --------------- | --------------- | ---------------------------------- |
| `id`            | uuid            | PK                                 |
| `run_id`        | uuid            | not null, FK → `runs.id` restrict  |
| `actor_user_id` | uuid            | not null, FK → `users.id` restrict |
| `decision`      | `hitl_decision` | not null                           |
| `created_at`    | timestamptz     | not null, default now() **(exec)** |

Index: `hitl_decisions_run_id_idx` on `run_id`. Keep history; the latest row is the current
decision.

### `tool_invocations`

Written by the tool gateway. Args are redacted **before** insert (no tokens, no `Authorization`,
no `GIT_ASKPASS` output).

| Column          | Type                 | Constraints                                             |
| --------------- | -------------------- | ------------------------------------------------------- |
| `id`            | uuid                 | PK                                                      |
| `run_id`        | uuid                 | not null, FK → `runs.id` restrict                       |
| `tool`          | text                 | not null (`git` / `github` / `actions` / `sandbox`)     |
| `name`          | text                 | not null (allowlisted name, e.g. `get_failed_job_logs`) |
| `args_redacted` | jsonb                | not null                                                |
| `result_status` | `tool_result_status` | not null                                                |
| `created_at`    | timestamptz          | not null, default now() **(exec)**                      |

Index: `tool_invocations_run_id_idx` on `run_id`.

### `audit_events`

Append-only. `started_at` / `ended_at` are optional (later timings).

| Column       | Type        | Constraints                                                        |
| ------------ | ----------- | ------------------------------------------------------------------ |
| `id`         | bigint      | PK, identity / `bigserial`                                         |
| `run_id`     | uuid        | not null, FK → `runs.id` restrict                                  |
| `action`     | text        | not null (`graph.retrieve`, `sandbox.exec`, `hitl.approve`, …)     |
| `detail`     | jsonb       | not null, default `{}` — redacted; include `attempt` when relevant |
| `at`         | timestamptz | not null, default now() — event time from the ERD                  |
| `started_at` | timestamptz | nullable **(exec, agreed timing)**                                 |
| `ended_at`   | timestamptz | nullable **(exec, agreed timing)**                                 |

Index: `audit_events_run_id_at_idx` on `(run_id, at)`.

Do not put tokens in `detail`. `GET /runs/:id` and `GET /activity` read this.

---

## Tables we do not own

### graphile-worker

Install with the library's own migrate (see its docs). Default schema is `graphile_worker`.
Leave it alone in Drizzle.

Enqueue from `createRun`:

- task name: `graph_step` or `sandbox_exec` (the old `jobs.kind` values)
- payload: `{ runId }` only — no tokens
- `jobKey` / uniqueness: prefer `runId` + kind so a retry does not double-enqueue

Worker death: graphile-worker lock TTL. Resume the LangGraph checkpoint for that `run_id`.

### LangGraph checkpoints

`PostgresSaver.fromConnString(DATABASE_URL)` then `await saver.setup()` once on worker boot.
Library tables (`checkpoints`, …). `thread_id = run_id`. Do not model these in Drizzle. Do not
write tokens into checkpoint state.

---

## Client rules

```ts
// server/db/client.ts — sketch
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema/index.ts'

export function createDb(url: string) {
  const pool = new Pool({ connectionString: url })
  return drizzle(pool, { schema })
}
```

- One `Pool` per process (API process, worker process).
- Read `DATABASE_URL` in the process entrypoint; pass it in. Do not import `process.env` from
  random schema files.
- `server/agent` may take a `PostgresSaver` or a connection string from the worker. It still must
  not import Hono.

---

## Application invariants (not DB triggers)

Implement these next to the writes, with tests. Do not encode them as triggers in the first PR.

1. Unknown / out-of-scope tool → `tool_result_status = denied`, run may go `failed`. No retry
   from the sandbox on git/API 403.
2. `opening_pr` and `merge_pull_request` only if the latest
   `sandbox_results.verdict` is `pass`.
3. HITL `UPDATE` (later) must include `version` (409 on mismatch).
4. `agent_branch` is always `adamant/{run_id}`.
5. Merge only this run's PR (`runs.pr_number`, head `adamant/{run_id}`).
   `merged` is written after that API call succeeds. `pull_request.closed`
   may confirm; it must not merge again.
6. Redact before persist. A test inserts a fake token in tool args and asserts the stored jsonb
   does not contain it.

---

## Who uses this after migrate

| Seat | Then they can                                       |
| ---- | --------------------------------------------------- |
| R3   | insert `queued` runs; `GET /runs` + `GET /activity` |
| R4   | insert `webhook_deliveries` (unique `delivery_id`)  |
| R7   | `PostgresSaver.setup()`; update `runs.status`       |
| R8   | insert `sandbox_results`                            |
| R10  | insert `tool_invocations` / `audit_events`          |
| R1   | enqueue `graph_step`                                |

## First PRs

1. Compose + `server/db` in `@adamant/server` + tables (no `jobs`). Migrate
   twice on a throwaway volume.
2. `server/worker` + graphile-worker; a no-op `graph_step` claims a job.
3. Seed one user + installation + eval `repo_bindings`. `POST /runs` and
   webhooks use that user as `actor_user_id`.

`pnpm typecheck` must pass on `@adamant/server`.
A Postgres CI job can wait.

## Checklist

- [ ] `docker compose up -d postgres` is healthy
- [ ] All tables in this file exist; `jobs` does not
- [ ] First SQL migration is committed; second migrate is a no-op
- [ ] No token-shaped columns
- [ ] graphile-worker and `PostgresSaver` are not modeled in Drizzle
