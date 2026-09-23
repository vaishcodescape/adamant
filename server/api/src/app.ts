import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'

import {
  type ApiDependencies,
  type CreateRunCommand,
  type PublicRun,
  type RunRecord,
  type SessionPrincipal,
} from './ports.ts'

const shaPattern = /^[0-9a-f]{40}$/i
const decimalIdPattern = /^[1-9][0-9]{0,18}$/
const idempotencyKeyPattern = /^[!-~]{1,200}$/
const runIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const invalidBranchCharacters = new Set(['~', '^', ':', '?', '*', '[', ']', '\\'])
const createRunKeys = new Set(['installationId', 'repositoryId', 'baseSha', 'targetBranch'])
const maxPostgresBigint = 9_223_372_036_854_775_807n
const maxCreateRunBodySize = 16 * 1024

interface ApiEnvironment {
  Variables: {
    principal: SessionPrincipal
  }
}

interface CreateRunBody {
  installationId: string
  repositoryId: string
  baseSha: string
  targetBranch: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isValidDatabaseId(value: string): boolean {
  return decimalIdPattern.test(value) && BigInt(value) <= maxPostgresBigint
}

function isValidTargetBranch(value: string): boolean {
  if (
    value.length < 1 ||
    value.length > 255 ||
    value.startsWith('-') ||
    value === '@' ||
    value.endsWith('.') ||
    value.includes('..') ||
    value.includes('@{') ||
    [...value].some((character) => {
      const codePoint = character.charCodeAt(0)
      return invalidBranchCharacters.has(character) || codePoint <= 0x20 || codePoint >= 0x7f
    })
  ) {
    return false
  }

  return value
    .split('/')
    .every(
      (component) =>
        component.length > 0 && !component.startsWith('.') && !component.endsWith('.lock'),
    )
}

function parseCreateRunBody(value: unknown): CreateRunBody | null {
  if (!isObject(value) || Object.keys(value).some((key) => !createRunKeys.has(key))) {
    return null
  }

  const { installationId, repositoryId, baseSha, targetBranch } = value
  if (
    typeof installationId !== 'string' ||
    !isValidDatabaseId(installationId) ||
    typeof repositoryId !== 'string' ||
    !isValidDatabaseId(repositoryId) ||
    typeof baseSha !== 'string' ||
    !shaPattern.test(baseSha) ||
    typeof targetBranch !== 'string' ||
    !isValidTargetBranch(targetBranch)
  ) {
    return null
  }

  return { installationId, repositoryId, baseSha: baseSha.toLowerCase(), targetBranch }
}

function publicRun(run: RunRecord): PublicRun {
  return {
    id: run.id,
    installationId: run.installationId,
    repositoryId: run.repositoryId,
    baseSha: run.baseSha,
    targetBranch: run.targetBranch,
    status: run.status,
  }
}

function assertNever(_value: never): never {
  throw new Error('Unhandled run service result')
}

export function createApp(dependencies: ApiDependencies) {
  return new Hono<ApiEnvironment>()
    .get('/health', (c) => c.json({ status: 'ok' as const }))
    .use('/runs/*', async (c, next) => {
      const principal = await dependencies.authenticate(c.req.header('Authorization'))
      if (principal === null) {
        return c.json({ error: { code: 'unauthorized' as const } }, 401)
      }
      c.set('principal', principal)
      await next()
    })
    .post(
      '/runs',
      bodyLimit({
        maxSize: maxCreateRunBodySize,
        onError: (c) => c.json({ error: { code: 'payload_too_large' as const } }, 413),
      }),
      async (c) => {
        const principal = c.get('principal')
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
          default:
            return assertNever(result)
        }
      },
    )
    .get('/runs/:id', async (c) => {
      const principal = c.get('principal')
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
        default:
          return assertNever(result)
      }
    })
}

// Electron main imports this type for the Hono client, so response literals stay narrow.
export type ApiType = ReturnType<typeof createApp>
