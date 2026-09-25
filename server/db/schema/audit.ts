import { pgTable, uuid, text, timestamp, jsonb, index, check } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { runs } from './runs.ts'
import { repositories } from './github.ts'
import { users } from './users.ts'

/**
 * DISTINCTION FROM audit_events (below): tool_invocations is agent tool-call
 * telemetry — one row per external tool call the agent makes, with timing and
 * pass/fail outcome, primarily for agent debugging and enforcing the redaction
 * boundary. `inputRedacted` must already be redacted by the caller before insert —
 * secrets/tokens/API keys must never reach this table. `repositoryId` is stored
 * directly (denormalized from runs.repositoryId) so the scoping requirement is
 * visible in the row itself; NOTE: Postgres CHECK constraints cannot verify this
 * value actually matches the referenced run's repository — true enforcement of that
 * consistency requires a trigger (recommended as a hardening follow-up, not included
 * in this base schema) or a disciplined application-layer guarantee.
 */
export const toolInvocations = pgTable(
  'tool_invocations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'restrict' }),
    toolName: text('tool_name').notNull(),
    inputRedacted: jsonb('input_redacted')
      .notNull()
      .default(sql`'{}'::jsonb`),
    outcome: text('outcome').notNull(),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('tool_invocations_run_id_idx').on(table.runId, table.startedAt),
    check('tool_invocations_outcome_check', sql`${table.outcome} in ('success','failure')`),
  ],
)

/**
 * DISTINCTION FROM tool_invocations (above): audit_events is the broader
 * human-readable business-event history (state transitions, decisions, webhook
 * arrivals) used for compliance/traceability across the whole system — not tied to
 * "a tool call" as a concept. `runId` is nullable because some events are
 * system-level (e.g. a webhook arriving before any run exists). `payload` is
 * structured, redacted, event-specific detail (e.g. old/new status) — never raw
 * secrets or unredacted request/response bodies.
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'set null' }),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('audit_events_run_id_idx').on(table.runId, table.createdAt)],
)
