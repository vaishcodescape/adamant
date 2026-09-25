import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { runs } from './runs.ts'

/**
 * 1:1 with `runs` (UNIQUE runId), update-in-place. ASSUMPTION: triage happens once,
 * early in a run's life, based on the baseline (attempt 0) sandbox result. A
 * `changes_requested` loop re-attempts patch generation but does NOT re-triage —
 * the failure category doesn't change just because a candidate was rejected. If
 * re-triage per attempt is ever needed, this becomes a history table keyed by
 * (runId, attemptNumber) instead of a 1:1 snapshot — flagged in trade-offs.
 */
export const triageResults = pgTable(
  'triage_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    parsedError: text('parsed_error'),
    filePath: text('file_path'),
    lineNumber: integer('line_number'),
    failingTests: jsonb('failing_tests')
      .notNull()
      .default(sql`'[]'::jsonb`),
    category: text('category').notNull(),
    reasonCode: text('reason_code').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('triage_results_run_id_uidx').on(table.runId),
    check('triage_results_category_check', sql`${table.category} in ('repairable','report_only')`),
  ],
)

/**
 * Kept separate from `sandbox_results` even though both share the (runId,
 * attemptNumber) key space: a patch_attempts row is written at GENERATION time and
 * can fail before a candidate ever reaches the sandbox (e.g. malformed diff, policy
 * violation). A sandbox_results row for attemptNumber > 0 only exists if generation
 * succeeded and validation actually ran. Merging the two tables would force nullable
 * "not yet validated" columns onto every generation-only failure — separate tables
 * model the two lifecycle stages honestly.
 */
export const patchAttempts = pgTable(
  'patch_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    attemptNumber: integer('attempt_number').notNull(),
    candidateHash: text('candidate_hash').notNull(),
    outcome: text('outcome').notNull(),
    failureReason: text('failure_reason'),
    // ASSUMPTION: patch diffs are small (bounded by the project's own file/line caps),
    // so storing them inline as TEXT is safe. If that assumption changes, switch to an
    // artifactRef pointer, matching the sandbox_results log pattern.
    patchDiff: text('patch_diff'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('patch_attempts_run_attempt_uidx').on(table.runId, table.attemptNumber),
    check(
      'patch_attempts_outcome_check',
      sql`${table.outcome} in ('success','failed_validation','generation_error')`,
    ),
  ],
)
