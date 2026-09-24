# Adamant backend plan — IT-314 mid-eval

**Window:** 21 Sep 2026 – 17 Oct 2026 (26 days)
**People:** 10, backend first
**Eval date:** 17 Oct 2026 (Saturday) — feature freeze 15 Oct, rehearse 16 Oct, present 17 Oct
**Load assumption:** ~10 focused hours per person per week (~380 person-hours). Enough for a vertical slice, not V1.

Adamant repairs a red CI build, proves the fix in a sandbox, waits for a human, then opens a pull request. **It never merges.** The desktop UI stays a shell until after mid-eval. Demo the backend with `curl` / `heal-eval.mjs`, logs, and a GitHub PR.

Grounded in [product.md](product.md) (Phase 0 then a thin Phase 1), [backend-architecture.md](backend-architecture.md), [tech-stack.md](tech-stack.md), and [performance.md](performance.md). `server/` and `core/` do not exist yet.

---

## Starting point (21 Sep)

The Electron app boots and shows runtime info. There is no API, no Postgres, no GitHub App runtime, no agent, no sandbox. Design docs and skills are written. Mid-eval success is a **working heal slice**, not a finished product and not a polished inbox.

---

## What 17 Oct has to show

- [ ] `POST /runs` creates a queued run; a worker claims it (`graphile-worker`, not a hand-rolled jobs table)
- [ ] Retrieve the failing SHA via mirror + worktree; parse failed-job logs in code before any model call
- [ ] Triage: patch lint / type / dep-upgrade; report flaky / infra / missing-secret; do not invent a fix
- [ ] Sandbox proves fail-then-pass; HITL is rejected without a passing `sandbox_results` row
- [ ] Push only `refs/heads/adamant/{run_id}` after sandbox pass; open a PR; never merge or force-push
- [ ] Eval harness on ≥8 cases with a **measured** fix rate; one live heal and one honest give-up in the demo

Heal path:

```
retrieve → triage → diagnose → plan → patch → sandbox → HITL → open PR → observe
                              ↑               |          |
                              └───────────────┘          └→ patch (request changes)
```

Dashed/back edges: sandbox fail → diagnose (retry); HITL request-changes → patch. HITL cannot fire without a passing sandbox row.

---

## Cut line

| Priority | Scope |
| --- | --- |
| **P0 — ship for mid-eval** | Schema, create run, worker claim, worktree, log parse, triage, sandbox, HITL gate, push agent branch, eval harness, one live or scripted heal, one give-up |
| **P1 — still backend, if time** | Real model patches on several cases, `workflow_run` webhooks creating runs, automatic PR, SSE live events, test-weakening guard, prompt cache |
| **P2 — after 17 Oct** | Electron Heal button and inbox, local mode, fingerprint grouping, `.adamant.yml`, Dependabot replay, metrics dashboard, `/adamant approve` comments |

If Phase C slips: **keep the pipeline** and script one type-error patch so the demo still proves sandbox-before-PR. Do not spend mid-eval week on the renderer.

---

## Phases

| Phase | When | Days | Goal | Exit criterion |
| --- | --- | --- | --- | --- |
| **A. Foundation** | 21–27 Sep | 7 | Packages, schema, GitHub App, eval skeleton exist and compile | `POST /runs` writes a row; worker claims a no-op job; 3 eval cases have failing logs |
| **B. Plumbing** | 28 Sep–4 Oct | 7 | A run can clone the failing SHA, parse the CI log, and record a sandbox fail | curl a run on eval case 1 → parsed error in `audit_events` → `sandbox_results` = fail |
| **C. Heal loop** | 5–11 Oct | 7 | Patch, prove in sandbox, HITL, push `adamant/{run_id}`. No merge | ≥3 eval cases go red → patch → sandbox pass → approve → PR or agent branch |
| **D. Demo lock** | 12–17 Oct | 6 | Rehearsed 8-minute demo. Feature freeze. Honest numbers | Known-good case, backup recording, slides that only claim what was run |

**Friday integration checkpoints** (not new-feature days):

| Date | Must be true |
| --- | --- |
| 26 Sep | Insert run + claim no-op job + 3 eval logs |
| 3–4 Oct | Clone, parse, sandbox fail |
| 10–11 Oct | Three heals dry-run |
| 15 Oct | Feature freeze |
| 16 Oct | Rehearsal |
| 17 Oct | Present |

Miss a Friday → cut stretch work, not the slice.

---

## Ten seats (assign names)

Five pods of two. Each pod owns a package boundary so ten people are not editing the same files. **R1 reviews every PR that touches the run path.**

| Seat | Name | Title | Pod | Owns |
| --- | --- | --- | --- | --- |
| R1 | | Integrator | Platform | pnpm workspace, compose, CI, merge traffic, demo script |
| R2 | | Schema & jobs | Platform | Drizzle schema, migrations, graphile-worker, run state machine |
| R3 | | API identity | API | Hono, OAuth sessions, `POST /runs`, `GET` run, HITL HTTP |
| R4 | | GitHub App | API | Octokit App, HMAC webhooks, installations, `repo_bindings` |
| R5 | | git adapter | Tools | mirrors, worktrees, `GIT_ASKPASS`, refspec `adamant/{run_id}` |
| R6 | | GitHub / Actions | Tools | failed-job logs, checks, create PR, per-call installation tokens |
| R7 | | Agent graph | Agent + sandbox | LangGraph nodes, checkpoints, diagnose + patch prompts |
| R8 | | Sandbox | Agent + sandbox | dockerode, isolation, `sandbox_results`, artifact logs |
| R9 | | Eval set | Eval + contract | sample TS repo, ~20 broken commits, fix-rate harness, log parser |
| R10 | | Contract & audit | Eval + contract | `@adamant/contract` zod, tool gateway logging, SSE, redaction |

### Why this split

| Pod | People | Package | Why they are paired |
| --- | --- | --- | --- |
| Platform | R1 + R2 | workspace, compose, Drizzle, graphile-worker | Everyone else is blocked until packages and tables exist. Integrator keeps merges moving. |
| API | R3 + R4 | `@adamant/api` | HTTP is thin: auth/commands vs GitHub HMAC. Same Hono app, different route files. |
| Tools | R5 + R6 | `core/agent` adapters | git CLI and Octokit are separate allowlists. Both go through R10's gateway. |
| Agent + sandbox | R7 + R8 | `@adamant/agent`, worker `sandbox_exec` | Graph must not import Hono or dockerode. Sandbox is a job the graph enqueues. |
| Eval + contract | R9 + R10 | eval repo, `@adamant/contract` | Parser and schemas have no cloud deps, so they start on day one and keep the demo honest. |

R9 and R10 start **day one**. R3 / R7 / R8 wait on R1 + R2 + R10 for packages, tables, and shared schemas.

---

## Workload

Assumes ~10 focused hours per person per week, 2 people per pod:

| Phase | Platform | API | Tools | Agent + sandbox | Eval + contract | Total |
| --- | --- | --- | --- | --- | --- | --- |
| A Foundation | 20h | 20h | 20h | 20h | 20h | 100h |
| B Plumbing | 20h | 20h | 20h | 20h | 20h | 100h |
| C Heal loop | 20h | 20h | 20h | 20h | 20h | 100h |
| D Demo lock | 16h | 16h | 16h | 16h | 16h | 80h |
| **Total** | **76h** | **76h** | **76h** | **76h** | **76h** | **~380h** |

Must vs stretch task count (not hour-weighted): Phase A 10 must; B 10 must + 1 stretch; C 10 must + 1 stretch; D 10 must.

---

## Dependencies — who unblocks whom

| Until this lands | These seats wait |
| --- | --- |
| R1 workspace + compose (day 1–2) | Everyone. Do not start extra Electron work. |
| R2 schema + graphile-worker (day 2–4) | R3 enqueue, R7 checkpointer, R8 `sandbox_results` |
| R10 zod contract (day 1–3) | R3 request bodies, R7 graph state, R5/R6 tool inputs |
| R9 log parser (Phase B) | R7 triage. Do not send raw logs to the model. |
| R5 worktree + R6 failed logs (Phase B) | R7 retrieve / diagnose |
| R8 fail-then-pass sandbox (Phase B/C) | R2 HITL gate, R5 push, R4 open PR |
| R7 `interrupt()` HITL (Phase C) | R3 approve route is a no-op until the graph pauses |

---

## Phase A — Foundation (21–27 Sep)

**Goal:** Packages, schema, GitHub App, eval skeleton exist and compile.
**Exit:** `POST /runs` writes a row; worker claims a no-op job; 3 eval cases have failing logs.

| Seat | Pri | Task | Done when |
| --- | --- | --- | --- |
| R1 | Must | Add `server/*` and `core/*` to the workspace; docker-compose for Postgres; backend CI job | `pnpm typecheck` passes on empty packages; compose up is documented |
| R2 | Must | Drizzle schema for every table in the architecture ERD; graphile-worker migrations | migrate on empty DB; `runs.status` enum and `version` column exist |
| R3 | Must | Hono health + `POST /runs` stub that inserts queued run and returns 202 | curl `POST /runs` creates a row; no model, no git |
| R4 | Must | Dev GitHub App + HMAC webhook receiver; persist `delivery_id`; ACK duplicates | signed ping is stored; replay of same `delivery_id` does not insert twice |
| R5 | Must | git allowlist parser + worktree helper against a local fixture repo | allowed fetch/checkout/diff/log; denied force-push and default-branch push in tests |
| R6 | Must | Octokit wrapper that mints an installation token per call and never stores it | tests prove token is not in logs, checkpoints, or returned payloads |
| R7 | Must | LangGraph skeleton: retrieve → triage → diagnose → plan → patch → sandbox → hitl → openPr as stubs | graph runs with Postgres checkpointer; `thread_id = run_id`; statuses update |
| R8 | Must | dockerode smoke: start alpine, capture stdout, destroy; no `docker.sock` mount | one container per job; destroyed on exit; isolation flags in code |
| R9 | Must | Eval repo + 3 cases: type error, snapshot drift, renamed API after a dep bump | script applies a broken commit and saves the failing log |
| R10 | Must | `@adamant/contract`: `RunStatus`, `CreateRun`, `HitlDecision`, `SandboxVerdict`, `ToolInvocation` | API, worker, and agent import schemas; no duplicate types |

---

## Phase B — Plumbing (28 Sep–4 Oct)

**Goal:** A run can clone the failing SHA, parse the CI log, and record a sandbox fail.
**Exit:** curl a run on eval case 1 → parsed error in `audit_events` → `sandbox_results` = fail.

| Seat | Pri | Task | Done when |
| --- | --- | --- | --- |
| R1 | Must | Worker process entrypoint; compose runs api + worker + postgres together | `pnpm --filter @adamant/worker start` claims jobs in <1s via `LISTEN/NOTIFY` |
| R2 | Must | Enqueue `graph_step` on createRun; claim `SKIP LOCKED`; lock TTL; queued → running | killing the worker releases the lock; a second worker resumes |
| R3 | Must | GitHub OAuth (dev user ok); auth middleware; `Idempotency-Key`; `GET /runs/:id` | unauthenticated POST is 401; same `Idempotency-Key` returns the same run |
| R3 | Stretch | HITL stub with `runs.version` optimistic lock (409 on mismatch) | two concurrent approves: one 200, one 409 |
| R4 | Must | Failed `workflow_run` webhook creates a run bound to installation + repo | one delivery → one run; actor access check documented even if simplified |
| R5 | Must | Bare mirror per repo + `git worktree add --detach` at the failing SHA | second run on same repo does not `git clone` from scratch |
| R6 | Must | `get_failed_job_logs`: failed jobs only, ANSI stripped, scoped to `repo_id` | fixture + live path both return truncated logs; 403 fails the run |
| R7 | Must | retrieve + triage nodes: inspect repo, classify failure from parsed log | type error vs infra vs missing secret vs flaky is a code path, not a prompt guess |
| R8 | Must | `sandbox_exec` job copies the worktree and runs the eval repo's test command | unpatched eval case writes `sandbox_results.verdict = fail` + `artifact_key` |
| R9 | Must | Grow to 10 eval cases; pure log parser (first error, `file:line`, test names) | parser unit tests on saved logs; R7 consumes the structured failure |
| R10 | Must | Gateway writer for `tool_invocations` + `audit_events`; SSE `/runs/:id/events` | every stub tool leaves a redacted row with `run_id` and timings |

---

## Phase C — Heal loop (5–11 Oct)

**Goal:** Patch, prove in sandbox, HITL, push `adamant/{run_id}`. No merge.
**Exit:** At least 3 eval cases go red → patch → sandbox pass → approve → PR or agent branch.

| Seat | Pri | Task | Done when |
| --- | --- | --- | --- |
| R1 | Must | `scripts/heal-eval.mjs` drives one case end-to-end; R1 is merge cop | one command reproduces the mid-eval demo on a clean compose stack |
| R2 | Must | Reject `awaiting_hitl` without a passing `sandbox_results` row; cap `diagnose_attempts` | tests cover the gate and the cap; HITL TTL → `aborted`, branch left in place |
| R3 | Must | HITL approve / request_changes / abort; `opening_pr` status; no tokens in responses | approve without sandbox pass is 409/403; session token never leaves main/API |
| R4 | Must | Create PR via App; store `pr_number`; copy `merged` from `pull_request.closed` only | agent never calls merge; PR opens from `adamant/{run_id}` into the working branch |
| R5 | Must | commit locally; push `refs/heads/adamant/{run_id}` only after sandbox pass | failed attempts never push; force-push and default-branch push still denied |
| R6 | Must | compare + create PR tools; installation token minted per call, scoped to repo | out-of-`repo_id` calls fail closed; args redacted in `tool_invocations` |
| R7 | Must | Real diagnose + patch: parsed log, diff since last green, cited files; `interrupt()` for HITL | ≥3 eval cases patched; infra/flaky cases report and do not patch |
| R7 | Stretch | Prompt cache stable prefix; effort low on triage, high on patch; text-editor edits only | `cache_read_input_tokens` > 0 on second call of a run |
| R8 | Must | Network off during tests; CPU/mem/PID/time limits; targeted tests then full suite once | timeout = fail attempt; logs in artifacts; one container destroyed on exit |
| R9 | Must | Aim for 20 cases including flaky (no patch) and missing env (report only); fix-rate script | harness prints pass/fail/give-up per case; number is ready for slides |
| R10 | Must | Unknown tools fail closed; test-weakening scan flags skip / any / ts-ignore / assertion edits | weakening diffs are flagged; PR evidence shape: cause, evidence, fix, verified, not checked |

---

## Phase D — Demo lock (12–17 Oct)

**Goal:** Rehearsed 8-minute demo. Feature freeze. Honest numbers.
**Exit:** Known-good case, backup recording, slides that only claim what was run.

| Seat | Pri | Task | Done when |
| --- | --- | --- | --- |
| R1 | Must | Feature freeze 15 Oct; 8-minute demo script; backup screen recording if GitHub is down | two rehearsals; fallback uses fixture logs + local eval repo |
| R2 | Must | Seed script for the demo installation, `repo_binding`, and known-good run | `compose down/up` + seed restores the demo in minutes |
| R3 | Must | Lock a demo user path; document every public route for the slides | no unfinished auth traps during the live `POST /runs` |
| R4 | Must | Install the App on the eval repo; confirm webhook and PR permissions for the demo | one live webhook can be shown, or the team honestly uses `POST /runs` |
| R5 | Must | Clean leftover worktrees; prove the demo SHA is reachable from the mirror | demo retrieve step is <10s on a warm mirror |
| R6 | Must | Fixture pack of failed-job logs if Actions is slow or rate-limited | demo still diagnoses when GitHub logs 429 |
| R7 | Must | Prompt freeze unless fix rate is 0%; keep one scripted patch as belt-and-braces | at least one case heals live; a second case is the honest give-up |
| R8 | Must | Pre-pull/build the eval image so the sandbox is warm for the demo | sandbox step on the known-good case is well under 3 minutes |
| R9 | Must | Fix-rate table for slides: category, n, fixed, give-up, notes — only measured numbers | no claimed percentages that were not produced by the harness |
| R10 | Must | Printable audit trail for the demo run; redaction review of stored rows | slides can show `tool_invocations` with no tokens; SSE optional if it flickers |

---

## Tasks by seat

### R1 — Integrator

- **A** Must — Add `server/*` and `core/*` to the workspace; docker-compose for Postgres; backend CI job. *Done when:* `pnpm typecheck` passes on empty packages; compose up is documented.
- **B** Must — Worker process entrypoint; compose runs api + worker + postgres together. *Done when:* worker claims jobs in <1s via `LISTEN/NOTIFY`.
- **C** Must — `scripts/heal-eval.mjs` drives one case end-to-end; merge cop. *Done when:* one command reproduces the demo on a clean compose stack.
- **D** Must — Feature freeze 15 Oct; 8-minute demo script; backup recording. *Done when:* two rehearsals; fallback uses fixtures.

### R2 — Schema & jobs

- **A** Must — Drizzle schema for the architecture ERD; graphile-worker migrations. *Done when:* migrate on empty DB; `runs.status` and `version` exist.
- **B** Must — Enqueue `graph_step`; claim `SKIP LOCKED`; lock TTL; queued → running. *Done when:* worker death releases the lock; a second worker resumes.
- **C** Must — Reject `awaiting_hitl` without passing `sandbox_results`; cap `diagnose_attempts`. *Done when:* tests cover the gate and cap; HITL TTL → `aborted`.
- **D** Must — Seed script for demo installation, `repo_binding`, known-good run. *Done when:* compose + seed restores the demo in minutes.

### R3 — API identity

- **A** Must — Hono health + `POST /runs` stub (202). *Done when:* curl creates a row; no model, no git.
- **B** Must — GitHub OAuth; auth middleware; `Idempotency-Key`; `GET /runs/:id`. *Done when:* unauthenticated POST is 401; same key returns the same run.
- **B** Stretch — HITL stub with `runs.version` optimistic lock. *Done when:* two concurrent approves: one 200, one 409.
- **C** Must — HITL approve / request_changes / abort; `opening_pr`; no tokens in responses. *Done when:* approve without sandbox pass is 409/403.
- **D** Must — Lock a demo user path; document public routes. *Done when:* no auth traps during live `POST /runs`.

### R4 — GitHub App

- **A** Must — Dev GitHub App + HMAC webhook receiver; `delivery_id` PK. *Done when:* signed ping stored; duplicate ACK, no second insert.
- **B** Must — Failed `workflow_run` webhook creates a bound run. *Done when:* one delivery → one run.
- **C** Must — Create PR via App; store `pr_number`; `merged` copied from GitHub only. *Done when:* agent never calls merge.
- **D** Must — Install the App on the eval repo; confirm permissions. *Done when:* live webhook or honest `POST /runs`.

### R5 — git adapter

- **A** Must — Allowlist parser + worktree helper on a local fixture. *Done when:* denied force-push and default-branch push in tests.
- **B** Must — Bare mirror + `git worktree add --detach` at failing SHA. *Done when:* second run does not clone from scratch.
- **C** Must — commit locally; push `refs/heads/adamant/{run_id}` only after sandbox pass. *Done when:* failed attempts never push.
- **D** Must — Clean leftover worktrees; demo SHA reachable from the mirror. *Done when:* retrieve <10s on a warm mirror.

### R6 — GitHub / Actions

- **A** Must — Octokit wrapper; installation token minted per call, never stored. *Done when:* token absent from logs, checkpoints, payloads.
- **B** Must — `get_failed_job_logs`: failed jobs only, ANSI stripped, scoped to `repo_id`. *Done when:* truncated logs; 403 fails the run.
- **C** Must — compare + create PR tools; token per call, scoped to repo. *Done when:* out-of-repo calls fail closed; args redacted.
- **D** Must — Fixture pack of failed-job logs. *Done when:* demo still diagnoses on GitHub 429.

### R7 — Agent graph

- **A** Must — LangGraph skeleton with stub nodes and Postgres checkpointer. *Done when:* `thread_id = run_id`; statuses update.
- **B** Must — retrieve + triage from parsed log. *Done when:* classification is a code path, not a prompt guess.
- **C** Must — Real diagnose + patch; `interrupt()` for HITL. *Done when:* ≥3 eval cases patched; infra/flaky do not patch.
- **C** Stretch — Stable prompt-cache prefix; effort low/high; text-editor edits only. *Done when:* cache read tokens > 0 on second call.
- **D** Must — Prompt freeze unless fix rate is 0%; keep one scripted patch. *Done when:* one live heal + one give-up.

### R8 — Sandbox

- **A** Must — dockerode smoke (alpine in, stdout out, destroyed); no `docker.sock`. *Done when:* one container per job; isolation flags in code.
- **B** Must — `sandbox_exec` copies worktree and runs eval tests. *Done when:* unpatched case writes `verdict = fail`.
- **C** Must — Network off during tests; resource/time limits; targeted tests then full suite once. *Done when:* timeout = fail attempt; artifacts stored.
- **D** Must — Pre-pull/build the eval image. *Done when:* known-good sandbox well under 3 minutes.

### R9 — Eval set

- **A** Must — Eval repo + 3 cases (type error, snapshot drift, renamed API). *Done when:* script applies a broken commit and saves the log.
- **B** Must — 10 cases; pure log parser. *Done when:* unit tests on saved logs; R7 consumes structured failure.
- **C** Must — Aim for 20 cases including flaky (no patch) and missing env (report only); fix-rate script. *Done when:* harness prints pass/fail/give-up.
- **D** Must — Fix-rate table for slides from measured numbers only. *Done when:* no invented percentages.

### R10 — Contract & audit

- **A** Must — `@adamant/contract` zod schemas. *Done when:* API, worker, and agent import them; no duplicate types.
- **B** Must — Gateway writer + SSE `/runs/:id/events`. *Done when:* every stub tool leaves a redacted row with timings.
- **C** Must — Unknown tools fail closed; test-weakening scan. *Done when:* weakening diffs flagged; PR evidence shape enforced.
- **D** Must — Printable audit trail; redaction review. *Done when:* slides can show `tool_invocations` with no tokens.

---

## 8-minute demo (17 Oct)

| Min | Show | Who talks | Backup |
| --- | --- | --- | --- |
| 0–1 | Job: red CI, no prompt. Trust: no merge, no force-push, no secrets in logs | R1 | Slide only |
| 1–2 | Architecture: API vs graph worker vs sandbox worker vs allowlisted tools | R1 + R2 | This doc / architecture diagrams |
| 2–4 | Live: `POST /runs` on eval type-error. Audit trail retrieve → triage → diagnose | R3 + R7 | `heal-eval.mjs` against fixtures |
| 4–6 | Sandbox fail then pass. HITL approve. PR from `adamant/{run_id}` | R8 + R4 | Pre-recorded passing sandbox + already-open PR |
| 6–7 | Give-up: flaky or missing env. Report, no patch. Eval fix-rate table | R9 | Saved harness output |
| 7–8 | What we will not claim, and the post-eval plan (Electron Heal, webhooks, V1) | R1 | Phase table in product.md |

---

## Risks

| Risk | Likelihood | If it hits | Owner |
| --- | --- | --- | --- |
| Ten people collide on the same files | High | Stick to package owners; R1 is the only cross-cutting editor | R1 |
| GitHub App / OAuth not approved in time | Med | Demo via `POST /runs` + fixture logs; App HMAC still unit-tested | R4 |
| Model fix rate is ~0% in week 3 | Med | Keep pipeline; one scripted patch on a type error; still show give-up | R7 |
| Docker on student machines is painful | Med | One shared demo host; sandbox tests skip when Docker is missing in CI | R8 |
| Scope creeps into Electron UI | High | No renderer work until 17 Oct. Demo is curl + logs + GitHub PR | All |
| Secrets leak into checkpoints or audit | Low / severe | R6 + R10 redaction tests are merge-blocking | R10 |

---

## Working agreements

- Branch `feat/…` `fix/…` `docs/…` `chore/…` — never `main`, never `adamant/*`.
- Small PRs, one package when possible. Squash-merge. One approving review.
- R1 reviews run-path diffs against [performance.md](performance.md).
- Agent tools follow the `add-agent-tool` skill: allowlist, zod, audit, redaction, repo scope from the run, fail closed.
- Daily 15-minute standup: yesterday's done-when, today's done-when, blocker.
- Friday is integration, not new features.
- After 17 Oct, R3/R1 add the Electron IPC Heal button on this same API — that is V1, not mid-eval.
