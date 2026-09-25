import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { afterEach, describe, it } from 'node:test'
import { createServerApp } from '../../server/api/server.ts'

const session = 'server-session'
const webhookSecret = 'server-webhook-secret'

describe('composed API', () => {
  afterEach(() => {
    delete process.env.ADAMANT_SESSION_SECRET
    delete process.env.GITHUB_WEBHOOK_SECRET
  })

  it('leaves health open and requires a session for runs and activity', async () => {
    process.env.ADAMANT_SESSION_SECRET = session
    const app = createServerApp()

    assert.equal((await app.request('/health')).status, 200)

    const blocked = await app.request('/runs', {
      method: 'POST',
      body: JSON.stringify({
        repository_id: 'repo-1',
        created_by_user_id: 'user-1',
        base_sha: 'abc123',
        source_sha: 'abc123',
        target_branch: 'main',
      }),
      headers: { 'content-type': 'application/json' },
    })
    assert.equal(blocked.status, 401)

    const created = await app.request('/runs', {
      method: 'POST',
      body: JSON.stringify({
        repository_id: 'repo-1',
        created_by_user_id: 'user-1',
        base_sha: 'abc123',
        source_sha: 'abc123',
        target_branch: 'main',
      }),
      headers: { 'content-type': 'application/json', ADAMANT_SESSION: session },
    })
    assert.equal(created.status, 201)
    const body = (await created.json()) as { data: { status: string } }
    assert.equal(body.data.status, 'queued')

    const activity = await app.request('/activity', {
      headers: { ADAMANT_SESSION: session },
    })
    assert.equal(activity.status, 200)
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
