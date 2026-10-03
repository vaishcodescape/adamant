import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { type RunSummary } from '@adamant/contract'
import { createRunsRoute } from '../../server/api/routes/runs.ts'
import { type RunApiStore, UnknownRepositoryError } from '../../server/api/services/runStore.ts'

const session = 'cli-session'
const userId = '00000000-0000-0000-0000-000000000001'
const run: RunSummary = {
  id: 'run-1',
  repositoryId: 'repo-1',
  sourceSha: 'abc',
  targetBranch: 'adamant/run-1',
  status: 'queued',
  version: 1,
  createdAt: '1970-01-01T00:00:00.000Z',
  updatedAt: '1970-01-01T00:00:00.000Z',
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
          body: JSON.stringify({ repositoryId: 'repo-1', sourceSha: 'a'.repeat(40) }),
        })
      ).status,
      202,
    )
    assert.equal((await route.request('/run-1', { headers })).status, 200)
  })

  it('rejects a source that is not a full commit SHA before it reaches git', async () => {
    let created = 0
    const store = {
      create: async () => {
        created += 1
        return { run, created: true }
      },
      list: async () => [],
      detail: async () => null,
    } satisfies RunApiStore
    process.env.ADAMANT_SESSION_SECRET = session
    process.env.ADAMANT_SEED_USER_ID = userId
    const route = createRunsRoute(store)

    for (const sourceSha of ['abc123', '--upload-pack=touch /tmp/x', 'HEAD']) {
      const response = await route.request('/', {
        method: 'POST',
        headers: {
          ADAMANT_SESSION: session,
          'content-type': 'application/json',
          'idempotency-key': `key-${sourceSha}`,
        },
        body: JSON.stringify({ repositoryId: 'repo-1', sourceSha }),
      })
      assert.equal(response.status, 400, sourceSha)
    }
    assert.equal(created, 0)
  })

  it('answers 404, not 500, for a repository that does not exist', async () => {
    const store = {
      create: async () => {
        throw new UnknownRepositoryError()
      },
      list: async () => [],
      detail: async () => null,
    } satisfies RunApiStore
    process.env.ADAMANT_SESSION_SECRET = session
    process.env.ADAMANT_SEED_USER_ID = userId
    const route = createRunsRoute(store)

    const response = await route.request('/', {
      method: 'POST',
      headers: {
        ADAMANT_SESSION: session,
        'content-type': 'application/json',
        'idempotency-key': 'k',
      },
      body: JSON.stringify({ repositoryId: 'missing', sourceSha: 'a'.repeat(40) }),
    })

    assert.equal(response.status, 404)
  })
})
