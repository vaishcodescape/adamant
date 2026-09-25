import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { afterEach, describe, it } from 'node:test'
import { createGithubWebhookRoute } from '../../server/api/webhooks/github.ts'
import {
  createWebhookService,
  DuplicateDeliveryError,
} from '../../server/api/services/webhookService.ts'
import { createMemoryWebhookStore } from '../../server/api/services/webhookStore.ts'

const secret = 'test-webhook-secret'

const installation = { id: 99, account: { login: 'acme', type: 'Organization' } }
const repository = {
  id: 1234,
  name: 'eval',
  full_name: 'acme/eval',
  default_branch: 'main',
  owner: { login: 'acme' },
}

function service() {
  const store = createMemoryWebhookStore()
  const enqueued: string[] = []
  const webhooks = createWebhookService({
    store,
    queue: { enqueueGraphStep: async (runId) => void enqueued.push(runId) },
  })

  return { store, enqueued, webhooks }
}

function sign(body: string) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
}

function post(
  route: ReturnType<typeof createGithubWebhookRoute>,
  body: string,
  headers: Record<string, string>,
) {
  return route.request('/', { method: 'POST', body, headers })
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
    const response = await post(createGithubWebhookRoute(service().webhooks), '{}', {
      'x-github-delivery': 'delivery-no-secret',
      'x-github-event': 'ping',
      'x-hub-signature-256': 'sha256=abc',
    })

    assert.equal(response.status, 500)
    assert.deepEqual(await response.json(), { error: 'Server configuration error' })
  })

  it('rejects a missing delivery id and a bad signature', async () => {
    await withSecret(async () => {
      const route = createGithubWebhookRoute(service().webhooks)
      const missing = await post(route, '{}', {
        'x-github-event': 'ping',
        'x-hub-signature-256': sign('{}'),
      })
      assert.equal(missing.status, 400)

      const body = JSON.stringify({ zen: 'keep it logically awesome' })
      const bad = await post(route, body, {
        'x-github-delivery': 'delivery-bad-sig',
        'x-github-event': 'ping',
        'x-hub-signature-256': 'sha256=deadbeef',
      })
      assert.equal(bad.status, 401)
      assert.deepEqual(await bad.json(), { error: 'Invalid signature' })
    })
  })

  it('stores no delivery for a body that fails the signature check', async () => {
    await withSecret(async () => {
      const { store, webhooks } = service()
      const body = JSON.stringify({ zen: 'tampered' })
      const response = await post(createGithubWebhookRoute(webhooks), body, {
        'x-github-delivery': 'delivery-tampered',
        'x-github-event': 'ping',
        'x-hub-signature-256': sign('something else'),
      })

      assert.equal(response.status, 401)
      assert.equal(store.deliveries.size, 0)
    })
  })

  it('rejects a signed body that is not JSON', async () => {
    await withSecret(async () => {
      const body = '{not-json'
      const response = await post(createGithubWebhookRoute(service().webhooks), body, {
        'x-github-delivery': 'delivery-bad-json',
        'x-github-event': 'ping',
        'x-hub-signature-256': sign(body),
      })
      assert.equal(response.status, 400)
    })
  })

  it('accepts a signed ping and ignores a replay of the same delivery', async () => {
    await withSecret(async () => {
      const route = createGithubWebhookRoute(service().webhooks)
      const body = JSON.stringify({ zen: 'keep it logically awesome' })
      const headers = {
        'x-github-delivery': 'delivery-ping',
        'x-github-event': 'ping',
        'x-hub-signature-256': sign(body),
      }
      const first = await post(route, body, headers)
      const second = await post(route, body, headers)

      assert.equal(first.status, 202)
      assert.deepEqual(await first.json(), { message: 'Accepted' })
      assert.equal(second.status, 202)
      assert.deepEqual(await second.json(), { message: 'Duplicate delivery ignored' })
    })
  })
})

describe('webhook triggers a heal', () => {
  const failedWorkflow = {
    action: 'completed',
    installation,
    repository,
    workflow_run: { conclusion: 'failure', head_sha: 'deadbeef' },
  }

  it('queues a run and enqueues graph_step for a failed workflow run', async () => {
    const { store, enqueued, webhooks } = service()

    const result = await webhooks.processEvent('delivery-red', 'workflow_run', failedWorkflow)

    assert.match(result.runId ?? '', /^[0-9a-f-]{36}$/i)
    assert.deepEqual(enqueued, [result.runId])
    assert.equal(store.queuedRuns.length, 1)
    assert.deepEqual(
      {
        sourceSha: store.queuedRuns[0]?.sourceSha,
        repositoryId: store.queuedRuns[0]?.repositoryId,
        idempotencyKey: store.queuedRuns[0]?.idempotencyKey,
      },
      {
        sourceSha: 'deadbeef',
        repositoryId: 'repository-1234',
        idempotencyKey: 'webhook:delivery-red',
      },
    )
  })

  it('writes the delivery before the run, so a replay cannot start a second one', async () => {
    const { store, enqueued, webhooks } = service()

    await webhooks.processEvent('delivery-red', 'workflow_run', failedWorkflow)
    await assert.rejects(
      webhooks.processEvent('delivery-red', 'workflow_run', failedWorkflow),
      DuplicateDeliveryError,
    )

    assert.equal(store.queuedRuns.length, 1)
    assert.equal(enqueued.length, 1)
  })

  it('starts nothing for a green build or a workflow still running', async () => {
    const { store, enqueued, webhooks } = service()

    const green = await webhooks.processEvent('delivery-green', 'workflow_run', {
      ...failedWorkflow,
      workflow_run: { conclusion: 'success', head_sha: 'deadbeef' },
    })
    const running = await webhooks.processEvent('delivery-running', 'workflow_run', {
      ...failedWorkflow,
      action: 'requested',
    })

    assert.equal(green.runId, null)
    assert.equal(running.runId, null)
    assert.equal(store.queuedRuns.length, 0)
    assert.equal(enqueued.length, 0)
  })

  it('does not queue a run it cannot scope to a repository', async () => {
    const { store, enqueued, webhooks } = service()

    const result = await webhooks.processEvent('delivery-unbound', 'workflow_run', {
      action: 'completed',
      workflow_run: { conclusion: 'failure', head_sha: 'deadbeef' },
    })

    assert.equal(result.runId, null)
    assert.equal(store.queuedRuns.length, 0)
    assert.equal(enqueued.length, 0)
  })

  it('records a merged pull request of ours without starting a heal', async () => {
    const { store, enqueued, webhooks } = service()
    store.publishedPrs.set('repository-1234#42', 'run-1')

    const merged = await webhooks.processEvent('delivery-merged', 'pull_request', {
      action: 'closed',
      installation,
      repository,
      pull_request: { merged: true, number: 42 },
    })

    assert.equal(merged.runId, null)
    assert.equal(enqueued.length, 0)
    assert.deepEqual(store.audits, [{ runId: 'run-1', eventType: 'pull_request.merged' }])
  })

  it('keeps a merged pull request that is not ours for the CLI feed', async () => {
    const { store, enqueued, webhooks } = service()

    await webhooks.processEvent('delivery-theirs', 'pull_request', {
      action: 'closed',
      installation,
      repository,
      pull_request: { merged: true, number: 43 },
    })

    assert.deepEqual(store.audits, [{ runId: null, eventType: 'pull_request.merged' }])
    assert.equal(enqueued.length, 0)
    assert.equal(store.deliveries.has('delivery-theirs'), true)
  })

  it('ignores a pull request that closed without merging', async () => {
    const { store, webhooks } = service()

    await webhooks.processEvent('delivery-closed', 'pull_request', {
      action: 'closed',
      installation,
      repository,
      pull_request: { merged: false, number: 44 },
    })

    assert.deepEqual(store.audits, [])
  })

  it('binds the installation and repository from an installation event', async () => {
    const { store, webhooks } = service()

    await webhooks.processEvent('delivery-install', 'installation', {
      action: 'created',
      installation,
      repository,
    })

    assert.equal(store.deliveries.get('delivery-install')?.repositoryId, 'repository-1234')
    assert.equal(store.deliveries.get('delivery-install')?.installationId, 'installation-99')
  })
})
