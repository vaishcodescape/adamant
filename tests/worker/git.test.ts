import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import {
  assertAllowed,
  GitWorkspace,
  type ExecGit,
  type ExecResult,
} from '../../server/worker/git.ts'

const workspaces: string[] = []

async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adamant-git-test-'))
  workspaces.push(dir)
  return dir
}

type Call = { args: readonly string[]; env: NodeJS.ProcessEnv; input?: string }

function recordingExec(result: Partial<ExecResult> = {}) {
  const calls: Call[] = []
  const exec: ExecGit = async (args, options) => {
    calls.push({
      args,
      env: options.env,
      ...(options.input === undefined ? {} : { input: options.input }),
    })
    return { code: 0, stdout: '', stderr: '', ...result }
  }
  return { calls, exec }
}

async function workspace(exec: ExecGit, runId = 'run-1') {
  return new GitWorkspace({
    runId,
    dir: await tempDir(),
    owner: 'acme',
    name: 'eval',
    token: async () => 'ghs_installationtokenvalue',
    exec,
  })
}

describe('git allowlist', () => {
  afterEach(async () => {
    await Promise.all(
      workspaces.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    )
  })

  it('accepts the subcommands the heal path needs', () => {
    for (const args of [
      ['fetch', '--depth', '1', 'origin', 'abc'],
      ['checkout', '--detach', 'abc'],
      ['apply', '--index', '-'],
      ['commit', '--message', 'fix'],
      ['push', 'origin', 'HEAD:refs/heads/adamant/run-1'],
      ['clean', '-fd'],
    ]) {
      assert.doesNotThrow(() => assertAllowed(args))
    }
  })

  it('denies anything that is not on the list', () => {
    for (const args of [['rebase'], ['tag'], ['submodule', 'update'], ['filter-branch']]) {
      assert.throws(() => assertAllowed(args), /not on the allowlist/)
    }
  })

  it('denies force pushing in every spelling', () => {
    assert.throws(() => assertAllowed(['push', '--force', 'origin', 'main']), /denied/)
    assert.throws(() => assertAllowed(['push', '-f', 'origin', 'main']), /Force pushing is denied/)
    assert.throws(
      () => assertAllowed(['push', 'origin', '+refs/heads/main']),
      /Force pushing is denied/,
    )
    assert.throws(() => assertAllowed(['push', '--force-with-lease', 'origin', 'main']), /denied/)
  })

  it('denies deleting a remote ref and running a remote command', () => {
    assert.throws(() => assertAllowed(['push', '--delete', 'origin', 'main']), /denied/)
    assert.throws(() => assertAllowed(['fetch', '--upload-pack=sh', 'origin']), /denied/)
  })
})

describe('GitWorkspace', () => {
  afterEach(async () => {
    await Promise.all(
      workspaces.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    )
  })

  it('pushes only to refs/heads/adamant/{run_id}', async () => {
    const { calls, exec } = recordingExec()
    const ws = await workspace(exec, 'run-abc')

    await ws.push('adamant/run-abc')

    assert.deepEqual(calls.at(-1)?.args, [
      'push',
      '--quiet',
      'origin',
      'HEAD:refs/heads/adamant/run-abc',
    ])
  })

  it('refuses a push to any other branch', async () => {
    const { calls, exec } = recordingExec()
    const ws = await workspace(exec, 'run-abc')

    await assert.rejects(ws.push('main'), /Unauthorized push to main/)
    assert.equal(calls.length, 0)
  })

  it('keeps the installation token out of the remote URL and the argv', async () => {
    const { calls, exec } = recordingExec()
    const ws = await workspace(exec)

    await ws.init()
    await ws.fetchSha('deadbeef')

    assert.equal(ws.remoteUrl, 'https://x-access-token@github.com/acme/eval.git')
    for (const call of calls) {
      assert.equal(
        call.args.some((arg) => arg.includes('ghs_')),
        false,
      )
    }
  })

  it('passes the token to git through a one-shot askpass helper', async () => {
    const { calls, exec } = recordingExec()
    const ws = await workspace(exec)

    await ws.init()
    await ws.fetchSha('deadbeef')

    const unauthenticated = calls.find((call) => call.args[0] === 'init')
    const authenticated = calls.find((call) => call.args[0] === 'fetch')

    assert.equal(unauthenticated?.env.ADAMANT_GIT_TOKEN, undefined)
    assert.equal(unauthenticated?.env.GIT_ASKPASS, undefined)
    assert.equal(authenticated?.env.ADAMANT_GIT_TOKEN, 'ghs_installationtokenvalue')
    assert.match(String(authenticated?.env.GIT_ASKPASS), /askpass\.sh$/)
    assert.equal(authenticated?.env.GIT_TERMINAL_PROMPT, '0')

    const helper = await fs.readFile(String(authenticated?.env.GIT_ASKPASS), 'utf8')
    assert.equal(helper.includes('ghs_installationtokenvalue'), false)
  })

  it('removes the askpass helper and the worktree on cleanup', async () => {
    const { calls, exec } = recordingExec()
    const ws = await workspace(exec)

    await ws.init()
    await ws.fetchSha('deadbeef')
    const helper = String(calls.find((call) => call.args[0] === 'fetch')?.env.GIT_ASKPASS)

    await ws.cleanup()

    await assert.rejects(fs.access(helper))
    await assert.rejects(fs.access(ws.dir))
  })

  it('resets to the base commit before applying a candidate', async () => {
    const { calls, exec } = recordingExec()
    const ws = await workspace(exec)

    await ws.checkout('basesha')
    await ws.applyPatch('diff --git a/x b/x')

    assert.deepEqual(
      calls.map((call) => call.args[0]),
      ['checkout', 'reset', 'clean', 'apply'],
    )
    assert.deepEqual(calls[1]?.args, ['reset', '--hard', '--quiet', 'basesha'])
    assert.equal(calls.at(-1)?.input, 'diff --git a/x b/x')
  })

  it('refuses to apply a patch before a base commit is checked out', async () => {
    const { exec } = recordingExec()
    const ws = await workspace(exec)

    await assert.rejects(ws.applyPatch('diff'), /Checkout the base commit/)
  })

  it('surfaces a failing git command as an error', async () => {
    const exec: ExecGit = async (args) =>
      args[0] === 'apply'
        ? { code: 1, stdout: '', stderr: 'error: patch does not apply' }
        : { code: 0, stdout: '', stderr: '' }
    const ws = await workspace(exec)

    await ws.checkout('basesha')
    await assert.rejects(ws.applyPatch('diff'), /patch does not apply/)
  })
})
