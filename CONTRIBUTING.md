# Contributing

## Setup

Node.js 22.12+ and pnpm 10+.

```bash
pnpm install
pnpm dev
```

Phase 1 work is [docs/phase-1-tasks.md](docs/phase-1-tasks.md). Layout and
security: [AGENTS.md](AGENTS.md) (applies to people as well as agents).

## Workflow

1. **Open or pick an issue** using the bug or feature template.
2. **Branch from `main`:** `feat/…`, `fix/…`, `docs/…` or `chore/…`. Never commit to `main`.
   `adamant/*` is reserved for the agent's own branches.
3. **Commit** with imperative subjects of at most 72 characters (`Add run list IPC method`). Add a
   body when the reason isn't obvious.
4. **Run the checks:**
   ```bash
   pnpm typecheck && pnpm lint && pnpm build
   pnpm format:check
   ```
5. **Open a PR** using the template. Keep it short and only claim what you verified; the
   [`write-pull-request`](.agents/skills/write-pull-request/SKILL.md) skill has the rules and an
   example.

## Review and merge

The `adamant-protocols` ruleset ([adamant-protocols.json](adamant-protocols.json)) requires:

- one approving review
- a completed CodeRabbit review of the current commit
- linear history, so PRs are **squash-merged** and the PR title becomes the commit subject
- Copilot code review and CodeQL code scanning

The checked-in ruleset targets the default branch. Repository administrators keep the live GitHub
ruleset aligned with [adamant-protocols.json](adamant-protocols.json).

Reviewers check correctness first, then the security rules in AGENTS.md, then
[docs/performance.md](docs/performance.md) for run-path changes. Style is Prettier and ESLint's
job.

## Using AI coding agents

Claude Code, Cursor and Codex all read `AGENTS.md` and `.agents/skills/`.

You own what you submit. Read every line an agent wrote before opening the PR, and make sure the
description says what you checked, not what the agent says it did.
