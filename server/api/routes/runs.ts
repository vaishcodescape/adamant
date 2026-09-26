import { Hono } from 'hono'
import { authMiddleware, type AuthVariables } from '../middleware/auth.ts'
import { createDefaultRunApiStore, type RunApiStore } from '../services/runStore.ts'

export function createRunsRoute(store: RunApiStore = createDefaultRunApiStore()) {
  const route = new Hono<{ Variables: AuthVariables }>()
  route.use('*', authMiddleware)

  route.post('/', async (c) => {
    const key = c.req.header('idempotency-key')
    const body = (await c.req.json().catch(() => null)) as {
      repositoryId?: string
      sourceSha?: string
    } | null
    if (!key || !body?.repositoryId || !body.sourceSha) {
      return c.json({ error: 'Idempotency-Key, repositoryId, and sourceSha are required' }, 400)
    }
    const result = await store.create({
      repositoryId: body.repositoryId,
      sourceSha: body.sourceSha,
      idempotencyKey: key,
      userId: c.get('userId'),
    })
    return c.json({ run: result.run }, result.created ? 202 : 200)
  })

  route.get('/', async (c) => c.json({ runs: await store.list(c.get('userId')) }))
  route.get('/:id', async (c) => {
    const detail = await store.detail(c.get('userId'), c.req.param('id'))
    return detail ? c.json(detail) : c.json({ error: 'Run not found' }, 404)
  })
  return route
}
