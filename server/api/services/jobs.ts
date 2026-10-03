import { sql } from 'drizzle-orm'
import { type Db } from '../../db/client.ts'

type Executor = Pick<Db, 'execute'>

/**
 * Queues the heal for a run. Call it inside the transaction that inserted the
 * run, so a run row never exists without its job.
 *
 * The payload is bound as one `::json` parameter. `json_build_object('runId',
 * $1)` cannot infer a type for `$1` (Postgres 42P18), which failed every insert.
 */
export async function enqueueGraphStep(executor: Executor, runId: string): Promise<void> {
  await executor.execute(sql`select graphile_worker.add_job(
    'graph_step', ${JSON.stringify({ runId })}::json,
    job_key := ${runId}, max_attempts := 3
  )`)
}
