import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { graphStep } from '../../server/worker/index.ts'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

describe('worker', () => {
  it('treats graph_step as a claimed no-op', async () => {
    let message = ''
    let meta: unknown
    await graphStep(
      { runId: 'run-1' },
      {
        logger: {
          info: (next, extra) => {
            message = next
            meta = extra
          },
        },
      },
    )

    assert.equal(message, 'graph_step received (no-op)')
    assert.deepEqual(meta, { payload: { runId: 'run-1' } })
  })

  it('refuses to start without DATABASE_URL', async () => {
    const env: NodeJS.ProcessEnv = {}
    if (process.env.PATH) env.PATH = process.env.PATH
    if (process.env.HOME) env.HOME = process.env.HOME

    const proc = spawn(process.execPath, ['--experimental-strip-types', 'server/worker/index.ts'], {
      cwd: repoRoot,
      env,
    })
    let stderr = ''
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })

    const code = await new Promise<number | null>((resolve) => proc.on('close', resolve))
    assert.equal(code, 1)
    assert.match(stderr, /DATABASE_URL is required to start @adamant\/worker/)
  })
})
