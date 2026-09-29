import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { createServerApp } from '../../server/api/server.ts'
import { createActivityService } from '../../server/api/services/activityService.ts'

const SESSION = 'test-session-secret'
const SEED_USER_ID = '00000000-0000-0000-0000-000000000001'

async function readStreamText(
  stream: ReadableStream<Uint8Array>,
  maxBytes = 4096,
): Promise<string> {
  const reader = stream.getReader()
  let text = ''
  const decoder = new TextDecoder()

  while (text.length < maxBytes) {
    const { done, value } = await reader.read()
    if (done || !value) break
    text += decoder.decode(value, { stream: true })
    if (text.includes('\n\n')) break
  }

  reader.releaseLock()
  return text
}

describe('Activity SSE Stream', () => {
  beforeEach(() => {
    process.env.ADAMANT_SESSION_SECRET = SESSION
    process.env.ADAMANT_SEED_USER_ID = SEED_USER_ID
  })

  afterEach(() => {
    delete process.env.ADAMANT_SESSION_SECRET
    delete process.env.ADAMANT_SEED_USER_ID
  })

  it('unauthenticated request returns 401', async () => {
    const app = createServerApp()
    const res = await app.request('/activity')
    assert.equal(res.status, 401)
  })

  it('authenticated request succeeds', async () => {
    const app = createServerApp()
    const res = await app.request('/activity', {
      headers: { ADAMANT_SESSION: SESSION },
    })
    assert.equal(res.status, 200)
  })

  it('SSE response headers/content type are correct', async () => {
    const app = createServerApp()
    const res = await app.request('/activity', {
      headers: { ADAMANT_SESSION: SESSION },
    })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/)
    assert.match(res.headers.get('cache-control') ?? '', /no-cache/)
  })

  it('persisted activity is streamed with correct event IDs and types', async () => {
    const activityService = createActivityService()
    activityService.publish({
      id: 'wh_deliv-1',
      type: 'webhook:workflow_run',
      timestamp: '2026-09-29T10:00:00.000Z',
      payload: { deliveryId: 'deliv-1', status: 'completed' },
    })

    const app = createServerApp(undefined, { activityService })
    const res = await app.request('/activity', {
      headers: { ADAMANT_SESSION: SESSION },
    })

    assert.equal(res.status, 200)
    assert.ok(res.body)
    const bodyText = await readStreamText(res.body)

    assert.match(bodyText, /id: wh_deliv-1/)
    assert.match(bodyText, /event: webhook:workflow_run/)
    assert.match(bodyText, /"deliveryId":"deliv-1"/)
  })

  it('new activity reaches connected clients', async () => {
    const activityService = createActivityService()
    const app = createServerApp(undefined, { activityService })

    const controller = new AbortController()
    const res = await app.request('/activity', {
      headers: { ADAMANT_SESSION: SESSION },
      signal: controller.signal,
    })

    assert.equal(res.status, 200)
    assert.ok(res.body)
    const reader = res.body.getReader()

    // Publish new activity after connection established
    activityService.publish({
      id: 'audit_event-100',
      type: 'audit:run.queued',
      timestamp: new Date().toISOString(),
      payload: { runId: 'run-100', sourceSha: 'sha100' },
    })

    const chunk = await reader.read()
    assert.ok(!chunk.done)
    const text = new TextDecoder().decode(chunk.value)

    assert.match(text, /id: audit_event-100/)
    assert.match(text, /event: audit:run\.queued/)
    assert.match(text, /"runId":"run-100"/)

    reader.releaseLock()
    controller.abort()
  })

  it('disconnect removes the subscription/listener', async () => {
    const activityService = createActivityService()
    const app = createServerApp(undefined, { activityService })

    assert.equal(activityService.subscriberCount(), 0)

    const controller = new AbortController()
    const res = await app.request('/activity', {
      headers: { ADAMANT_SESSION: SESSION },
      signal: controller.signal,
    })

    assert.equal(res.status, 200)
    assert.equal(activityService.subscriberCount(), 1)

    // Abort stream / disconnect client
    controller.abort()

    // Give microtask tick for abort cleanup to run
    await new Promise((resolve) => setTimeout(resolve, 10))

    assert.equal(activityService.subscriberCount(), 0)
  })

  it('reconnect/replay using Last-Event-ID works and does not duplicate the boundary event', async () => {
    const activityService = createActivityService()
    activityService.publish({
      id: 'evt_1',
      type: 'audit:step_1',
      timestamp: '2026-09-29T10:00:00.000Z',
      payload: { step: 1 },
    })
    activityService.publish({
      id: 'evt_2',
      type: 'audit:step_2',
      timestamp: '2026-09-29T10:01:00.000Z',
      payload: { step: 2 },
    })
    activityService.publish({
      id: 'evt_3',
      type: 'audit:step_3',
      timestamp: '2026-09-29T10:02:00.000Z',
      payload: { step: 3 },
    })

    const app = createServerApp(undefined, { activityService })

    // Reconnect with Last-Event-ID: evt_2
    const res = await app.request('/activity', {
      headers: {
        ADAMANT_SESSION: SESSION,
        'Last-Event-ID': 'evt_2',
      },
    })

    assert.equal(res.status, 200)
    assert.ok(res.body)
    const bodyText = await readStreamText(res.body)

    // Boundary event evt_2 and earlier event evt_1 must NOT be replayed
    assert.doesNotMatch(bodyText, /id: evt_1/)
    assert.doesNotMatch(bodyText, /id: evt_2/)

    // Subsequent event evt_3 MUST be replayed
    assert.match(bodyText, /id: evt_3/)
    assert.match(bodyText, /event: audit:step_3/)
  })
})
