import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { run } from 'graphile-worker'

/**
 * Scope of this PR (A1 — workspace setup): get a worker process running,
 * connected to Postgres via graphile-worker, capable of claiming a job.
 * `graph_step` is a no-op placeholder here — wiring it to the real LangGraph
 * invocation (`compileHealGraph(deps).invoke(...)`, thread_id = run.id) is a
 * later task, not part of getting the workspace/stack running.
 *
 * graphile-worker owns its own schema (`graphile_worker` by default) and its
 * own job-claiming (SELECT ... FOR UPDATE SKIP LOCKED). Nothing here
 * duplicates that — see server/db for why there is no hand-rolled jobs table.
 */
export async function graphStep(
  payload: unknown,
  helpers: { logger: { info: (message: string, meta?: Record<string, unknown>) => void } },
): Promise<void> {
  helpers.logger.info(`graph_step received (no-op)`, { payload })
}

async function main() {
  const connectionString = process.env.DATABASE_URL

  if (!connectionString) {
    throw new Error('DATABASE_URL is required to start @adamant/worker')
  }

  const runner = await run({
    connectionString,
    concurrency: 1,
    taskList: {
      graph_step: async (payload, helpers) => {
        await graphStep(payload, helpers)
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
