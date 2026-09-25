import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  uniqueIndex,
  index,
  check,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { repositories } from './github.ts'
import { users } from './users.ts'

/**
 * STATUS DESIGN DECISION: text + CHECK, not a native Postgres ENUM. Enum values will
 * change during active development; ALTER TYPE ... ADD VALUE has transactional
 * restrictions in older Postgres versions and is more disruptive than shipping a new
 * CHECK constraint. Zod (A2) is the actual compile-time/runtime type guard for status
 * values in application code — the DB CHECK exists as a last-resort integrity net.
 *
 * STATUS SET: intentionally coarse-grained. Fine-grained node position within the
 * LangGraph pipeline (retrieve/triage/reproduce/diagnose/patch/validate) is already
 * tracked by LangGraph's own Postgres checkpointer (thread_id = runs.id) — duplicating
 * that here would create two sources of truth. `runs.status` answers "what does the
 * API/dashboard show," not "which graph node is executing right now."
 *
 * IDEMPOTENCY: enforced by a partial unique index on (repositoryId, idempotencyKey)
 * WHERE idempotencyKey IS NOT NULL. Scoped to repository (not global) because an
 * idempotency key is a caller-chosen string meaningful only within one caller's
 * context. NULL is excluded from the constraint so webhook-triggered runs (which
 * have no client-supplied key) never collide with each other.
 *
 * VERSION: a plain integer, incremented by the application inside every
 * state-changing UPDATE using `WHERE id = $1 AND version = $2` (optimistic
 * concurrency). If zero rows are affected, the caller's view was stale — surface a
 * 409 rather than silently applying a decision made against outdated state.
 */
export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'restrict' }),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    idempotencyKey: text('idempotency_key'),
    sourceSha: text('source_sha').notNull(),
    targetBranch: text('target_branch').notNull(),
    status: text('status').notNull().default('queued'),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('runs_repo_idempotency_key_uidx')
      .on(table.repositoryId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
    index('runs_repository_created_idx').on(table.repositoryId, table.createdAt),
    index('runs_pending_status_idx')
      .on(table.status)
      .where(sql`${table.status} in ('queued','running')`),
    check(
      'runs_status_check',
      sql`${table.status} in (
        'queued','running','report_only','awaiting_hitl',
        'changes_requested','publishing','succeeded','aborted','failed'
      )`,
    ),
  ],
)
