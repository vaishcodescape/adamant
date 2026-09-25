import { type GitProvider, type PullRequestRef } from '../agent/deps.ts'
import { type GitHubClient } from './github.ts'
import { type GitWorkspace } from './git.ts'

/**
 * The concrete GitProvider: a per-run worktree for the code, the GitHub App
 * for pull requests and logs. Scope comes from the run record passed in here,
 * never from anything the model produced.
 */
export interface GitProviderContext {
  readonly runId: string
  readonly owner: string
  readonly name: string
  readonly installationId: string
  readonly baseSha: string
}

export function createGitHubGitProvider(
  context: GitProviderContext,
  workspace: GitWorkspace,
  github: GitHubClient,
): GitProvider {
  const repo = {
    installationId: context.installationId,
    owner: context.owner,
    name: context.name,
  }

  return {
    async fetch() {
      await workspace.init()
      await workspace.fetchSha(context.baseSha)
    },

    async checkout(sha) {
      await workspace.checkout(sha)
    },

    async applyPatch(patch) {
      await workspace.applyPatch(patch)
    },

    async commit(message) {
      await workspace.commitAll(message)
    },

    async push(branch) {
      await workspace.push(branch)
    },

    async openPr(branch, base, title, body): Promise<PullRequestRef> {
      return github.createPullRequest({ ...repo, head: branch, base, title, body })
    },

    async mergePr(prNumber) {
      await github.mergePullRequest({
        ...repo,
        prNumber,
        commitTitle: `Adamant run ${context.runId} (#${prNumber})`,
      })
    },

    async getFailureLogs() {
      return github.failedJobLogs({ ...repo, headSha: context.baseSha })
    },
  }
}
