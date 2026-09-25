import { defineConfig } from 'drizzle-kit'

const url = process.env.DATABASE_URL

if (!url) {
  throw new Error('DATABASE_URL is required to run drizzle-kit')
}

export default defineConfig({
  dialect: 'postgresql',
  // drizzle-kit resolves these from server/, where the db:* scripts run.
  schema: './db/schema/index.ts',
  out: './db/drizzle',
  dbCredentials: { url },
})
