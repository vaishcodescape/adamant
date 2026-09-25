import { pgTable, uuid, text, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core'

/**
 * ASSUMPTION: Authentication is GitHub-OAuth-based, matching the GitHub App-centric
 * design of the rest of the system. `githubUserId` is nullable only so the table stays
 * extensible if a second auth provider is ever added — in the current system every
 * row is expected to have one. If multi-provider auth becomes real, introduce a
 * separate `user_identities` table (user_id, provider, provider_user_id) instead of
 * adding more nullable provider columns here.
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
  (table) => [uniqueIndex('users_github_user_id_uidx').on(table.githubUserId)],
)

/**
 * Session tokens are never stored raw. The API generates an opaque random token,
 * returns it to the client once, and stores only its SHA-256 hash here. A session is
 * valid iff `revokedAt IS NULL AND expiresAt > now()` — enforced at the application
 * layer since PostgreSQL cannot express "compare to the current time" in a CHECK
 * constraint (CHECK constraints must be immutable at write time).
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
