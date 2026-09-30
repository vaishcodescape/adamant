import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ActivityEventEnvelopeSchema, RunDetailSchema, RunSummarySchema } from '@adamant/contract'

const run = {
  id: 'run-1',
  repositoryId: 'repo-1',
  sourceSha: 'abc123',
  targetBranch: 'adamant/run-1',
  status: 'running',
  version: 2,
  createdAt: '2026-09-29T10:00:00.000Z',
  updatedAt: '2026-09-29T10:01:00.000Z',
} as const

const auditEvent = {
  id: 'event-1',
  runId: 'run-1',
  eventType: 'run.started',
  payload: { previousStatus: 'queued' },
  actorUserId: null,
  createdAt: '2026-09-29T10:01:00.000Z',
} as const

describe('@adamant/contract', () => {
  it('accepts valid run summaries and run details', () => {
    assert.deepEqual(RunSummarySchema.parse(run), run)
    assert.deepEqual(RunDetailSchema.parse({ run, auditEvents: [auditEvent] }), {
      run,
      auditEvents: [auditEvent],
    })
  })

  it('accepts a valid activity event envelope', () => {
    const event = {
      id: 'activity-1',
      type: 'audit.created',
      runId: 'run-1',
      occurredAt: '2026-09-29T10:01:00.000Z',
      payload: { auditEvent },
    }

    assert.deepEqual(ActivityEventEnvelopeSchema.parse(event), event)
  })

  it('rejects invalid statuses, timestamps, and extra fields', () => {
    assert.throws(() => RunSummarySchema.parse({ ...run, status: 'healing' }))
    assert.throws(() => RunSummarySchema.parse({ ...run, createdAt: 'not-a-date' }))
    assert.throws(() => RunSummarySchema.parse({ ...run, unexpected: true }))
  })

  it('rejects incomplete audit and activity events', () => {
    assert.throws(() =>
      RunDetailSchema.parse({ run, auditEvents: [{ ...auditEvent, payload: 'raw text' }] }),
    )
    assert.throws(() =>
      ActivityEventEnvelopeSchema.parse({
        id: 'activity-1',
        type: 'audit.created',
        runId: null,
        occurredAt: '2026-09-29T10:01:00.000Z',
      }),
    )
  })
})
