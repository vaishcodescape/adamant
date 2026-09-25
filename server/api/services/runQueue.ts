import { makeWorkerUtils, type WorkerUtils } from 'graphile-worker'

/**
 * The API's half of the queue. It inserts the run and enqueues `graph_step`;
 * the worker claims it through graphile-worker's LISTEN/NOTIFY, so pickup is
 * immediate rather than on a poll (docs/performance.md#cloud-loop).
 */
export interface RunQueue {
  enqueueGraphStep(runId: string): Promise<void>
}

/** No queue configured: say so loudly rather than dropping the run. */
export function createUnavailableRunQueue(): RunQueue {
  return {
    async enqueueGraphStep() {
      throw new Error('DATABASE_URL is required to enqueue graph_step')
    },
  }
}

export function createGraphileRunQueue(connectionString: string): RunQueue {
  let utils: Promise<WorkerUtils> | null = null

  const connect = () => {
    utils ??= makeWorkerUtils({ connectionString })
    return utils
  }

  return {
    async enqueueGraphStep(runId) {
      const worker = await connect()
      // jobKey is the run id, so a retried delivery cannot queue a second
      // graph for the same run.
      await worker.addJob('graph_step', { runId }, { jobKey: runId, maxAttempts: 3 })
    },
  }
}
