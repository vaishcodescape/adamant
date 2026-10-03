import { type BaseCheckpointSaver } from '@langchain/langgraph-checkpoint'
import OpenAI from 'openai'
import { type ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses'
import { compileHealGraph } from './graph.ts'
import {
  type GitProvider,
  type LlmProvider,
  type PreviousAttempt,
  type SandboxProvider,
  type SourceExcerpt,
} from './deps.ts'
import { type RunRecorder } from './recorder.ts'
import { describeSources } from './sources.ts'
import { describeFailure, type FailureContext } from './triage.ts'

/**
 * One model for every heal step so prompt caching can hit. Diagnose and plan
 * sort the failure (low effort). The patch writes the diff (high effort).
 * The system text stays identical across calls. Every user message opens with
 * the same failure and source block and puts its own task last, so the three
 * calls of an attempt share that whole block as a cached prefix.
 */
const DEFAULT_MODEL = 'gpt-6'
const MAX_VARIABLE_CHARS = 24_000

const HEAL_INSTRUCTIONS_PROMPT = [
  'You are the Adamant heal agent for a failing GitHub Actions check.',
  'Use only the failure text, source, diagnosis, or plan in the user message.',
  'Never repeat secrets, tokens, credentials, or environment values.',
  'A patch is a unified diff that edits the existing files. Do not rewrite a whole file.',
  'Context and removed lines in a diff must match the source shown, character for character.',
  'When an earlier candidate is shown, it already failed: do not repeat it.',
].join('\n')

export type OpenAiResponses = {
  create(body: ResponseCreateParamsNonStreaming): Promise<{ output_text: string }>
}

export type OpenAiLlmOptions = {
  client?: OpenAiResponses
  model?: string
  apiKey?: string
}

type Effort = 'low' | 'high'

function readModel(explicit: string | undefined): string {
  const fromEnv = process.env.OPENAI_MODEL
  return explicit || fromEnv || DEFAULT_MODEL
}

function requireApiKey(explicit: string | undefined): string {
  const key = explicit ?? process.env.OPENAI_API_KEY
  if (!key) {
    throw new Error('OPENAI_API_KEY is required in the worker')
  }
  return key
}

function responsesClient(apiKey: string): OpenAiResponses {
  const openai = new OpenAI({ apiKey })
  return {
    create(body) {
      return openai.responses.create(body)
    },
  }
}

function tail(text: string): string {
  if (text.length <= MAX_VARIABLE_CHARS) return text
  return text.slice(-MAX_VARIABLE_CHARS)
}

/** Empty when this is the first candidate, so the cached prefix stays stable. */
function describeAttempt(attempt: PreviousAttempt | null): string {
  if (!attempt) return ''

  return [
    '',
    `Candidate ${attempt.attemptNumber} was already tried and rejected.`,
    'Why it failed:',
    tail(attempt.failure),
    '',
    'The rejected diff:',
    tail(attempt.patch),
    '',
    'Find a different cause or a different fix.',
  ].join('\n')
}

/** The same text for every step of a run, so it is the cached part of each prompt. */
function sharedContext(failure: FailureContext, sources: readonly SourceExcerpt[]): string {
  return [describeFailure(failure), '', describeSources(sources)].join('\n')
}

async function complete(
  client: OpenAiResponses,
  model: string,
  effort: Effort,
  input: string,
): Promise<string> {
  const response = await client.create({
    model,
    instructions: HEAL_INSTRUCTIONS_PROMPT,
    input,
    reasoning: { effort },
    // CI logs can contain secrets. Do not retain the prompt with OpenAI.
    store: false,
  })
  const text = response.output_text.trim()
  if (!text) {
    throw new Error('OpenAI returned an empty heal response')
  }
  return text
}

export function createOpenAiLlm(options?: OpenAiLlmOptions): LlmProvider {
  const model = readModel(options?.model)
  const client = options?.client ?? responsesClient(requireApiKey(options?.apiKey))

  return {
    diagnose({ failure, sources, previousAttempt }) {
      return complete(
        client,
        model,
        'low',
        [
          sharedContext(failure, sources),
          describeAttempt(previousAttempt),
          '',
          'Task: sort this failure. Name the cause, the file and line when present, and the tests involved.',
        ].join('\n'),
      )
    },
    plan({ failure, sources, diagnostics }) {
      return complete(
        client,
        model,
        'low',
        [
          sharedContext(failure, sources),
          '',
          'Diagnosis:',
          tail(diagnostics),
          '',
          'Task: write a short repair plan from this diagnosis. Name the files to change and why.',
        ].join('\n'),
      )
    },
    patch({ failure, sources, diagnostics, plan, previousAttempt }) {
      return complete(
        client,
        model,
        'high',
        [
          sharedContext(failure, sources),
          '',
          'Diagnosis:',
          tail(diagnostics),
          '',
          'Plan:',
          tail(plan),
          describeAttempt(previousAttempt),
          '',
          'Task: write the unified diff for this plan against the source shown. Return the diff only, with no explanation.',
        ].join('\n'),
      )
    },
  }
}

export type OpenAiHealGraphOptions = OpenAiLlmOptions & {
  checkpointer?: BaseCheckpointSaver
}

/**
 * LangGraph heal loop whose model calls go through the worker's OpenAI key.
 * The client is created here from that key. The API must not build one.
 */
export function compileOpenAiHealGraph(
  deps: { git: GitProvider; sandbox: SandboxProvider; recorder: RunRecorder },
  options?: OpenAiHealGraphOptions,
) {
  const checkpointer = options?.checkpointer
  return compileHealGraph(
    {
      git: deps.git,
      sandbox: deps.sandbox,
      recorder: deps.recorder,
      llm: createOpenAiLlm(options),
    },
    checkpointer ? { checkpointer } : undefined,
  )
}
