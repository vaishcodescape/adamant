import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { type BaseCheckpointSaver } from '@langchain/langgraph-checkpoint'
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres'
import { run } from 'graphile-worker'
import { compileOpenAiHealGraph, type OpenAiLlmOptions } from '../agent/index.ts'
import { type RunRecorder } from '../agent/recorder.ts'
import { type GitProvider, type SandboxProvider } from '../agent/deps.ts'
import { createRunProviders } from './providers.ts'
import { createRunStore, createWorkerDb, type HealRun } from './runs.ts'

/**
 * `graph_step` loads the run and invokes `compileOpenAiHealGraph`. That helper
 * attaches this process's OpenAI key. Do not construct the client in the API.
 *
 * graphile-worker owns its own schema (`graphile_worker` by default) and its
 * own job-claiming (SELECT ... FOR UPDATE SKIP LOCKED). Nothing here
 * duplicates that — see server/db for why there is no hand-rolled jobs table.
 *
 * A thrown step is retried on the same thread (`thread_id = run_id`) so a
 * dead worker resumes the checkpoint instead of starting a second graph.
 */
export type GraphStepHelpers = {
  logger: { info: (message: string, meta?: Record<string, unknown>) => void }
  job?: { attempts: number; max_attempts: number }
}

export type RunTools = {
  git: GitProvider
  sandbox: SandboxProvider
  recorder: RunRecorder
  dispose?: () => Promise<void>
}

export type GraphStepDependencies = {
  loadRun: (runId: string) => Promise<HealRun | null>
  markRunning: (runId: string) => Promise<boolean>
  markFinished: (runId: string, status: 'succeeded' | 'failed') => Promise<void>
  /** Built per run: the worktree, refspec and recorder are all run-scoped. */
  createTools: (run: HealRun) => RunTools
  llmOptions?: OpenAiLlmOptions
  checkpointer?: BaseCheckpointSaver
}

export async function graphStep(
  payload: unknown,
  helpers: GraphStepHelpers,
  deps: GraphStepDependencies,
): Promise<void> {
  const runId = readRunId(payload)
  const run = await deps.loadRun(runId)
  if (!run) {
    throw new Error(`graph_step run not found: ${runId}`)
  }

  const claimed = await deps.markRunning(runId)
  if (!claimed) {
    helpers.logger.info('graph_step skipped because run is not queued', { runId })
    return
  }
  helpers.logger.info('graph_step invoking heal graph', { runId })

  const tools = deps.createTools(run)
  const llmOptions = deps.llmOptions
  const checkpointer = deps.checkpointer
  const graph = compileOpenAiHealGraph(
    { git: tools.git, sandbox: tools.sandbox, recorder: tools.recorder },
    checkpointer ? { ...llmOptions, checkpointer } : llmOptions,
  )

  try {
    const finalState = await graph.invoke(
      {
        runId,
        repository: {
          owner: run.owner,
          name: run.name,
          installationId: run.installationId,
          defaultBranch: run.defaultBranch,
        },
        baseSha: run.baseSha,
      },
      { configurable: { thread_id: runId } },
    )
    const status = finalState.status === 'completed' ? 'succeeded' : 'failed'
    await deps.markFinished(runId, status)
  } catch (error) {
    if (isLastAttempt(helpers)) {
      await deps.markFinished(runId, 'failed')
    }
    throw error
  } finally {
    // The worktree holds a checkout of someone's repository. It goes away
    // whether the run merged, gave up, or threw.
    await tools.dispose?.().catch(() => {})
  }
}

function readRunId(payload: unknown): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('graph_step payload must be an object with runId')
  }
  const runId = (payload as { runId?: unknown }).runId
  if (typeof runId !== 'string' || runId.length === 0) {
    throw new Error('graph_step payload must be an object with runId')
  }
  return runId
}

function isLastAttempt(helpers: GraphStepHelpers): boolean {
  const job = helpers.job
  if (!job) return true
  return job.attempts >= job.max_attempts
}

async function main() {
  const connectionString = process.env.DATABASE_URL

  if (!connectionString) {
    throw new Error('DATABASE_URL is required to start @adamant/worker')
  }

  const db = createWorkerDb(connectionString)
  const store = createRunStore(db)
  const checkpointer = PostgresSaver.fromConnString(connectionString)
  await checkpointer.setup()

  const deps: GraphStepDependencies = {
    ...store,
    createTools: (healRun) => createRunProviders({ db, run: healRun }),
    checkpointer,
  }

  const runner = await run({
    connectionString,
    concurrency: 1,
    taskList: {
      graph_step: async (payload, helpers) => {
        await graphStep(payload, helpers, deps)
      },
    },
  })

  console.log('@adamant/worker connected and waiting for jobs')

  await runner.promise
}

function isDirectRun() {
  const entry = process.argv[1]
  if (!entry) return false
  return import.meta.url === pathToFileURL(path.resolve(entry)).href
}

if (isDirectRun()) {
  main().catch((error: unknown) => {
    console.error('@adamant/worker crashed', error)
    process.exit(1)
  })
}
