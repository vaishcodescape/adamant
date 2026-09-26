import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { afterEach, describe, it } from 'node:test'
import { createServerApp } from '../../server/api/server.ts'
import { type RunApiStore } from '../../server/api/services/runStore.ts'

const session = 'cli-session'
const userId = '00000000-0000-0000-0000-000000000001'
const webhookSecret = 'webhook-secret'

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
    delete process.env.GITHUB_WEBHOOK_SECRET
  })
  it('leaves health open and protects runs', async () => {
    process.env.ADAMANT_SESSION_SECRET = session
    process.env.ADAMANT_SEED_USER_ID = userId
    const app = createServerApp(store)
    assert.equal((await app.request('/health')).status, 200)

    assert.equal((await app.request('/runs')).status, 401)
    assert.equal(
      (await app.request('/runs', { headers: { ADAMANT_SESSION: session } })).status,
      200,
    )

    const activity = await app.request('/activity', {
      headers: { ADAMANT_SESSION: session },
    })
    assert.equal(activity.status, 200)
  })

  it('requires a session for every schema resource, not only /runs', async () => {
    process.env.ADAMANT_SESSION_SECRET = session
    process.env.ADAMANT_SEED_USER_ID = userId
    const app = createServerApp()

    const blockedRead = await app.request('/sessions')
    assert.equal(blockedRead.status, 401)

    const blockedForgedSandboxPass = await app.request('/sandbox-results', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        run_id: 'run-1',
        attempt_number: 1,
        candidate_hash: 'fake',
        base_sha: 'abc123',
        commands: ['npm test'],
        verdict: 'pass',
        exit_code: 0,
        artifact_ref: 'fake',
      }),
    })
    assert.equal(blockedForgedSandboxPass.status, 401)

    const allowed = await app.request('/sandbox-results', {
      headers: { ADAMANT_SESSION: session },
    })
    assert.equal(allowed.status, 200)
  })

  it('accepts a signed GitHub delivery without a CLI session', async () => {
    process.env.GITHUB_WEBHOOK_SECRET = webhookSecret
    const app = createServerApp()
    const body = JSON.stringify({ zen: 'hello' })
    const signature = `sha256=${createHmac('sha256', webhookSecret).update(body).digest('hex')}`
    const response = await app.request('/webhooks/github', {
      method: 'POST',
      body,
      headers: {
        'x-github-delivery': 'composed-ping',
        'x-github-event': 'ping',
        'x-hub-signature-256': signature,
      },
    })

    assert.equal(response.status, 202)
  })
})
