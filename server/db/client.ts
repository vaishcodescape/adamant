import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema/index.ts'

/**
 * One Pool per process. The API process and the worker process each call this
 * once with their own DATABASE_URL and hold onto the result — do not create a
 * new pool per request/job. The worker hands this pool to graphile-worker and
 * to the LangGraph checkpointer too, so one process opens one pool.
 */
export function createDb(url: string, options: { maxConnections?: number } = {}) {
  if (!url) {
    throw new Error('DATABASE_URL is required to create the database client')
  }

  const pool = new Pool({
    connectionString: url,
    ...(options.maxConnections ? { max: options.maxConnections } : {}),
  })
  // An idle client that loses its backend (restart, failover, network drop) is
  // reported here. Unhandled, that 'error' event crashes the whole process; the
  // pool already discards the client and opens a new one on the next query.
  pool.on('error', (error) => {
    console.error('Postgres idle client error', error)
  })
  // The same for a client that is checked out when its connection drops, such
  // as graphile-worker's long-lived LISTEN client. Queries still reject as usual.
  pool.on('connect', (client) => {
    client.on('error', (error) => {
      console.error('Postgres client error', error)
    })
  })
  return drizzle(pool, { schema })
}

export type Db = ReturnType<typeof createDb>
export * from './schema/index.ts'
