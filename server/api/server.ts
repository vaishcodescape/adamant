import { Hono, type MiddlewareHandler } from 'hono'

import { createDb, type Db } from '../db/client.ts'
import { createApp, resourceNames } from './app.ts'
import { createAuthMiddleware } from './middleware/auth.ts'
import { createActivityRoute } from './routes/activity.ts'
import { createAuthRoute, type OAuthConfig } from './routes/auth.ts'
import { createRunsRoute } from './routes/runs.ts'
import { createActivityService, type ActivityService } from './services/activityService.ts'
import { createPostgresRunApiStore, type RunApiStore } from './services/runStore.ts'
import { createWebhookService } from './services/webhookService.ts'
import { createPostgresWebhookStore } from './services/webhookStore.ts'
import { createGithubWebhookRoute } from './webhooks/github.ts'

/**
 * Auth is applied here per resource (looping resourceNames so a new resource
 * cannot ship unauthenticated by omission). GitHub calls /webhooks/github with
 * its own signature, and /health stays open for infra checks.
 *
 * With a database, /runs is the Postgres-backed router and the in-memory
 * schema CRUD is not mounted: its rows never reach Postgres, its maps grow
 * without bound, and its POST /audit-events would publish forged events to
 * every `adamant watch`. Without a database the CRUD is the local stand-in.
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

const alreadyAuthenticated: MiddlewareHandler = async (_c, next) => {
  await next()
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

  for (const name of [...resourceNames, 'activity']) {
    app.use(`/${name}`, authMiddleware)
    app.use(`/${name}/*`, authMiddleware)
  }

  if (resolvedRunStore) {
    // The loop above already authenticated /runs; a second pass would repeat
    // the session lookup on every request.
    app.route('/runs', createRunsRoute(resolvedRunStore, alreadyAuthenticated))
  }

  if (database) {
    app.route(
      '/auth',
      createAuthRoute(database, options.oauthConfig ?? readOAuthConfig(), {
        ...(options.fetch ? { fetch: options.fetch } : {}),
      }),
    )
    app.get('/health', (c) => c.json({ status: 'ok' }))
  } else {
    createApp(undefined, app, resolvedActivityService)
  }

  // One pool per process: the webhook store reuses the server's database.
  app.route(
    '/webhooks/github',
    createGithubWebhookRoute(
      database ? createWebhookService({ store: createPostgresWebhookStore(database) }) : undefined,
    ),
  )
  app.route('/activity', createActivityRoute(resolvedActivityService))

  return app
}

export type ApiType = ReturnType<typeof createServerApp>
