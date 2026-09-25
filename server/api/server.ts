import { Hono } from 'hono'
import { createApp } from './app.ts'
import { authMiddleware } from './middleware/auth.ts'
import { activity } from './routes/activity.ts'
import { github } from './webhooks/github.ts'

/**
 * Schema CRUD serves /runs. The dedicated runs router is a CLI-shaped stub and
 * would hide those handlers, so auth is applied here and that router stays
 * available for direct tests. GitHub calls /webhooks/github with its own signature.
 */
export function createServerApp() {
  const app = new Hono()

  app.use('/runs', authMiddleware)
  app.use('/runs/*', authMiddleware)
  app.use('/activity', authMiddleware)
  app.use('/activity/*', authMiddleware)

  createApp(undefined, app)
  app.route('/webhooks/github', github)
  app.route('/activity', activity)

  return app
}

export type ApiType = ReturnType<typeof createServerApp>
