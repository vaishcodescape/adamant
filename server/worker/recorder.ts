import { desc, eq } from 'drizzle-orm'
import {
  auditEvents,
  patchAttempts,
  prPublications,
  sandboxResults,
  toolInvocations,
  type Db,
} from '../db/client.ts'
import { redact, type RunRecorder, type SandboxVerdict } from '../agent/recorder.ts'

/**
 * Postgres implementation of the agent's recorder, bound to one run and one
 * repository. Arguments and payloads are redacted on the way in, so a token
 * that reached a tool cannot reach these tables.
 */
export interface RecorderContext {
  readonly runId: string
  readonly repositoryId: string
}

export function createPostgresRecorder(db: Db, context: RecorderContext): RunRecorder {
  return {
    async audit(eventType, payload) {
      await db.insert(auditEvents).values({
        runId: context.runId,
        eventType,
        payload: redact(payload ?? {}),
      })
    },

    async toolInvocation(record) {
      await db.insert(toolInvocations).values({
        runId: context.runId,
        repositoryId: context.repositoryId,
        toolName: record.tool,
        inputRedacted: redact(record.args),
        // The schema records success or failure; a denial is a failure that
        // never ran, and the message says which.
        outcome: record.outcome === 'ok' ? 'success' : 'failure',
        errorMessage:
          record.outcome === 'denied'
            ? `denied: ${record.errorMessage ?? 'not on the allowlist'}`
            : (record.errorMessage ?? null),
        startedAt: record.startedAt,
        finishedAt: new Date(),
      })
    },

    async patchAttempt(record) {
      await db
        .insert(patchAttempts)
        .values({
          runId: context.runId,
          attemptNumber: record.attemptNumber,
          candidateHash: record.candidateHash,
          outcome: record.outcome,
          failureReason: record.failureReason ?? null,
          patchDiff: record.patchDiff,
          finishedAt: new Date(),
        })
        .onConflictDoNothing()
    },

    async sandboxResult(record) {
      await db
        .insert(sandboxResults)
        .values({
          runId: context.runId,
          attemptNumber: record.attemptNumber,
          candidateHash: record.candidateHash,
          baseSha: record.baseSha,
          commands: [...record.commands],
          verdict: record.verdict,
          exitCode: record.exitCode ?? null,
          startedAt: new Date(),
          finishedAt: new Date(),
        })
        .onConflictDoNothing()
    },

    async prPublication(record) {
      await db
        .insert(prPublications)
        .values({
          runId: context.runId,
          repositoryId: context.repositoryId,
          githubPrNumber: record.prNumber,
          prUrl: record.prUrl,
          baseSha: record.baseSha,
          candidateHash: record.candidateHash,
        })
        .onConflictDoNothing()
    },

    async latestSandboxVerdict() {
      const rows = await db
        .select({ verdict: sandboxResults.verdict })
        .from(sandboxResults)
        .where(eq(sandboxResults.runId, context.runId))
        .orderBy(desc(sandboxResults.attemptNumber))
        .limit(1)

      return (rows[0]?.verdict as SandboxVerdict | undefined) ?? null
    },

    async publishedPrNumber() {
      const rows = await db
        .select({ prNumber: prPublications.githubPrNumber })
        .from(prPublications)
        .where(eq(prPublications.runId, context.runId))
        .limit(1)

      return rows[0]?.prNumber ?? null
    },
  }
}
