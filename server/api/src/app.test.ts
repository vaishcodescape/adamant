import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createApp } from './app.ts'
import {
  type ApiDependencies,
  type CreateRunCommand,
  type CreateRunResult,
  type ReadRunResult,
  type RunRecord,
} from './ports.ts'

const runId = '4da8e1b3-2b0d-4e5a-9b6f-72d8718d6d4f'
const validBody = {
  installationId: '123',
  repositoryId: '456',
  baseSha: 'A'.repeat(40),
  targetBranch: 'main',
}

const run: RunRecord = {
  id: runId,
  actorUserId: 'user_1',
  installationId: '123',
  repositoryId: '456',
  baseSha: 'a'.repeat(40),
  targetBranch: 'main',
  status: 'queued',
}

interface ReadCall {
  runId: string
  actorUserId: string
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
    readCalls?: ReadCall[]
    authenticated?: boolean
  } = {},
): ApiDependencies {
  const commands = overrides.commands ?? []
  const readCalls = overrides.readCalls ?? []
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
      readRun: async (requestedRunId, actorUserId) => {
        readCalls.push({ runId: requestedRunId, actorUserId })
        return overrides.readResult ?? { kind: 'found', run }
      },
    },
  }
}

describe('API', () => {
  it('reports health without authentication', async () => {
    const response = await createApp(dependencies()).request('/health')

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { status: 'ok' })
  })

  it('protects every run route with session middleware', async () => {
    const app = createApp(dependencies())
    const createResponse = await app.request('/runs', {
      ...requestBody(validBody),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'request-1' },
    })
    const readResponse = await app.request(`/runs/${runId}`)

    assert.equal(createResponse.status, 401)
    assert.equal(readResponse.status, 401)
    assert.deepEqual(await createResponse.json(), { error: { code: 'unauthorized' } })
    assert.deepEqual(await readResponse.json(), { error: { code: 'unauthorized' } })
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
        id: runId,
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

  it('validates each create-run field independently', async () => {
    for (const [field, value] of [
      ['installationId', '0'],
      ['repositoryId', '01'],
      ['baseSha', 'main'],
      ['targetBranch', '../main'],
    ] as const) {
      const response = await createApp(dependencies()).request(
        '/runs',
        requestBody({ ...validBody, [field]: value }),
      )

      assert.equal(response.status, 400, field)
      assert.deepEqual(await response.json(), { error: { code: 'invalid_request' } }, field)
    }
  })

  it('rejects database ids outside the positive int64 range', async () => {
    for (const value of ['9223372036854775808', '1'.repeat(400)]) {
      const response = await createApp(dependencies()).request(
        '/runs',
        requestBody({ ...validBody, installationId: value }),
      )

      assert.equal(response.status, 400, value)
    }
  })

  it('rejects branch names that git treats as invalid or option-like', async () => {
    for (const targetBranch of [
      '-foo',
      '--upload-pack=x',
      '.hidden',
      'foo/.bar',
      'foo.lock/bar',
      `a${String.fromCharCode(0x7f)}b`,
    ]) {
      const response = await createApp(dependencies()).request(
        '/runs',
        requestBody({ ...validBody, targetBranch }),
      )

      assert.equal(response.status, 400, targetBranch)
    }
  })

  it('rejects create-run bodies larger than 16 KiB', async () => {
    const response = await createApp(dependencies()).request(
      '/runs',
      requestBody({ ...validBody, padding: 'x'.repeat(17 * 1024) }),
    )

    assert.equal(response.status, 413)
    assert.deepEqual(await response.json(), { error: { code: 'payload_too_large' } })
  })

  it('rejects client-provided status and validation claims', async () => {
    const response = await createApp(dependencies()).request(
      '/runs',
      requestBody({ ...validBody, status: 'awaiting_hitl', validationPassed: true }),
    )

    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: { code: 'invalid_request' } })
  })

  it('passes the run id and session user to the authorization boundary', async () => {
    const readCalls: ReadCall[] = []
    const response = await createApp(dependencies({ readCalls })).request(`/runs/${runId}`, {
      headers: { Authorization: 'Bearer session' },
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      run: {
        id: runId,
        installationId: '123',
        repositoryId: '456',
        baseSha: 'a'.repeat(40),
        targetBranch: 'main',
        status: 'queued',
      },
    })
    assert.deepEqual(readCalls, [{ runId, actorUserId: 'user_1' }])
  })

  it('rejects malformed run ids before querying the service', async () => {
    const readCalls: ReadCall[] = []
    const response = await createApp(dependencies({ readCalls })).request('/runs/run_123', {
      headers: { Authorization: 'Bearer session' },
    })

    assert.equal(response.status, 400)
    assert.deepEqual(readCalls, [])
  })

  it('does not reveal whether another user owns a run', async () => {
    const response = await createApp(dependencies({ readResult: { kind: 'not_found' } })).request(
      `/runs/${runId}`,
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
    ).request(`/runs/${runId}`, { headers: { Authorization: 'Bearer session' } })

    assert.equal(createResponse.status, 503)
    assert.equal(readResponse.status, 503)
  })
})
