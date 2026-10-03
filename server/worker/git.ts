import { spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * Allowlisted git. The model never reaches this class directly: the graph
 * calls the gateway in server/agent/tools.ts, which calls a GitProvider built
 * on top of this. Rules: docs/backend-architecture.md#git-graph-worker.
 *
 * The push refspec is computed here from the run id. Nothing the model
 * produces can change which ref is written.
 */
export type ExecResult = { code: number; stdout: string; stderr: string }

export type ExecGit = (
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; input?: string },
) => Promise<ExecResult>

const ALLOWED_SUBCOMMANDS = new Set([
  'init',
  'remote',
  'config',
  'fetch',
  'checkout',
  'switch',
  'status',
  'diff',
  'log',
  'show',
  'rev-parse',
  'add',
  'apply',
  'commit',
  'push',
  'reset',
  'clean',
])

/** Flags that turn an allowed subcommand into a denied operation. */
const DENIED_FLAGS = new Set([
  '--force',
  '--force-with-lease',
  '--force-if-includes',
  '--mirror',
  '--delete',
  '--prune',
  '--all',
  '--tags',
  '--exec',
  '--upload-pack',
  '--receive-pack',
])

const MAX_OUTPUT_CHARS = 256 * 1024
const DEFAULT_TIMEOUT_MS = 120_000
/** A source file larger than this is cut; the prompt only shows a window of it. */
const MAX_READ_BYTES = 256 * 1024

// Full object ids only. Anything else could be read as an option by
// `fetch` / `checkout`, and a short id cannot be fetched by want.
const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i

function assertCommitSha(sha: string): void {
  if (!COMMIT_SHA.test(sha)) {
    throw new GitDeniedError('Expected a full commit SHA.')
  }
}

export class GitDeniedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GitDeniedError'
  }
}

export class GitCommandError extends Error {
  readonly code: number

  constructor(message: string, code: number) {
    super(message)
    this.name = 'GitCommandError'
    this.code = code
  }
}

export function assertAllowed(args: readonly string[]): void {
  const subcommand = args[0]
  if (!subcommand || !ALLOWED_SUBCOMMANDS.has(subcommand)) {
    throw new GitDeniedError(`git ${subcommand ?? '(none)'} is not on the allowlist.`)
  }

  for (const arg of args) {
    // `push -f` and `clean -f` differ: force-push is denied, cleaning the run's
    // own worktree is not, so short flags are judged per subcommand below.
    if (DENIED_FLAGS.has(arg)) {
      throw new GitDeniedError(`git ${subcommand} ${arg} is denied.`)
    }
    if (arg.startsWith('--upload-pack=') || arg.startsWith('--receive-pack=')) {
      throw new GitDeniedError(`git ${subcommand} ${arg} is denied.`)
    }
  }

  if (subcommand === 'push') {
    assertPushRefspecs(args)
  }
}

/**
 * `push` carries its destructive spellings in the refspec, not only in flags:
 * a leading `+` on any refspec forces, and an empty source (`:refs/heads/x`)
 * deletes the remote ref. Both are judged here rather than by matching the one
 * spelling the agent happens to emit.
 */
function assertPushRefspecs(args: readonly string[]): void {
  for (const arg of args.slice(1)) {
    // Short forms of --force / --delete. They mean other things elsewhere
    // (`clean -fd` is allowed), so they are only denied for push.
    if (arg === '-f') {
      throw new GitDeniedError('Force pushing is denied.')
    }
    if (arg === '-d') {
      throw new GitDeniedError('Deleting a remote ref is denied.')
    }
    if (arg.startsWith('-')) continue
    if (arg.startsWith('+')) {
      throw new GitDeniedError('Force pushing is denied.')
    }
    if (arg.startsWith(':')) {
      throw new GitDeniedError('Deleting a remote ref is denied.')
    }
  }
}

function truncate(text: string): string {
  return text.length > MAX_OUTPUT_CHARS ? text.slice(-MAX_OUTPUT_CHARS) : text
}

export const execGit: ExecGit = (args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn('git', [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), DEFAULT_TIMEOUT_MS)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout = truncate(stdout + chunk)
    })
    child.stderr.on('data', (chunk: string) => {
      stderr = truncate(stderr + chunk)
    })
    child.on('error', (error: Error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })

    if (options.input !== undefined) {
      child.stdin.end(options.input)
    } else {
      child.stdin.end()
    }
  })

export interface GitWorkspaceOptions {
  readonly runId: string
  readonly dir: string
  readonly owner: string
  readonly name: string
  /** Minted per call. Never written to `.git/config` or to any file. */
  readonly token: () => Promise<string>
  readonly exec?: ExecGit
  readonly hostname?: string
}

/**
 * One detached worktree per run. Credentials reach git through a one-shot
 * `GIT_ASKPASS` helper and an environment variable on that one child process,
 * so no token is ever written to the repository or left on disk with it.
 */
export class GitWorkspace {
  private readonly options: GitWorkspaceOptions
  private readonly exec: ExecGit
  private askpassPath: string | null = null
  private baseSha: string | null = null

  constructor(options: GitWorkspaceOptions) {
    this.options = options
    this.exec = options.exec ?? execGit
  }

  get dir(): string {
    return this.options.dir
  }

  get agentBranch(): string {
    return `adamant/${this.options.runId}`
  }

  get remoteUrl(): string {
    const host = this.options.hostname ?? 'github.com'
    return `https://x-access-token@${host}/${this.options.owner}/${this.options.name}.git`
  }

  async init(): Promise<void> {
    // A worker that died mid-run leaves this run's worktree behind, and the
    // retry would then fail on `remote add`. The path is this run's own.
    await fs.rm(this.options.dir, { recursive: true, force: true })
    await fs.mkdir(this.options.dir, { recursive: true })
    await this.run(['init', '--quiet'])
    await this.run(['config', 'user.name', 'adamant[bot]'])
    await this.run(['config', 'user.email', 'adamant[bot]@users.noreply.github.com'])
    await this.run(['config', 'commit.gpgsign', 'false'])
    await this.run(['remote', 'add', 'origin', this.remoteUrl])
  }

  /** Shallow fetch of one commit. A full clone per run is the slow path. */
  async fetchSha(sha: string): Promise<void> {
    assertCommitSha(sha)
    await this.run(['fetch', '--depth', '1', '--quiet', 'origin', sha], { authenticated: true })
  }

  async checkout(sha: string): Promise<void> {
    assertCommitSha(sha)
    await this.run(['checkout', '--quiet', '--detach', sha])
    this.baseSha = sha
  }

  /**
   * Reset to the base commit, then apply. Resetting first is what keeps a
   * second candidate independent of the first.
   */
  async applyPatch(patch: string): Promise<void> {
    if (!this.baseSha) {
      throw new Error('Checkout the base commit before applying a patch.')
    }
    await this.run(['reset', '--hard', '--quiet', this.baseSha])
    await this.run(['clean', '-fd', '--quiet'])
    // git rejects a last hunk without its newline as a corrupt patch, and
    // `--recount` ignores hunk-header line counts, which models often get wrong.
    const input = patch.endsWith('\n') ? patch : `${patch}\n`
    await this.run(['apply', '--index', '--recount', '--whitespace=nowarn', '-'], { input })
  }

  /**
   * Commits exactly the candidate, which `apply --index` staged. Staging the
   * whole tree would also commit whatever install and tests wrote that the repo
   * does not ignore (coverage, reports, build output) into the merged PR.
   */
  async commitCandidate(message: string): Promise<void> {
    await this.run(['commit', '--quiet', '--message', message])
  }

  /**
   * Reads a file from the checkout for the prompt. `fromLog` is a path as a CI
   * log prints it, often absolute on the runner, so the longest suffix that
   * names a file here wins. Nothing outside the worktree or under `.git` is
   * readable, symlinks included. Null when no suffix matches.
   */
  async readFile(fromLog: string): Promise<{ path: string; text: string } | null> {
    const segments = fromLog
      .replace(/\\/g, '/')
      .split('/')
      .filter((segment) => segment !== '' && segment !== '.')
    if (segments.includes('..')) return null

    const root = await fs.realpath(this.options.dir)
    for (let start = 0; start < segments.length; start += 1) {
      const relative = segments.slice(start).join('/')
      if (relative === '.git' || relative.startsWith('.git/')) continue

      const resolved = await fs.realpath(path.join(root, relative)).catch(() => null)
      if (!resolved || !resolved.startsWith(`${root}${path.sep}`)) continue
      if (path.relative(root, resolved).split(path.sep)[0] === '.git') continue

      const stats = await fs.stat(resolved)
      if (!stats.isFile()) continue

      const handle = await fs.open(resolved, 'r')
      try {
        const buffer = Buffer.alloc(Math.min(stats.size, MAX_READ_BYTES))
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
        return { path: relative, text: buffer.subarray(0, bytesRead).toString('utf8') }
      } finally {
        await handle.close()
      }
    }

    return null
  }

  /** Always `HEAD:refs/heads/adamant/{run_id}`, never a ref the model chose. */
  async push(branch: string): Promise<void> {
    if (branch !== this.agentBranch) {
      throw new GitDeniedError(
        `Unauthorized push to ${branch}. Allowed branch: ${this.agentBranch}`,
      )
    }
    await this.run(['push', '--quiet', 'origin', `HEAD:refs/heads/${this.agentBranch}`], {
      authenticated: true,
    })
  }

  async cleanup(): Promise<void> {
    if (this.askpassPath) {
      await fs.rm(path.dirname(this.askpassPath), { recursive: true, force: true })
      this.askpassPath = null
    }
    await fs.rm(this.options.dir, { recursive: true, force: true })
  }

  private async run(
    args: readonly string[],
    options?: { authenticated?: boolean; input?: string },
  ): Promise<ExecResult> {
    assertAllowed(args)

    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: this.options.dir,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_ADVICE: '0',
    }

    if (options?.authenticated) {
      env.GIT_ASKPASS = await this.ensureAskpass()
      env.ADAMANT_GIT_TOKEN = await this.options.token()
    }

    const result = await this.exec(args, {
      cwd: this.options.dir,
      env,
      ...(options?.input === undefined ? {} : { input: options.input }),
    })

    if (result.code !== 0) {
      // The token is only ever in env, never in argv, so neither can leak here.
      throw new GitCommandError(
        `git ${args[0]} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
        result.code,
      )
    }

    return result
  }

  private async ensureAskpass(): Promise<string> {
    if (this.askpassPath) return this.askpassPath

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adamant-askpass-'))
    const file = path.join(dir, 'askpass.sh')
    await fs.writeFile(file, '#!/bin/sh\nprintf %s "$ADAMANT_GIT_TOKEN"\n', { mode: 0o700 })
    this.askpassPath = file

    return file
  }
}
