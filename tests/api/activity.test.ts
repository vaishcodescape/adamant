import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { createServerApp } from '../../server/api/server.ts'
import { createActivityService } from '../../server/api/services/activityService.ts'
import type { Db } from '../../server/db/client.ts'

const SESSION = 'test-session-secret'
const SEED_USER_ID = '00000000-0000-0000-0000-000000000001'

const waitTick = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms))

async function readStreamFrame(
  stream: ReadableStream<Uint8Array>,
  maxBytes = 8192,
): Promise<string> {
  const reader = stream.getReader()
  let text = ''
  const decoder = new TextDecoder()

  try {
    while (text.length < maxBytes) {
      const { done, value } = await reader.read()
      if (done || !value) break
      text += decoder.decode(value, { stream: true })
      if (text.includes('\n\n') || text.includes('\r\n\r\n')) {
        break
      }
    }
  } finally {
    reader.releaseLock()
  }

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
    const controller = new AbortController()
    try {
      const app = createServerApp()
      const res = await app.request('/activity', {
        headers: { ADAMANT_SESSION: SESSION },
        signal: controller.signal,
      })
      assert.equal(res.status, 200)
    } finally {
      controller.abort()
    }
  })

  it('SSE response headers/content type are correct', async () => {
    const controller = new AbortController()
    try {
      const app = createServerApp()
      const res = await app.request('/activity', {
        headers: { ADAMANT_SESSION: SESSION },
        signal: controller.signal,
      })
      assert.equal(res.status, 200)
      assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/)
      assert.match(res.headers.get('cache-control') ?? '', /no-cache/)
    } finally {
      controller.abort()
    }
  })

  it('persisted activity is streamed with correct event IDs and types', async () => {
    const activityService = createActivityService()
    activityService.publish({
      id: 'wh_deliv-1',
      type: 'webhook:workflow_run',
      timestamp: '2026-09-29T10:00:00.000Z',
      payload: { deliveryId: 'deliv-1', status: 'completed' },
    })

    const controller = new AbortController()
    try {
      const app = createServerApp(undefined, { activityService })
      const res = await app.request('/activity', {
        headers: { ADAMANT_SESSION: SESSION },
        signal: controller.signal,
      })

      assert.equal(res.status, 200)
      assert.ok(res.body)
      const bodyText = await readStreamFrame(res.body)

      assert.match(bodyText, /id: wh_deliv-1/)
      assert.match(bodyText, /event: webhook:workflow_run/)
      assert.match(bodyText, /"deliveryId":"deliv-1"/)
    } finally {
      controller.abort()
      await waitTick()
      assert.equal(activityService.subscriberCount(), 0)
    }
  })

  it('new activity reaches connected clients', async () => {
    const activityService = createActivityService()
    const app = createServerApp(undefined, { activityService })

    const controller = new AbortController()
    try {
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
    } finally {
      controller.abort()
      await waitTick()
      assert.equal(activityService.subscriberCount(), 0)
    }
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

    await waitTick()

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

    const controller = new AbortController()
    try {
      const app = createServerApp(undefined, { activityService })

      // Reconnect with Last-Event-ID: evt_2
      const res = await app.request('/activity', {
        headers: {
          ADAMANT_SESSION: SESSION,
          'Last-Event-ID': 'evt_2',
        },
        signal: controller.signal,
      })

      assert.equal(res.status, 200)
      assert.ok(res.body)
      const bodyText = await readStreamFrame(res.body)

      // Boundary event evt_2 and earlier event evt_1 must NOT be replayed
      assert.doesNotMatch(bodyText, /id: evt_1/)
      assert.doesNotMatch(bodyText, /id: evt_2/)

      // Subsequent event evt_3 MUST be replayed
      assert.match(bodyText, /id: evt_3/)
      assert.match(bodyText, /event: audit:step_3/)
    } finally {
      controller.abort()
      await waitTick()
      assert.equal(activityService.subscriberCount(), 0)
    }
  })

  it('preserves and orders events that share the same timestamp by ID', async () => {
    const activityService = createActivityService()
    activityService.publish({
      id: 'evt_b',
      type: 'audit:step_b',
      timestamp: '2026-09-29T10:00:00.000Z',
      payload: { step: 'b' },
    })
    activityService.publish({
      id: 'evt_a',
      type: 'audit:step_a',
      timestamp: '2026-09-29T10:00:00.000Z',
      payload: { step: 'a' },
    })

    const controller = new AbortController()
    try {
      const app = createServerApp(undefined, { activityService })

      // Reconnect after evt_a: should still replay evt_b with identical timestamp
      const res = await app.request('/activity', {
        headers: {
          ADAMANT_SESSION: SESSION,
          'Last-Event-ID': 'evt_a',
        },
        signal: controller.signal,
      })

      assert.equal(res.status, 200)
      assert.ok(res.body)
      const bodyText = await readStreamFrame(res.body)

      assert.doesNotMatch(bodyText, /id: evt_a/)
      assert.match(bodyText, /id: evt_b/)
    } finally {
      controller.abort()
      await waitTick()
      assert.equal(activityService.subscriberCount(), 0)
    }
  })

  it('bounds in-memory event retention', async () => {
    const activityService = createActivityService({ maxInMemoryEvents: 2 })
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

    const history = await activityService.getHistory()
    assert.equal(history.length, 2)
    assert.equal(history[0]?.id, 'evt_2')
    assert.equal(history[1]?.id, 'evt_3')
  })

  it('propagates database query failure instead of swallowing it', async () => {
    const mockDb = {
      select: () => {
        throw new Error('Database connection failed')
      },
    } as unknown as Db

    const activityService = createActivityService({ database: mockDb })
    await assert.rejects(
      async () => {
        await activityService.getHistory()
      },
      {
        message: 'Database connection failed',
      },
    )
  })

  it('buffers live events during history replay and drains them in order without duplicating history', async () => {
    let unblockHistory!: () => void
    const historyBlocker = new Promise<void>((resolve) => {
      unblockHistory = resolve
    })

    const baseService = createActivityService()
    const customService = {
      ...baseService,
      async getHistory() {
        await historyBlocker
        return [
          {
            id: 'evt_hist_1',
            type: 'audit:hist_1',
            timestamp: '2026-09-29T10:00:00.000Z',
            payload: { hist: 1 },
          },
        ]
      },
    }

    const app = createServerApp(undefined, { activityService: customService })
    const controller = new AbortController()

    try {
      const resPromise = app.request('/activity', {
        headers: { ADAMANT_SESSION: SESSION },
        signal: controller.signal,
      })

      // Give connection time to subscribe and start waiting for history
      await waitTick(20)

      // Publish a live event while history is still pending
      customService.publish({
        id: 'evt_live_1',
        type: 'audit:live_1',
        timestamp: '2026-09-29T10:01:00.000Z',
        payload: { live: 1 },
      })

      // Also publish an event that matches history to test deduplication
      customService.publish({
        id: 'evt_hist_1',
        type: 'audit:hist_1',
        timestamp: '2026-09-29T10:00:00.000Z',
        payload: { hist: 1 },
      })

      // Now unblock history
      unblockHistory()

      const res = await resPromise
      assert.equal(res.status, 200)
      assert.ok(res.body)

      const reader = res.body.getReader()
      let fullText = ''
      const decoder = new TextDecoder()
      while (fullText.length < 8192) {
        const { done, value } = await reader.read()
        if (done || !value) break
        fullText += decoder.decode(value, { stream: true })
        if (fullText.includes('evt_live_1')) break
      }
      reader.releaseLock()

      // History event comes before live event
      const histPos = fullText.indexOf('id: evt_hist_1')
      const livePos = fullText.indexOf('id: evt_live_1')
      assert.ok(histPos !== -1, 'History event should be present')
      assert.ok(livePos !== -1, 'Live event should be present')
      assert.ok(histPos < livePos, 'History event should appear before live event')

      // History event should NOT be duplicated
      const secondHistPos = fullText.indexOf('id: evt_hist_1', histPos + 1)
      assert.equal(secondHistPos, -1, 'History event should not be duplicated')
    } finally {
      controller.abort()
      await waitTick()
      assert.equal(customService.subscriberCount(), 0)
    }
  })
})
