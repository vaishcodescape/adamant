import { desc, gt } from 'drizzle-orm'
import type { Db } from '../../db/client.ts'
import { auditEvents, webhookDeliveries } from '../../db/client.ts'

export interface ActivityEvent {
  readonly id: string
  readonly type: string
  readonly timestamp: string
  readonly payload: Record<string, unknown>
}

export type ActivityListener = (event: ActivityEvent) => void

export interface ActivityService {
  getHistory(): Promise<ActivityEvent[]>
  subscribe(listener: ActivityListener): () => void
  publish(event: ActivityEvent): void
  subscriberCount(): number
}

export type ActivityServiceOptions = {
  database?: Db
  memoryStores?: Record<string, Map<string, Record<string, unknown>>>
  maxInMemoryEvents?: number
  /** Newest rows replayed per table on connect. */
  historyLimit?: number
  /** How often the database is tailed while at least one client is connected. */
  pollIntervalMs?: number
}

const DEFAULT_MAX_IN_MEMORY_EVENTS = 1000
const DEFAULT_HISTORY_LIMIT = 500
const DEFAULT_POLL_INTERVAL_MS = 1000

/**
 * `created_at` is the inserting transaction's start time, so a row can commit
 * after a newer one was already seen. Each poll re-reads this window and drops
 * ids it has published; it also absorbs clock skew between API and database.
 */
const TAIL_OVERLAP_MS = 30_000

function deliveryEvent(row: {
  id: string
  githubDeliveryId: string
  eventType: string
  repositoryId: string | null
  installationId: string | null
  processingStatus: string
  receivedAt: Date
}): ActivityEvent {
  const receivedAt = new Date(row.receivedAt).toISOString()
  return {
    id: `wh_${row.id}`,
    type: `webhook:${row.eventType}`,
    timestamp: receivedAt,
    payload: {
      id: row.id,
      deliveryId: row.githubDeliveryId,
      eventType: row.eventType,
      repositoryId: row.repositoryId ?? null,
      installationId: row.installationId ?? null,
      processingStatus: row.processingStatus,
      receivedAt,
    },
  }
}

function auditEvent(row: {
  id: string
  runId: string | null
  eventType: string
  payload: unknown
  actorUserId: string | null
  createdAt: Date
}): ActivityEvent {
  const createdAt = new Date(row.createdAt).toISOString()
  return {
    id: `audit_${row.id}`,
    type: `audit:${row.eventType}`,
    timestamp: createdAt,
    payload: {
      id: row.id,
      runId: row.runId ?? null,
      eventType: row.eventType,
      payload: (row.payload as Record<string, unknown>) ?? {},
      actorUserId: row.actorUserId ?? null,
      createdAt,
    },
  }
}

function byTimeThenId(a: ActivityEvent, b: ActivityEvent): number {
  const tA = new Date(a.timestamp).getTime()
  const tB = new Date(b.timestamp).getTime()
  if (tA !== tB) return tA - tB
  return a.id.localeCompare(b.id)
}

/**
 * The newest `limit` rows of each table, optionally only those after `since`,
 * oldest first. Both reads walk a time index; neither scans its table.
 */
async function loadRecent(db: Db, limit: number, since?: Date): Promise<ActivityEvent[]> {
  const deliveries = await db
    .select({
      id: webhookDeliveries.id,
      githubDeliveryId: webhookDeliveries.githubDeliveryId,
      eventType: webhookDeliveries.eventType,
      repositoryId: webhookDeliveries.repositoryId,
      installationId: webhookDeliveries.installationId,
      processingStatus: webhookDeliveries.processingStatus,
      receivedAt: webhookDeliveries.receivedAt,
    })
    .from(webhookDeliveries)
    .where(since ? gt(webhookDeliveries.receivedAt, since) : undefined)
    .orderBy(desc(webhookDeliveries.receivedAt))
    .limit(limit)

  const audits = await db
    .select({
      id: auditEvents.id,
      runId: auditEvents.runId,
      eventType: auditEvents.eventType,
      payload: auditEvents.payload,
      actorUserId: auditEvents.actorUserId,
      createdAt: auditEvents.createdAt,
    })
    .from(auditEvents)
    .where(since ? gt(auditEvents.createdAt, since) : undefined)
    .orderBy(desc(auditEvents.createdAt))
    .limit(limit)

  return [...deliveries.map(deliveryEvent), ...audits.map(auditEvent)].sort(byTimeThenId)
}

/**
 * Manages activity event pub/sub and chronological history aggregation.
 * Merges persisted database records, memory stores, and recent in-memory activity
 * using a bounded retention queue and deterministic timestamp + ID ordering.
 *
 * With a database, history is the newest rows of each table, and new rows are
 * tailed from Postgres while anyone is connected. The webhook handler and the
 * worker (a separate process) both write those rows; neither calls `publish`.
 */
export function createActivityService(options: ActivityServiceOptions = {}): ActivityService {
  const listeners = new Set<ActivityListener>()
  const maxInMemoryEvents = options.maxInMemoryEvents ?? DEFAULT_MAX_IN_MEMORY_EVENTS
  const historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const inMemoryEvents = new Map<string, ActivityEvent>()
  const database = options.database

  // Database tail: runs only while someone is connected.
  let tailing = false
  let polling = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let watermark = 0
  const tailed = new Map<string, number>()

  return {
    async getHistory() {
      const eventsById = new Map<string, ActivityEvent>()

      if (options.database) {
        for (const event of await loadRecent(options.database, historyLimit)) {
          eventsById.set(event.id, event)
        }
      }

      if (options.memoryStores) {
        const whStore = options.memoryStores['webhook-deliveries']
        if (whStore) {
          for (const [id, row] of whStore.entries()) {
            const eventType = String(row.event_type ?? row.eventType ?? 'unknown')
            const deliveryId = String(row.github_delivery_id ?? row.githubDeliveryId ?? id)
            const receivedAt = String(row.received_at ?? row.receivedAt ?? new Date().toISOString())
            eventsById.set(`wh_${id}`, {
              id: `wh_${id}`,
              type: `webhook:${eventType}`,
              timestamp: new Date(receivedAt).toISOString(),
              payload: {
                id,
                deliveryId,
                eventType,
                repositoryId: row.repository_id ?? row.repositoryId ?? null,
                installationId: row.installation_id ?? row.installationId ?? null,
                processingStatus: row.processing_status ?? row.processingStatus ?? 'received',
                receivedAt,
              },
            })
          }
        }

        const auditStore = options.memoryStores['audit-events']
        if (auditStore) {
          for (const [id, row] of auditStore.entries()) {
            const eventType = String(row.event_type ?? row.eventType ?? 'unknown')
            const createdAt = String(row.created_at ?? row.createdAt ?? new Date().toISOString())
            eventsById.set(`audit_${id}`, {
              id: `audit_${id}`,
              type: `audit:${eventType}`,
              timestamp: new Date(createdAt).toISOString(),
              payload: {
                id,
                runId: row.run_id ?? row.runId ?? null,
                eventType,
                payload: (row.payload as Record<string, unknown>) ?? {},
                actorUserId: row.actor_user_id ?? row.actorUserId ?? null,
                createdAt,
              },
            })
          }
        }
      }

      for (const [id, evt] of inMemoryEvents.entries()) {
        if (!eventsById.has(id)) {
          eventsById.set(id, evt)
        }
      }

      return Array.from(eventsById.values()).sort(byTimeThenId)
    },

    subscribe(listener) {
      listeners.add(listener)
      startTail()
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) stopTail()
      }
    },

    publish,

    subscriberCount() {
      return listeners.size
    },
  }

  function publish(event: ActivityEvent) {
    if (!inMemoryEvents.has(event.id)) {
      if (inMemoryEvents.size >= maxInMemoryEvents) {
        const oldestKey = inMemoryEvents.keys().next().value
        if (oldestKey !== undefined) {
          inMemoryEvents.delete(oldestKey)
        }
      }
      inMemoryEvents.set(event.id, event)
    }
    for (const listener of listeners) {
      try {
        listener(event)
      } catch {
        /* ignore listener write errors */
      }
    }
  }

  function startTail() {
    if (!database || tailing) return
    tailing = true
    watermark = Date.now()
    tailed.clear()
    // A poll still in flight reschedules itself when it sees `tailing`.
    if (!polling) scheduleTail()
  }

  function stopTail() {
    tailing = false
    if (timer) clearTimeout(timer)
    timer = undefined
  }

  function scheduleTail() {
    timer = setTimeout(() => void tailOnce(), pollIntervalMs)
    timer.unref()
  }

  async function tailOnce() {
    timer = undefined
    polling = true
    try {
      if (!database) return
      const since = new Date(watermark - TAIL_OVERLAP_MS)
      for (const event of await loadRecent(database, historyLimit, since)) {
        if (tailed.has(event.id)) continue
        const at = new Date(event.timestamp).getTime()
        tailed.set(event.id, at)
        watermark = Math.max(watermark, at)
        publish(event)
      }
      for (const [id, at] of tailed) {
        if (at < watermark - 2 * TAIL_OVERLAP_MS) tailed.delete(id)
      }
    } catch (error) {
      // A missed poll is retried by the next one; the window covers the gap.
      console.error('activity tail failed', error)
    } finally {
      polling = false
      if (tailing) scheduleTail()
    }
  }
}
