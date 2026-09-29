import { createHash, randomBytes, randomUUID } from 'node:crypto'

import { and, eq, gt, sql } from 'drizzle-orm'

import { type Db } from '../../db/client.ts'
import { oauthStates, sessions, userIdentities, users } from '../../db/schema/index.ts'

export type OAuthProvider = 'github' | 'google'

export type OAuthIdentityInput = {
  provider: OAuthProvider
  providerUserId: string
  email?: string
  username: string
}

export type AuthenticatedSession = {
  sessionId: string
  userId: string
}

function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function generateSessionToken(): string {
  return randomBytes(32).toString('base64url')
}

function generateOAuthState(): string {
  return randomBytes(32).toString('base64url')
}

function generateUsername(provider: OAuthProvider, username: string): string {
  return `${provider}_${username}`
}

export async function createOAuthState(db: Db, provider: OAuthProvider): Promise<string> {
  const state = generateOAuthState()
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000)

  await db.insert(oauthStates).values({
    id: randomUUID(),
    state,
    provider,
    createdAt: new Date(),
    expiresAt,
  })

  return state
}

export async function consumeOAuthState(
  db: Db,
  provider: OAuthProvider,
  state: string,
): Promise<boolean> {
  const deleted = await db
    .delete(oauthStates)
    .where(
      and(
        eq(oauthStates.state, state),
        eq(oauthStates.provider, provider),
        gt(oauthStates.expiresAt, sql`now()`),
      ),
    )
    .returning({ id: oauthStates.id })

  return deleted.length > 0
}

export async function deleteExpiredOAuthStates(db: Db): Promise<number> {
  const result = await db.execute(sql`
    with expired as (
      select id
      from oauth_states
      where expires_at < now()
      order by expires_at
      limit 1000
    )
    delete from oauth_states
    using expired
    where oauth_states.id = expired.id
  `)
  return result.rowCount ?? 0
}

export async function upsertOAuthIdentity(
  db: Db,
  input: OAuthIdentityInput,
): Promise<{ userId: string }> {
  const normalizedEmail = input.email?.trim().toLowerCase()
  const existingIdentity = await db
    .select({
      userId: userIdentities.userId,
    })
    .from(userIdentities)
    .where(
      and(
        eq(userIdentities.provider, input.provider),
        eq(userIdentities.providerUserId, input.providerUserId),
      ),
    )
    .limit(1)

  const identity = existingIdentity[0]

  if (identity) {
    await db
      .update(userIdentities)
      .set({
        email: normalizedEmail ?? null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(userIdentities.provider, input.provider),
          eq(userIdentities.providerUserId, input.providerUserId),
        ),
      )

    return { userId: identity.userId }
  }

  return db.transaction(async (tx) => {
    let userId: string | undefined
    let createdUserId: string | undefined

    if (normalizedEmail) {
      const existingUser = await tx
        .select({ id: users.id })
        .from(users)
        .where(sql`lower(${users.email}) = ${normalizedEmail}`)
        .limit(1)
      userId = existingUser[0]?.id
    }

    if (!userId) {
      const createdUser = await tx
        .insert(users)
        .values({
          username: generateUsername(input.provider, input.username),
          email: normalizedEmail ?? null,
        })
        .onConflictDoNothing()
        .returning({ id: users.id })
      createdUserId = createdUser[0]?.id
      userId = createdUserId
    }

    if (!userId && normalizedEmail) {
      const concurrentUser = await tx
        .select({ id: users.id })
        .from(users)
        .where(sql`lower(${users.email}) = ${normalizedEmail}`)
        .limit(1)
      userId = concurrentUser[0]?.id
    }

    if (!userId) {
      throw new Error('Failed to create or find Adamant user')
    }

    const insertedIdentity = await tx
      .insert(userIdentities)
      .values({
        userId,
        provider: input.provider,
        providerUserId: input.providerUserId,
        email: normalizedEmail ?? null,
      })
      .onConflictDoNothing({
        target: [userIdentities.provider, userIdentities.providerUserId],
      })
      .returning({ userId: userIdentities.userId })

    if (insertedIdentity[0]) {
      return { userId: insertedIdentity[0].userId }
    }

    if (createdUserId) {
      await tx.delete(users).where(eq(users.id, createdUserId))
    }

    const winningIdentity = await tx
      .select({ userId: userIdentities.userId })
      .from(userIdentities)
      .where(
        and(
          eq(userIdentities.provider, input.provider),
          eq(userIdentities.providerUserId, input.providerUserId),
        ),
      )
      .limit(1)

    if (!winningIdentity[0]) {
      throw new Error('Failed to create or find OAuth identity')
    }

    return { userId: winningIdentity[0].userId }
  })
}

export async function createSession(
  db: Db,
  userId: string,
): Promise<{ token: string; sessionId: string }> {
  const token = generateSessionToken()
  const tokenHash = hashSessionToken(token)

  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)

  const createdSession = await db
    .insert(sessions)
    .values({
      userId,
      tokenHash,
      expiresAt,
    })
    .returning({
      id: sessions.id,
    })

  const session = createdSession[0]

  if (!session) {
    throw new Error('Failed to create session')
  }

  return {
    token,
    sessionId: session.id,
  }
}

export async function authenticateSession(
  db: Db,
  token: string,
): Promise<AuthenticatedSession | null> {
  const tokenHash = hashSessionToken(token)

  const result = await db
    .select({
      sessionId: sessions.id,
      userId: sessions.userId,
      revokedAt: sessions.revokedAt,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .where(eq(sessions.tokenHash, tokenHash))
    .limit(1)

  const session = result[0]

  if (!session) {
    return null
  }

  if (session.revokedAt) {
    return null
  }

  if (session.expiresAt && new Date(session.expiresAt).getTime() < Date.now()) {
    return null
  }

  await db
    .update(sessions)
    .set({
      lastUsedAt: new Date(),
    })
    .where(eq(sessions.id, session.sessionId))

  return {
    sessionId: session.sessionId,
    userId: session.userId,
  }
}

export async function revokeSession(db: Db, sessionId: string): Promise<void> {
  await db
    .update(sessions)
    .set({
      revokedAt: new Date(),
    })
    .where(eq(sessions.id, sessionId))
}

export async function getUserAuthInfo(
  db: Db,
  userId: string,
): Promise<{
  id: string
  username: string
  email: string | null
  providers: OAuthProvider[]
} | null> {
  const userResult = await db
    .select({
      id: users.id,
      username: users.username,
      email: users.email,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  const user = userResult[0]

  if (!user) {
    return null
  }

  const identities = await db
    .select({
      provider: userIdentities.provider,
    })
    .from(userIdentities)
    .where(eq(userIdentities.userId, userId))

  const providers = identities
    .map((identity) => identity.provider)
    .filter((provider): provider is OAuthProvider => provider === 'github' || provider === 'google')

  return {
    id: user.id,
    username: user.username,
    email: user.email,
    providers,
  }
}
