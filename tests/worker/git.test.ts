import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import {
  assertAllowed,
  execGit,
  GitWorkspace,
  type ExecGit,
  type ExecResult,
} from '../../server/worker/git.ts'

const SHA = 'deadbeef'.repeat(5)
const BASE_SHA = 'ba5e'.repeat(10)

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
    // A leading `+` forces whatever the source side is, not only a full refname.
    assert.throws(
      () => assertAllowed(['push', 'origin', '+HEAD:refs/heads/adamant/run-1']),
      /Force pushing is denied/,
    )
    assert.throws(() => assertAllowed(['push', 'origin', '+main']), /Force pushing is denied/)
  })

  it('denies deleting a remote ref and running a remote command', () => {
    assert.throws(() => assertAllowed(['push', '--delete', 'origin', 'main']), /denied/)
    assert.throws(() => assertAllowed(['fetch', '--upload-pack=sh', 'origin']), /denied/)
    // An empty source side deletes the destination ref.
    assert.throws(
      () => assertAllowed(['push', 'origin', ':refs/heads/main']),
      /Deleting a remote ref is denied/,
    )
    assert.throws(
      () => assertAllowed(['push', '-d', 'origin', 'main']),
      /Deleting a remote ref is denied/,
    )
  })

  it('still allows the run worktree to clean itself with short flags', () => {
    assert.doesNotThrow(() => assertAllowed(['clean', '-fd', '--quiet']))
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
    await ws.fetchSha(SHA)

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
    await ws.fetchSha(SHA)

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
    await ws.fetchSha(SHA)
    const helper = String(calls.find((call) => call.args[0] === 'fetch')?.env.GIT_ASKPASS)

    await ws.cleanup()

    await assert.rejects(fs.access(helper))
    await assert.rejects(fs.access(ws.dir))
  })

  it('resets to the base commit before applying a candidate', async () => {
    const { calls, exec } = recordingExec()
    const ws = await workspace(exec)

    await ws.checkout(BASE_SHA)
    await ws.applyPatch('diff --git a/x b/x')

    assert.deepEqual(
      calls.map((call) => call.args[0]),
      ['checkout', 'reset', 'clean', 'apply'],
    )
    assert.deepEqual(calls[1]?.args, ['reset', '--hard', '--quiet', BASE_SHA])
    assert.deepEqual(calls.at(-1)?.args, [
      'apply',
      '--index',
      '--recount',
      '--whitespace=nowarn',
      '-',
    ])
    assert.equal(calls.at(-1)?.input, 'diff --git a/x b/x\n')
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

    await ws.checkout(BASE_SHA)
    await assert.rejects(ws.applyPatch('diff'), /patch does not apply/)
  })

  it('refuses a commit id that git could read as an option', async () => {
    const { calls, exec } = recordingExec()
    const ws = await workspace(exec)

    for (const sha of ['--upload-pack=touch /tmp/x', '-uevil', 'abc123', 'HEAD', `${SHA}x`]) {
      await assert.rejects(ws.fetchSha(sha), /full commit SHA/)
      await assert.rejects(ws.checkout(sha), /full commit SHA/)
    }
    assert.equal(calls.length, 0)
  })

  it('starts from an empty worktree when a crashed run left one behind', async () => {
    const { calls, exec } = recordingExec()
    const ws = await workspace(exec)
    await fs.writeFile(path.join(ws.dir, 'stale.txt'), 'from the dead worker')

    await ws.init()

    await assert.rejects(fs.access(path.join(ws.dir, 'stale.txt')))
    assert.equal(calls[0]?.args[0], 'init')
  })
})

/**
 * The same class driving the real git binary. The fakes above pin the argv;
 * these pin what git actually does with it.
 */
describe('GitWorkspace against real git', () => {
  afterEach(async () => {
    await Promise.all(
      workspaces.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    )
  })

  async function repoWithBase() {
    const dir = await tempDir()
    const ws = new GitWorkspace({
      runId: 'run-real',
      dir,
      owner: 'acme',
      name: 'eval',
      token: async () => 'unused',
    })
    await ws.init()
    await fs.mkdir(path.join(dir, 'src'))
    await fs.writeFile(
      path.join(dir, 'src/sum.ts'),
      'export function sum(a, b) {\n  return a - b\n}\n',
    )
    await fs.writeFile(path.join(dir, '.gitignore'), 'node_modules\n')
    const env = { PATH: process.env.PATH ?? '', HOME: dir, GIT_CONFIG_GLOBAL: '/dev/null' }
    for (const args of [
      ['add', '--all'],
      ['commit', '--quiet', '-m', 'base'],
      ['rev-parse', 'HEAD'],
    ]) {
      const result = await execGit(args, { cwd: dir, env })
      assert.equal(result.code, 0, result.stderr)
      if (args[0] === 'rev-parse') await ws.checkout(result.stdout.trim())
    }
    return { dir, ws, env }
  }

  const fix = [
    'diff --git a/src/sum.ts b/src/sum.ts',
    '--- a/src/sum.ts',
    '+++ b/src/sum.ts',
    '@@ -1,3 +1,3 @@',
    ' export function sum(a, b) {',
    '-  return a - b',
    '+  return a + b',
    ' }',
  ].join('\n')

  it('applies a diff whose final newline was trimmed away', async () => {
    const { dir, ws } = await repoWithBase()

    await ws.applyPatch(fix)

    assert.match(await fs.readFile(path.join(dir, 'src/sum.ts'), 'utf8'), /return a \+ b/)
  })

  it('applies a diff whose hunk header miscounts its lines', async () => {
    const { dir, ws } = await repoWithBase()

    await ws.applyPatch(fix.replace('@@ -1,3 +1,3 @@', '@@ -1,7 +1,9 @@'))

    assert.match(await fs.readFile(path.join(dir, 'src/sum.ts'), 'utf8'), /return a \+ b/)
  })

  it('commits the candidate and nothing the sandbox wrote', async () => {
    const { dir, ws, env } = await repoWithBase()
    await ws.applyPatch(fix)
    await fs.writeFile(path.join(dir, 'coverage.json'), '{}')
    await fs.mkdir(path.join(dir, 'node_modules'))
    await fs.writeFile(path.join(dir, 'node_modules/dep.js'), '')

    await ws.commitCandidate('fix: sum')

    const files = await execGit(['show', '--name-only', '--format=', 'HEAD'], { cwd: dir, env })
    assert.deepEqual(files.stdout.trim().split('\n'), ['src/sum.ts'])
  })

  it('reads a file by the absolute path a CI runner printed', async () => {
    const { ws } = await repoWithBase()

    const found = await ws.readFile('/home/runner/work/eval/eval/src/sum.ts')

    assert.equal(found?.path, 'src/sum.ts')
    assert.match(found?.text ?? '', /return a - b/)
  })

  it('reads nothing outside the worktree or inside .git', async () => {
    const { dir, ws } = await repoWithBase()
    const outside = await tempDir()
    await fs.writeFile(path.join(outside, 'secret.txt'), 'nope')
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(dir, 'link.txt'))

    assert.equal(await ws.readFile('../secret.txt'), null)
    assert.equal(await ws.readFile(path.join(outside, 'secret.txt')), null)
    assert.equal(await ws.readFile('link.txt'), null)
    assert.equal(await ws.readFile('.git/config'), null)
    assert.equal(await ws.readFile('src'), null)
  })
})
