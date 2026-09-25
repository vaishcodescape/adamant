import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { compileHealGraph } from '../../server/agent/graph.ts'
import { type GitProvider, type SandboxOutcome } from '../../server/agent/deps.ts'
import { createMemoryRecorder, type MemoryRecorder } from '../../server/agent/recorder.ts'

/**
 * One red build healed without a human: diagnose, patch, prove it in the
 * sandbox, open the PR, merge it. The fake git provider below stands in for
 * GitHub, but every gate the real run passes through is the real one.
 */
const repository = {
  owner: 'acme',
  name: 'eval',
  installationId: '42',
  defaultBranch: 'main',
}

const failingLog = [
  'not ok 1 - sum adds two numbers',
  '  AssertionError: Expected 3 to equal 5',
  '      at src/sum.ts:4:11',
].join('\n')

type Journal = {
  calls: string[]
  branches: string[]
  merged: number[]
  prBase: string[]
  applied: string[]
}

function fakeGit(journal: Journal, overrides: Partial<GitProvider> = {}): GitProvider {
  return {
    fetch: async () => void journal.calls.push('fetch'),
    checkout: async () => void journal.calls.push('checkout'),
    applyPatch: async (patch) => {
      journal.calls.push('applyPatch')
      journal.applied.push(patch)
    },
    commit: async () => void journal.calls.push('commit'),
    push: async (branch) => {
      journal.calls.push('push')
      journal.branches.push(branch)
    },
    openPr: async (_branch, base) => {
      journal.calls.push('openPr')
      journal.prBase.push(base)
      return { number: 77, url: 'https://github.com/acme/eval/pull/77' }
    },
    mergePr: async (prNumber) => {
      journal.calls.push('mergePr')
      journal.merged.push(prNumber)
    },
    getFailureLogs: async () => failingLog,
    ...overrides,
  }
}

function journal(): Journal {
  return { calls: [], branches: [], merged: [], prBase: [], applied: [] }
}

function scriptedLlm(patches: readonly string[]) {
  let index = 0
  return {
    diagnose: async () => 'Assertion in src/sum.ts returns the wrong total.',
    plan: async () => 'Fix the addition in src/sum.ts.',
    patch: async () => patches[Math.min(index++, patches.length - 1)] ?? 'diff',
  }
}

function sandboxScript(outcomes: readonly SandboxOutcome[]) {
  let index = 0
  return {
    runValidation: async () =>
      outcomes[Math.min(index++, outcomes.length - 1)] ?? {
        verdict: 'fail' as const,
        commands: [],
        output: '',
      },
  }
}

const pass: SandboxOutcome = {
  verdict: 'pass',
  exitCode: 0,
  commands: ['npm ci', 'npm test'],
  output: '1..2\nok 1\nok 2',
}
const fail: SandboxOutcome = {
  verdict: 'fail',
  exitCode: 1,
  commands: ['npm ci', 'npm test'],
  output: 'not ok 1 - sum adds two numbers',
}

describe('autonomous heal loop', () => {
  it('heals a red build end to end with no human step', async () => {
    const log = journal()
    const recorder = createMemoryRecorder()
    const graph = compileHealGraph({
      git: fakeGit(log),
      sandbox: sandboxScript([pass]),
      llm: scriptedLlm(['--- a/src/sum.ts\n+++ b/src/sum.ts\n']),
      recorder,
    })

    const finalState = await graph.invoke({ runId: 'run-77', repository, baseSha: 'deadbeef' })

    assert.equal(finalState.status, 'completed')
    assert.deepEqual(log.calls, [
      'fetch',
      'checkout',
      'applyPatch',
      'commit',
      'push',
      'openPr',
      'mergePr',
    ])
    assert.deepEqual(log.branches, ['adamant/run-77'])
    assert.deepEqual(log.prBase, ['main'], 'a PR bases on a branch, never on the failing SHA')
    assert.deepEqual(log.merged, [77])
    assert.deepEqual(
      recorder.audits.map((row) => row.eventType),
      ['run.retrieved', 'run.merged'],
    )
  })

  it('retries after a failing candidate and only pushes once it passes', async () => {
    const log = journal()
    const recorder = createMemoryRecorder()
    const graph = compileHealGraph({
      git: fakeGit(log),
      sandbox: sandboxScript([fail, pass]),
      llm: scriptedLlm(['first candidate', 'second candidate']),
      recorder,
    })

    const finalState = await graph.invoke({ runId: 'run-78', repository, baseSha: 'abc' })

    assert.equal(finalState.status, 'completed')
    assert.equal(finalState.attemptNumber, 2)
    assert.equal(log.calls.filter((call) => call === 'push').length, 1)
    assert.deepEqual(log.applied, ['first candidate', 'second candidate'])
    assert.deepEqual(
      recorder.sandboxes.map((row) => row.verdict),
      ['fail', 'pass'],
    )
    assert.deepEqual(
      recorder.patches.map((row) => row.outcome),
      ['failed_validation', 'success'],
    )
  })

  it('treats a diff that will not apply as a spent attempt, not a crash', async () => {
    const log = journal()
    const recorder = createMemoryRecorder()
    let applies = 0
    const graph = compileHealGraph({
      git: fakeGit(log, {
        applyPatch: async (patch) => {
          applies += 1
          if (applies === 1) throw new Error('error: patch does not apply')
          log.applied.push(patch)
        },
      }),
      sandbox: sandboxScript([pass]),
      llm: scriptedLlm(['malformed diff', 'good diff']),
      recorder,
    })

    const finalState = await graph.invoke({ runId: 'run-79', repository, baseSha: 'abc' })

    assert.equal(finalState.status, 'completed')
    assert.equal(finalState.attemptNumber, 2)
    assert.deepEqual(
      recorder.patches.map((row) => row.outcome),
      ['generation_error', 'success'],
    )
    assert.deepEqual(log.applied, ['good diff'])
  })

  it('gives up without opening a PR when every candidate fails', async () => {
    const log = journal()
    const recorder = createMemoryRecorder()
    const graph = compileHealGraph({
      git: fakeGit(log),
      sandbox: sandboxScript([fail]),
      llm: scriptedLlm(['a', 'b']),
      recorder,
    })

    const finalState = await graph.invoke({ runId: 'run-80', repository, baseSha: 'abc' })

    assert.equal(finalState.status, 'failed')
    assert.match(String(finalState.error), /without a passing sandbox/)
    assert.equal(log.calls.includes('push'), false)
    assert.equal(log.calls.includes('openPr'), false)
    assert.equal(log.merged.length, 0)
    assert.equal(recorder.publications.length, 0)
  })

  it('refuses to merge when the sandbox row was never persisted', async () => {
    const log = journal()
    const recorder: MemoryRecorder = createMemoryRecorder()
    // A recorder that accepts the write but never surfaces a verdict stands in
    // for a sandbox row that did not commit. The merge gate reads the row back.
    const blind = { ...recorder, latestSandboxVerdict: async () => null }

    const graph = compileHealGraph({
      git: fakeGit(log),
      sandbox: sandboxScript([pass]),
      llm: scriptedLlm(['diff']),
      recorder: blind,
    })

    const finalState = await graph.invoke({ runId: 'run-81', repository, baseSha: 'abc' })

    assert.equal(finalState.status, 'failed')
    assert.match(String(finalState.error), /without a passing sandbox result/)
    assert.equal(log.merged.length, 0)
    assert.equal(log.calls.includes('openPr'), true, 'the PR is opened; only the merge is refused')
  })

  it('writes an audit trail and a tool log for the whole run', async () => {
    const recorder = createMemoryRecorder()
    const graph = compileHealGraph({
      git: fakeGit(journal()),
      sandbox: sandboxScript([pass]),
      llm: scriptedLlm(['diff']),
      recorder,
    })

    await graph.invoke({ runId: 'run-82', repository, baseSha: 'abc' })

    assert.deepEqual(
      recorder.tools.map((row) => row.tool),
      [
        'git_fetch',
        'git_checkout',
        'get_failure_logs',
        'git_apply_patch',
        'git_commit',
        'git_push',
        'open_pull_request',
        'merge_pull_request',
      ],
    )
    assert.ok(recorder.tools.every((row) => row.outcome === 'ok'))
    assert.ok(recorder.tools.every((row) => row.args.runId === 'run-82'))
  })

  it('keeps a token out of the tool log even if one reaches a tool argument', async () => {
    const recorder = createMemoryRecorder()
    await recorder.toolInvocation({
      tool: 'git_push',
      args: { remote: 'https://x-access-token:ghs_abcdefghijklmnopqrst@github.com/acme/eval.git' },
      outcome: 'ok',
      startedAt: new Date(),
    })

    assert.equal(String(recorder.tools[0]?.args.remote).includes('ghs_'), false)
    assert.match(String(recorder.tools[0]?.args.remote), /\[redacted\]/)
  })
})
