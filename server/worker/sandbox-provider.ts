import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { type SandboxOutcome, type SandboxProvider } from '../agent/deps.ts'
import { DockerSandbox } from '../sandbox/index.ts'
import { type SandboxExecutionOptions, type SandboxResult } from '../sandbox/types.ts'

/**
 * Proves a candidate in a sealed container. The candidate is already in the
 * workspace (`applyPatch` put it there), so this only runs commands and turns
 * the exit code into a verdict.
 *
 * Install may reach the network; tests never do. That split is the only reason
 * `network` is configurable at all — see docs/backend-architecture.md#sandbox.
 */
export interface SandboxRunnerOptions {
  readonly runId: string
  readonly workspacePath: string
  readonly workdir?: string
  /** Run once before the test command, with the network on. Skipped when empty. */
  readonly installCommand?: string
  readonly testCommand: string
  readonly image?: string
  readonly timeoutMs?: number
  readonly installTimeoutMs?: number
  readonly sandbox?: Pick<DockerSandbox, 'run'>
}

const MAX_OUTPUT_CHARS = 16_000
const DEFAULT_INSTALL_TIMEOUT_MS = 300_000
const DEFAULT_TEST_TIMEOUT_MS = 600_000

/** Files whose contents decide what an install produces. */
const DEPENDENCY_MANIFESTS = [
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'bun.lockb',
  'requirements.txt',
  'pyproject.toml',
  'poetry.lock',
  'Pipfile.lock',
  'go.sum',
  'Cargo.lock',
  'Gemfile.lock',
]

/** What a previous successful install in this run left behind. */
interface InstallRecord {
  readonly fingerprint: string
  /** Top-level entries the install created, e.g. node_modules. */
  readonly outputs: readonly string[]
}

function workdirPath(workspacePath: string, workdir: string | undefined): string {
  if (!workdir?.trim()) return workspacePath
  const resolved = path.resolve(workspacePath, workdir.trim().replace(/^[/\\]+/, ''))
  return resolved.startsWith(`${workspacePath}${path.sep}`) ? resolved : workspacePath
}

async function fingerprint(dirs: readonly string[], extra: readonly string[]): Promise<string> {
  const hash = createHash('sha256')
  for (const part of extra) hash.update(`${part}\0`)
  for (const dir of new Set(dirs)) {
    for (const name of DEPENDENCY_MANIFESTS) {
      const content = await fs.readFile(path.join(dir, name)).catch(() => null)
      hash.update(`${dir}/${name}\0`)
      hash.update(content ?? '\0missing\0')
    }
  }
  return hash.digest('hex')
}

async function entries(dir: string): Promise<Set<string>> {
  return new Set(await fs.readdir(dir).catch(() => []))
}

async function allExist(paths: readonly string[]): Promise<boolean> {
  const checks = await Promise.all(
    paths.map((target) =>
      fs.access(target).then(
        () => true,
        () => false,
      ),
    ),
  )
  return checks.every(Boolean)
}

function tail(text: string): string {
  return text.length > MAX_OUTPUT_CHARS ? text.slice(-MAX_OUTPUT_CHARS) : text
}

function combine(result: SandboxResult): string {
  return tail([result.stdout, result.stderr].filter((part) => part.trim().length > 0).join('\n'))
}

/** Infra problems are not a verdict on the patch; they are reported as `error`. */
function verdictFor(result: SandboxResult): SandboxOutcome['verdict'] {
  if (result.reason === 'TIMEOUT') return 'timeout'
  if (result.reason === 'INFRA_FAILURE' || result.reason === 'INVALID_WORKSPACE') return 'error'
  return result.success ? 'pass' : 'fail'
}

export function createDockerSandboxProvider(options: SandboxRunnerOptions): SandboxProvider {
  const docker = options.sandbox ?? new DockerSandbox()
  const commands = [options.installCommand, options.testCommand].filter(
    (command): command is string => Boolean(command && command.trim()),
  )

  const execute = (command: string, extra: Partial<SandboxExecutionOptions>) =>
    docker.run({
      runId: options.runId,
      workspacePath: options.workspacePath,
      ...(options.workdir ? { workdir: options.workdir } : {}),
      command,
      ...(options.image === undefined ? {} : { image: options.image }),
      ...extra,
    })

  const installDir = workdirPath(options.workspacePath, options.workdir)
  let installed: InstallRecord | null = null

  /**
   * A retry re-ran the full install (often a minute) for a candidate that did
   * not touch a dependency. It is reused only when every manifest is
   * byte-identical and what the last install created is still on disk:
   * `git clean` removes it between candidates unless the repo ignores it.
   */
  async function canReuseInstall(print: string): Promise<boolean> {
    if (!installed || installed.fingerprint !== print || installed.outputs.length === 0) {
      return false
    }
    return allExist(installed.outputs)
  }

  return {
    async runValidation() {
      if (options.installCommand?.trim()) {
        const print = await fingerprint(
          [options.workspacePath, installDir],
          [options.installCommand, options.image ?? ''],
        )
        if (await canReuseInstall(print)) {
          return runTests()
        }

        const before = await entries(installDir)
        const install = await execute(options.installCommand, {
          network: 'bridge',
          timeoutMs: options.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS,
        })

        if (!install.success) {
          installed = null
          return {
            verdict: verdictFor(install) === 'pass' ? 'error' : verdictFor(install),
            commands,
            output: combine(install),
            ...(install.exitCode === null ? {} : { exitCode: install.exitCode }),
          }
        }

        const after = await entries(installDir)
        installed = {
          fingerprint: print,
          outputs: [...after]
            .filter((name) => !before.has(name))
            .map((name) => path.join(installDir, name)),
        }
      }

      return runTests()
    },
  }

  async function runTests(): Promise<SandboxOutcome> {
    const tests = await execute(options.testCommand, {
      network: 'none',
      timeoutMs: options.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS,
    })

    return {
      verdict: verdictFor(tests),
      commands,
      output: combine(tests),
      ...(tests.exitCode === null ? {} : { exitCode: tests.exitCode }),
    }
  }
}
