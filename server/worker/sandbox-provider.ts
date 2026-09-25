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
      command,
      ...(options.image === undefined ? {} : { image: options.image }),
      ...extra,
    })

  return {
    async runValidation() {
      if (options.installCommand?.trim()) {
        const install = await execute(options.installCommand, {
          network: 'bridge',
          timeoutMs: options.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS,
        })

        if (!install.success) {
          return {
            verdict: verdictFor(install) === 'pass' ? 'error' : verdictFor(install),
            commands,
            output: combine(install),
            ...(install.exitCode === null ? {} : { exitCode: install.exitCode }),
          }
        }
      }

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
    },
  }
}
