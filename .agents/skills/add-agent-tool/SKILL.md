---
name: add-agent-tool
description: Add or change a tool the Adamant agent can call (git, GitHub API, GitHub Actions, sandbox). Use when working on the agent's tool gateway or giving the model a new capability. Enforces the allowlist, audit logging, credential and scope rules from the architecture doc.
---

# Adding an agent tool

The model never runs commands directly. It calls tools, and every tool goes through the gateway,
which checks the allowlist, logs the call and scopes it to one run and one repo. The rules come
from [docs/backend-architecture.md](../../../docs/backend-architecture.md#agent-tools). The code
will live in `server/agent` (see [docs/tech-stack.md](../../../docs/tech-stack.md#layout)).

## Before writing it

- Check the architecture doc's allowed and denied lists. If the tool isn't covered, update the doc
  in the same PR and say so in the description.
- Prefer a narrow tool (`get_failed_job_logs(run_id)`) over a general one (`run_shell(cmd)`).
  Narrow tools are easier to allowlist and give the model fewer ways to go wrong.

## Required for every tool

1. **A zod input schema.** Validate the model's input before doing anything. Invalid input returns
   a tool error, not an exception.
2. **An allowlist entry.** Anything not on the list fails closed.
3. **Audit logging through the gateway:** a `tool_invocations` row (tool, name, redacted args,
   result status) and `audit_events`, both with `run_id`, plus `started_at` / `ended_at`.
4. **Redaction.** Strip tokens, `Authorization` headers and anything secret-shaped from args and
   results before they're stored or returned to the model.
5. **Scope from the run, not the model.** The repo, branch and refspec come from the run record.
   The push refspec is always `refs/heads/adamant/{run_id}`, computed by the adapter.
6. **Credentials minted per call.** Get a GitHub installation token when the tool runs; for git,
   pass it through a one-shot `GIT_ASKPASS` helper. Never put it in the prompt, checkpoint, logs
   or sandbox.
7. **Bounded output.** Truncate or summarise large results (logs, diffs) before returning them.
   Huge tool results slow every later model call and push useful context out.
8. **Errors as tool results.** Return a failed tool call to the model as a result with
   `is_error: true` so it can adapt. A 403 from git or the GitHub API fails the run; don't retry it
   from the sandbox.

## Never allowed

Force-pushing, pushing to the default branch, deleting the default branch, changing
rulesets or admin settings, minting tokens, acting on any repo other than the run's bound repo,
merging a PR this run did not open.

`merge_pull_request` is allowed **only** for `runs.pr_number` when the head is
`adamant/{run_id}` and the latest `sandbox_results.verdict` is `pass`. The adapter
reads those from the run; the model does not pass an arbitrary PR number.

## Tests

For each tool, cover at least:

- an allowed call succeeding and being logged with `run_id`
- a denied or out-of-scope call failing closed
- secrets redacted from the stored args and result

## Finish

Run the repo checks from AGENTS.md, and apply the `performance-review` skill if the tool is on the
run path.
