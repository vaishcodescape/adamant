import { serve } from '@hono/node-server'
import { runMigrations } from 'graphile-worker'
import { createServerApp, type ApiType } from './server.ts'

export type { ApiType }

const port = Number(process.env.PORT ?? 8787)
const connectionString = process.env.DATABASE_URL

// The API enqueues jobs inside its own transactions, so it needs graphile-worker's
// schema even if no worker has started yet. A webhook that fails here is lost:
// GitHub does not redeliver it. The migration is idempotent and lock-guarded.
if (connectionString) {
  await runMigrations({ connectionString })
}

const app = createServerApp()

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`@adamant/api listening on http://localhost:${info.port}`)
})
