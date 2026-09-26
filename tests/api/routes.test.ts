import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { createRunsRoute } from '../../server/api/routes/runs.ts'
import { type RunApiStore } from '../../server/api/services/runStore.ts'

const session = 'cli-session'
const userId = '00000000-0000-0000-0000-000000000001'
const run = {
  id: 'run-1',
  repositoryId: 'repo-1',
  createdByUserId: userId,
  idempotencyKey: 'key-1',
  sourceSha: 'abc',
  targetBranch: 'adamant/run-1',
  status: 'queued',
  version: 1,
  createdAt: new Date(0),
  updatedAt: new Date(0),
}

describe('CLI run routes', () => {
  afterEach(() => {
    delete process.env.ADAMANT_SESSION_SECRET
    delete process.env.ADAMANT_SEED_USER_ID
  })
  it('authenticates and creates, lists, and reads persisted runs', async () => {
    const store = {
      create: async () => ({ run, created: true }),
      list: async () => [run],
      detail: async () => ({ run, auditEvents: [] }),
    } satisfies RunApiStore
    const route = createRunsRoute(store)
    process.env.ADAMANT_SESSION_SECRET = session
    process.env.ADAMANT_SEED_USER_ID = userId
    assert.equal((await route.request('/')).status, 401)
    const headers = { ADAMANT_SESSION: session }
    assert.equal((await route.request('/', { headers })).status, 200)
    assert.equal(
      (
        await route.request('/', {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': 'key-1' },
          body: JSON.stringify({ repositoryId: 'repo-1', sourceSha: 'abc' }),
        })
      ).status,
      202,
    )
    assert.equal((await route.request('/run-1', { headers })).status, 200)
  })
})
