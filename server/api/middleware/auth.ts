import type { Context, Next } from 'hono'
import { getCookie } from 'hono/cookie'
import { timingSafeEqual } from 'node:crypto'

import { type Db } from '../../db/client.ts'
import { authenticateSession, type AuthenticatedSession } from '../services/authService.ts'

export type AuthVariables = {
  userId: string
  sessionId: string
}

export const SESSION_COOKIE_NAME = 'adamant_session'

export type AuthMiddlewareOptions = {
  database?: Db
  authenticate?: (token: string) => Promise<AuthenticatedSession | null>
  legacySession?: {
    token: string
    userId: string
  }
}

function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a)
  const bufferB = Buffer.from(b)
  return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB)
}

function readBearerToken(header: string | undefined): string | undefined {
  const match = header?.match(/^Bearer\s+(\S+)$/i)
  return match?.[1]
}

export function createAuthMiddleware(options: AuthMiddlewareOptions = {}) {
  const database = options.database
  const configuredLegacySession = options.legacySession
  const authenticate =
    options.authenticate ??
    (database ? (token: string) => authenticateSession(database, token) : undefined)

  return async function authMiddleware(c: Context, next: Next) {
    const token =
      c.req.header('ADAMANT_SESSION') ??
      readBearerToken(c.req.header('Authorization')) ??
      getCookie(c, SESSION_COOKIE_NAME) ??
      c.req.query('session')

    if (!token) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    try {
      if (authenticate) {
        const session = await authenticate(token)

        if (!session) {
          return c.json({ error: 'Unauthorized' }, 401)
        }

        c.set('userId', session.userId)
        c.set('sessionId', session.sessionId)
        await next()
        return
      }

      const legacySession =
        configuredLegacySession ??
        (process.env.ADAMANT_SESSION_SECRET && process.env.ADAMANT_SEED_USER_ID
          ? {
              token: process.env.ADAMANT_SESSION_SECRET,
              userId: process.env.ADAMANT_SEED_USER_ID,
            }
          : undefined)

      if (!legacySession) {
        throw new Error('No session authentication method is configured')
      }

      if (!safeEqual(token, legacySession.token)) {
        return c.json({ error: 'Unauthorized' }, 401)
      }

      c.set('userId', legacySession.userId)
      c.set('sessionId', 'phase-1-seeded-session')
      await next()
    } catch (error) {
      console.error('Failed to authenticate session', error)
      return c.json({ error: 'Server misconfiguration' }, 500)
    }
  }
}
