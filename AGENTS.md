# Adamant: notes for coding agents

Adamant diagnoses a red CI build, proves a fix in a sandbox, opens a pull
request, and merges **that** PR. It does not merge anyone else's work.

Phase 1 is a hosted backend (GitHub App + worker) plus a CLI that stays
connected to that API, with one heal-and-merge.
Start at [docs/phase-1-tasks.md](docs/phase-1-tasks.md).

Read before larger changes:

- [docs/product.md](docs/product.md): what we are building
- [docs/phase-1-tasks.md](docs/phase-1-tasks.md): Phase 1 tasks
- [docs/backend-architecture.md](docs/backend-architecture.md): how API, worker, and agent connect
- [docs/database.md](docs/database.md): Postgres schema
- [docs/tech-stack.md](docs/tech-stack.md): stack and layout
- [docs/performance.md](docs/performance.md): speed rules for the run path
- [docs/mid-eval-backend-plan.md](docs/mid-eval-backend-plan.md): calendar only

## Layout

```
electron/           desktop shell
server/             @adamant/server   one package.json and one tsconfig.json
  api/              Hono (webhooks + CLI)
  db/               Drizzle; drizzle.config.ts lives here
  worker/           graphile-worker
  agent/            LangGraph; must not import Hono
  sandbox/          Docker runner
  cli/              monitor (create)
docs/               design docs
```

See [docs/tech-stack.md](docs/tech-stack.md). `server/api` does not import
`server/agent`.

## Commands

```bash
pnpm install
pnpm dev            # Vite + watch builds + Electron
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
```

Before saying a change is done, run `pnpm typecheck`, `pnpm lint` and `pnpm build`, plus
`pnpm format:check` on the files you touched. Report failures as they are; don't claim a check
passed if you didn't run it.

## Code conventions

- TypeScript strict mode, with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. Don't
  use `any`, non-null `!` or `@ts-ignore` to get around them.
- Type-only imports use the inline form: `import { type AppInfo } from '@adamant/shared'`.
- Named exports. Default exports only where a tool requires them (Vite configs).
- Prettier: no semicolons, single quotes, 100 columns, trailing commas.
- Comments explain _why_, not what. Match the density of the surrounding file.
- `@adamant/shared` is source-only; it has no build step.

## Security rules (don't break these)

Electron:

- The renderer is untrusted. Keep `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`.
- Never expose `ipcRenderer`, IPC event objects or arbitrary channel names to the renderer. Every
  bridge method is explicit and typed in `@adamant/shared`. Use the `add-ipc-method` skill.
- Validate arguments in main-process IPC handlers; the renderer can send anything.
- Don't loosen the Content-Security-Policy in `electron/adamant/index.html` or allow remote code.
- The renderer does not call the backend directly; main does, and the session token stays in main.

Backend (from docs/backend-architecture.md):

- The agent force-pushes nowhere and pushes only `refs/heads/adamant/{run_id}`.
  It may merge **only** the PR for that run, after a passing `sandbox_results`
  row. Use the `add-agent-tool` skill for `merge_pull_request`.
- Every agent tool is allowlisted, logged to `tool_invocations` / `audit_events` with `run_id`, and
  unknown calls fail closed.
- GitHub installation tokens are minted per call and never stored in Electron, checkpoints, prompts,
  logs or the sandbox.
- No PR and no merge without a passing `sandbox_results` row.

## Performance

Changes to the worker, agent or sandbox follow the checklist in
[docs/performance.md](docs/performance.md#checklist-for-changes-to-the-run-path). Use the
`performance-review` skill to check a diff against it.

## Skills

Task-specific instructions live in `.agents/skills/` (read by Claude Code, Codex and Cursor).

| Skill                | Use when                                                  |
| -------------------- | --------------------------------------------------------- |
| `add-ipc-method`     | Adding or changing a method between the renderer and main |
| `add-agent-tool`     | Adding or changing a tool the agent can call              |
| `performance-review` | Reviewing a change to the run path for speed regressions  |
| `write-pull-request` | Writing commit messages, PR titles and PR descriptions    |

## Git and pull requests

- Never commit to `main`. Branch as `feat/…`, `fix/…`, `docs/…` or `chore/…`. `adamant/*` is
  reserved for the agent.
- Follow `.github/pull_request_template.md` and the `write-pull-request` skill: short, specific,
  only claims you verified.
- See [CONTRIBUTING.md](CONTRIBUTING.md) for the review and merge flow.
