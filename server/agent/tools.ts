import { type GitProvider } from './deps.ts'

export class SecureGitClient {
  private readonly git: GitProvider
  private readonly runId: string

  constructor(git: GitProvider, runId: string) {
    this.git = git
    this.runId = runId
  }

  async fetch(repo: { owner: string; name: string }): Promise<void> {
    await this.git.fetch(repo)
  }

  async checkout(sha: string): Promise<void> {
    await this.git.checkout(sha)
  }

  async commit(message: string): Promise<void> {
    await this.git.commit(message)
  }

  async push(branch: string): Promise<void> {
    if (!this.runId) {
      throw new Error('Run ID is required for push operations.')
    }
    const expectedBranch = `adamant/${this.runId}`
    if (branch !== expectedBranch) {
      throw new Error(
        `Unauthorized push attempt to branch ${branch}. Allowed branch: ${expectedBranch}`,
      )
    }
    await this.git.push(branch)
  }

  async openPr(branch: string, base: string, title: string, body: string): Promise<number> {
    if (!this.runId) {
      throw new Error('Run ID is required for opening PR.')
    }
    const expectedBranch = `adamant/${this.runId}`
    if (branch !== expectedBranch) {
      throw new Error(`Unauthorized PR attempt from branch ${branch}.`)
    }
    return this.git.openPr(branch, base, title, body)
  }

  async mergePr(
    prNumber: number,
    expectedPrNumber: number | null,
    sandboxVerdict: string | undefined,
  ): Promise<void> {
    if (!this.runId) {
      throw new Error('Run ID is required for merge operations.')
    }
    if (sandboxVerdict !== 'pass') {
      throw new Error(`Cannot merge PR ${prNumber} without a passing sandbox result.`)
    }
    if (!expectedPrNumber || prNumber !== expectedPrNumber) {
      throw new Error(`Cannot merge PR ${prNumber}. It does not match the PR opened for this run.`)
    }

    await this.git.mergePr(prNumber)
  }
}
