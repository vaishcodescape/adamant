import { serve } from '@hono/node-server'
import { createServerApp, type ApiType } from './server.ts'

const app = createServerApp()

export type { ApiType }

const port = Number(process.env.PORT ?? 8787)

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`@adamant/api listening on http://localhost:${info.port}`)
})
