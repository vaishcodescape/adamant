import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createAuthMiddleware } from '../../server/api/middleware/auth.ts'
import { createAuthRoute } from '../../server/api/routes/auth.ts'
import { createRunsRoute } from '../../server/api/routes/runs.ts'
import { consumeOAuthState, upsertOAuthIdentity } from '../../server/api/services/authService.ts'
import { type RunApiStore } from '../../server/api/services/runStore.ts'
import { type Db } from '../../server/db/client.ts'

describe('session authentication', () => {
  it('accepts bearer tokens and exposes the authenticated context', async () => {
    let authenticatedUserId: string | undefined
    const store = {
      create: async () => {
        throw new Error('not used')
      },
      list: async (userId) => {
        authenticatedUserId = userId
        return []
      },
      detail: async () => null,
    } satisfies RunApiStore
    const app = createRunsRoute(
      store,
      createAuthMiddleware({
        authenticate: async (token) =>
          token === 'valid'
            ? {
                sessionId: 'session-1',
                userId: 'user-1',
              }
            : null,
      }),
    )

    assert.equal((await app.request('/')).status, 401)
    assert.equal(
      (
        await app.request('/', {
          headers: { Authorization: 'Basic valid' },
        })
      ).status,
      401,
    )

    const response = await app.request('/', {
      headers: { Authorization: 'Bearer valid' },
    })
    assert.equal(response.status, 200)
    assert.equal(authenticatedUserId, 'user-1')
  })

  it('accepts the HttpOnly browser-session cookie', async () => {
    let authenticatedToken: string | undefined
    const store = {
      create: async () => {
        throw new Error('not used')
      },
      list: async () => [],
      detail: async () => null,
    } satisfies RunApiStore
    const app = createRunsRoute(
      store,
      createAuthMiddleware({
        authenticate: async (token) => {
          authenticatedToken = token
          return { sessionId: 'session-1', userId: 'user-1' }
        },
      }),
    )

    const response = await app.request('/', {
      headers: { Cookie: 'adamant_session=cookie-token' },
    })

    assert.equal(response.status, 200)
    assert.equal(authenticatedToken, 'cookie-token')
  })

  it('keeps the seeded Phase 1 session as a database-free fallback', async () => {
    let authenticatedUserId: string | undefined
    const store = {
      create: async () => {
        throw new Error('not used')
      },
      list: async (userId) => {
        authenticatedUserId = userId
        return []
      },
      detail: async () => null,
    } satisfies RunApiStore
    const app = createRunsRoute(
      store,
      createAuthMiddleware({
        legacySession: {
          token: 'seed-token',
          userId: 'seed-user',
        },
      }),
    )

    assert.equal((await app.request('/?session=wrong')).status, 401)
    const response = await app.request('/?session=seed-token')
    assert.equal(response.status, 200)
    assert.equal(authenticatedUserId, 'seed-user')
  })
})

describe('OAuth persistence', () => {
  it('consumes state with one delete and returns whether a row was removed', async () => {
    let deleteCalls = 0
    const database = {
      delete: () => {
        deleteCalls += 1
        return {
          where: () => ({
            returning: async () => [{ id: 'state-1' }],
          }),
        }
      },
    } as unknown as Db

    assert.equal(await consumeOAuthState(database, 'github', 'state'), true)
    assert.equal(deleteCalls, 1)
  })

  it('removes a newly created user when another callback wins the identity race', async () => {
    let insertCalls = 0
    let deletedUserId: string | undefined
    const transaction = {
      insert: () => {
        insertCalls += 1
        return {
          values: () => ({
            onConflictDoNothing: () => ({
              returning: async () => (insertCalls === 1 ? [{ id: 'created-user' }] : []),
            }),
          }),
        }
      },
      delete: () => ({
        where: (condition: unknown) => {
          assert.ok(condition)
          deletedUserId = 'created-user'
          return Promise.resolve()
        },
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ userId: 'winning-user' }],
          }),
        }),
      }),
    }
    const database = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [],
          }),
        }),
      }),
      transaction: async (callback: (tx: typeof transaction) => Promise<{ userId: string }>) =>
        callback(transaction),
    } as unknown as Db

    const result = await upsertOAuthIdentity(database, {
      provider: 'github',
      providerUserId: 'provider-user',
      username: 'octocat',
    })

    assert.deepEqual(result, { userId: 'winning-user' })
    assert.equal(deletedUserId, 'created-user')
  })
})

describe('OAuth routes', () => {
  it('does not expose missing configuration details', async () => {
    const app = createAuthRoute({} as Db, {})
    const response = await app.request('/github')

    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), {
      error: 'OAuth authentication is unavailable',
    })
  })

  it('binds the authorization state to the initiating browser', async () => {
    let storedState: string | undefined
    const database = {
      insert: () => ({
        values: async (value: { state: string }) => {
          storedState = value.state
        },
      }),
    } as unknown as Db
    const app = createAuthRoute(database, {
      github: {
        clientId: 'client',
        clientSecret: 'secret',
        redirectUri: 'http://localhost/callback',
      },
    })

    const response = await app.request('/github')
    const location = new URL(response.headers.get('location') ?? '')
    const state = location.searchParams.get('state')
    const cookie = response.headers.get('set-cookie')

    assert.equal(response.status, 302)
    assert.equal(state, storedState)
    assert.match(cookie ?? '', new RegExp(`adamant_oauth_github_state=${state}`))
    assert.match(cookie ?? '', /HttpOnly/i)
    assert.match(cookie ?? '', /Secure/i)
    assert.match(cookie ?? '', /SameSite=Lax/i)
    assert.match(cookie ?? '', /Path=\/auth\/github\/callback/i)
  })

  it('rejects callbacks not bound to the initiating browser before consuming state', async () => {
    let stateConsumptionAttempts = 0
    let providerRequests = 0
    const database = {
      delete: () => {
        stateConsumptionAttempts += 1
        return {
          where: () => ({
            returning: async () => [{ id: 'state-1' }],
          }),
        }
      },
    } as unknown as Db
    const app = createAuthRoute(
      database,
      {
        github: {
          clientId: 'client',
          clientSecret: 'secret',
          redirectUri: 'http://localhost/callback',
        },
      },
      {
        fetch: async () => {
          providerRequests += 1
          return Response.json({ access_token: 'provider-token' })
        },
      },
    )

    const missingCookie = await app.request('/github/callback?code=code&state=state')
    const mismatchedCookie = await app.request('/github/callback?code=code&state=state', {
      headers: { Cookie: 'adamant_oauth_github_state=another-state' },
    })

    assert.equal(missingCookie.status, 400)
    assert.equal(mismatchedCookie.status, 400)
    assert.equal(stateConsumptionAttempts, 0)
    assert.equal(providerRequests, 0)
  })

  it('bounds provider requests and hides callback failures', async () => {
    const database = {
      delete: () => ({
        where: () => ({
          returning: async () => [{ id: 'state-1' }],
        }),
      }),
    } as unknown as Db
    let requestSignal: AbortSignal | null | undefined
    const app = createAuthRoute(
      database,
      {
        github: {
          clientId: 'client',
          clientSecret: 'secret',
          redirectUri: 'http://localhost/callback',
        },
      },
      {
        fetch: async (_input, init) => {
          requestSignal = init?.signal
          throw new Error('provider secret detail')
        },
      },
    )

    const response = await app.request('/github/callback?code=code&state=state', {
      headers: { Cookie: 'adamant_oauth_github_state=state' },
    })
    assert.ok(requestSignal instanceof AbortSignal)
    assert.equal(response.status, 500)
    assert.deepEqual(await response.json(), {
      error: 'OAuth authentication failed',
    })
  })

  it('hands the session to browsers only through a non-cacheable HttpOnly cookie', async () => {
    const database = {
      delete: () => ({
        where: () => ({
          returning: async () => [{ id: 'state-1' }],
        }),
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ userId: 'user-1' }],
          }),
        }),
      }),
      update: () => ({
        set: () => ({
          where: async () => {},
        }),
      }),
      insert: () => ({
        values: () => ({
          returning: async () => [{ id: 'session-1' }],
        }),
      }),
    } as unknown as Db
    const providerResponses = [
      Response.json({ access_token: 'provider-token' }),
      Response.json({ id: 123, login: 'octocat' }),
      Response.json([]),
    ]
    const app = createAuthRoute(
      database,
      {
        github: {
          clientId: 'client',
          clientSecret: 'secret',
          redirectUri: 'http://localhost/callback',
        },
      },
      {
        fetch: async () => {
          const response = providerResponses.shift()
          if (!response) throw new Error('unexpected provider request')
          return response
        },
      },
    )

    const response = await app.request('/github/callback?code=code&state=state', {
      headers: { Cookie: 'adamant_oauth_github_state=state' },
    })
    const cookie = response.headers.get('set-cookie')
    const body = await response.text()

    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(JSON.parse(body), { authenticated: true })
    assert.match(cookie ?? '', /adamant_session=/)
    assert.match(cookie ?? '', /HttpOnly/i)
    assert.match(cookie ?? '', /Secure/i)
    assert.match(cookie ?? '', /SameSite=Lax/i)
    assert.doesNotMatch(body, /provider-token/)
  })
})
