import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { describeFailure, parseFailure } from '../../server/agent/triage.ts'

const actionsLog = [
  '2024-05-01T10:00:00.1234567Z ##[group]Run pnpm test',
  '2024-05-01T10:00:00.1234567Z pnpm test',
  '2024-05-01T10:00:00.1234567Z ##[endgroup]',
  '2024-05-01T10:00:01.1234567Z ',
  '2024-05-01T10:00:01.1234567Z > adamant@0.1.0 test',
  '2024-05-01T10:00:02.1234567Z not ok 1 - adds two numbers',
  '2024-05-01T10:00:02.1234567Z   AssertionError [ERR_ASSERTION]: Expected values to be strictly equal',
  '2024-05-01T10:00:02.1234567Z       at Object.<anonymous> (src/sum.ts:7:10)',
  '2024-05-01T10:00:03.1234567Z not ok 2 - subtracts two numbers',
].join('\n')

describe('CI failure triage', () => {
  it('pulls the first error, the location and the failing tests out of an Actions log', () => {
    const failure = parseFailure(actionsLog)

    assert.equal(failure.location, 'src/sum.ts:7')
    assert.deepEqual(failure.failingTests, ['adds two numbers', 'subtracts two numbers'])
    assert.match(String(failure.firstError), /AssertionError/)
  })

  it('strips timestamps, ANSI colour and Actions grouping from the excerpt', () => {
    const failure = parseFailure(`[31mError: red text[0m\n${actionsLog}`)

    assert.equal(failure.excerpt.includes('##[group]'), false)
    assert.equal(failure.excerpt.includes('2024-05-01T10:00:00'), false)
    assert.equal(failure.excerpt.includes('['), false)
  })

  it('prefers a repository path over one inside node_modules', () => {
    const failure = parseFailure(
      [
        'Error: boom',
        '    at node_modules/vitest/dist/index.js:100:2',
        '    at src/app.ts:42:8',
      ].join('\n'),
    )

    assert.equal(failure.location, 'src/app.ts:42')
  })

  it('reads a tsc diagnostic location', () => {
    const failure = parseFailure('src/app.ts(12,4): error TS2345: Argument of type string')

    assert.equal(failure.location, 'src/app.ts:12')
    assert.match(String(failure.firstError), /TS2345/)
  })

  it('bounds the excerpt so a huge log cannot reach the prompt', () => {
    const huge = `${'filler line\n'.repeat(50_000)}Error: boom at src/app.ts:1`
    const failure = parseFailure(huge, { maxExcerptChars: 500 })

    assert.ok(failure.excerpt.length <= 500)
    assert.match(failure.excerpt, /Error: boom/)
  })

  it('does not throw on an empty or unrecognised log', () => {
    const empty = parseFailure('')

    assert.equal(empty.firstError, null)
    assert.equal(empty.location, null)
    assert.deepEqual(empty.failingTests, [])
    assert.match(describeFailure(empty), /First error: not identified/)
  })

  it('describes the failure in a stable field order for prompt caching', () => {
    const described = describeFailure(parseFailure(actionsLog))

    assert.match(described, /^First error: /)
    assert.match(described, /\nLocation: src\/sum\.ts:7\n/)
    assert.match(described, /\nFailing tests: adds two numbers, subtracts two numbers\n/)
  })
})
