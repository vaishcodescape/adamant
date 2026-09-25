import { pgTable, uuid, text, timestamp, uniqueIndex, index, check } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { githubInstallations, repositories } from './github.ts'

/**
 * Deduplication is enforced by the UNIQUE index on `githubDeliveryId` alone — GitHub
 * guarantees this ID (the X-GitHub-Delivery header, a UUID string) is unique per
 * delivery attempt, including retried deliveries of the *same* logical event, which
 * is exactly the case we need to catch. Insert with
 * `ON CONFLICT (github_delivery_id) DO NOTHING`; zero rows affected means "already
 * seen" — ACK without reprocessing. This is a database guarantee, not app logic.
 *
 * Only a payload digest (SHA-256 of the raw body) is stored, never the raw payload —
 * it exists purely for debugging/integrity checks, not for replaying event content.
 */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    githubDeliveryId: text('github_delivery_id').notNull(),
    eventType: text('event_type').notNull(),
    installationId: uuid('installation_id').references(() => githubInstallations.id, {
      onDelete: 'set null',
    }),
    repositoryId: uuid('repository_id').references(() => repositories.id, { onDelete: 'set null' }),
    payloadDigest: text('payload_digest'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    processingStatus: text('processing_status').notNull().default('received'),
  },
  (table) => [
    uniqueIndex('webhook_deliveries_delivery_id_uidx').on(table.githubDeliveryId),
    index('webhook_deliveries_repository_id_idx').on(table.repositoryId),
    check(
      'webhook_deliveries_processing_status_check',
      sql`${table.processingStatus} in ('received','processed','ignored','failed')`,
    ),
  ],
)
