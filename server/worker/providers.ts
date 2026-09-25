import * as os from 'node:os'
import * as path from 'node:path'
import { type GitProvider, type SandboxProvider } from '../agent/deps.ts'
import { type RunRecorder } from '../agent/recorder.ts'
import { createPostgresRecorder } from './recorder.ts'
import { createGitHubGitProvider } from './git-provider.ts'
import { createGitHubClient, readGitHubAppConfig, type GitHubClient } from './github.ts'
import { GitWorkspace } from './git.ts'
import { createDockerSandboxProvider } from './sandbox-provider.ts'
import { type HealRun } from './runs.ts'
import { type Db } from '../db/client.ts'

function unavailable(tool: string): never {
  throw new Error(`${tool} is unavailable: the GitHub App is not configured in this worker`)
}

/**
 * Fail closed when `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` are missing.
 * These methods do not talk to GitHub and do not read tokens, so a
 * misconfigured worker fails the run instead of quietly doing nothing.
 */
export function createUnavailableGitProvider(): GitProvider {
  return {
    fetch: async () => unavailable('git fetch'),
    checkout: async () => unavailable('git checkout'),
    applyPatch: async () => unavailable('git apply'),
    commit: async () => unavailable('git commit'),
    push: async () => unavailable('git push'),
    openPr: async () => unavailable('open_pull_request'),
    mergePr: async () => unavailable('merge_pull_request'),
    getFailureLogs: async () => unavailable('get_failure_logs'),
  }
}

export interface SandboxSettings {
  readonly image: string
  readonly installCommand: string
  readonly testCommand: string
}

export function readSandboxSettings(env = process.env): SandboxSettings {
  return {
    image: env.ADAMANT_SANDBOX_IMAGE ?? 'node:22-bookworm-slim',
    installCommand: env.ADAMANT_SANDBOX_INSTALL ?? 'npm ci --no-audit --no-fund',
    testCommand: env.ADAMANT_SANDBOX_TEST ?? 'npm test',
  }
}

export interface RunProviders {
  readonly git: GitProvider
  readonly sandbox: SandboxProvider
  readonly recorder: RunRecorder
  /** Removes the run's worktree and its askpass helper. Always call it. */
  readonly dispose: () => Promise<void>
}

export interface RunProviderOptions {
  readonly db: Db
  readonly run: HealRun
  readonly workspaceRoot?: string
  readonly github?: GitHubClient | null
  readonly sandboxSettings?: SandboxSettings
}

/**
 * Builds the tools for one run. Everything is scoped to that run: the
 * worktree path, the push refspec, the recorder's `run_id`, and the
 * installation the token is minted from.
 */
export function createRunProviders(options: RunProviderOptions): RunProviders {
  const { db, run } = options
  const recorder = createPostgresRecorder(db, {
    runId: run.runId,
    repositoryId: run.repositoryId,
  })

  const config = readGitHubAppConfig()
  const github = options.github ?? (config ? createGitHubClient(config) : null)

  if (!github) {
    return {
      git: createUnavailableGitProvider(),
      sandbox: { runValidation: async () => unavailable('sandbox') },
      recorder,
      dispose: async () => {},
    }
  }

  const workspacePath = path.join(
    options.workspaceRoot ?? path.join(os.tmpdir(), 'adamant-workspaces'),
    run.runId,
  )

  const workspace = new GitWorkspace({
    runId: run.runId,
    dir: workspacePath,
    owner: run.owner,
    name: run.name,
    token: () => github.installationToken(run.installationId),
  })

  const settings = options.sandboxSettings ?? readSandboxSettings()

  return {
    git: createGitHubGitProvider(
      {
        runId: run.runId,
        owner: run.owner,
        name: run.name,
        installationId: run.installationId,
        baseSha: run.baseSha,
      },
      workspace,
      github,
    ),
    sandbox: createDockerSandboxProvider({
      runId: run.runId,
      workspacePath,
      image: settings.image,
      installCommand: settings.installCommand,
      testCommand: settings.testCommand,
    }),
    recorder,
    dispose: () => workspace.cleanup(),
  }
}
