# Performance

Time goes to installs, tests, model calls, and waiting on people — not to Hono
vs Fastify.

**Phase 1** only needs the items below. Local mode, fingerprints, desktop
notifications, and parallel candidate patches are later.

## Phase 1 (do these)

- Parse the CI log in code first (first error, `file:line`, test names). Do
  not send the raw dump to the model.
- Download only the failed jobs' logs.
- Push `adamant/{run_id}` **once**, after the sandbox passes — not on every
  attempt.
- Cap `diagnose_attempts`.
- While retrying, run only the failing tests; run the full suite once before
  merge if you can.
- Prefer a worktree at the failing SHA over `git clone` every run (a mirror
  can wait if it slows you down).

## Targets (revise when we have timings)

| Measure                          | Target  |
| -------------------------------- | ------- |
| Job picked up after trigger      | < 1 s   |
| Verified fix, cloud (warm image) | < 3 min |

## Cloud loop

`graphile-worker` uses `LISTEN/NOTIFY`, so keep a worker running.

**Code:** one bare mirror per repo if you have time; per run `git fetch` +
`git worktree add --detach`. Evict unused mirrors when disk is low.

**Image (nice to have):** one image per lockfile hash so install is not once
per run. Tests still run with the network off.

### Model calls

Official `openai` SDK, `OPENAI_API_KEY` in the worker only.

- One model (`OPENAI_MODEL`, default GPT-6). Effort `low` to sort the
  failure, `high` to write the patch.
- Keep the prompt prefix stable (tools, system, repo). Put run IDs and log
  lines after it. Check `usage.prompt_tokens_details.cached_tokens`.
- Edit with apply-patch / str-replace. Do not rewrite whole files.
- When the model asks for several tools, run them concurrently.

## Later

Local mode (same `server/agent` on the developer's checkout; model calls
through the API). Failure fingerprints. `/adamant approve`. Parallel
candidate patches. `audit_events.started_at` / `ended_at` and a timing UI.

## Checklist for changes to the run path

Use this when reviewing worker, agent, or sandbox code. The
`performance-review` skill applies it.

- [ ] Failed-job logs only; parsed before the model
- [ ] Edits via apply-patch / str-replace
- [ ] Parallel tool results in one message
- [ ] Targeted tests during retries
- [ ] Push only after the sandbox passes
- [ ] No fresh `git clone` per run if a mirror already exists
