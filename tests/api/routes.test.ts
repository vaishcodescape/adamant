import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { activity } from '../../server/api/routes/activity.ts'
import { runs } from '../../server/api/routes/runs.ts'

const session = 'cli-session'

async function withSession(fn: () => Promise<void>) {
  const previous = process.env.ADAMANT_SESSION_SECRET
  process.env.ADAMANT_SESSION_SECRET = session
  try {
    await fn()
  } finally {
    if (previous === undefined) delete process.env.ADAMANT_SESSION_SECRET
    else process.env.ADAMANT_SESSION_SECRET = previous
  }
}

describe('CLI routes', () => {
  afterEach(() => {
    delete process.env.ADAMANT_SESSION_SECRET
  })

  it('rejects runs and activity when the session secret is unset', async () => {
    delete process.env.ADAMANT_SESSION_SECRET
    assert.equal((await runs.request('/')).status, 500)
    assert.equal((await activity.request('/')).status, 500)
  })

  it('requires the session on runs and activity', async () => {
    await withSession(async () => {
      assert.equal((await runs.request('/')).status, 401)
      assert.equal((await activity.request('/')).status, 401)

      const listed = await runs.request('/', { headers: { ADAMANT_SESSION: session } })
      const created = await runs.request('/', {
        method: 'POST',
        headers: { ADAMANT_SESSION: session },
      })
      const detail = await runs.request('/run-1', { headers: { ADAMANT_SESSION: session } })
      const feed = await activity.request('/?session=' + session)

      assert.equal(listed.status, 200)
      assert.deepEqual(await listed.json(), { runs: [] })
      assert.equal(created.status, 202)
      assert.deepEqual(await created.json(), { runId: 'TODO', status: 'queued' })
      assert.equal(detail.status, 200)
      const detailBody = (await detail.json()) as { id: string }
      assert.equal(detailBody.id, 'run-1')
      assert.equal(feed.status, 200)
    })
  })
})
