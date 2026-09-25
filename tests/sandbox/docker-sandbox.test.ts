import { describe, it } from 'node:test'
import * as assert from 'node:assert'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { DockerSandbox } from '../../server/sandbox/docker-sandbox.ts'
import type { SpawnFunction } from '../../server/sandbox/types.ts'

interface MockStream extends EventEmitter {
  setEncoding: (encoding: string) => MockStream
}

interface MockProcess extends EventEmitter {
  stdout: MockStream
  stderr: MockStream
  kill: () => boolean
}

function createMockStream(): MockStream {
  const stream = new EventEmitter() as MockStream
  stream.setEncoding = () => stream
  return stream
}

function createMockProcess(): MockProcess {
  const proc = new EventEmitter() as MockProcess
  proc.stdout = createMockStream()
  proc.stderr = createMockStream()
  proc.kill = () => true
  return proc
}

function closeSoon(proc: MockProcess, code: number | null = 0) {
  process.nextTick(() => proc.emit('close', code))
  return proc as unknown as ChildProcess
}

describe('DockerSandbox', () => {
  it('rejects non-absolute workspacePath before shelling out', async () => {
    const sandbox = new DockerSandbox()
    const result = await sandbox.run({
      workspacePath: 'relative/path/dir',
      command: 'echo test',
    })

    assert.strictEqual(result.success, false)
    assert.strictEqual(result.exitCode, null)
    assert.strictEqual(result.reason, 'INVALID_WORKSPACE')
    assert.match(result.stderr, /Path must be absolute/)
  })

  it('rejects an absolute workspace that does not exist', async () => {
    const sandbox = new DockerSandbox()
    const result = await sandbox.run({
      workspacePath: path.join(os.tmpdir(), `adamant-missing-${Date.now()}`),
      command: 'true',
    })

    assert.strictEqual(result.success, false)
    assert.strictEqual(result.reason, 'INVALID_WORKSPACE')
    assert.match(result.stderr, /does not exist/)
  })

  it('constructs hardened security arguments correctly', async () => {
    let capturedCmd = ''
    let capturedArgs: string[] = []

    const mockSpawn: SpawnFunction = (cmd, args) => {
      capturedCmd = cmd
      capturedArgs = args
      return closeSoon(createMockProcess())
    }

    const sandbox = new DockerSandbox({ spawnFn: mockSpawn })
    const absPath = process.cwd()

    const result = await sandbox.run({
      workspacePath: absPath,
      command: 'pnpm test',
      runId: 'eval-42',
      memoryLimit: '512m',
      cpuLimit: '0.5',
      pidsLimit: '50',
      user: '1000:1000',
    })

    assert.strictEqual(result.success, true)
    assert.strictEqual(capturedCmd, 'docker')
    assert.ok(capturedArgs.includes('--cap-drop'))
    assert.ok(capturedArgs.includes('ALL'))
    assert.ok(capturedArgs.includes('--security-opt'))
    assert.ok(capturedArgs.includes('no-new-privileges'))
    assert.ok(capturedArgs.includes('--network'))
    assert.ok(capturedArgs.includes('none'))
    assert.ok(capturedArgs.includes('--pids-limit'))
    assert.ok(capturedArgs.includes('50'))
    assert.ok(capturedArgs.includes('--user'))
    assert.ok(capturedArgs.includes('1000:1000'))
    assert.ok(capturedArgs.some((arg) => arg.startsWith('type=bind,src=')))
    assert.ok(capturedArgs.includes('node:22-bookworm-slim'))
    assert.deepEqual(capturedArgs.slice(-3), ['sh', '-c', 'pnpm test'])
  })

  it('handles infra failure distinctly from test failure', async () => {
    const mockSpawn: SpawnFunction = () => {
      const proc = createMockProcess()
      process.nextTick(() => proc.emit('error', new Error('ENOENT: docker not found')))
      return proc as unknown as ChildProcess
    }

    const sandbox = new DockerSandbox({ spawnFn: mockSpawn })
    const result = await sandbox.run({
      workspacePath: process.cwd(),
      command: 'test',
    })

    assert.strictEqual(result.success, false)
    assert.strictEqual(result.exitCode, null)
    assert.strictEqual(result.reason, 'INFRA_FAILURE')
  })

  it('reports a non-zero exit as a completed test failure', async () => {
    const mockSpawn: SpawnFunction = () => closeSoon(createMockProcess(), 2)
    const sandbox = new DockerSandbox({ spawnFn: mockSpawn })
    const result = await sandbox.run({
      workspacePath: process.cwd(),
      command: 'pnpm test',
    })

    assert.strictEqual(result.success, false)
    assert.strictEqual(result.exitCode, 2)
    assert.strictEqual(result.reason, 'COMPLETED')
    assert.strictEqual(result.timedOut, false)
  })

  it('drops environment variables whose names look like secrets', async () => {
    let envFile = ''
    const mockSpawn: SpawnFunction = (_cmd, args) => {
      const flag = args.indexOf('--env-file')
      const file = flag === -1 ? undefined : args[flag + 1]
      if (file) envFile = fs.readFileSync(file, 'utf8')
      return closeSoon(createMockProcess())
    }

    const sandbox = new DockerSandbox({ spawnFn: mockSpawn })
    const result = await sandbox.run({
      workspacePath: process.cwd(),
      command: 'true',
      env: { CI: '1', GITHUB_TOKEN: 'shh', API_KEY: 'k' },
    })

    assert.strictEqual(result.success, true)
    assert.match(envFile, /^CI=1$/m)
    assert.doesNotMatch(envFile, /GITHUB_TOKEN/)
    assert.doesNotMatch(envFile, /API_KEY/)
    assert.doesNotMatch(envFile, /shh/)
  })

  it('kills the container when the command exceeds the timeout', async () => {
    const calls: string[][] = []
    const mockSpawn: SpawnFunction = (_cmd, args) => {
      calls.push(args)
      const proc = createMockProcess()
      if (args[0] === 'rm') closeSoon(proc)
      return proc as unknown as ChildProcess
    }

    const sandbox = new DockerSandbox({ spawnFn: mockSpawn })
    const result = await sandbox.run({
      workspacePath: process.cwd(),
      command: 'sleep 100',
      timeoutMs: 20,
    })

    assert.strictEqual(result.success, false)
    assert.strictEqual(result.timedOut, true)
    assert.strictEqual(result.reason, 'TIMEOUT')
    assert.ok(calls.some((args) => args[0] === 'rm' && args.includes('-f')))
  })

  it('keeps only the tail of oversized command output', async () => {
    const mockSpawn: SpawnFunction = () => {
      const proc = createMockProcess()
      process.nextTick(() => {
        proc.stdout.emit('data', 'x'.repeat(600 * 1024))
        proc.emit('close', 0)
      })
      return proc as unknown as ChildProcess
    }

    const sandbox = new DockerSandbox({ spawnFn: mockSpawn })
    const result = await sandbox.run({
      workspacePath: process.cwd(),
      command: 'true',
    })

    assert.strictEqual(result.success, true)
    assert.ok(result.stdout.length <= 512 * 1024)
    assert.ok(result.stdout.length > 0)
  })
})
