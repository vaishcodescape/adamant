import { Hono } from 'hono'

import { createDb, type Db } from '../db/client.ts'
import { createApp, resourceNames } from './app.ts'
import { createAuthMiddleware } from './middleware/auth.ts'
import { createActivityRoute } from './routes/activity.ts'
import { createAuthRoute, type OAuthConfig } from './routes/auth.ts'
import { createRunsRoute } from './routes/runs.ts'
import { createActivityService, type ActivityService } from './services/activityService.ts'
import { createPostgresRunApiStore, type RunApiStore } from './services/runStore.ts'
import { github } from './webhooks/github.ts'

/**
 * Schema CRUD serves /runs and every other resource table. The dedicated runs
 * router is a CLI-shaped stub and would hide those handlers, so auth is
 * applied here per resource (looping resourceNames so a new resource cannot
 * ship unauthenticated by omission) and that router stays available for
 * direct tests. GitHub calls /webhooks/github with its own signature, and
 * /health stays open for infra checks.
 */
export type ServerOptions = {
  database?: Db
  oauthConfig?: OAuthConfig
  fetch?: typeof globalThis.fetch
  activityService?: ActivityService
}

function readOAuthConfig(): OAuthConfig {
  const provider = (name: 'GITHUB' | 'GOOGLE') => {
    const clientId = process.env[`${name}_OAUTH_CLIENT_ID`]
    const clientSecret = process.env[`${name}_OAUTH_CLIENT_SECRET`]
    const redirectUri = process.env[`${name}_OAUTH_REDIRECT_URI`]
    return clientId && clientSecret && redirectUri
      ? { clientId, clientSecret, redirectUri }
      : undefined
  }

  const github = provider('GITHUB')
  const google = provider('GOOGLE')
  return {
    ...(github ? { github } : {}),
    ...(google ? { google } : {}),
  }
}

export function createServerApp(runStore?: RunApiStore, options: ServerOptions = {}) {
  const app = new Hono()
  const database =
    options.database ?? (process.env.DATABASE_URL ? createDb(process.env.DATABASE_URL) : undefined)
  const authMiddleware = createAuthMiddleware({
    ...(database ? { database } : {}),
  })
  const resolvedRunStore = runStore ?? (database ? createPostgresRunApiStore(database) : undefined)
  const resolvedActivityService =
    options.activityService ??
    createActivityService({
      ...(database ? { database } : {}),
    })

  for (const name of resourceNames) {
    app.use(`/${name}`, authMiddleware)
    app.use(`/${name}/*`, authMiddleware)
  }

  app.use('/activity', authMiddleware)
  app.use('/activity/*', authMiddleware)

  if (resolvedRunStore) {
    app.route('/runs', createRunsRoute(resolvedRunStore, authMiddleware))
  }

  if (database) {
    app.route(
      '/auth',
      createAuthRoute(database, options.oauthConfig ?? readOAuthConfig(), {
        ...(options.fetch ? { fetch: options.fetch } : {}),
      }),
    )
  }

  createApp(undefined, app, resolvedActivityService)

  app.route('/webhooks/github', github)
  app.route('/activity', createActivityRoute(resolvedActivityService))

  return app
}

export type ApiType = ReturnType<typeof createServerApp>
