import { type GitProvider, type PullRequestRef } from './deps.ts'
import { type RunRecorder } from './recorder.ts'

/**
 * The gateway between the graph and anything that touches GitHub. Every call
 * is on the allowlist below, scoped to this run, and written to
 * `tool_invocations` with its arguments redacted. A call that is not on the
 * list fails closed. Rules: docs/backend-architecture.md#agent-tools.
 */
export const ALLOWED_GIT_TOOLS = [
  'git_fetch',
  'git_checkout',
  'git_apply_patch',
  'git_commit',
  'git_push',
  'open_pull_request',
  'merge_pull_request',
  'get_failure_logs',
] as const

export type GitToolName = (typeof ALLOWED_GIT_TOOLS)[number]

const allowed = new Set<string>(ALLOWED_GIT_TOOLS)

export class ToolDeniedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolDeniedError'
  }
}

export class SecureGitClient {
  private readonly git: GitProvider
  private readonly runId: string
  private readonly recorder: RunRecorder

  constructor(git: GitProvider, runId: string, recorder: RunRecorder) {
    if (!runId) {
      throw new Error('Run ID is required to construct the git tool gateway.')
    }
    this.git = git
    this.runId = runId
    this.recorder = recorder
  }

  /** The only branch this run may write. Computed here, never passed by the model. */
  get agentBranch(): string {
    return `adamant/${this.runId}`
  }

  async fetch(repo: { owner: string; name: string }): Promise<void> {
    await this.guarded('git_fetch', { ...repo }, () => this.git.fetch(repo))
  }

  async checkout(sha: string): Promise<void> {
    await this.guarded('git_checkout', { sha }, () => this.git.checkout(sha))
  }

  async applyPatch(patch: string): Promise<void> {
    await this.guarded('git_apply_patch', { bytes: patch.length }, () => this.git.applyPatch(patch))
  }

  async commit(message: string): Promise<void> {
    await this.guarded('git_commit', { message }, () => this.git.commit(message))
  }

  async push(branch: string): Promise<void> {
    await this.guarded('git_push', { branch }, () => {
      this.assertAgentBranch(branch, `Unauthorized push attempt to branch ${branch}.`)
      return this.git.push(branch)
    })
  }

  async openPr(branch: string, base: string, title: string, body: string): Promise<PullRequestRef> {
    return this.guarded('open_pull_request', { branch, base, title }, () => {
      this.assertAgentBranch(branch, `Unauthorized PR attempt from branch ${branch}.`)
      if (base === branch) {
        throw new ToolDeniedError('A pull request cannot target its own head branch.')
      }
      return this.git.openPr(branch, base, title, body)
    })
  }

  /**
   * Merges this run's pull request and nothing else. The verdict is read back
   * from `sandbox_results`, not from graph state, so an in-memory pass that was
   * never persisted cannot merge anything.
   */
  async mergePr(prNumber: number, expectedPrNumber: number | null): Promise<void> {
    await this.guarded('merge_pull_request', { prNumber, expectedPrNumber }, async () => {
      if (!expectedPrNumber || prNumber !== expectedPrNumber) {
        throw new ToolDeniedError(
          `Cannot merge PR ${prNumber}. It does not match the PR opened for this run.`,
        )
      }

      const published = await this.recorder.publishedPrNumber()
      if (published !== null && published !== prNumber) {
        throw new ToolDeniedError(
          `Cannot merge PR ${prNumber}. This run published PR ${published}.`,
        )
      }

      const verdict = await this.recorder.latestSandboxVerdict()
      if (verdict !== 'pass') {
        throw new ToolDeniedError(`Cannot merge PR ${prNumber} without a passing sandbox result.`)
      }

      await this.git.mergePr(prNumber)
    })
  }

  async getFailureLogs(): Promise<string> {
    return this.guarded('get_failure_logs', {}, () => this.git.getFailureLogs())
  }

  /** Named dispatch for anything that reaches the gateway by name. Fails closed. */
  async invoke(tool: string): Promise<never> {
    if (!allowed.has(tool)) {
      const error = new ToolDeniedError(`Unknown tool ${tool} is not on the allowlist.`)
      await this.recorder.toolInvocation({
        tool,
        args: {},
        outcome: 'denied',
        errorMessage: error.message,
        startedAt: new Date(),
      })
      throw error
    }
    throw new Error(`Call ${tool} through its typed method on SecureGitClient.`)
  }

  private assertAgentBranch(branch: string, message: string): void {
    if (branch !== this.agentBranch) {
      throw new ToolDeniedError(`${message} Allowed branch: ${this.agentBranch}`)
    }
  }

  private async guarded<T>(
    tool: GitToolName,
    args: Record<string, unknown>,
    call: () => Promise<T>,
  ): Promise<T> {
    const startedAt = new Date()

    if (!allowed.has(tool)) {
      await this.record(tool, args, 'denied', startedAt, `Tool ${tool} is not on the allowlist.`)
      throw new ToolDeniedError(`Tool ${tool} is not on the allowlist.`)
    }

    try {
      const result = await call()
      await this.record(tool, args, 'ok', startedAt)
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const outcome = error instanceof ToolDeniedError ? 'denied' : 'error'
      await this.record(tool, args, outcome, startedAt, message)
      throw error
    }
  }

  private async record(
    tool: string,
    args: Record<string, unknown>,
    outcome: 'ok' | 'error' | 'denied',
    startedAt: Date,
    errorMessage?: string,
  ): Promise<void> {
    await this.recorder.toolInvocation({
      tool,
      args: { ...args, runId: this.runId },
      outcome,
      startedAt,
      ...(errorMessage === undefined ? {} : { errorMessage }),
    })
  }
}
