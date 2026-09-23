import { serve } from '@hono/node-server'

import { createApp } from './app.ts'
import { type RunService } from './ports.ts'

const unavailableRuns: RunService = {
  createRun: async () => ({ kind: 'unavailable' }),
  readRun: async () => ({ kind: 'unavailable' }),
}

const app = createApp({
  // Session verification and persistent run storage arrive through their dedicated packages.
  // Until then, the executable server fails closed while route tests inject trusted fakes.
  authenticate: async () => null,
  runs: unavailableRuns,
})

export { type ApiType } from './app.ts'

const port = Number(process.env.PORT ?? 8787)

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`@adamant/api listening on http://localhost:${info.port}`)
})
