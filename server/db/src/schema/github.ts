import { pgTable, uuid, text, bigint, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core'

/**
 * One table per concept (installation, repository), not one combined table, because
 * an installation can cover many repositories and the two have independent
 * lifecycles: an installation can be suspended while repository metadata (name,
 * default branch) still needs to be readable for historical runs.
 */
export const githubInstallations = pgTable(
  'github_installations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    githubInstallationId: bigint('github_installation_id', { mode: 'number' }).notNull(),
    accountLogin: text('account_login').notNull(),
    accountType: text('account_type').notNull(), // CHECK added in migration: 'User' | 'Organization'
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    suspendedAt: timestamp('suspended_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('github_installations_installation_id_uidx').on(table.githubInstallationId),
  ],
)

/**
 * `githubRepoId` (GitHub's numeric repo ID) is the canonical unique key, NOT
 * (owner, name) — GitHub repos can be renamed or transferred, and the numeric ID
 * survives that. On repository transfer/reinstall, the application should
 * upsert on `githubRepoId` and update `installationId` rather than inserting a
 * second row.
 */
export const repositories = pgTable(
  'repositories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    installationId: uuid('installation_id')
      .notNull()
      .references(() => githubInstallations.id, { onDelete: 'cascade' }),
    githubRepoId: bigint('github_repo_id', { mode: 'number' }).notNull(),
    owner: text('owner').notNull(),
    name: text('name').notNull(),
    defaultBranch: text('default_branch').notNull().default('main'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('repositories_github_repo_id_uidx').on(table.githubRepoId),
    uniqueIndex('repositories_owner_name_uidx').on(table.owner, table.name),
    index('repositories_installation_id_idx').on(table.installationId),
  ],
)
