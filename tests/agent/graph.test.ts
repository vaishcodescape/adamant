import { describe, it } from 'node:test'
import * as assert from 'node:assert'
import { compileHealGraph } from '../../server/agent/graph.ts'
import {
  type AgentDependencies,
  type GitProvider,
  type SandboxProvider,
  type LlmProvider,
} from '../../server/agent/deps.ts'
import { createMemoryRecorder, type MemoryRecorder } from '../../server/agent/recorder.ts'
import { SecureGitClient } from '../../server/agent/tools.ts'

const repository = {
  owner: 'test',
  name: 'repo',
  installationId: 'inst-1',
  defaultBranch: 'main',
}

const mockGit = (overrides: Partial<GitProvider> = {}): GitProvider => ({
  fetch: async () => {},
  checkout: async () => {},
  applyPatch: async () => {},
  commit: async () => {},
  push: async () => {},
  openPr: async () => ({ number: 123, url: 'https://github.com/test/repo/pull/123' }),
  mergePr: async () => {},
  getFailureLogs: async () => 'Error: boom at src/app.ts:10',
  ...overrides,
})

describe('Agent System LangGraph Core', () => {
  const createMockDeps = (): AgentDependencies & { recorder: MemoryRecorder } => ({
    git: mockGit(),
    sandbox: {
      runValidation: async () => ({ verdict: 'pass', commands: ['npm test'], output: 'ok' }),
    } as SandboxProvider,
    llm: {
      diagnose: async () => 'diagnostics-result',
      plan: async () => 'plan-result',
      patch: async () => 'patch-result',
    } as unknown as LlmProvider,
    recorder: createMemoryRecorder(),
  })

  it('graph can be constructed', () => {
    const graph = compileHealGraph(createMockDeps())
    assert.ok(graph)
  })

  it('successful sandbox routes to openPr, mergePr, and ends in completed', async () => {
    const deps = createMockDeps()
    const graph = compileHealGraph(deps)

    const finalState = await graph.invoke({ runId: 'run-1', repository, baseSha: 'abc' })

    assert.strictEqual(finalState.status, 'completed')
    assert.strictEqual(finalState.sandboxResult?.verdict, 'pass')
    assert.strictEqual(finalState.prNumber, 123)
    assert.strictEqual(finalState.prUrl, 'https://github.com/test/repo/pull/123')
    assert.deepStrictEqual(
      deps.recorder.sandboxes.map((row) => row.verdict),
      ['pass'],
    )
    assert.strictEqual(deps.recorder.publications.length, 1)
  })

  it('failed sandbox routes back to diagnose and increments attempt number', async () => {
    const deps = createMockDeps()
    let sandboxCalls = 0
    deps.sandbox.runValidation = async () => {
      sandboxCalls++
      return { verdict: 'fail', commands: [], output: 'still red' }
    }

    const graph = compileHealGraph(deps)
    const finalState = await graph.invoke({
      runId: 'run-2',
      repository,
      baseSha: 'abc',
      maxAttempts: 2,
    })

    assert.strictEqual(sandboxCalls, 2)
    assert.strictEqual(finalState.attemptNumber, 2)
  })

  it('enforces a maximum of exactly two repair candidates by default', async () => {
    const deps = createMockDeps()
    let patchCalls = 0
    deps.llm.patch = async () => {
      patchCalls++
      return `patch-${patchCalls}`
    }
    deps.sandbox.runValidation = async () => ({
      verdict: 'fail',
      commands: [],
      output: 'still red',
    })

    const graph = compileHealGraph(deps)
    const finalState = await graph.invoke({
      runId: 'run-3',
      repository,
      baseSha: 'abc',
    }) // using default maxAttempts

    assert.strictEqual(patchCalls, 2)
    assert.strictEqual(finalState.attemptNumber, 2)
    assert.strictEqual(finalState.status, 'failed')
    assert.match(String(finalState.error), /without a passing sandbox/)
    assert.strictEqual(deps.recorder.publications.length, 0)
  })

  it('parses the failure once and reuses it across attempts', async () => {
    const deps = createMockDeps()
    let logCalls = 0
    deps.git.getFailureLogs = async () => {
      logCalls++
      return 'FAIL test/app.test.ts\nError: boom at src/app.ts:10'
    }
    deps.sandbox.runValidation = async () => ({ verdict: 'fail', commands: [], output: 'red' })

    const graph = compileHealGraph(deps)
    const finalState = await graph.invoke({ runId: 'run-4', repository, baseSha: 'abc' })

    assert.strictEqual(logCalls, 1)
    assert.strictEqual(finalState.failure?.location, 'src/app.ts:10')
  })
})

describe('SecureGitClient Tool Boundary', () => {
  const client = (git: Partial<GitProvider>, runId = 'run-1', recorder = createMemoryRecorder()) =>
    new SecureGitClient(mockGit(git), runId, recorder)

  it('rejects push to unauthorized branch', async () => {
    await assert.rejects(client({}).push('unauthorized-branch'), /Unauthorized push attempt/)
  })

  it('rejects push to main', async () => {
    await assert.rejects(client({}).push('main'), /Unauthorized push attempt/)
  })

  it('accepts push to adamant/{run_id}', async () => {
    let pushedBranch = ''
    const gateway = client({ push: async (branch) => void (pushedBranch = branch) }, 'run-123')

    await gateway.push('adamant/run-123')
    assert.strictEqual(pushedBranch, 'adamant/run-123')
  })

  it('rejects opening a pull request from any branch other than adamant/{run_id}', async () => {
    await assert.rejects(
      client({}).openPr('main', 'main', 'title', 'body'),
      /Unauthorized PR attempt/,
    )
  })

  it('merges only the pull request opened for this run after a passing sandbox', async () => {
    let merged = 0
    const recorder = createMemoryRecorder()
    await recorder.sandboxResult({
      attemptNumber: 1,
      candidateHash: 'hash',
      baseSha: 'abc',
      commands: ['npm test'],
      verdict: 'pass',
    })

    const gateway = client(
      { mergePr: async (prNumber) => void (merged = prNumber) },
      'run-1',
      recorder,
    )
    await gateway.mergePr(7, 7)

    assert.strictEqual(merged, 7)
  })

  it('automatic merge fails unless a passing sandbox row exists', async () => {
    const recorder = createMemoryRecorder()
    await recorder.sandboxResult({
      attemptNumber: 1,
      candidateHash: 'hash',
      baseSha: 'abc',
      commands: [],
      verdict: 'fail',
    })

    await assert.rejects(
      client({}, 'run-1', recorder).mergePr(123, 123),
      /Cannot merge PR 123 without a passing sandbox result/,
    )
  })

  it('automatic merge fails when no sandbox ran at all', async () => {
    await assert.rejects(
      client({}).mergePr(123, 123),
      /Cannot merge PR 123 without a passing sandbox result/,
    )
  })

  it('automatic merge fails if expected PR does not match', async () => {
    await assert.rejects(
      client({}).mergePr(123, 456),
      /Cannot merge PR 123. It does not match the PR opened for this run/,
    )
  })

  it('automatic merge fails if expected PR is null', async () => {
    await assert.rejects(
      client({}).mergePr(123, null),
      /Cannot merge PR 123. It does not match the PR opened for this run/,
    )
  })

  it('refuses to merge a PR this run did not publish', async () => {
    const recorder = createMemoryRecorder()
    await recorder.sandboxResult({
      attemptNumber: 1,
      candidateHash: 'hash',
      baseSha: 'abc',
      commands: [],
      verdict: 'pass',
    })
    await recorder.prPublication({
      prNumber: 9,
      prUrl: 'https://github.com/test/repo/pull/9',
      baseSha: 'abc',
      candidateHash: 'hash',
    })

    await assert.rejects(client({}, 'run-1', recorder).mergePr(10, 10), /This run published PR 9/)
  })

  it('fails closed on a tool that is not on the allowlist', async () => {
    const recorder = createMemoryRecorder()
    await assert.rejects(
      client({}, 'run-1', recorder).invoke('delete_branch'),
      /not on the allowlist/,
    )
    assert.deepStrictEqual(
      recorder.tools.map((row) => [row.tool, row.outcome]),
      [['delete_branch', 'denied']],
    )
  })

  it('logs every call to tool_invocations with the run id', async () => {
    const recorder = createMemoryRecorder()
    const gateway = client({}, 'run-1', recorder)

    await gateway.fetch({ owner: 'test', name: 'repo' })
    await assert.rejects(gateway.push('main'), /Unauthorized push attempt/)

    assert.deepStrictEqual(
      recorder.tools.map((row) => [row.tool, row.outcome]),
      [
        ['git_fetch', 'ok'],
        ['git_push', 'denied'],
      ],
    )
    for (const row of recorder.tools) {
      assert.strictEqual(row.args.runId, 'run-1')
    }
  })

  it('openPr rejects if sandbox did not pass', async () => {
    const { createNodes } = await import('../../server/agent/nodes.ts')
    const nodes = createNodes({
      git: mockGit(),
      sandbox: {} as SandboxProvider,
      llm: {} as LlmProvider,
      recorder: createMemoryRecorder(),
    })

    await assert.rejects(
      nodes.openPrNode({
        runId: 'run-1',
        repository,
        baseSha: 'abc',
        sourceSha: null,
        status: 'sandboxing',
        failure: null,
        diagnostics: null,
        plan: null,
        candidatePatch: null,
        candidateHash: null,
        lastAttemptFailure: null,
        attemptNumber: 1,
        maxAttempts: 3,
        sandboxResult: { verdict: 'fail', commands: [] },
        error: null,
        prNumber: null,
        prUrl: null,
      }),
      /Cannot open PR without a passing sandbox result/,
    )
  })
})
