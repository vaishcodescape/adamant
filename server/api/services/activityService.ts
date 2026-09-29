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
}

export function createActivityService(options: ActivityServiceOptions = {}): ActivityService {
  const listeners = new Set<ActivityListener>()
  const inMemoryEvents: ActivityEvent[] = []

  return {
    async getHistory() {
      const events: ActivityEvent[] = []

      if (options.database) {
        try {
          const whRows = await options.database
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

          for (const row of whRows) {
            const receivedAt = row.receivedAt
              ? new Date(row.receivedAt).toISOString()
              : new Date().toISOString()
            events.push({
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
            })
          }

          const auditRows = await options.database
            .select({
              id: auditEvents.id,
              runId: auditEvents.runId,
              eventType: auditEvents.eventType,
              payload: auditEvents.payload,
              actorUserId: auditEvents.actorUserId,
              createdAt: auditEvents.createdAt,
            })
            .from(auditEvents)

          for (const row of auditRows) {
            const createdAt = row.createdAt
              ? new Date(row.createdAt).toISOString()
              : new Date().toISOString()
            events.push({
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
            })
          }
        } catch {
          // ignore error if database queries fail in unmigrated test environment
        }
      }

      if (options.memoryStores) {
        const whStore = options.memoryStores['webhook-deliveries']
        if (whStore) {
          for (const [id, row] of whStore.entries()) {
            const eventType = String(row.event_type || row.eventType || 'unknown')
            const deliveryId = String(row.github_delivery_id || row.githubDeliveryId || id)
            const receivedAt = String(row.received_at || row.receivedAt || new Date().toISOString())
            events.push({
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
            const eventType = String(row.event_type || row.eventType || 'unknown')
            const createdAt = String(row.created_at || row.createdAt || new Date().toISOString())
            events.push({
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

      for (const evt of inMemoryEvents) {
        if (!events.some((e) => e.id === evt.id)) {
          events.push(evt)
        }
      }

      return events.sort((a, b) => {
        const tA = new Date(a.timestamp).getTime()
        const tB = new Date(b.timestamp).getTime()
        if (tA !== tB) return tA - tB
        return a.id.localeCompare(b.id)
      })
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    publish(event) {
      if (!inMemoryEvents.some((e) => e.id === event.id)) {
        inMemoryEvents.push(event)
      }
      for (const listener of listeners) {
        try {
          listener(event)
        } catch {
          /* ignore listener write errors */
        }
      }
    },

    subscriberCount() {
      return listeners.size
    },
  }
}
