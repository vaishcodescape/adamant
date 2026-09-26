import { and, eq, sql } from 'drizzle-orm'
import { createDb, githubInstallations, repositories, runs, type Db } from '../db/client.ts'

/** Graph input loaded from a queued run. `source_sha` is the commit to check out. */
export type HealRun = {
  runId: string
  baseSha: string
  repositoryId: string
  owner: string
  name: string
  /** PR base branch. A SHA cannot be one, so it is read from the repo row. */
  defaultBranch: string
  installationId: string
}

export type RunStore = {
  loadRun: (runId: string) => Promise<HealRun | null>
  markRunning: (runId: string) => Promise<boolean>
  markFinished: (runId: string, status: 'succeeded' | 'failed') => Promise<void>
}

export function createRunStore(db: Db): RunStore {
  return {
    async loadRun(runId) {
      const rows = await db
        .select({
          runId: runs.id,
          baseSha: runs.sourceSha,
          repositoryId: runs.repositoryId,
          owner: repositories.owner,
          name: repositories.name,
          defaultBranch: repositories.defaultBranch,
          installationId: githubInstallations.githubInstallationId,
        })
        .from(runs)
        .innerJoin(repositories, eq(repositories.id, runs.repositoryId))
        .innerJoin(githubInstallations, eq(githubInstallations.id, repositories.installationId))
        .where(eq(runs.id, runId))
        .limit(1)

      const row = rows[0]
      if (!row) return null

      return {
        runId: row.runId,
        baseSha: row.baseSha,
        repositoryId: row.repositoryId,
        owner: row.owner,
        name: row.name,
        defaultBranch: row.defaultBranch,
        installationId: String(row.installationId),
      }
    },

    async markRunning(runId) {
      const rows = await db
        .update(runs)
        .set({ status: 'running', updatedAt: new Date(), version: sql`${runs.version} + 1` })
        .where(and(eq(runs.id, runId), eq(runs.status, 'queued')))
        .returning({ id: runs.id })
      return rows.length === 1
    },

    async markFinished(runId, status) {
      await setStatus(db, runId, status)
    },
  }
}

async function setStatus(db: Db, runId: string, status: 'running' | 'succeeded' | 'failed') {
  await db
    .update(runs)
    .set({
      status,
      updatedAt: new Date(),
      version: sql`${runs.version} + 1`,
    })
    .where(eq(runs.id, runId))
}

export function createWorkerDb(url: string) {
  return createDb(url)
}
