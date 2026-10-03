import { Hono } from 'hono'
import { type MiddlewareHandler } from 'hono'
import { createAuthMiddleware, type AuthVariables } from '../middleware/auth.ts'
import {
  createDefaultRunApiStore,
  UnknownRepositoryError,
  type RunApiStore,
} from '../services/runStore.ts'

// The worker passes this to `git fetch` and `git checkout`. Anything but a full
// hex object id could be read as an option, and a short one cannot be fetched.
const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i

export function createRunsRoute(
  store: RunApiStore = createDefaultRunApiStore(),
  requireSession: MiddlewareHandler = createAuthMiddleware(),
) {
  const route = new Hono<{ Variables: AuthVariables }>()
  route.use('*', requireSession)

  route.post('/', async (c) => {
    const key = c.req.header('idempotency-key')
    const body = (await c.req.json().catch(() => null)) as {
      repositoryId?: string
      sourceSha?: string
    } | null
    if (!key || !body?.repositoryId || !body.sourceSha) {
      return c.json({ error: 'Idempotency-Key, repositoryId, and sourceSha are required' }, 400)
    }
    if (!COMMIT_SHA.test(body.sourceSha)) {
      return c.json({ error: 'sourceSha must be a full commit SHA' }, 400)
    }
    try {
      const result = await store.create({
        repositoryId: body.repositoryId,
        sourceSha: body.sourceSha,
        idempotencyKey: key,
        userId: c.get('userId'),
      })
      return c.json({ run: result.run }, result.created ? 202 : 200)
    } catch (error) {
      if (error instanceof UnknownRepositoryError) {
        return c.json({ error: error.message }, 404)
      }
      throw error
    }
  })

  route.get('/', async (c) => c.json({ runs: await store.list(c.get('userId')) }))
  route.get('/:id', async (c) => {
    const detail = await store.detail(c.get('userId'), c.req.param('id'))
    return detail ? c.json(detail) : c.json({ error: 'Run not found' }, 404)
  })
  return route
}
