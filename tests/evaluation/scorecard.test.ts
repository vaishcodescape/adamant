import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  createEvaluationScorecard,
  parseEvaluationSuite,
  renderScorecardJson,
  renderScorecardMarkdown,
  summarizeEvaluation,
  type EvaluationCaseResult,
} from '../../server/evaluation/scorecard.ts'

const cases: readonly EvaluationCaseResult[] = [
  {
    caseName: 'fixed case',
    expectedOutcome: 'pass',
    actualOutcome: 'pass',
    baselineVerdict: 'fail',
    patchedVerdict: 'pass',
    attempts: 1,
    elapsedMs: 1_200,
    category: 'fixed',
  },
  {
    caseName: 'valid give-up',
    expectedOutcome: 'report only',
    actualOutcome: 'report only',
    baselineVerdict: 'fail',
    patchedVerdict: 'not-run',
    attempts: 0,
    elapsedMs: 300,
    category: 'correct-give-up-or-report-only',
  },
  {
    caseName: 'bad patch',
    expectedOutcome: 'pass',
    actualOutcome: 'wrong behavior',
    baselineVerdict: 'fail',
    patchedVerdict: 'pass',
    attempts: 2,
    elapsedMs: 2_000,
    category: 'incorrect-patch',
  },
  {
    caseName: 'failed repair',
    expectedOutcome: 'pass',
    actualOutcome: 'fail',
    baselineVerdict: 'fail',
    patchedVerdict: 'fail',
    attempts: 3,
    elapsedMs: 2_500,
    category: 'failed-repair',
  },
]

describe('evaluation scorecard', () => {
  it('counts every outcome and calculates the acceptable-outcome rate', () => {
    assert.deepEqual(summarizeEvaluation(cases), {
      totalCases: 4,
      evaluatedCases: 4,
      pendingCases: 0,
      acceptableOutcomes: 2,
      acceptableOutcomeRatePercent: 50,
      totalAttempts: 6,
      totalElapsedMs: 6_000,
      categoryCounts: {
        fixed: 1,
        'correct-give-up-or-report-only': 1,
        'incorrect-patch': 1,
        'failed-repair': 1,
        'not-evaluated': 0,
      },
    })
  })

  it('renders stable JSON and a readable Markdown summary', () => {
    const scorecard = createEvaluationScorecard({ suiteName: 'Test suite', cases })
    const json = JSON.parse(renderScorecardJson(scorecard)) as { schemaVersion: number }
    const markdown = renderScorecardMarkdown(scorecard)

    assert.equal(json.schemaVersion, 1)
    assert.match(markdown, /^# Test suite/)
    assert.match(markdown, /Evaluated cases: \*\*4\/4\*\*/)
    assert.match(markdown, /Acceptable outcomes among evaluated cases: \*\*2\/4 \(50%\)\*\*/)
    assert.match(markdown, /\| Incorrect patch \| 1 \|/)
    assert.match(
      markdown,
      /\| fixed case \| pass \| pass \| fail \| pass \| 1 \| 1.2 s \| fixed \|/,
    )
  })

  it('keeps pending fixtures out of the outcome-rate denominator', () => {
    const pendingCase: EvaluationCaseResult = {
      caseName: 'pending fixture',
      expectedOutcome: 'pass',
      actualOutcome: 'not run',
      baselineVerdict: 'fail',
      patchedVerdict: 'not-run',
      attempts: 0,
      elapsedMs: 0,
      category: 'not-evaluated',
    }
    const summary = summarizeEvaluation([...cases, pendingCase])

    assert.equal(summary.totalCases, 5)
    assert.equal(summary.evaluatedCases, 4)
    assert.equal(summary.pendingCases, 1)
    assert.equal(summary.acceptableOutcomeRatePercent, 50)

    const pendingOnly = summarizeEvaluation([pendingCase])
    assert.equal(pendingOnly.acceptableOutcomeRatePercent, null)
    assert.match(
      renderScorecardMarkdown(
        createEvaluationScorecard({ suiteName: 'Pending', cases: [pendingCase] }),
      ),
      /Acceptable outcomes among evaluated cases: \*\*0\/0 \(n\/a\)\*\*/,
    )
  })

  it('rejects incomplete records and unknown categories', () => {
    assert.throws(
      () =>
        parseEvaluationSuite({
          suiteName: 'Broken suite',
          cases: [{ ...cases[0], category: 'almost-fixed' }],
        }),
      /cases\[0\]\.category must be one of/,
    )
    assert.throws(
      () => parseEvaluationSuite({ suiteName: 'Empty suite', cases: [] }),
      /cases must be a non-empty array/,
    )
  })
})
