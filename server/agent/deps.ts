import { type FailureContext } from './triage.ts'
import { type RunRecorder } from './recorder.ts'

export interface PullRequestRef {
  readonly number: number
  readonly url: string
}

export interface GitProvider {
  fetch(repo: { owner: string; name: string }): Promise<void>
  checkout(sha: string): Promise<void>
  /**
   * Reset the worktree to the checked-out base, then apply this diff. Resetting
   * first is what makes a second attempt independent of the first; a diff that
   * does not apply rejects here rather than reaching the sandbox.
   */
  applyPatch(patch: string): Promise<void>
  commit(message: string): Promise<void>
  push(branch: string): Promise<void>
  openPr(branch: string, base: string, title: string, body: string): Promise<PullRequestRef>
  mergePr(prNumber: number): Promise<void>
  /** Logs of the failed jobs only, never the whole workflow run. */
  getFailureLogs(): Promise<string>
}

export interface SandboxOutcome {
  readonly verdict: 'pass' | 'fail' | 'timeout' | 'error'
  readonly exitCode?: number
  readonly commands: readonly string[]
  /** Bounded tail of the run, fed back into the next diagnose on a failure. */
  readonly output: string
}

export interface SandboxProvider {
  /** The candidate is already applied to the workspace by `applyPatch`. */
  runValidation(input: { attemptNumber: number; candidateHash: string }): Promise<SandboxOutcome>
}

export interface PreviousAttempt {
  readonly attemptNumber: number
  readonly patch: string
  /** Why it did not hold: sandbox output, or the reason the diff was rejected. */
  readonly failure: string
}

export interface LlmProvider {
  diagnose(input: {
    failure: FailureContext
    previousAttempt: PreviousAttempt | null
  }): Promise<string>
  plan(input: { failure: FailureContext; diagnostics: string }): Promise<string>
  patch(input: {
    failure: FailureContext
    diagnostics: string
    plan: string
    previousAttempt: PreviousAttempt | null
  }): Promise<string>
}

export interface AgentDependencies {
  readonly git: GitProvider
  readonly sandbox: SandboxProvider
  readonly llm: LlmProvider
  readonly recorder: RunRecorder
}
