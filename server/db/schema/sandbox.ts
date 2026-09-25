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
 * IDENTITY: UNIQUE(runId, attemptNumber) — not a compound key including
 * candidateHash. ASSUMPTION: `attemptNumber` is assigned once per candidate and is
 * never reused within a run (0 is reserved for the pre-patch baseline; 1..N are
 * candidate attempts in strictly increasing order). Under that assumption,
 * attemptNumber alone already identifies "one exact candidate at one attempt" — the
 * prompt's required invariant — without needing a redundant compound key. If that
 * assumption is ever violated (e.g. an attempt number gets retried/reused), this
 * constraint would need to become (runId, attemptNumber, candidateHash) instead. See
 * the design doc's trade-offs section for the consequence if this assumption breaks.
 *
 * The CHECK constraint ties attemptNumber=0 to candidateHash IS NULL (baseline has no
 * candidate yet) and attemptNumber>0 to candidateHash IS NOT NULL (every real
 * candidate attempt must be identified by its hash).
 *
 * `commands` is a small structured JSONB array of command strings — not the log
 * output itself. `artifactRef` is a pointer into external artifact storage for full
 * logs/output; large log content does not belong in this table or this database.
 */
export const sandboxResults = pgTable(
  'sandbox_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    attemptNumber: integer('attempt_number').notNull(),
    candidateHash: text('candidate_hash'),
    baseSha: text('base_sha').notNull(),
    commands: jsonb('commands')
      .notNull()
      .default(sql`'[]'::jsonb`),
    verdict: text('verdict').notNull(),
    exitCode: integer('exit_code'),
    artifactRef: text('artifact_ref'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('sandbox_results_run_attempt_uidx').on(table.runId, table.attemptNumber),
    check(
      'sandbox_results_verdict_check',
      sql`${table.verdict} in ('pass','fail','timeout','error')`,
    ),
    check(
      'sandbox_results_baseline_candidate_check',
      sql`(${table.attemptNumber} = 0 and ${table.candidateHash} is null)
          or (${table.attemptNumber} > 0 and ${table.candidateHash} is not null)`,
    ),
  ],
)
