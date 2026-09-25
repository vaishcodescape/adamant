import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { getTableColumns, getTableName } from 'drizzle-orm'
import { createDb } from '../../server/db/client.ts'
import * as schema from '../../server/db/schema/index.ts'

describe('database schema', () => {
  it('exports the Phase 1 tables and no jobs table', () => {
    const names = [
      schema.users,
      schema.sessions,
      schema.githubInstallations,
      schema.repositories,
      schema.webhookDeliveries,
      schema.runs,
      schema.sandboxResults,
      schema.triageResults,
      schema.patchAttempts,
      schema.hitlDecisions,
      schema.approvals,
      schema.prPublications,
      schema.toolInvocations,
      schema.auditEvents,
    ].map((table) => getTableName(table))

    assert.deepEqual(names.sort(), [
      'approvals',
      'audit_events',
      'github_installations',
      'hitl_decisions',
      'patch_attempts',
      'pr_publications',
      'repositories',
      'runs',
      'sandbox_results',
      'sessions',
      'tool_invocations',
      'triage_results',
      'users',
      'webhook_deliveries',
    ])
    assert.equal('jobs' in schema, false)
  })

  it('keeps run identity on source sha, target branch, status, and version', () => {
    const columns = getTableColumns(schema.runs)
    assert.equal(columns.sourceSha?.notNull, true)
    assert.equal(columns.targetBranch?.notNull, true)
    assert.equal(columns.status?.notNull, true)
    assert.equal(columns.version?.notNull, true)
    assert.equal(Object.hasOwn(columns, 'baseSha'), false)
  })

  it('refuses to open a client without DATABASE_URL', () => {
    assert.throws(() => createDb(''), /DATABASE_URL is required/)
  })
})
