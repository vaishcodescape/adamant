# Adamant

**A build goes red. Adamant works out why, proves a fix in a sealed container, opens a pull
request, and merges _that_ pull request.** It merges nothing else.

[![CI](https://github.com/vaishcodescape/adamant/actions/workflows/ci.yaml/badge.svg)](https://github.com/vaishcodescape/adamant/actions/workflows/ci.yaml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A522.12-brightgreen)

Adamant is a GitHub App plus an always-on backend. GitHub pushes an event the moment a workflow
fails — there is no poll loop — and a worker runs a LangGraph agent that diagnoses the failure,
patches the code, and ships only once the repo's own tests pass in a throwaway Docker container.
Phase 1 targets TypeScript repositories on GitHub Actions.

Written for the IT-314 software engineering course. [docs/product.md](docs/product.md) is the
full picture.

## How it works

```mermaid
flowchart LR
  Red[Failed workflow_run] -->|signed webhook| Api[API]
  Api -->|queued run + job| Pg[(PostgreSQL)]
  Pg -->|graph_step| Worker[Worker: LangGraph agent]
  Worker --> Box[Sandbox container]
  Box -->|pass or fail| Worker
  Worker -->|push adamant/run_id, open PR, merge it| Gh[GitHub]
  Cli[adamant CLI] -. reads .-> Api
```

1. The App is installed on a repo. A failed `workflow_run` reaches `/webhooks/github`, gets its
   HMAC checked, and is recorded by delivery id — a replay is ACKed, never run twice.
2. The API inserts a `queued` run and enqueues one `graph_step`. It never calls a model or Docker.
3. A worker claims the job and invokes the heal graph with `thread_id = run_id`, so a worker that
   dies resumes from its checkpoint instead of starting the run again.
4. The agent reads the Actions logs, triages them into evidence, and commits a candidate patch in
   a per-run worktree. Nothing is pushed yet.
5. The sandbox installs the candidate's dependencies with the network on, runs the tests with it
   off, and writes `pass` or `fail`. A fail goes back to diagnose, up to a capped number of
   attempts.
6. On a pass — and only then — the agent pushes `refs/heads/adamant/{run_id}`, opens a PR stating
   cause, evidence, fix, what was verified and what was not, and merges that PR.

Every tool call the agent made is on `tool_invocations` and `audit_events`, keyed by run.

## Why “Adamant”?

The name **Adamant** is inspired by Wolverine’s adamantium claws and skeleton. Adamantium makes
him nearly indestructible: it gives him extraordinary strength, turns his claws into unstoppable
weapons, and makes him feel almost invincible. A flawless upgrade—apart from the minor
inconvenience that it slowly poisons him and, in _Logan_, contributes to his death.

AI carries a similar contradiction. It can make us feel superhuman—helping us write faster, solve
harder problems, build ambitious ideas, and confidently generate 500 lines of code we only
_mostly_ understand. But when we depend on it for every answer, it can quietly weaken the abilities
it is supposed to enhance: independent thought, curiosity, problem-solving, and creativity.

That is why we chose **Adamant**. It represents immense power, while reminding us that every
powerful tool has a cost when used without restraint—especially when “just one quick prompt”
somehow becomes our entire thinking process.

**Use the power. Don’t let the power use you.**

## Status

Phase 1 is in progress ([docs/phase-1-tasks.md](docs/phase-1-tasks.md)).

| Piece                                                                  | State                                     |
| ---------------------------------------------------------------------- | ----------------------------------------- |
| Webhooks → `runs` in Postgres, dedupe by delivery id                   | Implemented                               |
| Worker + heal graph (triage → diagnose → patch → sandbox → PR → merge) | Implemented                               |
| Docker sandbox runner                                                  | Implemented                               |
| `POST /runs`, `GET /runs`, `GET /runs/:id`                             | Implemented                               |
| GitHub and Google OAuth, sessions, `GET /auth/me`                      | Implemented in the API; no Electron login |
| `GET /activity` SSE feed                                               | Stub — answers JSON, does not stream yet  |
| `@adamant/cli` (`status`, `runs`, `run <id>`, `watch`)                 | Not built yet                             |
| Electron app                                                           | Shell only; healing does not run from it  |
| Human-in-the-loop approval before merge                                | Phase 2                                   |

## Quick start

Node.js 22.12+, pnpm 10+, and Docker (for Postgres and the sandbox).

### Backend

```bash
pnpm install
cp .env.example .env                       # fill in the secrets you need
docker compose up -d postgres
DATABASE_URL=postgres://adamant:adamant@localhost:5432/adamant \
  pnpm --filter @adamant/server db:migrate
docker compose up                          # API on :8787, worker on the queue
```

`curl localhost:8787/health` answers `{"status":"ok"}`, and the worker logs
`@adamant/worker connected and waiting for jobs` once it has the queue.

Without Compose, in two terminals:

```bash
pnpm --filter @adamant/server dev          # API, watch mode
pnpm --filter @adamant/server dev:worker   # worker, watch mode
```

Real deliveries need a public URL: host the API, or point the App at smee/ngrok while you are
developing it locally. Installing and subscribing the App is in
[docs/product.md](docs/product.md#how-the-github-app-works).

### Desktop shell

```bash
pnpm dev
```

Vite's dev server for the renderer, watch-mode builds for main and preload, and Electron, all
wired together. Extra arguments are forwarded to Electron:
`pnpm dev --remote-debugging-port=9222`.

### Checks

```bash
pnpm test && pnpm typecheck && pnpm lint && pnpm format:check && pnpm build
```

Exactly what CI runs.

## Configuration

Secrets are split by process on purpose: the API can verify a webhook but cannot call a model or
act on a repo, and the worker can do the work but never sees a user session.

| Variable                                             | Read by              | What it is                                                          |
| ---------------------------------------------------- | -------------------- | ------------------------------------------------------------------- |
| `DATABASE_URL`                                       | API, worker, drizzle | Postgres connection string                                          |
| `PORT`                                               | API                  | HTTP port, default `8787`                                           |
| `GITHUB_WEBHOOK_SECRET`                              | API                  | HMAC on every delivery; a bad signature is a 401 and stores nothing |
| `GITHUB_OAUTH_CLIENT_ID`, `_SECRET`, `_REDIRECT_URI` | API                  | Enables `GET /auth/github`; all three or the provider stays off     |
| `GOOGLE_OAUTH_CLIENT_ID`, `_SECRET`, `_REDIRECT_URI` | API                  | Same, for `GET /auth/google`                                        |
| `ADAMANT_SESSION_SECRET`, `ADAMANT_SEED_USER_ID`     | API                  | Seeded session used only when `DATABASE_URL` is unset               |
| `OPENAI_API_KEY`, `OPENAI_MODEL`                     | Worker               | Model calls happen here only — never in the API, CLI or Electron    |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`            | Worker               | An installation token is minted per call and stored nowhere         |
| `ADAMANT_SANDBOX_IMAGE`, `_INSTALL`, `_TEST`         | Worker               | What the sandbox runs; install may reach the network, tests may not |

`docker-compose.yml` does not forward the OAuth variables to the `api` service yet, so OAuth
needs `pnpm --filter @adamant/server dev` with them in the environment.

## HTTP API

| Route                                | Auth                  | Does                                              |
| ------------------------------------ | --------------------- | ------------------------------------------------- |
| `GET /health`                        | none                  | Liveness for infra checks                         |
| `POST /webhooks/github`              | `X-Hub-Signature-256` | Store the delivery; a failed build starts one run |
| `GET /auth/{github,google}`          | none                  | Start OAuth; state is bound to a cookie           |
| `GET /auth/{github,google}/callback` | OAuth state           | Sets the `adamant_session` httpOnly cookie        |
| `GET /auth/me`, `POST /auth/logout`  | session               | Current user; revoke the session                  |
| `POST /runs`                         | session               | Start a run; needs an `Idempotency-Key`           |
| `GET /runs`, `GET /runs/:id`         | session               | List runs; one run with its audit trail           |
| `GET /activity`                      | session               | Feed for `adamant watch` (stub)                   |

A session arrives as the `adamant_session` cookie, an `Authorization: Bearer` header, an
`ADAMANT_SESSION` header, or a `session` query parameter for the SSE feed. `/auth/*` and the
Postgres-backed runs router mount only when `DATABASE_URL` is set; without it the API falls back
to the seeded session and an in-memory store. The remaining schema tables are also exposed as
CRUD routes behind the same auth, for development.

## Commands

| Command                            | What it does                                               |
| ---------------------------------- | ---------------------------------------------------------- |
| `pnpm dev`                         | Renderer dev server + main/preload watch builds + Electron |
| `pnpm build`                       | Production bundles for every package                       |
| `pnpm start`                       | Build, then run Electron against the production bundles    |
| `pnpm test`                        | Node's test runner over `tests/`                           |
| `pnpm typecheck`                   | `tsc --noEmit` across the workspace                        |
| `pnpm lint`, `pnpm lint:fix`       | ESLint (flat config)                                       |
| `pnpm format`, `pnpm format:check` | Prettier                                                   |
| `pnpm package`                     | Installers in `release/` via electron-builder              |
| `pnpm package:dir`                 | Unpacked app directory only, for smoke-testing a build     |
| `pnpm clean`                       | Remove build output                                        |

Backend scripts run through `pnpm --filter @adamant/server <script>`:

| Script                       | What it does                                 |
| ---------------------------- | -------------------------------------------- |
| `dev`, `start`               | The Hono API                                 |
| `dev:worker`, `start:worker` | The graphile-worker process                  |
| `db:generate`                | Generate a migration from the Drizzle schema |
| `db:migrate`                 | Apply migrations                             |
| `db:studio`                  | Drizzle Studio against `DATABASE_URL`        |

## Layout

```
electron/          desktop shell
  main/            Electron main process: window, IPC handlers
  preload/         the only bridge into the renderer (CommonJS)
  adamant/         React renderer, treated as untrusted
  shared/          @adamant/shared: IPC channel names and payload types
server/            @adamant/server: one package.json, one tsconfig.json
  api/             Hono: webhooks, auth, runs, activity
  db/              Drizzle schema and migrations; drizzle.config.ts
  worker/          graphile-worker: graph_step, sandbox_exec
  agent/           LangGraph heal graph and tools; no HTTP
  sandbox/         Docker runner
tests/             node:test suites, one folder per area
docs/              design docs
.agents/skills/    task instructions for coding agents
scripts/dev.mjs    Vite + watchers + Electron
```

`server/api` does not import `server/agent`, and `server/agent` does not import Hono — the worker
is the only thing that holds both.

## Safety rails

These are invariants, not defaults. [AGENTS.md](AGENTS.md) is the version reviewers check against.

**The agent**

- Pushes exactly one ref, `refs/heads/adamant/{run_id}`. No force-push, no push to a default
  branch. The adapter sets the refspec; the model does not.
- May merge only the PR that run opened, and only after reading a passing `sandbox_results` row
  back from the table. Any other PR number is denied and the run fails.
- Calls allowlisted tools only, each logged to `tool_invocations` / `audit_events` with its
  `run_id`. Unknown calls fail closed.
- Never holds a long-lived GitHub token: installation tokens are minted per call and kept out of
  Electron, checkpoints, prompts, logs and the sandbox.
- Does not weaken tests to get a green build. Infra failures, missing secrets and flakes are
  reported, and the run stops.

**The sandbox** runs one container per attempt and destroys it: network off during tests, no
Docker socket, dropped capabilities, and memory, CPU, PID and time limits.

**The renderer** is untrusted: `contextIsolation: true`, `nodeIntegration: false`,
`sandbox: true`; `ipcRenderer` is never exposed and only the explicit methods of `AdamantApi`
cross the bridge, with main validating every argument; a Content-Security-Policy meta tag in
`electron/adamant/index.html` keeps it on local assets; navigation away from the app frame and
`window.open` are blocked, and only an `http:` or `https:` URL that survives `externalUrl()` is
handed to the system browser. The renderer never calls the backend — main does, and the session
token stays there.

## Desktop shell

`@adamant/shared` exports the channel names and payload types. `main` registers handlers against
them, `preload` exposes a narrow typed API on `window.adamant`, and the renderer calls that API.
Renaming a channel or changing a payload is therefore a compile error on all three sides rather
than a runtime failure. The package is source-only — no build step, inlined by each consumer's
bundler. The preload bundle is emitted as CommonJS because sandboxed preload scripts cannot be
ESM.

`electron-builder.yml` targets dmg/zip (macOS), NSIS (Windows) and AppImage/deb (Linux). Only the
built `dist` folders are packed — Vite bundles the dependencies, so no `node_modules` ship inside
the asar. Two things are still placeholders: there is no app icon (drop `icon.icns` / `icon.ico` /
`icon.png` into `build/`), and macOS builds are unsigned — set the usual `CSC_*` environment
variables to sign and notarise.

## Docs

| Doc                                                            | Covers                              |
| -------------------------------------------------------------- | ----------------------------------- |
| [docs/product.md](docs/product.md)                             | What we're building, and for whom   |
| [docs/phase-1-tasks.md](docs/phase-1-tasks.md)                 | Phase 1: app, CLI, heal + merge     |
| [docs/backend-architecture.md](docs/backend-architecture.md)   | API, worker, agent, GitHub, sandbox |
| [docs/database.md](docs/database.md)                           | Postgres schema                     |
| [docs/db-and-worker-setup.md](docs/db-and-worker-setup.md)     | Running the backend locally         |
| [docs/tech-stack.md](docs/tech-stack.md)                       | Stack, and why each piece           |
| [docs/performance.md](docs/performance.md)                     | Speed rules for the run path        |
| [docs/mid-eval-backend-plan.md](docs/mid-eval-backend-plan.md) | Calendar and seats                  |
| [docs/glossary.md](docs/glossary.md)                           | Words the other docs use            |
| [CONTRIBUTING.md](CONTRIBUTING.md)                             | Branches, commits, review, merge    |
| [AGENTS.md](AGENTS.md)                                         | Rules for agents and reviewers      |

## Contributing

Branch from `main` as `feat/…`, `fix/…`, `docs/…` or `chore/…` — never commit to `main`, and
leave `adamant/*` to the agent. Run the checks above, then open a PR with the template.
[CONTRIBUTING.md](CONTRIBUTING.md) has the review and merge flow.

Claude Code, Cursor and Codex read [AGENTS.md](AGENTS.md) and the skills in `.agents/skills/`.
You still own what you submit.

## License

[MIT](LICENSE) © vaishcodescape

