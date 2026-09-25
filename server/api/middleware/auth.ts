import type { Context, Next } from 'hono'

/**
 * Phase 1 User Authentication:
 * The CLI sends ADAMANT_SESSION in the header (or query param for SSE).
 * We compare it against the seeded ADAMANT_SESSION_SECRET.
 */
export async function authMiddleware(c: Context, next: Next) {
  const sessionHeader = c.req.header('ADAMANT_SESSION')
  const sessionQuery = c.req.query('session')
  const token = sessionHeader ?? sessionQuery
  const validToken = process.env.ADAMANT_SESSION_SECRET

  if (!validToken) {
    console.warn('ADAMANT_SESSION_SECRET is not configured!')
    return c.json({ error: 'Server misconfiguration' }, 500)
  }

  if (!token || token !== validToken) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  await next()
}
