import { and, desc, eq, isNull, or } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import {
  AuditEventSchema,
  RunDetailSchema,
  RunSummarySchema,
  type AuditEvent,
  type RunDetail,
  type RunSummary,
} from '@adamant/contract'
import { auditEvents, createDb, repositories, runs, type Db } from '../../db/client.ts'
import { enqueueGraphStep } from './jobs.ts'

export type CreateRunInput = {
  repositoryId: string
  sourceSha: string
  idempotencyKey: string
  userId: string
}

/** The repository id is not a known repository. The route answers 404, not 500. */
export class UnknownRepositoryError extends Error {
  constructor() {
    super('Repository not found')
    this.name = 'UnknownRepositoryError'
  }
}

/** Newest first. The CLI pages nothing yet, so the list is bounded here. */
export const RUN_LIST_LIMIT = 100

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FOREIGN_KEY_VIOLATION = '23503'

function isForeignKeyViolation(error: unknown): boolean {
  const cause = error instanceof Error && 'cause' in error ? error.cause : error
  return (cause as { code?: unknown } | null)?.code === FOREIGN_KEY_VIOLATION
}

/**
 * A user sees the runs they started and the runs the GitHub App started
 * (no creator). Webhook heals are the main Phase 1 path, and `/activity`
 * already shows them to every session; scoping on the creator alone hid
 * every one of them from `adamant runs`.
 */
function visibleTo(userId: string) {
  return or(eq(runs.createdByUserId, userId), isNull(runs.createdByUserId))
}

export interface RunApiStore {
  create(input: CreateRunInput): Promise<{ run: RunSummary; created: boolean }>
  list(userId: string): Promise<readonly RunSummary[]>
  detail(userId: string, runId: string): Promise<RunDetail | null>
}

function toRunSummary(run: typeof runs.$inferSelect): RunSummary {
  return RunSummarySchema.parse({
    id: run.id,
    repositoryId: run.repositoryId,
    sourceSha: run.sourceSha,
    targetBranch: run.targetBranch,
    status: run.status,
    version: run.version,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  })
}

function toAuditEvent(event: typeof auditEvents.$inferSelect): AuditEvent {
  return AuditEventSchema.parse({
    id: event.id,
    runId: event.runId,
    eventType: event.eventType,
    payload: event.payload,
    actorUserId: event.actorUserId,
    createdAt: event.createdAt.toISOString(),
  })
}

export function createPostgresRunApiStore(db: Db): RunApiStore {
  return {
    async create(input) {
      if (!UUID.test(input.repositoryId)) throw new UnknownRepositoryError()

      return db.transaction(async (tx) => {
        const runId = randomUUID()
        const inserted = await tx
          .insert(runs)
          .values({
            id: runId,
            repositoryId: input.repositoryId,
            createdByUserId: input.userId,
            sourceSha: input.sourceSha,
            targetBranch: `adamant/${runId}`,
            idempotencyKey: input.idempotencyKey,
            status: 'queued',
          })
          .onConflictDoNothing()
          .returning()
          .catch((error: unknown) => {
            if (isForeignKeyViolation(error)) throw new UnknownRepositoryError()
            throw error
          })

        const created = inserted[0]
        if (created) {
          await enqueueGraphStep(tx, runId)
          return { run: toRunSummary(created), created: true }
        }

        const existing = await tx
          .select()
          .from(runs)
          .where(
            and(
              eq(runs.repositoryId, input.repositoryId),
              eq(runs.idempotencyKey, input.idempotencyKey),
            ),
          )
          .limit(1)
        const run = existing[0]
        if (!run) throw new Error('Idempotent run lookup failed after insert conflict')
        return { run: toRunSummary(run), created: false }
      })
    },

    list(userId) {
      return db
        .select()
        .from(runs)
        .where(visibleTo(userId))
        .orderBy(desc(runs.createdAt))
        .limit(RUN_LIST_LIMIT)
        .then((rows) => rows.map(toRunSummary))
    },

    async detail(userId, runId) {
      // Not a uuid cannot name a run; asking Postgres would be a 500.
      if (!UUID.test(runId)) return null

      const rows = await db
        .select()
        .from(runs)
        .where(and(eq(runs.id, runId), visibleTo(userId)))
        .limit(1)
      const run = rows[0]
      if (!run) return null
      const events = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.runId, runId))
        .orderBy(auditEvents.createdAt)
      return RunDetailSchema.parse({
        run: toRunSummary(run),
        auditEvents: events.map(toAuditEvent),
      })
    },
  }
}

export function createDefaultRunApiStore(): RunApiStore {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is required for run routes')
  return createPostgresRunApiStore(createDb(url))
}

export async function repositoryExists(store: Db, repositoryId: string): Promise<boolean> {
  const rows = await store
    .select({ id: repositories.id })
    .from(repositories)
    .where(eq(repositories.id, repositoryId))
    .limit(1)
  return rows.length > 0
}
