import { constants as fsConstants } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { type BaseCheckpointSaver } from '@langchain/langgraph-checkpoint'
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres'
import { run } from 'graphile-worker'
import { compileOpenAiHealGraph, type OpenAiLlmOptions } from '../agent/index.ts'
import { type RunRecorder } from '../agent/recorder.ts'
import { type GitProvider, type SandboxProvider } from '../agent/deps.ts'
import { deleteExpiredOAuthStates } from '../api/services/authService.ts'
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
  markRunning: (runId: string, retry: boolean) => Promise<boolean>
  markFinished: (runId: string, status: 'succeeded' | 'failed') => Promise<void>
  /** Built per run: the worktree, refspec and recorder are all run-scoped. */
  createTools: (run: HealRun) => RunTools
  llmOptions?: OpenAiLlmOptions
  checkpointer?: BaseCheckpointSaver
}

const OAUTH_STATE_BATCH_SIZE = 1_000
const OAUTH_STATE_MAX_BATCHES = 50
/**
 * Heals in flight per process. A heal is mostly waiting (model calls, a
 * sandbox container with its own CPU and memory caps), so one at a time left a
 * single slow sandbox blocking every other red build.
 */
const DEFAULT_CONCURRENCY = 2

export function readConcurrency(env = process.env): number {
  const value = Number(env.ADAMANT_WORKER_CONCURRENCY ?? DEFAULT_CONCURRENCY)
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_CONCURRENCY
}

/**
 * Where run worktrees live. When the worker itself runs in a container, the
 * sandbox is started by the host's Docker daemon, which resolves bind-mount
 * sources on the host, so this path must be mounted at the same path on both
 * sides (see docker-compose.yml).
 */
export function readWorkspaceRoot(env = process.env): string {
  return env.ADAMANT_WORKSPACE_ROOT ?? path.join(os.tmpdir(), 'adamant-workspaces')
}

export async function drainExpiredOAuthStates(deleteBatch: () => Promise<number>): Promise<number> {
  let deleted = 0

  for (let batch = 0; batch < OAUTH_STATE_MAX_BATCHES; batch += 1) {
    const count = await deleteBatch()
    deleted += count

    if (count < OAUTH_STATE_BATCH_SIZE) {
      break
    }
  }

  return deleted
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

  const claimed = await deps.markRunning(runId, isRetry(helpers))
  if (!claimed) {
    helpers.logger.info('graph_step skipped because run is not queued', { runId })
    return
  }
  helpers.logger.info('graph_step invoking heal graph', { runId })

  const tools = deps.createTools(run)

  try {
    const llmOptions = deps.llmOptions
    const checkpointer = deps.checkpointer
    const graph = compileOpenAiHealGraph(
      { git: tools.git, sandbox: tools.sandbox, recorder: tools.recorder },
      checkpointer ? { ...llmOptions, checkpointer } : llmOptions,
    )
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

function isRetry(helpers: GraphStepHelpers): boolean {
  return (helpers.job?.attempts ?? 1) > 1
}

async function main() {
  const connectionString = process.env.DATABASE_URL

  if (!connectionString) {
    throw new Error('DATABASE_URL is required to start @adamant/worker')
  }

  const concurrency = readConcurrency()
  const workspaceRoot = readWorkspaceRoot()
  // Fail at boot, not on the first heal, when the worktree root is unusable.
  await fs.mkdir(workspaceRoot, { recursive: true })
  await fs.access(workspaceRoot, fsConstants.W_OK)

  // graphile-worker holds one connection for LISTEN and one per job in flight;
  // each heal also uses the pool for its recorder and checkpoints.
  const db = createWorkerDb(connectionString, concurrency * 2 + 4)
  const store = createRunStore(db)
  const checkpointer = new PostgresSaver(db.$client)
  await checkpointer.setup()

  const deps: GraphStepDependencies = {
    ...store,
    createTools: (healRun) => createRunProviders({ db, run: healRun, workspaceRoot }),
    checkpointer,
  }

  const runner = await run({
    pgPool: db.$client,
    concurrency,
    crontab: '0 * * * * cleanup_oauth_states',
    taskList: {
      graph_step: async (payload, helpers) => {
        await graphStep(payload, helpers, deps)
      },
      cleanup_oauth_states: async (_payload, helpers) => {
        const deleted = await drainExpiredOAuthStates(() => deleteExpiredOAuthStates(db))
        helpers.logger.info('expired OAuth states deleted', { deleted })
      },
    },
  })

  console.log(`@adamant/worker connected and waiting for jobs (concurrency ${concurrency})`)

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
