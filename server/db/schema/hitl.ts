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
import { runs } from './runs.ts'
import { users } from './users.ts'

/**
 * APPEND-ONLY LEDGER. Every approve/request_changes/abort action is recorded here
 * permanently and never updated or deleted — this is the audit trail proving what a
 * human actually decided and when. Enforcing true immutability requires either a
 * `REVOKE UPDATE, DELETE` grant on the application's DB role or a trigger that raises
 * on UPDATE/DELETE; neither is included in this base schema (avoiding
 * over-engineering before it's needed) but is flagged as a recommended hardening step
 * in the design doc's trade-offs section.
 */
export const hitlDecisions = pgTable(
  'hitl_decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    runVersion: integer('run_version').notNull(),
    candidateHash: text('candidate_hash'),
    baseSha: text('base_sha').notNull(),
    decidedByUserId: uuid('decided_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    action: text('action').notNull(),
    reason: text('reason'),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('hitl_decisions_run_id_idx').on(table.runId, table.decidedAt),
    check(
      'hitl_decisions_action_check',
      sql`${table.action} in ('approve','request_changes','abort')`,
    ),
  ],
)

/**
 * CURRENT-STATE SNAPSHOT. UNIQUE(runId) — at most one row per run, always upserted
 * (ON CONFLICT (run_id) DO UPDATE) rather than accumulating history, because history
 * already lives in `hitl_decisions` above. This table exists purely so "is there a
 * currently valid approval for run X" is an O(1) point lookup instead of a scan +
 * reduce over the full decision ledger every time it's checked (which happens on
 * every publish attempt).
 *
 * Validity is computed by the application by comparing this row's (runVersion,
 * candidateHash, baseSha, status) against the run's CURRENT values at read time —
 * Postgres CHECK constraints cannot reference another table's live data, so this
 * comparison is necessarily an application-level guarantee, backed by data this
 * schema stores specifically to make that comparison cheap and unambiguous.
 */
export const approvals = pgTable(
  'approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    runVersion: integer('run_version').notNull(),
    candidateHash: text('candidate_hash').notNull(),
    baseSha: text('base_sha').notNull(),
    decisionId: uuid('decision_id')
      .notNull()
      .references(() => hitlDecisions.id, { onDelete: 'restrict' }),
    status: text('status').notNull().default('active'),
    invalidatedAt: timestamp('invalidated_at', { withTimezone: true }),
    invalidatedReason: text('invalidated_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('approvals_run_id_uidx').on(table.runId),
    index('approvals_active_idx')
      .on(table.status)
      .where(sql`${table.status} = 'active'`),
    check('approvals_status_check', sql`${table.status} in ('active','invalidated')`),
    check(
      'approvals_invalidated_reason_check',
      sql`${table.invalidatedReason} is null or ${table.invalidatedReason} in (
        'request_changes','run_version_changed','candidate_changed','base_sha_changed'
      )`,
    ),
  ],
)
