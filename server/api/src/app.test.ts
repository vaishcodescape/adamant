import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createApp } from './app.ts'
import {
  type ApiDependencies,
  type CreateRunCommand,
  type CreateRunResult,
  type ReadRunResult,
  type RunRecord,
} from './contracts.ts'

const validBody = {
  installationId: '123',
  repositoryId: '456',
  baseSha: 'A'.repeat(40),
  targetBranch: 'main',
}

const run: RunRecord = {
  id: 'run_123',
  actorUserId: 'user_1',
  installationId: '123',
  repositoryId: '456',
  baseSha: 'a'.repeat(40),
  targetBranch: 'main',
  status: 'queued',
}

function requestBody(body: unknown, idempotencyKey = 'request-1'): RequestInit {
  return {
    method: 'POST',
    headers: {
      Authorization: 'Bearer session',
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(body),
  }
}

function dependencies(
  overrides: {
    createResult?: CreateRunResult
    readResult?: ReadRunResult
    commands?: CreateRunCommand[]
    authenticated?: boolean
  } = {},
): ApiDependencies {
  const commands = overrides.commands ?? []
  return {
    authenticate: async (authorization) =>
      overrides.authenticated === false || authorization !== 'Bearer session'
        ? null
        : { userId: 'user_1' },
    runs: {
      createRun: async (command) => {
        commands.push(command)
        return overrides.createResult ?? { kind: 'created', run }
      },
      readRun: async () => overrides.readResult ?? { kind: 'found', run },
    },
  }
}

describe('API', () => {
  it('reports health without authentication', async () => {
    const response = await createApp(dependencies()).request('/health')

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { status: 'ok' })
  })

  it('rejects run creation without a valid session', async () => {
    const app = createApp(dependencies())
    const response = await app.request('/runs', {
      ...requestBody(validBody),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'request-1' },
    })

    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { error: { code: 'unauthorized' } })
  })

  it('creates a queued run with trusted identity and exact source data', async () => {
    const commands: CreateRunCommand[] = []
    const response = await createApp(dependencies({ commands })).request(
      '/runs',
      requestBody(validBody),
    )

    assert.equal(response.status, 202)
    assert.deepEqual(await response.json(), {
      run: {
        id: 'run_123',
        installationId: '123',
        repositoryId: '456',
        baseSha: 'a'.repeat(40),
        targetBranch: 'main',
        status: 'queued',
      },
    })
    assert.deepEqual(commands, [
      {
        actorUserId: 'user_1',
        idempotencyKey: 'request-1',
        installationId: '123',
        repositoryId: '456',
        baseSha: 'a'.repeat(40),
        targetBranch: 'main',
      },
    ])
  })

  it('marks an idempotent replay without exposing actor identity', async () => {
    const response = await createApp(
      dependencies({ createResult: { kind: 'existing', run } }),
    ).request('/runs', requestBody(validBody))

    assert.equal(response.status, 202)
    assert.equal(response.headers.get('Idempotency-Replayed'), 'true')
    assert.equal(JSON.stringify(await response.json()).includes('actorUserId'), false)
  })

  it('rejects a reused idempotency key for different input', async () => {
    const response = await createApp(
      dependencies({ createResult: { kind: 'idempotency_conflict' } }),
    ).request('/runs', requestBody(validBody))

    assert.equal(response.status, 409)
    assert.deepEqual(await response.json(), { error: { code: 'idempotency_conflict' } })
  })

  it('rejects repositories outside the authenticated installation binding', async () => {
    const response = await createApp(dependencies({ createResult: { kind: 'forbidden' } })).request(
      '/runs',
      requestBody(validBody),
    )

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: { code: 'repository_not_authorized' } })
  })

  it('requires a printable bounded idempotency key', async () => {
    const response = await createApp(dependencies()).request(
      '/runs',
      requestBody(validBody, 'contains spaces'),
    )

    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: { code: 'invalid_idempotency_key' } })
  })

  it('rejects malformed identifiers, SHAs and branch names', async () => {
    const response = await createApp(dependencies()).request(
      '/runs',
      requestBody({
        installationId: 123,
        repositoryId: '0',
        baseSha: 'main',
        targetBranch: '../main',
      }),
    )

    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: { code: 'invalid_request' } })
  })

  it('rejects client-provided status and validation claims', async () => {
    const response = await createApp(dependencies()).request(
      '/runs',
      requestBody({ ...validBody, status: 'awaiting_hitl', validationPassed: true }),
    )

    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: { code: 'invalid_request' } })
  })

  it('returns only runs authorized for the session user', async () => {
    const response = await createApp(dependencies()).request('/runs/run_123', {
      headers: { Authorization: 'Bearer session' },
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      run: {
        id: 'run_123',
        installationId: '123',
        repositoryId: '456',
        baseSha: 'a'.repeat(40),
        targetBranch: 'main',
        status: 'queued',
      },
    })
  })

  it('does not reveal whether another user owns a run', async () => {
    const response = await createApp(dependencies({ readResult: { kind: 'not_found' } })).request(
      '/runs/run_123',
      { headers: { Authorization: 'Bearer session' } },
    )

    assert.equal(response.status, 404)
    assert.deepEqual(await response.json(), { error: { code: 'run_not_found' } })
  })

  it('fails closed while persistence is unavailable', async () => {
    const createResponse = await createApp(
      dependencies({ createResult: { kind: 'unavailable' } }),
    ).request('/runs', requestBody(validBody))
    const readResponse = await createApp(
      dependencies({ readResult: { kind: 'unavailable' } }),
    ).request('/runs/run_123', { headers: { Authorization: 'Bearer session' } })

    assert.equal(createResponse.status, 503)
    assert.equal(readResponse.status, 503)
  })
})
