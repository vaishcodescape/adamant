import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createDockerSandboxProvider } from '../../server/worker/sandbox-provider.ts'
import type { SandboxExecutionOptions, SandboxResult } from '../../server/sandbox/types.ts'

const ok: SandboxResult = {
  success: true,
  exitCode: 0,
  stdout: 'ok 1\nok 2',
  stderr: '',
  timedOut: false,
  durationMs: 10,
  reason: 'COMPLETED',
}

function fakeDocker(results: readonly SandboxResult[]) {
  const seen: SandboxExecutionOptions[] = []
  let index = 0
  const sandbox = {
    run: async (options: SandboxExecutionOptions) => {
      seen.push(options)
      return results[Math.min(index++, results.length - 1)] ?? ok
    },
  }
  return { seen, sandbox }
}

const provider = (
  results: readonly SandboxResult[],
  overrides: { installCommand?: string } = {},
) => {
  const { seen, sandbox } = fakeDocker(results)
  return {
    seen,
    provider: createDockerSandboxProvider({
      runId: 'run-1',
      workspacePath: '/tmp/adamant/run-1',
      installCommand: 'npm ci',
      testCommand: 'npm test',
      sandbox,
      ...overrides,
    }),
  }
}

describe('sandbox provider', () => {
  it('installs with a network and runs the tests with none', async () => {
    const { seen, provider: sandbox } = provider([ok, ok])

    const outcome = await sandbox.runValidation({ attemptNumber: 1, candidateHash: 'hash' })

    assert.equal(outcome.verdict, 'pass')
    assert.deepEqual(
      seen.map((call) => [call.command, call.network]),
      [
        ['npm ci', 'bridge'],
        ['npm test', 'none'],
      ],
    )
    assert.deepEqual(outcome.commands, ['npm ci', 'npm test'])
  })

  it('skips the install step when none is configured', async () => {
    const { seen, provider: sandbox } = provider([ok], { installCommand: '' })

    const outcome = await sandbox.runValidation({ attemptNumber: 1, candidateHash: 'hash' })

    assert.deepEqual(
      seen.map((call) => call.command),
      ['npm test'],
    )
    assert.deepEqual(outcome.commands, ['npm test'])
  })

  it('reports a non-zero test exit as a fail with its output', async () => {
    const { provider: sandbox } = provider([
      ok,
      { ...ok, success: false, exitCode: 1, stdout: 'not ok 1 - sum', stderr: 'failed' },
    ])

    const outcome = await sandbox.runValidation({ attemptNumber: 1, candidateHash: 'hash' })

    assert.equal(outcome.verdict, 'fail')
    assert.equal(outcome.exitCode, 1)
    assert.match(outcome.output, /not ok 1 - sum/)
    assert.match(outcome.output, /failed/)
  })

  it('reports a timeout as its own verdict, not as a pass', async () => {
    const { provider: sandbox } = provider([
      ok,
      { ...ok, success: false, exitCode: null, timedOut: true, reason: 'TIMEOUT' },
    ])

    const outcome = await sandbox.runValidation({ attemptNumber: 1, candidateHash: 'hash' })

    assert.equal(outcome.verdict, 'timeout')
    assert.equal(outcome.exitCode, undefined)
  })

  it('separates an infra failure from a test failure', async () => {
    const { provider: sandbox } = provider([
      ok,
      { ...ok, success: false, exitCode: null, reason: 'INFRA_FAILURE', error: 'no docker' },
    ])

    const outcome = await sandbox.runValidation({ attemptNumber: 1, candidateHash: 'hash' })

    assert.equal(outcome.verdict, 'error')
  })

  it('does not run the tests when install fails', async () => {
    const { seen, provider: sandbox } = provider([
      { ...ok, success: false, exitCode: 1, stderr: 'ERR lockfile' },
    ])

    const outcome = await sandbox.runValidation({ attemptNumber: 1, candidateHash: 'hash' })

    assert.equal(seen.length, 1)
    assert.equal(outcome.verdict, 'fail')
    assert.match(outcome.output, /ERR lockfile/)
  })

  it('bounds the output it hands back to the model', async () => {
    const { provider: sandbox } = provider([ok, { ...ok, stdout: 'x'.repeat(100_000) }])

    const outcome = await sandbox.runValidation({ attemptNumber: 1, candidateHash: 'hash' })

    assert.ok(outcome.output.length <= 16_000)
  })
})
