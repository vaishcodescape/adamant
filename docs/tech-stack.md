# Tech stack

What we chose and why. Phase 1 work: [phase-1-tasks.md](phase-1-tasks.md). Design:
[backend-architecture.md](backend-architecture.md).

`@adamant/server` already has the Hono API (health, runs, activity, GitHub
webhooks), Drizzle schema, a graphile-worker process, the LangGraph code in
`server/agent`, and a Docker sandbox runner. The worker's `graph_step` is
still a no-op: it does not invoke the graph. The CLI does not exist yet.

## TypeScript everywhere

CLI, API, workers, and agent share one pnpm workspace and one CI job.
Schemas live in `@adamant/contract` and are imported, not copied.

LangGraph.js has the pieces we need (state graph, interrupts, Postgres
checkpoints). If it gets in the way, drive the same loop from `runs.status`.

## Components

| Piece                 | Choice                                                              | Notes                                                                                          |
| --------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| HTTP API              | [Hono](https://hono.dev) on `@hono/node-server`                     | Webhooks + CLI (`GET /runs`, `/activity`); raw body for HMAC                                   |
| CLI                   | `@adamant/cli` on Node                                              | Monitor only; HTTPS to the hosted API; no model, no GitHub token                               |
| Validation / contract | `zod`, via `@hono/zod-validator`                                    | One schema package shared by API, workers and app                                              |
| GitHub App + webhooks | `@octokit/app`, `@octokit/webhooks`                                 | Installation tokens minted per call; webhook signature checks                                  |
| Database              | PostgreSQL with Drizzle ORM                                         | Migrations checked in                                                                          |
| Job queue             | `graphile-worker`                                                   | Postgres `SKIP LOCKED` plus `LISTEN/NOTIFY` for instant pickup                                 |
| Agent graph           | `@langchain/langgraph` + `@langchain/langgraph-checkpoint-postgres` | `thread_id = run_id`; Phase 1 does not `interrupt()` for a human                               |
| LLM                   | [`openai`](https://www.npmjs.com/package/openai)                    | `OPENAI_API_KEY`; model and effort per step — see [performance.md](performance.md#model-calls) |
| Sandbox               | `docker` CLI via `child_process`                                    | One container per job, as in the architecture doc                                              |

`graphile-worker` manages its own job tables, so it replaces the hand-designed `jobs` table in the
architecture doc. Run state stays in `runs`.

### Why Hono

Small, typed, reads the raw body (webhook HMAC), easy SSE later. The API only
auths and enqueues. Workers do the real work.

```ts
const app = new Hono().post('/runs', zValidator('json', CreateRunSchema), async (c) => {
  const run = await createRun(c.req.valid('json'))
  return c.json({ runId: run.id }, 202)
})
```

Fallback: Fastify. Skip NestJS and Express.

Phase 1 clients: GitHub webhooks and `@adamant/cli` against the hosted
API. Electron can import `typeof app` later via `hc<ApiType>`.

## Layout

```
electron/           desktop shell (later Heal UI)
server/             @adamant/server — one package.json and one tsconfig.json
  api/              Hono: webhooks, runs, /activity
  db/               Drizzle; drizzle.config.ts lives here
  worker/           graphile-worker
  agent/            LangGraph + tools; no HTTP
  sandbox/          Docker runner
  cli/              monitor — create
```

`server` is the backend workspace package in `pnpm-workspace.yaml`.

1. `server/agent` **must not import Hono.** The worker imports it. `server/api`
   does not import `server/agent`.
2. The CLI (and later Electron **main**) call the **hosted** API. Neither
   holds GitHub or OpenAI secrets.
