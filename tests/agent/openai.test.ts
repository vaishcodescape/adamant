import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses'
import { type GitProvider, type SandboxProvider } from '../../server/agent/deps.ts'
import { createMemoryRecorder } from '../../server/agent/recorder.ts'
import {
  compileOpenAiHealGraph,
  createOpenAiLlm,
  type OpenAiResponses,
} from '../../server/agent/openai.ts'

const git = {
  fetch: async () => {},
  checkout: async () => {},
  applyPatch: async () => {},
  commit: async () => {},
  push: async () => {},
  openPr: async () => ({ number: 1, url: 'https://github.com/acme/demo/pull/1' }),
  mergePr: async () => {},
  getFailureLogs: async () => 'Error: boom at src/app.ts:10',
} as GitProvider

const sandbox = {
  runValidation: async () => ({
    verdict: 'pass' as const,
    commands: ['pnpm test'],
    output: 'ok',
  }),
} as SandboxProvider

const repository = {
  owner: 'acme',
  name: 'demo',
  installationId: '1',
  defaultBranch: 'main',
}

function recordingClient() {
  const calls: ResponseCreateParamsNonStreaming[] = []
  const client: OpenAiResponses = {
    create: async (body) => {
      calls.push(body)
      return { output_text: `step-${calls.length}` }
    },
  }
  return { calls, client }
}

describe('OpenAI heal model', () => {
  it('requires the worker API key when no client is injected', () => {
    const previous = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = ''
    try {
      assert.throws(() => createOpenAiLlm(), /OPENAI_API_KEY is required in the worker/)
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = previous
    }
  })

  it('defaults to the configured heal model', async () => {
    const previousModel = process.env.OPENAI_MODEL
    const previousKey = process.env.OPENAI_API_KEY
    delete process.env.OPENAI_MODEL
    process.env.OPENAI_API_KEY = 'test-key'

    try {
      const { calls, client } = recordingClient()
      await createOpenAiLlm({ client }).plan({
        failure: { firstError: null, location: null, failingTests: [], excerpt: '' },
        diagnostics: 'd',
      })
      assert.equal(calls[0]?.model, 'gpt-6')
    } finally {
      if (previousModel === undefined) delete process.env.OPENAI_MODEL
      else process.env.OPENAI_MODEL = previousModel
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = previousKey
    }
  })

  it('runs diagnose and plan at low effort and the patch at high effort', async () => {
    const { calls, client } = recordingClient()
    const graph = compileOpenAiHealGraph(
      { git, sandbox, recorder: createMemoryRecorder() },
      { client, model: 'gpt-6' },
    )

    const finalState = await graph.invoke({
      runId: 'run-should-stay-out-of-the-prompt',
      repository,
      baseSha: 'abc',
    })

    assert.equal(finalState.status, 'completed')
    assert.equal(finalState.diagnostics, 'step-1')
    assert.equal(finalState.plan, 'step-2')
    assert.equal(finalState.candidatePatch, 'step-3')
    assert.deepEqual(
      calls.map((call) => call.reasoning?.effort),
      ['low', 'low', 'high'],
    )

    const instructions = calls.map((call) => call.instructions)
    assert.equal(new Set(instructions).size, 1)
    for (const call of calls) {
      assert.equal(call.model, 'gpt-6')
      assert.equal(call.store, false)
      const input = typeof call.input === 'string' ? call.input : ''
      assert.equal(input.includes('run-should-stay-out-of-the-prompt'), false)
      assert.equal(String(call.instructions).includes('run-should-stay-out-of-the-prompt'), false)
    }
    const diagnoseInput = calls[0]?.input
    assert.equal(typeof diagnoseInput, 'string')
    assert.match(String(diagnoseInput), /src\/app\.ts:10/)
  })

  it('shows the rejected candidate to the next diagnose so the retry differs', async () => {
    const { calls, client } = recordingClient()
    let attempts = 0
    const failingSandbox = {
      runValidation: async () => {
        attempts += 1
        return {
          verdict: 'fail' as const,
          commands: ['pnpm test'],
          output: `assertion failed on attempt ${attempts}`,
        }
      },
    } as SandboxProvider

    const graph = compileOpenAiHealGraph(
      { git, sandbox: failingSandbox, recorder: createMemoryRecorder() },
      { client, model: 'gpt-6' },
    )

    await graph.invoke({ runId: 'run-retry', repository, baseSha: 'abc', maxAttempts: 2 })

    const secondDiagnose = String(calls[3]?.input)
    assert.match(secondDiagnose, /Candidate 1 was already tried and rejected/)
    assert.match(secondDiagnose, /assertion failed on attempt 1/)
    assert.match(secondDiagnose, /step-3/)
  })

  it('redacts a secret-shaped sandbox output before it reaches the next prompt', async () => {
    const { calls, client } = recordingClient()
    const failingSandbox = {
      runValidation: async () => ({
        verdict: 'fail' as const,
        commands: ['pnpm test'],
        output: 'assertion failed: leaked sk-abcdefghijklmnopqrstuvwx in test output',
      }),
    } as SandboxProvider

    const graph = compileOpenAiHealGraph(
      { git, sandbox: failingSandbox, recorder: createMemoryRecorder() },
      { client, model: 'gpt-6' },
    )

    await graph.invoke({
      runId: 'run-retry-secret',
      repository,
      baseSha: 'abc',
      maxAttempts: 2,
    })

    const secondDiagnose = String(calls[3]?.input)
    assert.equal(secondDiagnose.includes('sk-abcdefghijklmnopqrstuvwx'), false)
    assert.match(secondDiagnose, /\[redacted\]/)
  })

  it('keeps the raw job log out of the prompt', async () => {
    const { calls, client } = recordingClient()
    const noisyGit = {
      ...git,
      getFailureLogs: async () =>
        [
          '2024-01-01T00:00:00.0000000Z ##[group]Run actions/checkout@v4',
          `2024-01-01T00:00:00.0000000Z ::add-mask::${'x'.repeat(40)}`,
          '2024-01-01T00:00:00.0000000Z ##[endgroup]',
          ...Array.from({ length: 400 }, (_, index) => `noise line ${index}`),
          'Error: expected 2 to equal 3 at src/sum.ts:7',
        ].join('\n'),
    } as GitProvider

    const graph = compileOpenAiHealGraph(
      { git: noisyGit, sandbox, recorder: createMemoryRecorder() },
      { client, model: 'gpt-6' },
    )
    await graph.invoke({ runId: 'run-noise', repository, baseSha: 'abc' })

    const diagnoseInput = String(calls[0]?.input)
    assert.match(diagnoseInput, /src\/sum\.ts:7/)
    assert.equal(diagnoseInput.includes('noise line 0'), false)
    assert.equal(diagnoseInput.includes('##[group]'), false)
  })
})
