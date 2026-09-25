# Local backend setup

The API, database, worker, agent, and sandbox are one package,
`@adamant/server`, under `server/`. For the full local stack, see the root
`README.md` and `docker-compose.yml`.

## Fresh checkout

```bash
pnpm install
pnpm typecheck
pnpm build
```

## Run the stack

```bash
docker compose up -d postgres
DATABASE_URL=postgres://adamant:adamant@localhost:5432/adamant pnpm --filter @adamant/server db:migrate
docker compose up
```

`docker compose up` starts Postgres, the API (`:8787`, `server/api/index.ts`),
and the worker (`server/worker/index.ts`). The worker connects to Postgres
via graphile-worker and logs `@adamant/worker connected and waiting for jobs`
once it's up.

## Directory boundaries

- `server/db` — Drizzle schema and `createDb`. Does not import Hono or
  `server/agent`.
- `server/api` — Hono. Does not import `server/agent`.
- `server/worker` — graphile-worker bootstrap. `graph_step` loads the run and
  invokes `compileOpenAiHealGraph` with `thread_id = run_id`.
- `server/agent` — LangGraph. Must not import Hono.
- `server/sandbox` — runs `docker` for one container per job.

## What's intentionally not here yet

- The `runs` insert and `add_job` are two statements, not one transaction. The
  delivery row is written first, so a replay cannot create a second run, and
  the job carries `jobKey = run_id`, so it cannot be queued twice. A crash
  between the two leaves a `queued` run with no job — recoverable; the reverse
  would not be.
- `@adamant/contract` (shared Zod types) is not a package yet.
- `server/cli` is not created yet.
