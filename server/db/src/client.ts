import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema/index.ts'

/**
 * One Pool per process. The API process and the worker process each call this
 * once with their own DATABASE_URL and hold onto the result — do not create a
 * new pool per request/job. core/agent's PostgresSaver takes its own
 * connection string directly from the worker; it does not go through this
 * client.
 */
export function createDb(url: string) {
  if (!url) {
    throw new Error('DATABASE_URL is required to create the database client')
  }

  const pool = new Pool({ connectionString: url })
  return drizzle(pool, { schema })
}

export type Db = ReturnType<typeof createDb>
export * from './schema/index.ts'
