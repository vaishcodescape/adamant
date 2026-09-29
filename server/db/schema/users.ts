import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

/**
 * Adamant user account.
 *
 * Authentication providers are stored separately in user_identities so that
 * one Adamant user can be linked to multiple providers.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    githubUserId: text('github_user_id'),

    username: text('username').notNull(),

    email: text('email'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('users_github_user_id_uidx').on(table.githubUserId),
    uniqueIndex('users_email_uidx').on(sql`lower(${table.email})`),
  ],
)

/**
 * OAuth identities linked to an Adamant user.
 *
 * We store only the provider identity, never OAuth access or refresh tokens.
 * A provider identity is unique by (provider, provider_user_id).
 */
export const userIdentities = pgTable(
  'user_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    provider: text('provider').notNull(),

    providerUserId: text('provider_user_id').notNull(),

    email: text('email'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('user_identities_provider_check', sql`${table.provider} in ('github', 'google')`),
    uniqueIndex('user_identities_provider_user_id_uidx').on(table.provider, table.providerUserId),
    index('user_identities_user_id_idx').on(table.userId),
  ],
)

/**
 * Session tokens are never stored raw.
 *
 * The API generates an opaque random token, returns it to the client once,
 * and stores only its SHA-256 hash here.
 *
 * A session is valid when:
 *   revoked_at IS NULL
 *   AND expires_at > now()
 *
 * The validity check is enforced by the application layer.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    tokenHash: text('token_hash').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),

    revokedAt: timestamp('revoked_at', { withTimezone: true }),

    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('sessions_token_hash_uidx').on(table.tokenHash),
    index('sessions_user_id_idx').on(table.userId),
  ],
)
