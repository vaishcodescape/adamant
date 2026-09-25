# Local backend setup — `@adamant/db` and `@adamant/worker`

Covers the two packages added in this PR. For the full local stack, see the
root `README.md` and `docker-compose.yml`.

## Fresh checkout

```bash
pnpm install
pnpm typecheck
pnpm build
```

## Run the stack

```bash
docker compose up -d postgres
DATABASE_URL=postgres://adamant:adamant@localhost:5432/adamant pnpm --filter @adamant/db db:migrate
docker compose up
```

`docker compose up` starts Postgres, the API (`:8787`), and the worker. The
worker connects to Postgres via graphile-worker and logs
`@adamant/worker connected and waiting for jobs` once it's up.

## Package boundaries

- `@adamant/db` — Drizzle schema and migrations only. Does not import Hono
  or the LangGraph agent. Both the API and the worker depend on it.
- `@adamant/worker` — graphile-worker bootstrap. Currently runs a no-op
  `graph_step` task; wiring it to the real LangGraph invocation is a
  separate, later task.

## What's intentionally not here yet

- The `graph_step` task body is a placeholder — it logs and returns.
- Enqueueing a job atomically alongside run creation (the
  `graphile_worker.add_job(...)` pattern, called in the same transaction as
  the `runs` insert) is part of wiring the API to the worker, not this PR.
- `@adamant/contract` (shared Zod types) is a separate package, not added
  here.
