import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { timingSafeEqual } from 'node:crypto'

import { type Db } from '../../db/client.ts'
import {
  createAuthMiddleware,
  SESSION_COOKIE_NAME,
  type AuthVariables,
} from '../middleware/auth.ts'
import {
  consumeOAuthState,
  createOAuthState,
  createSession,
  getUserAuthInfo,
  revokeSession,
  upsertOAuthIdentity,
  type OAuthProvider,
} from '../services/authService.ts'

const OAUTH_REQUEST_TIMEOUT_MS = 10_000
const OAUTH_STATE_MAX_AGE_SECONDS = 15 * 60
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60

export type OAuthProviderConfig = {
  clientId: string
  clientSecret: string
  redirectUri: string
}

export type OAuthConfig = {
  github?: OAuthProviderConfig
  google?: OAuthProviderConfig
}

export type AuthRouteOptions = {
  fetch?: typeof globalThis.fetch
}

class OAuthConfigurationError extends Error {}
class InvalidOAuthStateError extends Error {}

function getProviderConfig(config: OAuthConfig, provider: OAuthProvider): OAuthProviderConfig {
  const providerConfig = config[provider]
  if (!providerConfig) {
    throw new OAuthConfigurationError(`${provider} OAuth is not configured`)
  }
  return providerConfig
}

async function createOAuthAuthorizationUrl(
  db: Db,
  config: OAuthConfig,
  provider: OAuthProvider,
): Promise<{ state: string; url: string }> {
  const providerConfig = getProviderConfig(config, provider)
  const state = await createOAuthState(db, provider)

  const params = new URLSearchParams({
    client_id: providerConfig.clientId,
    redirect_uri: providerConfig.redirectUri,
    state,
  })

  if (provider === 'github') {
    params.set('scope', 'read:user user:email')

    return { state, url: `https://github.com/login/oauth/authorize?${params.toString()}` }
  }

  params.set('response_type', 'code')
  params.set('scope', 'openid email profile')
  params.set('access_type', 'offline')

  return { state, url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` }
}

function oauthStateCookieName(provider: OAuthProvider): string {
  return `adamant_oauth_${provider}_state`
}

function oauthStateCookiePath(provider: OAuthProvider): string {
  return `/auth/${provider}/callback`
}

function matchesBrowserState(browserState: string | undefined, callbackState: string): boolean {
  if (!browserState) return false

  const browserStateBytes = Buffer.from(browserState)
  const callbackStateBytes = Buffer.from(callbackState)
  return (
    browserStateBytes.length === callbackStateBytes.length &&
    timingSafeEqual(browserStateBytes, callbackStateBytes)
  )
}

async function exchangeCode(
  fetchProvider: typeof globalThis.fetch,
  config: OAuthConfig,
  provider: OAuthProvider,
  code: string,
): Promise<string> {
  const providerConfig = getProviderConfig(config, provider)

  const body = new URLSearchParams({
    client_id: providerConfig.clientId,
    client_secret: providerConfig.clientSecret,
    code,
    redirect_uri: providerConfig.redirectUri,
  })

  if (provider === 'github') {
    const response = await fetchProvider('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
      },
      body,
      signal: AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS),
    })

    if (!response.ok) {
      throw new Error('GitHub OAuth token exchange failed')
    }

    const data = (await response.json()) as {
      access_token?: string
      error?: string
      error_description?: string
    }

    if (!data.access_token) {
      throw new Error(data.error_description || data.error || 'GitHub OAuth token was not returned')
    }

    return data.access_token
  }

  body.set('grant_type', 'authorization_code')

  const response = await fetchProvider('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
    signal: AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS),
  })

  if (!response.ok) {
    throw new Error('Google OAuth token exchange failed')
  }

  const data = (await response.json()) as {
    access_token?: string
    error?: string
    error_description?: string
  }

  if (!data.access_token) {
    throw new Error(data.error_description || data.error || 'Google OAuth token was not returned')
  }

  return data.access_token
}

async function authenticateOAuthUser(
  fetchProvider: typeof globalThis.fetch,
  provider: OAuthProvider,
  accessToken: string,
): Promise<{
  providerUserId: string
  username: string
  email?: string
}> {
  if (provider === 'github') {
    const userResponse = await fetchProvider('https://api.github.com/user', {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'Adamant',
      },
      signal: AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS),
    })

    if (!userResponse.ok) {
      throw new Error('Failed to fetch GitHub user')
    }

    const user = (await userResponse.json()) as {
      id?: number
      login?: string
    }

    if (!user.id || !user.login) {
      throw new Error('GitHub user information is incomplete')
    }

    let verifiedEmail: string | undefined

    const emailsResponse = await fetchProvider('https://api.github.com/user/emails', {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'Adamant',
      },
      signal: AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS),
    })

    if (emailsResponse.ok) {
      const emails = (await emailsResponse.json()) as Array<{
        email?: string
        verified?: boolean
        primary?: boolean
      }>

      const primaryVerifiedEmail = emails.find(
        (entry) => entry.email && entry.verified && entry.primary,
      )

      const verifiedEmailEntry =
        primaryVerifiedEmail ?? emails.find((entry) => entry.email && entry.verified)

      verifiedEmail = verifiedEmailEntry?.email?.trim().toLowerCase()
    }

    return {
      providerUserId: String(user.id),
      username: user.login,
      ...(verifiedEmail ? { email: verifiedEmail } : {}),
    }
  }

  const response = await fetchProvider('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    signal: AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS),
  })

  if (!response.ok) {
    throw new Error('Failed to fetch Google user')
  }

  const user = (await response.json()) as {
    sub?: string
    email?: string
    email_verified?: boolean
    name?: string
  }

  if (!user.sub) {
    throw new Error('Google user information is incomplete')
  }

  return {
    providerUserId: user.sub,
    username: user.name ?? user.email ?? `google_${user.sub}`,
    ...(user.email_verified && user.email ? { email: user.email.trim().toLowerCase() } : {}),
  }
}

async function handleOAuthCallback(
  db: Db,
  config: OAuthConfig,
  fetchProvider: typeof globalThis.fetch,
  provider: OAuthProvider,
  code: string,
  state: string,
) {
  const validState = await consumeOAuthState(db, provider, state)

  if (!validState) {
    throw new InvalidOAuthStateError()
  }

  const accessToken = await exchangeCode(fetchProvider, config, provider, code)

  const identity = await authenticateOAuthUser(fetchProvider, provider, accessToken)

  const { userId } = await upsertOAuthIdentity(db, {
    provider,
    providerUserId: identity.providerUserId,
    username: identity.username,
    ...(identity.email ? { email: identity.email } : {}),
  })

  const session = await createSession(db, userId)

  return session
}

function oauthFailureStatus(error: unknown): 500 | 503 {
  return error instanceof OAuthConfigurationError ? 503 : 500
}

export function createAuthRoute(db: Db, config: OAuthConfig, options: AuthRouteOptions = {}) {
  const auth = new Hono<{ Variables: AuthVariables }>()
  const fetchProvider = options.fetch ?? globalThis.fetch
  const requireSession = createAuthMiddleware({ database: db })

  for (const provider of ['github', 'google'] as const) {
    auth.get(`/${provider}`, async (c) => {
      try {
        const { state, url } = await createOAuthAuthorizationUrl(db, config, provider)
        setCookie(c, oauthStateCookieName(provider), state, {
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
          path: oauthStateCookiePath(provider),
          maxAge: OAUTH_STATE_MAX_AGE_SECONDS,
        })
        return c.redirect(url)
      } catch (error) {
        console.error(`${provider} OAuth initialization failed`, error)
        return c.json({ error: 'OAuth authentication is unavailable' }, oauthFailureStatus(error))
      }
    })

    auth.get(`/${provider}/callback`, async (c) => {
      c.header('Cache-Control', 'no-store')
      const code = c.req.query('code')
      const state = c.req.query('state')

      if (!code || !state) {
        return c.json({ error: 'OAuth code and state are required' }, 400)
      }

      const browserState = getCookie(c, oauthStateCookieName(provider))
      if (!matchesBrowserState(browserState, state)) {
        return c.json({ error: 'Invalid or expired OAuth state' }, 400)
      }

      deleteCookie(c, oauthStateCookieName(provider), {
        secure: true,
        path: oauthStateCookiePath(provider),
      })

      try {
        const session = await handleOAuthCallback(db, config, fetchProvider, provider, code, state)
        setCookie(c, SESSION_COOKIE_NAME, session.token, {
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
          path: '/',
          maxAge: SESSION_MAX_AGE_SECONDS,
        })
        return c.json({ authenticated: true })
      } catch (error) {
        console.error(`${provider} OAuth callback failed`, error)
        if (error instanceof InvalidOAuthStateError) {
          return c.json({ error: 'Invalid or expired OAuth state' }, 400)
        }
        return c.json({ error: 'OAuth authentication failed' }, oauthFailureStatus(error))
      }
    })
  }

  auth.use('/logout', requireSession)
  auth.post('/logout', async (c) => {
    try {
      await revokeSession(db, c.get('sessionId'))
      deleteCookie(c, SESSION_COOKIE_NAME, {
        secure: true,
        path: '/',
      })
      c.header('Cache-Control', 'no-store')
      return c.json({ message: 'Logged out successfully' })
    } catch (error) {
      console.error('Failed to logout', error)
      return c.json({ error: 'Failed to logout' }, 500)
    }
  })

  auth.use('/me', requireSession)
  auth.get('/me', async (c) => {
    c.header('Cache-Control', 'no-store')
    try {
      const user = await getUserAuthInfo(db, c.get('userId'))
      return user ? c.json({ user }) : c.json({ error: 'User not found' }, 404)
    } catch (error) {
      console.error('Failed to load user', error)
      return c.json({ error: 'Failed to load user' }, 500)
    }
  })

  return auth
}
