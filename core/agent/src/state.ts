import { Annotation } from '@langchain/langgraph'

export interface RepositoryInfo {
  readonly owner: string
  readonly name: string
  readonly installationId: string
}

export interface SandboxResult {
  readonly verdict: 'pass' | 'fail' | 'error'
  readonly exitCode?: number
  readonly commands: readonly string[]
}

export const AgentStateAnnotation = Annotation.Root({
  runId: Annotation<string>(),
  repository: Annotation<RepositoryInfo>(),
  baseSha: Annotation<string>(),
  sourceSha: Annotation<string | null>({
    reducer: (a, b) => b ?? a,
    default: () => null,
  }),
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
    reducer: (a, b) => b ?? a,
    default: () => 'queued',
  }),
  diagnostics: Annotation<string | null>({
    reducer: (a, b) => b ?? a,
    default: () => null,
  }),
  plan: Annotation<string | null>({
    reducer: (a, b) => b ?? a,
    default: () => null,
  }),
  candidatePatch: Annotation<string | null>({
    reducer: (a, b) => b ?? a,
    default: () => null,
  }),
  attemptNumber: Annotation<number>({
    reducer: (a, b) => b ?? a,
    default: () => 0,
  }),
  maxAttempts: Annotation<number>({
    reducer: (a, b) => b ?? a,
    default: () => 2,
  }),
  sandboxResult: Annotation<SandboxResult | null>({
    reducer: (a, b) => b ?? a,
    default: () => null,
  }),
  error: Annotation<string | null>({
    reducer: (a, b) => b ?? a,
    default: () => null,
  }),
  prNumber: Annotation<number | null>({
    reducer: (a, b) => b ?? a,
    default: () => null,
  }),
})

export type AgentState = typeof AgentStateAnnotation.State
