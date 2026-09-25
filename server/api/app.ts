import { randomUUID } from 'node:crypto'
import { Hono, type Hono as HonoApp } from 'hono'

export type JsonRecord = Record<string, unknown>

export type ResourceName =
  | 'users'
  | 'sessions'
  | 'github-installations'
  | 'repositories'
  | 'runs'
  | 'webhook-deliveries'
  | 'triage-results'
  | 'patch-attempts'
  | 'sandbox-results'
  | 'pr-publications'
  | 'tool-invocations'
  | 'hitl-decisions'
  | 'approvals'
  | 'audit-events'

type ResourceConfig = {
  readonly primaryKey: string
  readonly required: readonly string[]
  readonly defaults?: (input: JsonRecord) => JsonRecord
}

type ResourceStore = Map<string, JsonRecord>

export const resourceNames = [
  'users',
  'sessions',
  'github-installations',
  'repositories',
  'runs',
  'webhook-deliveries',
  'triage-results',
  'patch-attempts',
  'sandbox-results',
  'pr-publications',
  'tool-invocations',
  'hitl-decisions',
  'approvals',
  'audit-events',
] as const satisfies readonly ResourceName[]

const now = () => new Date().toISOString()

const withTimestamps = (input: JsonRecord) => ({
  created_at: now(),
  updated_at: now(),
  ...input,
})

const appendCreatedAt = (input: JsonRecord) => ({
  created_at: now(),
  ...input,
})

const resourceConfigs = {
  users: {
    primaryKey: 'id',
    required: ['github_user_id'],
    defaults: appendCreatedAt,
  },
  sessions: {
    primaryKey: 'id',
    required: ['user_id', 'token_hash', 'expires_at'],
    defaults: appendCreatedAt,
  },
  'github-installations': {
    primaryKey: 'id',
    required: ['github_installation_id'],
    defaults: appendCreatedAt,
  },
  repositories: {
    primaryKey: 'id',
    required: ['installation_id', 'github_repo_id', 'owner', 'name'],
    defaults: withTimestamps,
  },
  runs: {
    primaryKey: 'id',
    required: ['repository_id', 'created_by_user_id', 'base_sha', 'source_sha', 'target_branch'],
    defaults: (input) => {
      const runId = typeof input.id === 'string' ? input.id : randomUUID()

      return withTimestamps({
        status: 'queued',
        version: 0,
        idempotency_key: `manual:${runId}`,
        ...input,
        id: runId,
        target_branch: input.target_branch ?? `adamant/${runId}`,
      })
    },
  },
  'webhook-deliveries': {
    primaryKey: 'id',
    required: [
      'github_delivery_id',
      'event_type',
      'processing_status',
      'installation_id',
      'repository_id',
      'payload_digest',
    ],
    defaults: appendCreatedAt,
  },
  'triage-results': {
    primaryKey: 'id',
    required: ['run_id', 'category', 'details'],
    defaults: appendCreatedAt,
  },
  'patch-attempts': {
    primaryKey: 'id',
    required: ['run_id', 'attempt_number', 'candidate_hash', 'patch_diff', 'outcome'],
    defaults: appendCreatedAt,
  },
  'sandbox-results': {
    primaryKey: 'id',
    required: [
      'run_id',
      'attempt_number',
      'candidate_hash',
      'base_sha',
      'commands',
      'verdict',
      'exit_code',
      'artifact_ref',
    ],
    defaults: (input) => ({
      created_at: now(),
      started_at: now(),
      finished_at: now(),
      ...input,
    }),
  },
  'pr-publications': {
    primaryKey: 'id',
    required: ['run_id', 'repository_id', 'github_pr_number', 'pr_url'],
    defaults: appendCreatedAt,
  },
  'tool-invocations': {
    primaryKey: 'id',
    required: ['run_id', 'repository_id', 'tool_name', 'input_redacted', 'outcome'],
    defaults: (input) => ({
      started_at: now(),
      finished_at: now(),
      ...input,
    }),
  },
  'hitl-decisions': {
    primaryKey: 'id',
    required: [
      'run_id',
      'run_version',
      'candidate_hash',
      'base_sha',
      'decided_by_user_id',
      'decision_id',
      'action',
      'status',
    ],
    defaults: appendCreatedAt,
  },
  approvals: {
    primaryKey: 'id',
    required: ['run_id', 'run_version', 'candidate_hash', 'base_sha', 'action', 'status'],
    defaults: appendCreatedAt,
  },
  'audit-events': {
    primaryKey: 'id',
    required: ['run_id', 'actor_user_id', 'event_type', 'payload'],
    defaults: appendCreatedAt,
  },
} as const satisfies Record<ResourceName, ResourceConfig>

function createStores() {
  return resourceNames.reduce(
    (stores, name) => {
      stores[name] = new Map()
      return stores
    },
    {} as Record<ResourceName, ResourceStore>,
  )
}

function normalizeBody(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  return value as JsonRecord
}

function missingFields(input: JsonRecord, required: readonly string[]) {
  return required.filter(
    (field) => input[field] === undefined || input[field] === null || input[field] === '',
  )
}

function withoutImmutableFields(input: JsonRecord, primaryKey: string) {
  const mutable = { ...input }

  delete mutable.id
  delete mutable[primaryKey]
  delete mutable.created_at

  return mutable
}

export function createApp(stores = createStores(), app: HonoApp = new Hono()) {
  app.get('/health', (c) => c.json({ status: 'ok' }))

  for (const [name, config] of Object.entries(resourceConfigs) as [
    ResourceName,
    ResourceConfig,
  ][]) {
    const store = stores[name]

    app
      .get(`/${name}`, (c) => c.json({ data: [...store.values()] }))
      .post(`/${name}`, async (c) => {
        const parsedBody = normalizeBody(await c.req.json().catch(() => null))

        if (!parsedBody) {
          return c.json({ error: 'request body must be a JSON object' }, 400)
        }

        const missing = missingFields(parsedBody, config.required)

        if (missing.length > 0) {
          return c.json({ error: 'missing required fields', fields: missing }, 400)
        }

        const row = config.defaults ? config.defaults(parsedBody) : parsedBody
        const id = String(row[config.primaryKey] ?? randomUUID())
        const saved = { id, ...row, [config.primaryKey]: id }

        if (store.has(id)) {
          return c.json({ error: `${name} row already exists` }, 409)
        }

        store.set(id, saved)

        return c.json({ data: saved }, 201)
      })
      .get(`/${name}/:id`, (c) => {
        const row = store.get(c.req.param('id'))

        if (!row) {
          return c.json({ error: `${name} row not found` }, 404)
        }

        return c.json({ data: row })
      })
      .patch(`/${name}/:id`, async (c) => {
        const id = c.req.param('id')
        const current = store.get(id)

        if (!current) {
          return c.json({ error: `${name} row not found` }, 404)
        }

        const parsedBody = normalizeBody(await c.req.json().catch(() => null))

        if (!parsedBody) {
          return c.json({ error: 'request body must be a JSON object' }, 400)
        }

        const changes = withoutImmutableFields(parsedBody, config.primaryKey)

        if (Object.keys(changes).length === 0) {
          return c.json({ error: 'request body has no mutable fields' }, 400)
        }

        const updated = {
          ...current,
          ...changes,
          ...(current.updated_at === undefined ? {} : { updated_at: now() }),
          id,
          [config.primaryKey]: id,
        }

        store.set(id, updated)

        return c.json({ data: updated })
      })
      .delete(`/${name}/:id`, (c) => {
        const deleted = store.delete(c.req.param('id'))

        if (!deleted) {
          return c.json({ error: `${name} row not found` }, 404)
        }

        return c.body(null, 204)
      })
  }

  return app
}

export type ApiType = ReturnType<typeof createApp>
