import { createHash, randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'

export type RunRecord = {
  id: string
  repositoryId: string
  createdByUserId: string | null
  idempotencyKey: string | null
  sourceSha: string
  targetBranch: string
  status: string
  createdAt: Date
  updatedAt: Date
}
export type ManualRunInput = {
  repositoryId: string
  sourceSha: string
  idempotencyKey: string
  userId: string
}
type WorkflowPayload = {
  action?: string
  installation?: { id?: number; account?: { login?: string; type?: string } }
  repository?: { id?: number; name?: string; default_branch?: string; owner?: { login?: string } }
  workflow_run?: { conclusion?: string; head_sha?: string }
}
function mapRun(row: Record<string, unknown>): RunRecord {
  return {
    id: String(row.id),
    repositoryId: String(row.repository_id),
    createdByUserId: row.created_by_user_id ? String(row.created_by_user_id) : null,
    idempotencyKey: row.idempotency_key ? String(row.idempotency_key) : null,
    sourceSha: String(row.source_sha),
    targetBranch: String(row.target_branch),
    status: String(row.status),
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
  }
}
async function enqueue(client: PoolClient, runId: string) {
  await client.query(
    `select graphile_worker.add_job(
       'graph_step', json_build_object('runId', $1)::json, job_key := $1
     )`,
    [runId],
  )
}
export class RunService {
  constructor(private readonly pool: Pool) {}

  async processWebhook(
    deliveryId: string,
    event: string,
    rawBody: string,
    payload: unknown,
    actorUserId: string,
  ): Promise<{ duplicate: boolean; runId: string | null }> {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const data = payload as WorkflowPayload
      const installation = data.installation
      const repository = data.repository
      let installationId: string | null = null
      let repositoryId: string | null = null
      if (installation?.id && installation.account?.login && installation.account.type) {
        const saved = await client.query<{ id: string }>(
          `insert into github_installations
             (github_installation_id, account_login, account_type)
           values ($1, $2, $3)
           on conflict (github_installation_id) do update set
             account_login = excluded.account_login,
             account_type = excluded.account_type, updated_at = now()
           returning id`,
          [installation.id, installation.account.login, installation.account.type],
        )
        installationId = saved.rows[0]?.id ?? null
      }
      if (installationId && repository?.id && repository.name && repository.owner?.login) {
        const saved = await client.query<{ id: string }>(
          `insert into repositories
             (installation_id, github_repo_id, owner, name, default_branch)
           values ($1, $2, $3, $4, $5)
           on conflict (github_repo_id) do update set
             installation_id = excluded.installation_id, owner = excluded.owner,
             name = excluded.name, default_branch = excluded.default_branch, updated_at = now()
           returning id`,
          [installationId, repository.id, repository.owner.login, repository.name,
            repository.default_branch ?? 'main'],
        )
        repositoryId = saved.rows[0]?.id ?? null
      }
      const delivery = await client.query(
        `insert into webhook_deliveries
           (github_delivery_id, event_type, installation_id, repository_id,
            payload_digest, processing_status, processed_at)
         values ($1, $2, $3, $4, $5, 'processed', now())
         on conflict (github_delivery_id) do nothing returning id`,
        [deliveryId, event, installationId, repositoryId,
          createHash('sha256').update(rawBody).digest('hex')],
      )
      if (delivery.rowCount === 0) {
        await client.query('commit')
        return { duplicate: true, runId: null }
      }
      const failed =
        event === 'workflow_run' &&
        data.action === 'completed' &&
        data.workflow_run?.conclusion === 'failure'
      if (!failed) {
        await client.query('commit')
        return { duplicate: false, runId: null }
      }
      if (!repositoryId || !data.workflow_run?.head_sha) {
        throw new Error('Failed workflow delivery is missing repository or head SHA')
      }
      const runId = randomUUID()
      await client.query(
        `insert into runs
           (id, repository_id, created_by_user_id, idempotency_key, source_sha,
            target_branch, status)
         values ($1, $2, $3, $4, $5, $6, 'queued')`,
        [runId, repositoryId, actorUserId, `webhook:${deliveryId}`,
          data.workflow_run.head_sha, `adamant/${runId}`],
      )
      await enqueue(client, runId)
      await client.query('commit')
      return { duplicate: false, runId }
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  }

  async createManualRun(input: ManualRunInput): Promise<{ run: RunRecord; created: boolean }> {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const existing = await client.query<Record<string, unknown>>(
        'select * from runs where repository_id = $1 and idempotency_key = $2',
        [input.repositoryId, input.idempotencyKey],
      )
      if (existing.rows[0]) {
        await client.query('commit')
        return { run: mapRun(existing.rows[0]), created: false }
      }
      const runId = randomUUID()
      const inserted = await client.query<Record<string, unknown>>(
        `insert into runs
           (id, repository_id, created_by_user_id, idempotency_key, source_sha,
            target_branch, status)
         values ($1, $2, $3, $4, $5, $6, 'queued') returning *`,
        [runId, input.repositoryId, input.userId, input.idempotencyKey,
          input.sourceSha, `adamant/${runId}`],
      )
      await enqueue(client, runId)
      await client.query('commit')
      const row = inserted.rows[0]
      if (!row) throw new Error('Run insert did not return a row')
      return { run: mapRun(row), created: true }
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  }

  async listRuns(userId: string): Promise<readonly RunRecord[]> {
    const result = await this.pool.query<Record<string, unknown>>(
      'select * from runs where created_by_user_id = $1 order by created_at desc',
      [userId],
    )
    return result.rows.map(mapRun)
  }

  async getRun(userId: string, runId: string) {
    const result = await this.pool.query<Record<string, unknown>>(
      'select * from runs where id = $1 and created_by_user_id = $2',
      [runId, userId],
    )
    const row = result.rows[0]
    if (!row) return null
    const audit = await this.pool.query<Record<string, unknown>>(
      `select id, event_type, payload, actor_user_id, created_at
       from audit_events where run_id = $1 order by created_at asc`,
      [runId],
    )
    return { ...mapRun(row), auditEvents: audit.rows }
  }
}
export function createRunService(databaseUrl: string) {
  return new RunService(new Pool({ connectionString: databaseUrl }))
}
