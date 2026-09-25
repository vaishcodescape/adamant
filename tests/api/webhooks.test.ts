import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { afterEach, describe, it } from 'node:test'
import { github } from '../../server/api/webhooks/github.ts'
import { WebhookService } from '../../server/api/services/webhookService.ts'

const secret = 'test-webhook-secret'

function sign(body: string) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
}

function post(body: string, headers: Record<string, string>) {
  return github.request('/', {
    method: 'POST',
    body,
    headers,
  })
}

async function withSecret(fn: () => Promise<void>) {
  const previous = process.env.GITHUB_WEBHOOK_SECRET
  process.env.GITHUB_WEBHOOK_SECRET = secret
  try {
    await fn()
  } finally {
    if (previous === undefined) delete process.env.GITHUB_WEBHOOK_SECRET
    else process.env.GITHUB_WEBHOOK_SECRET = previous
  }
}

describe('GitHub webhook', () => {
  afterEach(() => {
    delete process.env.GITHUB_WEBHOOK_SECRET
  })

  it('refuses to accept deliveries when the webhook secret is unset', async () => {
    delete process.env.GITHUB_WEBHOOK_SECRET
    const response = await post('{}', {
      'x-github-delivery': 'delivery-no-secret',
      'x-github-event': 'ping',
      'x-hub-signature-256': 'sha256=abc',
    })

    assert.equal(response.status, 500)
    assert.deepEqual(await response.json(), { error: 'Server configuration error' })
  })

  it('rejects a missing delivery id and a bad signature', async () => {
    await withSecret(async () => {
      const missing = await post('{}', {
        'x-github-event': 'ping',
        'x-hub-signature-256': sign('{}'),
      })
      assert.equal(missing.status, 400)

      const body = JSON.stringify({ zen: 'keep it logically awesome' })
      const bad = await post(body, {
        'x-github-delivery': 'delivery-bad-sig',
        'x-github-event': 'ping',
        'x-hub-signature-256': 'sha256=deadbeef',
      })
      assert.equal(bad.status, 401)
      assert.deepEqual(await bad.json(), { error: 'Invalid signature' })
    })
  })

  it('rejects a signed body that is not JSON', async () => {
    await withSecret(async () => {
      const body = '{not-json'
      const response = await post(body, {
        'x-github-delivery': 'delivery-bad-json',
        'x-github-event': 'ping',
        'x-hub-signature-256': sign(body),
      })
      assert.equal(response.status, 400)
    })
  })

  it('accepts a signed ping and ignores a replay of the same delivery', async () => {
    await withSecret(async () => {
      const body = JSON.stringify({ zen: 'keep it logically awesome' })
      const headers = {
        'x-github-delivery': 'delivery-ping',
        'x-github-event': 'ping',
        'x-hub-signature-256': sign(body),
      }
      const first = await post(body, headers)
      const second = await post(body, headers)

      assert.equal(first.status, 202)
      assert.deepEqual(await first.json(), { message: 'Accepted' })
      assert.equal(second.status, 202)
      assert.deepEqual(await second.json(), { message: 'Duplicate delivery ignored' })
    })
  })

  it('starts a run only for a completed failing workflow', async () => {
    const failed = await WebhookService.processEvent('delivery-red', 'workflow_run', {
      action: 'completed',
      workflow_run: { conclusion: 'failure' },
    })
    const passed = await WebhookService.processEvent('delivery-green', 'workflow_run', {
      action: 'completed',
      workflow_run: { conclusion: 'success' },
    })
    const running = await WebhookService.processEvent('delivery-running', 'workflow_run', {
      action: 'requested',
      workflow_run: { conclusion: 'failure' },
    })

    assert.match(failed.runId ?? '', /^[0-9a-f-]{36}$/i)
    assert.equal(passed.runId, null)
    assert.equal(running.runId, null)
    await assert.rejects(
      WebhookService.processEvent('delivery-red', 'workflow_run', {
        action: 'completed',
        workflow_run: { conclusion: 'failure' },
      }),
      /Duplicate delivery/,
    )
  })

  it('records a merged pull request without starting a heal run', async () => {
    const merged = await WebhookService.processEvent('delivery-merged', 'pull_request', {
      action: 'closed',
      pull_request: { merged: true, number: 42 },
    })
    const opened = await WebhookService.processEvent('delivery-opened', 'pull_request', {
      action: 'opened',
      pull_request: { merged: false, number: 43 },
    })

    assert.equal(merged.runId, null)
    assert.equal(opened.runId, null)
  })
})
