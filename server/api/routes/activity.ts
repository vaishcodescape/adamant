import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import {
  createActivityService,
  type ActivityEvent,
  type ActivityService,
} from '../services/activityService.ts'

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

      const listener = async (event: ActivityEvent) => {
        if (!active) return
        try {
          await stream.writeSSE({
            id: event.id,
            event: event.type,
            data: JSON.stringify(event.payload),
          })
        } catch {
          active = false
        }
      }

      const unsubscribe = activityService.subscribe(listener)

      const cleanup = () => {
        if (active) {
          active = false
          unsubscribe()
        }
      }

      stream.onAbort(() => {
        cleanup()
      })

      if (c.req.raw.signal.aborted) {
        cleanup()
        return
      }

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
        await stream.writeSSE({
          id: evt.id,
          event: evt.type,
          data: JSON.stringify(evt.payload),
        })
      }

      await new Promise<void>((resolve) => {
        const onAbort = () => {
          cleanup()
          resolve()
        }

        if (c.req.raw.signal.aborted) {
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
