import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import {
  createActivityService,
  type ActivityEvent,
  type ActivityService,
} from '../services/activityService.ts'

/**
 * Creates the /activity router for Server-Sent Events.
 * Serializes history replay and live pub/sub delivery through a single output queue
 * so clients receive chronological, deduplicated activity with graceful abort cleanup.
 */
export function createActivityRoute(service?: ActivityService) {
  const activity = new Hono()
  const activityService = service ?? createActivityService()

  activity.get('/', async (c) => {
    const lastEventId = c.req.header('last-event-id') ?? c.req.query('lastEventId') ?? null

    c.header('Content-Type', 'text/event-stream')
    c.header('Cache-Control', 'no-cache')
    c.header('Connection', 'keep-alive')

    return streamSSE(c, async (stream) => {
      let active = true
      let cleanedUp = false
      let unsubscribe = () => {}
      let resolveStreamPromise: (() => void) | null = null

      const cleanup = () => {
        if (cleanedUp) return
        cleanedUp = true
        active = false
        unsubscribe()
        if (resolveStreamPromise) {
          resolveStreamPromise()
          resolveStreamPromise = null
        }
      }

      const sentEventIds = new Set<string>()
      const liveQueue: ActivityEvent[] = []
      let historyLoaded = false
      let isFlushing = false

      const safeWrite = async (event: ActivityEvent): Promise<boolean> => {
        if (!active) return false
        if (sentEventIds.has(event.id)) return true
        try {
          await stream.writeSSE({
            id: event.id,
            event: event.type,
            data: JSON.stringify(event.payload),
          })
          sentEventIds.add(event.id)
          return true
        } catch {
          cleanup()
          return false
        }
      }

      const flushQueue = async () => {
        if (isFlushing || !historyLoaded || !active) return
        isFlushing = true
        while (liveQueue.length > 0 && active) {
          const nextEvt = liveQueue.shift()
          if (nextEvt) {
            const ok = await safeWrite(nextEvt)
            if (!ok) break
          }
        }
        isFlushing = false
      }

      const listener = (event: ActivityEvent) => {
        if (!active) return
        liveQueue.push(event)
        if (historyLoaded) {
          void flushQueue()
        }
      }

      unsubscribe = activityService.subscribe(listener)

      stream.onAbort(() => {
        cleanup()
      })

      if (c.req.raw.signal.aborted) {
        cleanup()
        return
      }

      try {
        const history = await activityService.getHistory()
        let startIndex = 0
        if (lastEventId) {
          const foundIdx = history.findIndex((e) => e.id === lastEventId)
          if (foundIdx !== -1) {
            startIndex = foundIdx + 1
          }
        }

        for (let i = startIndex; i < history.length; i++) {
          const evt = history[i]
          if (!evt || !active) break
          const ok = await safeWrite(evt)
          if (!ok) break
        }
      } finally {
        historyLoaded = true
      }

      if (active) {
        await flushQueue()
      }

      await new Promise<void>((resolve) => {
        resolveStreamPromise = resolve
        const onAbort = () => {
          cleanup()
        }

        if (c.req.raw.signal.aborted || !active) {
          onAbort()
        } else {
          c.req.raw.signal.addEventListener('abort', onAbort, { once: true })
          stream.onAbort(() => {
            onAbort()
          })
        }
      })
    })
  })

  return activity
}

export const activity = createActivityRoute()
