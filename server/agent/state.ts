import { Annotation } from '@langchain/langgraph'
import { type FailureContext } from './triage.ts'

export interface RepositoryInfo {
  readonly owner: string
  readonly name: string
  readonly installationId: string
  /** PR base. A SHA is not a valid base, so this comes from the run's repo row. */
  readonly defaultBranch: string
}

export interface SandboxResult {
  readonly verdict: 'pass' | 'fail' | 'timeout' | 'error'
  readonly exitCode?: number
  readonly commands: readonly string[]
}

const last = <T>(a: T, b: T | undefined) => b ?? a

export const AgentStateAnnotation = Annotation.Root({
  runId: Annotation<string>(),
  repository: Annotation<RepositoryInfo>(),
  baseSha: Annotation<string>(),
  sourceSha: Annotation<string | null>({ reducer: last, default: () => null }),
  status: Annotation<
    | 'queued'
    | 'retrieving'
    | 'diagnosing'
    | 'planning'
    | 'patching'
    | 'sandboxing'
    | 'publishing'
    | 'awaiting_hitl'
    | 'completed'
    | 'failed'
  >({
    reducer: last,
    default: () => 'queued',
  }),
  /** Parsed once in retrieve; every later attempt reuses it. */
  failure: Annotation<FailureContext | null>({ reducer: last, default: () => null }),
  diagnostics: Annotation<string | null>({ reducer: last, default: () => null }),
  plan: Annotation<string | null>({ reducer: last, default: () => null }),
  candidatePatch: Annotation<string | null>({ reducer: last, default: () => null }),
  candidateHash: Annotation<string | null>({ reducer: last, default: () => null }),
  /** Why the last candidate failed. This is what makes attempt 2 differ from 1. */
  lastAttemptFailure: Annotation<string | null>({ reducer: last, default: () => null }),
  attemptNumber: Annotation<number>({ reducer: last, default: () => 0 }),
  maxAttempts: Annotation<number>({ reducer: last, default: () => 2 }),
  sandboxResult: Annotation<SandboxResult | null>({ reducer: last, default: () => null }),
  error: Annotation<string | null>({ reducer: last, default: () => null }),
  prNumber: Annotation<number | null>({ reducer: last, default: () => null }),
  prUrl: Annotation<string | null>({ reducer: last, default: () => null }),
})

export type AgentState = typeof AgentStateAnnotation.State
