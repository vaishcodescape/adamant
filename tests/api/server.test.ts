import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { createServerApp } from '../../server/api/server.ts'
import { type RunApiStore } from '../../server/api/services/runStore.ts'

const store = {
  create: async () => {
    throw new Error('unused')
  },
  list: async () => [],
  detail: async () => null,
} satisfies RunApiStore

describe('composed API', () => {
  afterEach(() => {
    delete process.env.ADAMANT_SESSION_SECRET
    delete process.env.ADAMANT_SEED_USER_ID
  })
  it('leaves health open and protects runs', async () => {
    process.env.ADAMANT_SESSION_SECRET = 'secret'
    process.env.ADAMANT_SEED_USER_ID = '00000000-0000-0000-0000-000000000001'
    const app = createServerApp(store)
    assert.equal((await app.request('/health')).status, 200)
    assert.equal((await app.request('/runs')).status, 401)
    assert.equal(
      (await app.request('/runs', { headers: { ADAMANT_SESSION: 'secret' } })).status,
      200,
    )
  })
})
