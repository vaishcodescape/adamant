import { createHash, randomUUID } from 'node:crypto'
import { createDb } from '../../db/client.ts'
import { createGraphileRunQueue, createUnavailableRunQueue, type RunQueue } from './runQueue.ts'
import {
  createMemoryWebhookStore,
  createPostgresWebhookStore,
  type WebhookStore,
} from './webhookStore.ts'

/**
 * Red CI starts a heal. Nothing else does.
 *
 * Order matters: the delivery row is written before the run, so a retried
 * delivery is rejected by the unique index before it can create a second run
 * (docs/backend-architecture.md#auth-phase-1). A merge only ever confirms a
 * run we already published; it never starts one.
 */
export interface WebhookDependencies {
  readonly store: WebhookStore
  readonly queue: RunQueue
}

export interface WebhookResult {
  readonly runId: string | null
}

type RepositoryPayload = {
  id?: number
  name?: string
  full_name?: string
  default_branch?: string
  owner?: { login?: string }
}

type InstallationPayload = {
  id?: number
  account?: { login?: string; type?: string }
}

type EventPayload = {
  action?: string
  installation?: InstallationPayload
  repository?: RepositoryPayload
  workflow_run?: { conclusion?: string; head_sha?: string }
  pull_request?: { merged?: boolean; number?: number }
}

export class DuplicateDeliveryError extends Error {
  constructor() {
    super('Duplicate delivery')
    this.name = 'DuplicateDeliveryError'
  }
}

const digest = (payload: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(payload) ?? '')
    .digest('hex')

export function createWebhookService(deps: WebhookDependencies) {
  /** Both rows are keyed on GitHub's numeric ids, so this is safe to repeat. */
  async function bind(payload: EventPayload) {
    const installationId = payload.installation?.id
    const repository = payload.repository
    if (!installationId) return { installationRowId: null, repositoryRowId: null }

    const installationRowId = await deps.store.upsertInstallation({
      githubInstallationId: installationId,
      accountLogin: payload.installation?.account?.login ?? 'unknown',
      accountType: payload.installation?.account?.type ?? 'Organization',
    })

    const owner = repository?.owner?.login ?? repository?.full_name?.split('/')[0]
    if (!repository?.id || !repository.name || !owner) {
      return { installationRowId, repositoryRowId: null }
    }

    const repositoryRowId = await deps.store.upsertRepository({
      installationId: installationRowId,
      githubRepoId: repository.id,
      owner,
      name: repository.name,
      defaultBranch: repository.default_branch ?? 'main',
    })

    return { installationRowId, repositoryRowId }
  }

  async function handleWorkflowRun(
    deliveryId: string,
    payload: EventPayload,
    repositoryRowId: string | null,
  ): Promise<string | null> {
    if (payload.action !== 'completed') return null
    if (payload.workflow_run?.conclusion !== 'failure') return null

    const headSha = payload.workflow_run.head_sha
    if (!repositoryRowId || !headSha) return null

    const runId = randomUUID()
    const created = await deps.store.createQueuedRun({
      runId,
      repositoryId: repositoryRowId,
      sourceSha: headSha,
      idempotencyKey: `webhook:${deliveryId}`,
    })

    if (!created) return null

    await deps.store.recordAudit(created, 'run.queued', { deliveryId, sourceSha: headSha })
    // Last: a run row with no job is recoverable, a job with no run is not.
    await deps.queue.enqueueGraphStep(created)

    return created
  }

  async function handlePullRequest(
    deliveryId: string,
    payload: EventPayload,
    repositoryRowId: string | null,
  ): Promise<null> {
    if (payload.action !== 'closed' || !payload.pull_request?.merged) return null

    const prNumber = payload.pull_request.number
    if (!repositoryRowId || !prNumber) return null

    // A merge confirms a run we opened. It never starts a heal, and it never
    // merges anything a second time.
    const runId = await deps.store.findRunByPullRequest(repositoryRowId, prNumber)
    await deps.store.recordAudit(runId, 'pull_request.merged', {
      deliveryId,
      prNumber,
      ours: runId !== null,
    })

    return null
  }

  async function dispatch(
    deliveryId: string,
    event: string,
    payload: EventPayload,
    repositoryRowId: string | null,
  ): Promise<string | null> {
    switch (event) {
      case 'workflow_run':
        return handleWorkflowRun(deliveryId, payload, repositoryRowId)
      case 'pull_request':
        return handlePullRequest(deliveryId, payload, repositoryRowId)
      default:
        return null
    }
  }

  return {
    async processEvent(
      deliveryId: string,
      event: string,
      rawPayload: unknown,
    ): Promise<WebhookResult> {
      const payload = (rawPayload ?? {}) as EventPayload
      const { installationRowId, repositoryRowId } = await bind(payload)

      const stored = await deps.store.recordDelivery({
        deliveryId,
        eventType: event,
        installationId: installationRowId,
        repositoryId: repositoryRowId,
        payloadDigest: digest(rawPayload),
      })

      if (!stored) {
        throw new DuplicateDeliveryError()
      }

      const runId = await dispatch(deliveryId, event, payload, repositoryRowId)
      await deps.store.markDeliveryProcessed(deliveryId, runId ? 'processed' : 'ignored')

      return { runId }
    },
  }
}

export type WebhookService = ReturnType<typeof createWebhookService>

let cached: WebhookService | null = null

/**
 * Postgres-backed when `DATABASE_URL` is set, in-memory otherwise, so the API
 * still answers locally without a database. Resolved on first use, not at
 * import, so tests decide which one they get.
 */
export function defaultWebhookService(): WebhookService {
  if (cached) return cached

  const url = process.env.DATABASE_URL
  cached = url
    ? createWebhookService({
        store: createPostgresWebhookStore(createDb(url)),
        queue: createGraphileRunQueue(url),
      })
    : createWebhookService({
        store: createMemoryWebhookStore(),
        queue: createUnavailableRunQueue(),
      })

  return cached
}

/** Test seam: drops the memoised service so the next call re-reads the env. */
export function resetWebhookService(): void {
  cached = null
}
