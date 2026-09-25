import { Hono } from 'hono'
import { authMiddleware } from '../middleware/auth.ts'

const runs = new Hono()

// Secure all /runs endpoints with User Authentication
runs.use('*', authMiddleware)

runs.post('/', async (c) => {
  // Start a manual run (Phase 1 hits this or webhooks)
  return c.json({ runId: 'TODO', status: 'queued' }, 202)
})

runs.get('/', async (c) => {
  // CLI list runs
  return c.json({ runs: [] })
})

runs.get('/:id', async (c) => {
  // CLI detail
  return c.json({ id: c.req.param('id'), status: 'queued', audit_events: [] })
})

export { runs }
