import { Hono } from 'hono'
import { createApp, resourceNames } from './app.ts'
import { authMiddleware } from './middleware/auth.ts'
import { activity } from './routes/activity.ts'
import { createRunsRoute } from './routes/runs.ts'
import { type RunApiStore } from './services/runStore.ts'
import { github } from './webhooks/github.ts'

/**
 * Schema CRUD serves /runs and every other resource table. The dedicated runs
 * router is a CLI-shaped stub and would hide those handlers, so auth is
 * applied here per resource (looping resourceNames so a new resource cannot
 * ship unauthenticated by omission) and that router stays available for
 * direct tests. GitHub calls /webhooks/github with its own signature, and
 * /health stays open for infra checks.
 */
export function createServerApp(runStore?: RunApiStore) {
  const app = new Hono()

  for (const name of resourceNames) {
    app.use(`/${name}`, authMiddleware)
    app.use(`/${name}/*`, authMiddleware)
  }
  app.use('/activity', authMiddleware)
  app.use('/activity/*', authMiddleware)

  if (runStore || process.env.DATABASE_URL) {
    app.route('/runs', createRunsRoute(runStore))
  }
  createApp(undefined, app)
  app.route('/webhooks/github', github)
  app.route('/activity', activity)

  return app
}

export type ApiType = ReturnType<typeof createServerApp>
