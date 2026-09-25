export interface GitProvider {
  fetch(repo: { owner: string; name: string }): Promise<void>
  checkout(sha: string): Promise<void>
  commit(message: string): Promise<void>
  push(branch: string): Promise<void>
  openPr(branch: string, base: string, title: string, body: string): Promise<number>
  mergePr(prNumber: number): Promise<void>
  getFailureLogs(): Promise<string>
}

export interface SandboxProvider {
  runValidation(
    patch: string,
  ): Promise<{ verdict: 'pass' | 'fail' | 'error'; exitCode?: number; commands: readonly string[] }>
}

export interface LlmProvider {
  diagnose(failureLogs: string): Promise<string>
  plan(diagnostics: string): Promise<string>
  patch(plan: string): Promise<string>
}

export interface AgentDependencies {
  readonly git: GitProvider
  readonly sandbox: SandboxProvider
  readonly llm: LlmProvider
}
