import { and, desc, eq, sql } from 'drizzle-orm'
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

export type CreateRunInput = {
  repositoryId: string
  sourceSha: string
  idempotencyKey: string
  userId: string
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

        const created = inserted[0]
        if (created) {
          await tx.execute(sql`select graphile_worker.add_job(
            'graph_step', json_build_object('runId', ${runId})::json,
            job_key := ${runId}, max_attempts := 3
          )`)
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
        .where(eq(runs.createdByUserId, userId))
        .orderBy(desc(runs.createdAt))
        .then((rows) => rows.map(toRunSummary))
    },

    async detail(userId, runId) {
      const rows = await db
        .select()
        .from(runs)
        .where(and(eq(runs.id, runId), eq(runs.createdByUserId, userId)))
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
