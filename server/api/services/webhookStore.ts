import { and, eq, sql } from 'drizzle-orm'
import {
  auditEvents,
  githubInstallations,
  prPublications,
  repositories,
  runs,
  webhookDeliveries,
  type Db,
} from '../../db/client.ts'

/**
 * Everything the webhook handler writes. The Postgres implementation is what
 * runs; the in-memory one keeps the handler testable without a database.
 *
 * Deduplication is a database guarantee, not app logic: the unique index on
 * `github_delivery_id` decides, so two concurrent deliveries of the same event
 * cannot both start a run.
 */
export interface DeliveryInput {
  readonly deliveryId: string
  readonly eventType: string
  readonly installationId: string | null
  readonly repositoryId: string | null
  readonly payloadDigest: string
}

export interface InstallationInput {
  readonly githubInstallationId: number
  readonly accountLogin: string
  readonly accountType: string
}

export interface RepositoryInput {
  readonly installationId: string
  readonly githubRepoId: number
  readonly owner: string
  readonly name: string
  readonly defaultBranch: string
}

export interface QueuedRunInput {
  readonly runId: string
  readonly repositoryId: string
  readonly sourceSha: string
  readonly idempotencyKey: string
}

export interface WebhookStore {
  transaction<T>(callback: (store: WebhookStore) => Promise<T>): Promise<T>
  upsertInstallation(input: InstallationInput): Promise<string>
  upsertRepository(input: RepositoryInput): Promise<string>
  /** False when this delivery id was already stored. */
  recordDelivery(input: DeliveryInput): Promise<boolean>
  markDeliveryProcessed(deliveryId: string, status: 'processed' | 'ignored'): Promise<void>
  /** Null when an identical idempotency key already created a run. */
  createQueuedRun(input: QueuedRunInput): Promise<string | null>
  findRunByPullRequest(repositoryId: string, prNumber: number): Promise<string | null>
  recordAudit(
    runId: string | null,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void>
}

export function createPostgresWebhookStore(db: Db): WebhookStore {
  return {
    transaction(callback) {
      return db.transaction((tx) => callback(createPostgresWebhookStore(tx as unknown as Db)))
    },
    async upsertInstallation(input) {
      const rows = await db
        .insert(githubInstallations)
        .values({
          githubInstallationId: input.githubInstallationId,
          accountLogin: input.accountLogin,
          accountType: input.accountType,
        })
        .onConflictDoUpdate({
          target: githubInstallations.githubInstallationId,
          set: { accountLogin: input.accountLogin, updatedAt: new Date() },
        })
        .returning({ id: githubInstallations.id })

      const id = rows[0]?.id
      if (!id) throw new Error('Could not upsert the GitHub installation')
      return id
    },

    /** Keyed on the numeric repo id so a rename or transfer updates in place. */
    async upsertRepository(input) {
      const rows = await db
        .insert(repositories)
        .values({
          installationId: input.installationId,
          githubRepoId: input.githubRepoId,
          owner: input.owner,
          name: input.name,
          defaultBranch: input.defaultBranch,
        })
        .onConflictDoUpdate({
          target: repositories.githubRepoId,
          set: {
            installationId: input.installationId,
            owner: input.owner,
            name: input.name,
            defaultBranch: input.defaultBranch,
            updatedAt: new Date(),
          },
        })
        .returning({ id: repositories.id })

      const id = rows[0]?.id
      if (!id) throw new Error('Could not upsert the repository')
      return id
    },

    async recordDelivery(input) {
      const rows = await db
        .insert(webhookDeliveries)
        .values({
          githubDeliveryId: input.deliveryId,
          eventType: input.eventType,
          installationId: input.installationId,
          repositoryId: input.repositoryId,
          payloadDigest: input.payloadDigest,
        })
        .onConflictDoNothing({ target: webhookDeliveries.githubDeliveryId })
        .returning({ id: webhookDeliveries.id })

      return rows.length > 0
    },

    async markDeliveryProcessed(deliveryId, status) {
      await db
        .update(webhookDeliveries)
        .set({ processingStatus: status, processedAt: new Date() })
        .where(eq(webhookDeliveries.githubDeliveryId, deliveryId))
    },

    async createQueuedRun(input) {
      return db.transaction(async (tx) => {
        const rows = await tx
          .insert(runs)
          .values({
            id: input.runId,
            repositoryId: input.repositoryId,
            sourceSha: input.sourceSha,
            targetBranch: `adamant/${input.runId}`,
            idempotencyKey: input.idempotencyKey,
            status: 'queued',
          })
          .onConflictDoNothing()
          .returning({ id: runs.id })

        const runId = rows[0]?.id
        if (!runId) return null
        await tx.execute(sql`select graphile_worker.add_job(
          'graph_step', json_build_object('runId', ${runId})::json,
          job_key := ${runId}, max_attempts := 3
        )`)
        return runId
      })
    },

    async findRunByPullRequest(repositoryId, prNumber) {
      const rows = await db
        .select({ runId: prPublications.runId })
        .from(prPublications)
        .where(
          and(
            eq(prPublications.repositoryId, repositoryId),
            eq(prPublications.githubPrNumber, prNumber),
          ),
        )
        .limit(1)

      return rows[0]?.runId ?? null
    },

    async recordAudit(runId, eventType, payload) {
      await db.insert(auditEvents).values({ runId, eventType, payload })
    },
  }
}

export interface MemoryWebhookStore extends WebhookStore {
  readonly deliveries: Map<string, DeliveryInput>
  readonly queuedRuns: QueuedRunInput[]
  readonly enqueuedRuns: string[]
  readonly audits: { runId: string | null; eventType: string }[]
  /** Seeded by tests so a merged-PR delivery can find a run. */
  readonly publishedPrs: Map<string, string>
}

export function createMemoryWebhookStore(): MemoryWebhookStore {
  const deliveries = new Map<string, DeliveryInput>()
  const queuedRuns: QueuedRunInput[] = []
  const enqueuedRuns: string[] = []
  const audits: { runId: string | null; eventType: string }[] = []
  const publishedPrs = new Map<string, string>()
  const installations = new Map<number, string>()
  const repos = new Map<number, string>()
  const idempotencyKeys = new Set<string>()

  const store: MemoryWebhookStore = {
    deliveries,
    queuedRuns,
    enqueuedRuns,
    audits,
    publishedPrs,
    transaction(callback) {
      return callback(store)
    },
    async upsertInstallation(input) {
      const existing = installations.get(input.githubInstallationId)
      if (existing) return existing
      const id = `installation-${input.githubInstallationId}`
      installations.set(input.githubInstallationId, id)
      return id
    },
    async upsertRepository(input) {
      const existing = repos.get(input.githubRepoId)
      if (existing) return existing
      const id = `repository-${input.githubRepoId}`
      repos.set(input.githubRepoId, id)
      return id
    },
    async recordDelivery(input) {
      if (deliveries.has(input.deliveryId)) return false
      deliveries.set(input.deliveryId, input)
      return true
    },
    async markDeliveryProcessed() {},
    async createQueuedRun(input) {
      if (idempotencyKeys.has(input.idempotencyKey)) return null
      idempotencyKeys.add(input.idempotencyKey)
      queuedRuns.push(input)
      enqueuedRuns.push(input.runId)
      return input.runId
    },
    async findRunByPullRequest(repositoryId, prNumber) {
      return publishedPrs.get(`${repositoryId}#${prNumber}`) ?? null
    },
    async recordAudit(runId, eventType) {
      audits.push({ runId, eventType })
    },
  }
  return store
}
