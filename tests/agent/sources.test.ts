import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { type GitProvider } from '../../server/agent/deps.ts'
import { normalizePatch } from '../../server/agent/patch.ts'
import { createMemoryRecorder } from '../../server/agent/recorder.ts'
import { describeSources, readSources } from '../../server/agent/sources.ts'
import { SecureGitClient } from '../../server/agent/tools.ts'
import { findLocations, parseFailure } from '../../server/agent/triage.ts'

const diff = '--- a/src/sum.ts\n+++ b/src/sum.ts\n@@ -1 +1 @@\n-a\n+b\n'

describe('normalizePatch', () => {
  it('restores the newline git needs after the last hunk', () => {
    assert.equal(normalizePatch(diff.trimEnd()), diff)
  })

  it('takes the diff out of a Markdown fence and drops the prose around it', () => {
    const reply = `Here is the fix:\n\n\`\`\`diff\n${diff}\`\`\`\n\nThis restores addition.`
    assert.equal(normalizePatch(reply), diff)
  })

  it('drops a sentence before an unfenced diff', () => {
    assert.equal(normalizePatch(`The fix:\n${diff}`), diff)
  })
})

describe('findLocations', () => {
  it('returns each file once, in order, and skips node_modules', () => {
    const text = [
      'at Object.<anonymous> (/home/runner/work/eval/eval/src/sum.test.ts:4:11)',
      'at sum (node_modules/lib/index.js:9:2)',
      'at sum (src/sum.ts:2:10)',
      'at again (src/sum.ts:7:1)',
    ].join('\n')

    assert.deepEqual(findLocations(text, 5), [
      { file: '/home/runner/work/eval/eval/src/sum.test.ts', line: 4 },
      { file: 'src/sum.ts', line: 2 },
    ])
  })
})

describe('readSources', () => {
  const file = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`).join('\n')

  it('shows a window around the failing line, not the whole file', async () => {
    const failure = parseFailure('Error: boom\n    at run (src/big.ts:150:3)')
    const [source] = await readSources(async () => ({ path: 'src/big.ts', text: file }), failure)

    assert.equal(source?.path, 'src/big.ts')
    assert.equal(source?.startLine, 90)
    assert.equal(source?.text.split('\n')[0], 'line 90')
    assert.equal(source?.text.split('\n').at(-1), 'line 200')
  })

  it('skips files it cannot find or read and still returns the rest', async () => {
    const failure = parseFailure(
      'Error: boom\n at a (src/missing.ts:1:1)\n at b (src/found.ts:1:1)',
    )
    const sources = await readSources(async (fromLog) => {
      if (fromLog === 'src/missing.ts') throw new Error('EACCES')
      return { path: fromLog, text: 'export {}' }
    }, failure)

    assert.deepEqual(
      sources.map((source) => source.path),
      ['src/found.ts'],
    )
  })

  it('redacts a secret-shaped value in the source before the prompt sees it', async () => {
    const failure = parseFailure('Error: boom at src/config.ts:1')
    const [source] = await readSources(
      async () => ({ path: 'src/config.ts', text: 'const key = "sk-abcdefghijklmnopqrstuvwx"' }),
      failure,
    )

    assert.equal(source?.text.includes('sk-abcdefghijklmnopqrstuvwx'), false)
  })

  it('says so when the log named no file in the checkout', () => {
    assert.match(describeSources([]), /no file from the log was found/)
  })
})

describe('git_read_file tool', () => {
  it('logs the path with the run id, never the file contents', async () => {
    const recorder = createMemoryRecorder()
    const git = {
      readFile: async () => ({ path: 'src/a.ts', text: 'SECRET_BODY' }),
    } as unknown as GitProvider
    const client = new SecureGitClient(git, 'run-9', recorder)

    const found = await client.readFile('src/a.ts')

    assert.equal(found?.text, 'SECRET_BODY')
    assert.deepEqual(
      recorder.tools.map((row) => [row.tool, row.outcome, row.args]),
      [['git_read_file', 'ok', { path: 'src/a.ts', runId: 'run-9' }]],
    )
    assert.equal(JSON.stringify(recorder.tools).includes('SECRET_BODY'), false)
  })
})
