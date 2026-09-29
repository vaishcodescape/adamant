import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

export const oauthStates = pgTable(
  'oauth_states',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    state: text('state').notNull(),

    provider: text('provider').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('oauth_states_state_uidx').on(table.state),
    check('oauth_states_provider_check', sql`${table.provider} in ('github', 'google')`),
    index('oauth_states_expires_at_idx').on(table.expiresAt),
  ],
)
