# Glossary

Words this repo uses in a specific way. If a doc uses a term without explaining
it, it is defined here.

New to the project? Read [product.md](product.md) first, then come back when a
word does not make sense.

## The run

| Term             | Meaning                                                                                                                                                     |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Run**          | One attempt to heal one failing CI build. A row in `runs`, and the unit everything else hangs off: the branch name, the sandbox result, the audit trail.    |
| **Heal**         | Work out why a build is red, write a patch, prove it in a sandbox, open a pull request, and merge **that** PR.                                              |
| **Heal path**    | The whole route from "GitHub says a build failed" to "that PR is merged". Drawn end to end in [backend-architecture.md](backend-architecture.md#heal-path). |
| **Base SHA**     | The commit the build failed on. Every run starts from it.                                                                                                   |
| **Agent branch** | `adamant/{run_id}` — the only ref the agent is allowed to push.                                                                                             |
| **Eval repo**    | A small TypeScript repo with deliberately broken commits, used to test Adamant. Not this repo. The GitHub App is installed here.                            |

## The machinery

| Term               | Meaning                                                                                                                                        |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Control plane**  | Hosted API + worker. The GitHub App sends webhooks here; the CLI reads the same origin.                                                        |
| **GitHub App**     | The plugin installed on the repo. Failed CI starts a heal; merged PRs are recorded. Code does not run on GitHub.                               |
| **CLI**            | `@adamant/cli` — `status` / `runs` / `run` / `watch`. Stays connected to the **hosted** API. No keys.                                          |
| **Hosted backend** | The always-on API + worker + Postgres the GitHub App and the CLI both talk to.                                                                 |
| **Graph**          | The LangGraph state machine a worker runs to heal one build. Its nodes are listed in [backend-architecture.md](backend-architecture.md#graph). |
| **Node**           | One step of the graph (`diagnose`, `patch`, …).                                                                                                |
| **Thread ID**      | LangGraph's key for one conversation's saved state. For us it is always the run id, so a resumed run picks up exactly where it stopped.        |
| **Checkpoint**     | LangGraph's saved graph state, written to Postgres and keyed by thread id. Lets a worker that died mid-run resume instead of restarting.       |
| **Worktree**       | A second checkout of an already-cloned repo (`git worktree add`). Cheaper than cloning again for every run.                                    |
| **Sandbox**        | A throwaway container that runs the repo's tests with the network off. One per attempt, destroyed afterwards.                                  |
| **Verdict**        | What the sandbox concluded: `pass` or `fail`. A timeout is a `fail`.                                                                           |
| **Artifact**       | A file the run produced and we kept, such as sandbox logs. Stored outside Postgres; the database holds only its key.                           |

## Permissions and safety

| Term                   | Meaning                                                                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **HITL**               | Human in the loop — later. Phase 1 skips it and merges after a passing sandbox.                                                               |
| **merge_pull_request** | The only merge tool. It may merge `runs.pr_number` when the head is `adamant/{run_id}` and the latest sandbox verdict is `pass`.              |
| **Tool**               | A named, allowlisted function the model may call (`get_failed_job_logs`), instead of running shell commands itself.                           |
| **Tool gateway**       | The layer every tool call goes through. It checks the allowlist, scopes the call to the run's repo, redacts the arguments, and logs the call. |
| **Fail closed**        | When a request is not explicitly allowed, deny it. An unknown tool is refused, not guessed at.                                                |
| **Installation**       | A GitHub App installed on an account or org. It, not a user, is what grants Adamant access to a repo.                                         |
| **Installation token** | A short-lived GitHub token minted from the installation. Created per call and thrown away.                                                    |
| **Delivery ID**        | GitHub's `X-GitHub-Delivery` header, unique per webhook delivery. Our deduplication key.                                                      |
| **Idempotency key**    | What stops one event creating two runs: `workflow_run:{head_sha}`, or the client's `Idempotency-Key` header.                                  |
| **Seeded user**        | The placeholder row in `users` that owns Phase 1 runs, standing in for a real account until GitHub OAuth exists.                              |

## Process

| Term              | Meaning                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Phase**         | A stage of the roadmap in [product.md](product.md#roadmap). Phase 1 is the backend.                                      |
| **Seat (R1–R10)** | One person's slot on the mid-eval team. Who holds which seat is in [mid-eval-backend-plan.md](mid-eval-backend-plan.md). |
| **Workstream**    | Database, graph, GitHub App, healing, CLI.                                                                               |
