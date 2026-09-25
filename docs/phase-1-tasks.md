# Phase 1

One TypeScript repo. The GitHub App stays on. The CLI shows everything.

1. Failed Actions → webhook → run in Postgres → LangGraph heals → merge our PR
2. Any merged PR → webhook stored (and our run marked `merged` if it is ours)
3. `adamant watch` on your laptop, connected to the hosted API

It may merge **only** `adamant/{run_id}` after a passing sandbox.

Wiring: [backend-architecture.md](backend-architecture.md). Tables:
[database.md](database.md). Calendar: [mid-eval-backend-plan.md](mid-eval-backend-plan.md).

**Later:** Electron Heal, OAuth, HITL, fingerprints, `.adamant.yml`.

## Pieces

| Piece             | Where                                      | Done when                                                  |
| ----------------- | ------------------------------------------ | ---------------------------------------------------------- |
| **1. Database**   | `server/db` in `@adamant/server` + Compose | migrate; insert a `queued` run                             |
| **2. LangGraph**  | `server/agent` + `server/worker`           | worker `invoke`s, `thread_id = run_id`                     |
| **3. GitHub App** | `server/api`                               | App installed; failed CI starts a run; merges are recorded |
| **4. Healing**    | tools + `server/sandbox` + OpenAI          | red CI → sandbox pass → our PR **merged**                  |
| **5. CLI**        | `server/cli` (not created)                 | `watch` stays on the **hosted** API and shows runs/merges  |

`server/api` does **not** import `server/agent`. No `/agent` route.

Already done: Electron shell, `@adamant/server` (API, schema, worker, agent
graph, sandbox), this repo’s CI. Not done: the worker calling the graph, and
the CLI.

## Tasks

### 1. Database

| ID  | Who | Task                                                                   | Done when                                  |
| --- | --- | ---------------------------------------------------------------------- | ------------------------------------------ |
| 1.1 | R1  | Compose Postgres + `DATABASE_URL`                                      | `docker compose up -d postgres` is healthy |
| 1.2 | R2  | `server/db` tables in [database.md](database.md), no `jobs`            | migrate twice is a no-op                   |
| 1.3 | R1  | `server/worker` + graphile-worker                                      | a no-op `graph_step` is claimed            |
| 1.4 | R1  | Host API + worker (Compose or a VM) so GitHub and the CLI can reach it | public HTTPS URL stays up                  |

### 2. LangGraph

| ID  | Who   | Task                                                                       | Done when                                      |
| --- | ----- | -------------------------------------------------------------------------- | ---------------------------------------------- |
| 2.1 | R10   | `@adamant/contract` zod                                                    | API, worker, CLI share types                   |
| 2.2 | R7    | Graph stubs: retrieve → diagnose → plan → patch → sandbox → openPr → merge | statuses update                                |
| 2.3 | R1+R7 | Worker `compileHealGraph(deps).invoke(...)`                                | webhook or `POST /runs` reaches `running`      |
| 2.4 | R7    | OpenAI in the **worker**                                                   | key not in CLI, Electron, checkpoints, or logs |

### 3. GitHub App (the plugin)

| ID  | Who | Task                                                                           | Done when                                               |
| --- | --- | ------------------------------------------------------------------------------ | ------------------------------------------------------- |
| 3.1 | R4  | Dev GitHub App; HMAC; store `delivery_id`                                      | replay ≠ second delivery                                |
| 3.2 | R4  | `installations` + `repo_bindings`; App webhook → **hosted** `/webhooks/github` | App installed; events hit the host                      |
| 3.3 | R4  | Failed `workflow_run` → `queued` run + `graph_step`                            | one red check starts one run                            |
| 3.4 | R4  | Merged `pull_request` → confirm our run **or** store the delivery              | CLI can list every merge; we do not heal on merge alone |
| 3.5 | R3  | `POST /runs` + `GET /runs` + `GET /runs/:id`                                   | curl works when webhooks are down                       |

Subscribe only to `workflow_run`, `pull_request`, `ping`, `installation`.
Do not poll GitHub.

### 4. Healing

| ID  | Who | Task                                                      | Done when                              |
| --- | --- | --------------------------------------------------------- | -------------------------------------- |
| 4.1 | R9  | Eval repo + 3 broken commits                              | failing log saved                      |
| 4.2 | R9  | Log parser (`file:line`, first error, tests)              | model does not get the raw dump        |
| 4.3 | R5  | git allowlist; push only `adamant/{run_id}` after sandbox | force-push and `main` push denied      |
| 4.4 | R6  | Token per call; open **and merge** this run's PR          | no other PR is merged                  |
| 4.5 | R8  | Sandbox pass/fail, destroy container                      | unpatched = fail, patched = pass       |
| 4.6 | R7  | Real diagnose + patch                                     | one live or scripted heal, one give-up |
| 4.7 | R10 | PR body: cause, evidence, fix, verified, not checked      | no secrets                             |

Eval repo: App may merge (contents + pull-requests write; no blocking reviews for that App).

### 5. CLI

| ID  | Who | Task                                                  | Done when                                          |
| --- | --- | ----------------------------------------------------- | -------------------------------------------------- |
| 5.1 | R3  | Hosted `GET /activity` SSE (deliveries + audit)       | remote CLI can stay connected                      |
| 5.2 | R3  | `@adamant/cli`: `status`, `runs`, `run <id>`, `watch` | CLI against the **hosted** URL shows the same feed |

CLI env: `ADAMANT_API_URL` (hosted origin) + `ADAMANT_SESSION`. Nothing
else. `watch` is a long-lived SSE to that origin.

## Order

```
1.x db + hosted API/worker
2.x graph  +  3.x App (install, failed CI, merged PRs)
5.x CLI as soon as GET /runs works
4.x heal + merge
```

## Done when

Hosted API stays up. Fail a check on the eval repo → sandbox fail-then-pass →
our PR merged, visible in `adamant watch` on a laptop pointed at that
host. Merge any other PR → it shows in `watch`. Duplicate webhooks do not
start a second run. We did not merge a PR we did not open.
