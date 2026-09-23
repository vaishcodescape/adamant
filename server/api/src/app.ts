import { Hono } from 'hono'

import {
  type ApiDependencies,
  type CreateRunCommand,
  type RunRecord,
  type SessionPrincipal,
} from './contracts.ts'

const shaPattern = /^[0-9a-f]{40}$/i
const decimalIdPattern = /^[1-9][0-9]*$/
const idempotencyKeyPattern = /^[!-~]{1,200}$/
const runIdPattern = /^[A-Za-z0-9_-]{1,128}$/
const invalidBranchCharacters = new Set(['~', '^', ':', '?', '*', '[', ']', '\\'])
const createRunKeys = new Set(['installationId', 'repositoryId', 'baseSha', 'targetBranch'])

interface CreateRunBody {
  installationId: string
  repositoryId: string
  baseSha: string
  targetBranch: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isValidTargetBranch(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 255 &&
    ![...value].some(
      (character) => invalidBranchCharacters.has(character) || character.charCodeAt(0) <= 32,
    ) &&
    !value.startsWith('/') &&
    !value.endsWith('/') &&
    !value.endsWith('.') &&
    !value.endsWith('.lock') &&
    !value.includes('..') &&
    !value.includes('@{') &&
    !value.includes('//')
  )
}

function parseCreateRunBody(value: unknown): CreateRunBody | null {
  if (!isObject(value) || Object.keys(value).some((key) => !createRunKeys.has(key))) {
    return null
  }

  const { installationId, repositoryId, baseSha, targetBranch } = value
  if (
    typeof installationId !== 'string' ||
    !decimalIdPattern.test(installationId) ||
    typeof repositoryId !== 'string' ||
    !decimalIdPattern.test(repositoryId) ||
    typeof baseSha !== 'string' ||
    !shaPattern.test(baseSha) ||
    typeof targetBranch !== 'string' ||
    !isValidTargetBranch(targetBranch)
  ) {
    return null
  }

  return { installationId, repositoryId, baseSha: baseSha.toLowerCase(), targetBranch }
}

function publicRun(run: RunRecord): Omit<RunRecord, 'actorUserId'> {
  return {
    id: run.id,
    installationId: run.installationId,
    repositoryId: run.repositoryId,
    baseSha: run.baseSha,
    targetBranch: run.targetBranch,
    status: run.status,
  }
}

async function authenticate(
  dependencies: ApiDependencies,
  authorization: string | undefined,
): Promise<SessionPrincipal | null> {
  return dependencies.authenticate(authorization)
}

export function createApp(dependencies: ApiDependencies) {
  return new Hono()
    .get('/health', (c) => c.json({ status: 'ok' as const }))
    .post('/runs', async (c) => {
      const principal = await authenticate(dependencies, c.req.header('Authorization'))
      if (principal === null) {
        return c.json({ error: { code: 'unauthorized' as const } }, 401)
      }

      const idempotencyKey = c.req.header('Idempotency-Key')
      if (idempotencyKey === undefined || !idempotencyKeyPattern.test(idempotencyKey)) {
        return c.json({ error: { code: 'invalid_idempotency_key' as const } }, 400)
      }

      let body: unknown
      try {
        body = await c.req.json()
      } catch {
        return c.json({ error: { code: 'invalid_json' as const } }, 400)
      }

      const input = parseCreateRunBody(body)
      if (input === null) {
        return c.json({ error: { code: 'invalid_request' as const } }, 400)
      }

      const command: CreateRunCommand = {
        actorUserId: principal.userId,
        idempotencyKey,
        ...input,
      }
      const result = await dependencies.runs.createRun(command)

      switch (result.kind) {
        case 'created':
          return c.json({ run: publicRun(result.run) }, 202)
        case 'existing':
          c.header('Idempotency-Replayed', 'true')
          return c.json({ run: publicRun(result.run) }, 202)
        case 'forbidden':
          return c.json({ error: { code: 'repository_not_authorized' as const } }, 403)
        case 'idempotency_conflict':
          return c.json({ error: { code: 'idempotency_conflict' as const } }, 409)
        case 'unavailable':
          return c.json({ error: { code: 'service_unavailable' as const } }, 503)
      }
    })
    .get('/runs/:id', async (c) => {
      const principal = await authenticate(dependencies, c.req.header('Authorization'))
      if (principal === null) {
        return c.json({ error: { code: 'unauthorized' as const } }, 401)
      }

      const runId = c.req.param('id')
      if (!runIdPattern.test(runId)) {
        return c.json({ error: { code: 'invalid_run_id' as const } }, 400)
      }

      const result = await dependencies.runs.readRun(runId, principal.userId)
      switch (result.kind) {
        case 'found':
          return c.json({ run: publicRun(result.run) })
        case 'not_found':
          return c.json({ error: { code: 'run_not_found' as const } }, 404)
        case 'unavailable':
          return c.json({ error: { code: 'service_unavailable' as const } }, 503)
      }
    })
}

export type ApiType = ReturnType<typeof createApp>
