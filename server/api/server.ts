import { Hono } from 'hono'
import { authMiddleware } from './middleware/auth.ts'
import { activity } from './routes/activity.ts'
import { createRunsRoute } from './routes/runs.ts'
import { type RunApiStore } from './services/runStore.ts'
import { github } from './webhooks/github.ts'

/**
 * Schema CRUD serves /runs. The dedicated runs router is a CLI-shaped stub and
 * would hide those handlers, so auth is applied here and that router stays
 * available for direct tests. GitHub calls /webhooks/github with its own signature.
 */
export function createServerApp(runStore?: RunApiStore) {
  const app = new Hono()

  app.get('/health', (c) => c.json({ status: 'ok' }))

  app.use('/runs', authMiddleware)
  app.use('/runs/*', authMiddleware)
  app.use('/activity', authMiddleware)
  app.use('/activity/*', authMiddleware)

  if (runStore || process.env.DATABASE_URL) {
    app.route('/runs', createRunsRoute(runStore))
  }
  app.route('/webhooks/github', github)
  app.route('/activity', activity)

  return app
}

export type ApiType = ReturnType<typeof createServerApp>
