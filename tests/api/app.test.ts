import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  createApp,
  resourceNames,
  type JsonRecord,
  type ResourceName,
} from '../../server/api/app.ts'

async function json(response: Response) {
  return (await response.json()) as {
    data?: JsonRecord | JsonRecord[]
    fields?: string[]
    error?: string
  }
}

const payloads = {
  users: { github_user_id: 'github-user-1' },
  sessions: { user_id: 'user-1', token_hash: 'hash-1', expires_at: '2030-01-01T00:00:00.000Z' },
  'github-installations': { github_installation_id: '1001' },
  repositories: {
    installation_id: 'installation-1',
    github_repo_id: '2001',
    owner: 'adamant',
    name: 'api',
  },
  runs: {
    repository_id: 'repo-1',
    created_by_user_id: 'user-1',
    base_sha: 'abc123',
    source_sha: 'abc123',
    target_branch: 'main',
  },
  'webhook-deliveries': {
    github_delivery_id: 'delivery-1',
    event_type: 'workflow_run',
    processing_status: 'received',
    installation_id: 'installation-1',
    repository_id: 'repo-1',
    payload_digest: 'sha256:digest',
  },
  'triage-results': {
    run_id: 'run-1',
    category: 'test_failure',
    details: { file: 'src/index.ts' },
  },
  'patch-attempts': {
    run_id: 'run-1',
    attempt_number: 1,
    candidate_hash: 'candidate-1',
    patch_diff: '+ fixed',
    outcome: 'created',
  },
  'sandbox-results': {
    run_id: 'run-1',
    attempt_number: 1,
    candidate_hash: 'candidate-1',
    base_sha: 'abc123',
    commands: ['pnpm test'],
    verdict: 'pass',
    exit_code: 0,
    artifact_ref: 'artifacts/run-1.log',
  },
  'pr-publications': {
    run_id: 'run-1',
    repository_id: 'repo-1',
    github_pr_number: 42,
    pr_url: 'https://github.com/example/repo/pull/42',
  },
  'tool-invocations': {
    run_id: 'run-1',
    repository_id: 'repo-1',
    tool_name: 'git.diff',
    input_redacted: { path: 'src/index.ts' },
    outcome: 'success',
  },
  'hitl-decisions': {
    run_id: 'run-1',
    run_version: 1,
    candidate_hash: 'candidate-1',
    base_sha: 'abc123',
    decided_by_user_id: 'user-1',
    decision_id: 'decision-1',
    action: 'approve',
    status: 'active',
  },
  approvals: {
    run_id: 'run-1',
    run_version: 1,
    candidate_hash: 'candidate-1',
    base_sha: 'abc123',
    action: 'merge',
    status: 'approved',
  },
  'audit-events': {
    run_id: 'run-1',
    actor_user_id: 'user-1',
    event_type: 'run.created',
    payload: { source: 'test' },
  },
} as const satisfies Record<ResourceName, JsonRecord>

function row(body: Awaited<ReturnType<typeof json>>) {
  assert.ok(body.data && !Array.isArray(body.data))
  return body.data
}

describe('@adamant/api DB schema endpoints', () => {
  it('keeps the health endpoint available', async () => {
    const app = createApp()
    const response = await app.request('/health')

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { status: 'ok' })
  })

  it('validates required fields before creating rows', async () => {
    const app = createApp()
    const response = await app.request('/runs', {
      method: 'POST',
      body: JSON.stringify({ base_sha: 'abc123' }),
      headers: { 'content-type': 'application/json' },
    })
    const body = await json(response)

    assert.equal(response.status, 400)
    assert.equal(body.error, 'missing required fields')
    assert.deepEqual(body.fields, [
      'repository_id',
      'created_by_user_id',
      'source_sha',
      'target_branch',
    ])
  })

  it('creates, lists, and reads a run row from the schema', async () => {
    const app = createApp()
    const createResponse = await app.request('/runs', {
      method: 'POST',
      body: JSON.stringify({
        repository_id: 'repo-1',
        created_by_user_id: 'user-1',
        base_sha: 'abc123',
        source_sha: 'abc123',
        target_branch: 'main',
      }),
      headers: { 'content-type': 'application/json' },
    })
    const created = await json(createResponse)

    assert.equal(createResponse.status, 201)
    const createdRun = row(created)

    assert.equal(createdRun.status, 'queued')
    assert.equal(createdRun.version, 0)
    assert.equal(createdRun.target_branch, 'main')
    assert.match(String(createdRun.idempotency_key), /^manual:/)

    const id = String(createdRun.id)
    const getResponse = await app.request(`/runs/${id}`)
    const fetched = await json(getResponse)

    assert.equal(getResponse.status, 200)
    assert.equal(row(fetched).id, id)

    const listResponse = await app.request('/runs')
    const listed = (await listResponse.json()) as { data: Record<string, unknown>[] }

    assert.equal(listResponse.status, 200)
    assert.equal(listed.data.length, 1)
    assert.equal(listed.data[0]?.id, id)
  })

  it('supports create, list, read, update, and delete for every schema resource', async () => {
    const app = createApp()

    for (const resource of resourceNames) {
      const createResponse = await app.request(`/${resource}`, {
        method: 'POST',
        body: JSON.stringify(payloads[resource]),
        headers: { 'content-type': 'application/json' },
      })
      const created = row(await json(createResponse))
      const id = String(created.id)

      assert.equal(createResponse.status, 201, resource)
      assert.ok(id, resource)

      const listResponse = await app.request(`/${resource}`)
      const listed = await json(listResponse)

      assert.equal(listResponse.status, 200, resource)
      assert.ok(Array.isArray(listed.data), resource)
      assert.equal(listed.data.length, 1, resource)

      const getResponse = await app.request(`/${resource}/${id}`)
      assert.equal(getResponse.status, 200, resource)
      assert.equal(row(await json(getResponse)).id, id, resource)

      const patchResponse = await app.request(`/${resource}/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ test_marker: resource, id: 'cannot-replace-id' }),
        headers: { 'content-type': 'application/json' },
      })
      const patched = row(await json(patchResponse))

      assert.equal(patchResponse.status, 200, resource)
      assert.equal(patched.id, id, resource)
      assert.equal(patched.test_marker, resource, resource)

      const deleteResponse = await app.request(`/${resource}/${id}`, { method: 'DELETE' })
      assert.equal(deleteResponse.status, 204, resource)

      const missingResponse = await app.request(`/${resource}/${id}`)
      assert.equal(missingResponse.status, 404, resource)
    }
  })

  it('rejects malformed JSON, empty updates, and duplicate identifiers', async () => {
    const app = createApp()
    const malformed = await app.request('/users', {
      method: 'POST',
      body: '{',
      headers: { 'content-type': 'application/json' },
    })

    assert.equal(malformed.status, 400)

    const create = () =>
      app.request('/users', {
        method: 'POST',
        body: JSON.stringify({ id: 'fixed-id', github_user_id: 'github-user-1' }),
        headers: { 'content-type': 'application/json' },
      })

    assert.equal((await create()).status, 201)
    assert.equal((await create()).status, 409)

    const emptyPatch = await app.request('/users/fixed-id', {
      method: 'PATCH',
      body: JSON.stringify({ id: 'replacement-id', created_at: 'yesterday' }),
      headers: { 'content-type': 'application/json' },
    })

    assert.equal(emptyPatch.status, 400)
  })
})
