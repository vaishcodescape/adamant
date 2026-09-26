import type { Context, Next } from 'hono'
import { timingSafeEqual } from 'node:crypto'

/** Same shape either way, so length alone cannot short-circuit the compare. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB)
}

export type AuthVariables = { userId: string }

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

  if (!token || !safeEqual(token, validToken)) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const userId = process.env.ADAMANT_SEED_USER_ID
  if (!userId) {
    return c.json({ error: 'Server misconfiguration' }, 500)
  }
  c.set('userId', userId)

  await next()
}
