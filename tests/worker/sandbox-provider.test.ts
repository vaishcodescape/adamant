import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
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
  overrides: { installCommand?: string; workdir?: string } = {},
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

  it('passes workdir option through to docker sandbox run calls', async () => {
    const { seen, provider: sandbox } = provider([ok, ok], { workdir: 'packages/backend' })

    await sandbox.runValidation({ attemptNumber: 1, candidateHash: 'hash' })

    assert.equal(seen[0]?.workdir, 'packages/backend')
    assert.equal(seen[1]?.workdir, 'packages/backend')
  })
})

describe('sandbox install reuse across candidates', () => {
  async function workspace() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adamant-sandbox-test-'))
    await fs.writeFile(path.join(dir, 'package.json'), '{"name":"eval"}')
    await fs.writeFile(path.join(dir, 'package-lock.json'), '{"lockfileVersion":3}')
    return dir
  }

  /** An install that leaves node_modules in the workspace, as `npm ci` does. */
  function installingDocker(dir: string, installResult: SandboxResult = ok) {
    const commands: string[] = []
    const sandbox = {
      run: async (options: SandboxExecutionOptions) => {
        commands.push(options.command)
        if (options.command === 'npm ci' && installResult.success) {
          await fs.mkdir(path.join(dir, 'node_modules'), { recursive: true })
        }
        return options.command === 'npm ci' ? installResult : ok
      },
    }
    return { commands, sandbox }
  }

  function sandboxFor(dir: string, docker: ReturnType<typeof installingDocker>) {
    return createDockerSandboxProvider({
      runId: 'run-1',
      workspacePath: dir,
      installCommand: 'npm ci',
      testCommand: 'npm test',
      sandbox: docker.sandbox,
    })
  }

  it('skips the install for a candidate that left every manifest alone', async () => {
    const dir = await workspace()
    try {
      const docker = installingDocker(dir)
      const sandbox = sandboxFor(dir, docker)

      await sandbox.runValidation({ attemptNumber: 1, candidateHash: 'a' })
      const second = await sandbox.runValidation({ attemptNumber: 2, candidateHash: 'b' })

      assert.deepEqual(docker.commands, ['npm ci', 'npm test', 'npm test'])
      assert.equal(second.verdict, 'pass')
      assert.deepEqual(second.commands, ['npm ci', 'npm test'], 'what was verified is unchanged')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('reinstalls when a candidate changes a lockfile', async () => {
    const dir = await workspace()
    try {
      const docker = installingDocker(dir)
      const sandbox = sandboxFor(dir, docker)

      await sandbox.runValidation({ attemptNumber: 1, candidateHash: 'a' })
      await fs.writeFile(path.join(dir, 'package-lock.json'), '{"lockfileVersion":3,"x":1}')
      await sandbox.runValidation({ attemptNumber: 2, candidateHash: 'b' })

      assert.deepEqual(docker.commands, ['npm ci', 'npm test', 'npm ci', 'npm test'])
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('reinstalls when the reset between candidates removed what install wrote', async () => {
    const dir = await workspace()
    try {
      const docker = installingDocker(dir)
      const sandbox = sandboxFor(dir, docker)

      await sandbox.runValidation({ attemptNumber: 1, candidateHash: 'a' })
      await fs.rm(path.join(dir, 'node_modules'), { recursive: true })
      await sandbox.runValidation({ attemptNumber: 2, candidateHash: 'b' })

      assert.deepEqual(docker.commands, ['npm ci', 'npm test', 'npm ci', 'npm test'])
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('never reuses an install that failed', async () => {
    const dir = await workspace()
    try {
      const docker = installingDocker(dir, { ...ok, success: false, exitCode: 1 })
      const sandbox = sandboxFor(dir, docker)

      const first = await sandbox.runValidation({ attemptNumber: 1, candidateHash: 'a' })
      await sandbox.runValidation({ attemptNumber: 2, candidateHash: 'b' })

      assert.equal(first.verdict, 'fail')
      assert.deepEqual(docker.commands, ['npm ci', 'npm ci'])
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
