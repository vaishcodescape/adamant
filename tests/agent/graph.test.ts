import { describe, it } from 'node:test'
import * as assert from 'node:assert'
import { compileOpenAiHealGraph } from '../../server/agent/graph.ts'
import {
  type AgentDependencies,
  type GitProvider,
  type SandboxProvider,
  type LlmProvider,
} from '../../server/agent/deps.ts'
import { SecureGitClient } from '../../server/agent/tools.ts'

describe('Agent System LangGraph Core', () => {
  const createMockDeps = (): AgentDependencies => {
    return {
      git: {
        fetch: async () => {},
        checkout: async () => {},
        commit: async () => {},
        push: async () => {},
        openPr: async () => 123,
        mergePr: async () => {},
        getFailureLogs: async () => 'mock-logs',
      } as unknown as GitProvider,
      sandbox: {
        runValidation: async () => ({ verdict: 'pass', commands: ['npm test'] }),
      } as unknown as SandboxProvider,
      llm: {
        diagnose: async () => 'diagnostics-result',
        plan: async () => 'plan-result',
        patch: async () => 'patch-result',
      } as unknown as LlmProvider,
    }
  }

  it('graph can be constructed', () => {
    const deps = createMockDeps()
    const graph = compileOpenAiHealGraph(deps)
    assert.ok(graph)
  })

  it('successful sandbox routes to openPr, mergePr, and ends in completed', async () => {
    const deps = createMockDeps()
    const graph = compileOpenAiHealGraph(deps)

    const initialState = {
      runId: 'run-1',
      repository: { owner: 'test', name: 'repo', installationId: 'inst-1' },
      baseSha: 'abc',
    }

    const finalState = await graph.invoke(initialState)
    assert.strictEqual(finalState.status, 'completed')
    assert.strictEqual(finalState.sandboxResult?.verdict, 'pass')
    assert.strictEqual(finalState.prNumber, 123)
  })

  it('failed sandbox routes back to diagnose and increments attempt number', async () => {
    const deps = createMockDeps()
    let sandboxCalls = 0
    deps.sandbox.runValidation = async () => {
      sandboxCalls++
      return { verdict: 'fail', commands: [] }
    }

    const graph = compileOpenAiHealGraph(deps)
    const finalState = await graph.invoke({
      runId: 'run-2',
      repository: { owner: 'test', name: 'repo', installationId: 'inst-1' },
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
    deps.sandbox.runValidation = async () => {
      return { verdict: 'fail', commands: [] }
    }

    const graph = compileOpenAiHealGraph(deps)
    const finalState = await graph.invoke({
      runId: 'run-3',
      repository: { owner: 'test', name: 'repo', installationId: 'inst-1' },
      baseSha: 'abc',
    }) // using default maxAttempts

    assert.strictEqual(patchCalls, 2)
    assert.strictEqual(finalState.attemptNumber, 2)
    assert.strictEqual(finalState.status, 'failed')
    assert.match(String(finalState.error), /without a passing sandbox/)
  })
})

describe('SecureGitClient Tool Boundary', () => {
  it('rejects push to unauthorized branch', async () => {
    const mockGit = {
      push: async () => {},
      fetch: async () => {},
      checkout: async () => {},
      commit: async () => {},
      openPr: async () => 0,
      mergePr: async () => {},
      getFailureLogs: async () => 'mock-logs',
    } as GitProvider
    const client = new SecureGitClient(mockGit, 'run-1')

    await assert.rejects(client.push('unauthorized-branch'), /Unauthorized push attempt/)
  })

  it('rejects push to main', async () => {
    const mockGit = {
      push: async () => {},
      fetch: async () => {},
      checkout: async () => {},
      commit: async () => {},
      openPr: async () => 0,
      mergePr: async () => {},
      getFailureLogs: async () => 'mock-logs',
    } as GitProvider
    const client = new SecureGitClient(mockGit, 'run-1')

    await assert.rejects(client.push('main'), /Unauthorized push attempt/)
  })

  it('accepts push to adamant/{run_id}', async () => {
    let pushedBranch = ''
    const mockGit = {
      push: async (branch: string) => {
        pushedBranch = branch
      },
      fetch: async () => {},
      checkout: async () => {},
      commit: async () => {},
      openPr: async () => 0,
      mergePr: async () => {},
      getFailureLogs: async () => 'mock-logs',
    } as GitProvider
    const client = new SecureGitClient(mockGit, 'run-123')

    await client.push('adamant/run-123')
    assert.strictEqual(pushedBranch, 'adamant/run-123')
  })

  it('rejects opening a pull request from any branch other than adamant/{run_id}', async () => {
    const mockGit = {
      push: async () => {},
      fetch: async () => {},
      checkout: async () => {},
      commit: async () => {},
      openPr: async () => 0,
      mergePr: async () => {},
      getFailureLogs: async () => 'mock-logs',
    } as GitProvider
    const client = new SecureGitClient(mockGit, 'run-1')

    await assert.rejects(client.openPr('main', 'main', 'title', 'body'), /Unauthorized PR attempt/)
  })

  it('merges only the pull request opened for this run after a passing sandbox', async () => {
    let merged = 0
    const mockGit = {
      push: async () => {},
      fetch: async () => {},
      checkout: async () => {},
      commit: async () => {},
      openPr: async () => 0,
      mergePr: async (prNumber: number) => {
        merged = prNumber
      },
      getFailureLogs: async () => 'mock-logs',
    } as GitProvider
    const client = new SecureGitClient(mockGit, 'run-1')

    await client.mergePr(7, 7, 'pass')
    assert.strictEqual(merged, 7)
  })

  it('automatic merge fails unless sandbox passes', async () => {
    const mockGit = {
      push: async () => {},
      fetch: async () => {},
      checkout: async () => {},
      commit: async () => {},
      openPr: async () => 0,
      mergePr: async () => {},
      getFailureLogs: async () => 'mock-logs',
    } as GitProvider
    const client = new SecureGitClient(mockGit, 'run-1')

    await assert.rejects(
      client.mergePr(123, 123, 'fail'),
      /Cannot merge PR 123 without a passing sandbox result/,
    )
  })

  it('automatic merge fails if expected PR does not match', async () => {
    const mockGit = {
      push: async () => {},
      fetch: async () => {},
      checkout: async () => {},
      commit: async () => {},
      openPr: async () => 0,
      mergePr: async () => {},
      getFailureLogs: async () => 'mock-logs',
    } as GitProvider
    const client = new SecureGitClient(mockGit, 'run-1')

    await assert.rejects(
      client.mergePr(123, 456, 'pass'),
      /Cannot merge PR 123. It does not match the PR opened for this run/,
    )
  })

  it('automatic merge fails if expected PR is null', async () => {
    const mockGit = {
      push: async () => {},
      fetch: async () => {},
      checkout: async () => {},
      commit: async () => {},
      openPr: async () => 0,
      mergePr: async () => {},
      getFailureLogs: async () => 'mock-logs',
    } as GitProvider
    const client = new SecureGitClient(mockGit, 'run-1')

    await assert.rejects(
      client.mergePr(123, null, 'pass'),
      /Cannot merge PR 123. It does not match the PR opened for this run/,
    )
  })

  it('openPr rejects if sandbox did not pass', async () => {
    const { createNodes } = await import('../../server/agent/nodes.ts')
    const deps = {
      git: {
        push: async () => {},
        fetch: async () => {},
        checkout: async () => {},
        commit: async () => {},
        openPr: async () => 0,
        mergePr: async () => {},
        getFailureLogs: async () => 'mock-logs',
      } as GitProvider,
      sandbox: {} as SandboxProvider,
      llm: {} as LlmProvider,
    }
    const nodes = createNodes(deps)

    await assert.rejects(
      nodes.openPrNode({
        runId: 'run-1',
        repository: { owner: 'test', name: 'repo', installationId: 'inst-1' },
        baseSha: 'abc',
        sourceSha: null,
        status: 'sandboxing',
        diagnostics: null,
        plan: null,
        candidatePatch: null,
        attemptNumber: 1,
        maxAttempts: 3,
        sandboxResult: { verdict: 'fail', commands: [] },
        error: null,
        prNumber: null,
      }),
      /Cannot open PR without a passing sandbox result/,
    )
  })
})
