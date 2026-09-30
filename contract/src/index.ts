import { z } from 'zod'

const IdentifierSchema = z.string().min(1)
const TimestampSchema = z.string().datetime({ offset: true })
const JsonObjectSchema = z.record(z.string(), z.unknown())

export const RunStatusSchema = z.enum([
  'queued',
  'running',
  'report_only',
  'awaiting_hitl',
  'changes_requested',
  'publishing',
  'succeeded',
  'aborted',
  'failed',
])

export type RunStatus = z.infer<typeof RunStatusSchema>

export const RunSummarySchema = z
  .object({
    id: IdentifierSchema,
    repositoryId: IdentifierSchema,
    sourceSha: IdentifierSchema,
    targetBranch: IdentifierSchema,
    status: RunStatusSchema,
    version: z.number().int().nonnegative(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()

export type RunSummary = z.infer<typeof RunSummarySchema>

export const AuditEventSchema = z
  .object({
    id: IdentifierSchema,
    runId: IdentifierSchema.nullable(),
    eventType: IdentifierSchema,
    payload: JsonObjectSchema,
    actorUserId: IdentifierSchema.nullable(),
    createdAt: TimestampSchema,
  })
  .strict()

export type AuditEvent = z.infer<typeof AuditEventSchema>

export const RunDetailSchema = z
  .object({
    run: RunSummarySchema,
    auditEvents: z.array(AuditEventSchema),
  })
  .strict()

export type RunDetail = z.infer<typeof RunDetailSchema>

export const ActivityEventEnvelopeSchema = z
  .object({
    id: IdentifierSchema,
    type: IdentifierSchema,
    runId: IdentifierSchema.nullable(),
    occurredAt: TimestampSchema,
    payload: JsonObjectSchema,
  })
  .strict()

export type ActivityEventEnvelope = z.infer<typeof ActivityEventEnvelopeSchema>
