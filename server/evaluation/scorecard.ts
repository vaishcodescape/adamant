export const EVALUATION_CATEGORIES = [
  'fixed',
  'correct-give-up-or-report-only',
  'incorrect-patch',
  'failed-repair',
  'not-evaluated',
] as const

export type EvaluationCategory = (typeof EVALUATION_CATEGORIES)[number]

export interface EvaluationCaseResult {
  readonly caseName: string
  readonly expectedOutcome: string
  readonly actualOutcome: string
  readonly baselineVerdict: string
  readonly patchedVerdict: string
  readonly attempts: number
  readonly elapsedMs: number
  readonly category: EvaluationCategory
  readonly sourceSha?: string
  readonly evidenceUrl?: string
}

export interface EvaluationSuite {
  readonly suiteName: string
  readonly cases: readonly EvaluationCaseResult[]
}

export interface EvaluationSummary {
  readonly totalCases: number
  readonly evaluatedCases: number
  readonly pendingCases: number
  readonly acceptableOutcomes: number
  readonly acceptableOutcomeRatePercent: number | null
  readonly totalAttempts: number
  readonly totalElapsedMs: number
  readonly categoryCounts: Readonly<Record<EvaluationCategory, number>>
}

export interface EvaluationScorecard extends EvaluationSuite {
  readonly schemaVersion: 1
  readonly summary: EvaluationSummary
}

/** Narrow input to a non-null object, excluding arrays. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Return the original string, throwing an error naming the path for blank or non-string input. */
function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`)
  }
  return value
}

/** Require a non-negative safe integer, naming the field path in validation errors. */
function requiredNonNegativeInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${path} must be a non-negative integer`)
  }
  return value
}

/** Require a known outcome category, naming the field path and allowed values on failure. */
function requiredCategory(value: unknown, path: string): EvaluationCategory {
  if (typeof value !== 'string' || !EVALUATION_CATEGORIES.some((category) => category === value)) {
    throw new Error(`${path} must be one of: ${EVALUATION_CATEGORIES.join(', ')}`)
  }
  return value as EvaluationCategory
}

/** Allow an absent field; otherwise require a non-blank string with errors tied to its path. */
function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined
  return requiredString(value, path)
}

/** Validate a case with indexed field errors, preserving optional evidence when supplied. */
function parseCase(value: unknown, index: number): EvaluationCaseResult {
  const path = `cases[${index}]`
  if (!isRecord(value)) throw new Error(`${path} must be an object`)

  const sourceSha = optionalString(value.sourceSha, `${path}.sourceSha`)
  const evidenceUrl = optionalString(value.evidenceUrl, `${path}.evidenceUrl`)

  return {
    caseName: requiredString(value.caseName, `${path}.caseName`),
    expectedOutcome: requiredString(value.expectedOutcome, `${path}.expectedOutcome`),
    actualOutcome: requiredString(value.actualOutcome, `${path}.actualOutcome`),
    baselineVerdict: requiredString(value.baselineVerdict, `${path}.baselineVerdict`),
    patchedVerdict: requiredString(value.patchedVerdict, `${path}.patchedVerdict`),
    attempts: requiredNonNegativeInteger(value.attempts, `${path}.attempts`),
    elapsedMs: requiredNonNegativeInteger(value.elapsedMs, `${path}.elapsedMs`),
    category: requiredCategory(value.category, `${path}.category`),
    ...(sourceSha === undefined ? {} : { sourceSha }),
    ...(evidenceUrl === undefined ? {} : { evidenceUrl }),
  }
}

/** Parse an unknown suite, throwing for a blank name, empty case list, or invalid case fields. */
export function parseEvaluationSuite(value: unknown): EvaluationSuite {
  if (!isRecord(value)) throw new Error('evaluation input must be an object')
  if (!Array.isArray(value.cases) || value.cases.length === 0) {
    throw new Error('cases must be a non-empty array')
  }

  return {
    suiteName: requiredString(value.suiteName, 'suiteName'),
    cases: value.cases.map(parseCase),
  }
}

/**
 * Total outcomes, attempts, and elapsed time across validated cases.
 * Exclude pending cases from the acceptable-outcome rate; return null when none were evaluated.
 * Fixed and correct give-up/report-only cases are acceptable; round the percentage to two decimals.
 */
export function summarizeEvaluation(cases: readonly EvaluationCaseResult[]): EvaluationSummary {
  const categoryCounts: Record<EvaluationCategory, number> = {
    fixed: 0,
    'correct-give-up-or-report-only': 0,
    'incorrect-patch': 0,
    'failed-repair': 0,
    'not-evaluated': 0,
  }
  let totalAttempts = 0
  let totalElapsedMs = 0

  for (const result of cases) {
    categoryCounts[result.category] += 1
    totalAttempts += result.attempts
    totalElapsedMs += result.elapsedMs
  }

  const acceptableOutcomes = categoryCounts.fixed + categoryCounts['correct-give-up-or-report-only']
  const pendingCases = categoryCounts['not-evaluated']
  const evaluatedCases = cases.length - pendingCases
  const acceptableOutcomeRatePercent =
    evaluatedCases === 0 ? null : Math.round((acceptableOutcomes / evaluatedCases) * 10_000) / 100

  return {
    totalCases: cases.length,
    evaluatedCases,
    pendingCases,
    acceptableOutcomes,
    acceptableOutcomeRatePercent,
    totalAttempts,
    totalElapsedMs,
    categoryCounts,
  }
}

/** Attach schema version 1 and a computed summary to a validated suite, retaining its case list. */
export function createEvaluationScorecard(suite: EvaluationSuite): EvaluationScorecard {
  return {
    schemaVersion: 1,
    suiteName: suite.suiteName,
    cases: suite.cases,
    summary: summarizeEvaluation(suite.cases),
  }
}

/** Serialize the scorecard with two-space indentation and a trailing newline. */
export function renderScorecardJson(scorecard: EvaluationScorecard): string {
  return `${JSON.stringify(scorecard, null, 2)}\n`
}

/** Escape table separators and flatten line breaks so text stays within one Markdown cell. */
function markdownCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll(/\r?\n/g, ' ')
}

/** Display subsecond durations in milliseconds, otherwise seconds rounded to two decimal places. */
function formatElapsed(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds} ms`
  return `${Math.round((milliseconds / 1_000) * 100) / 100} s`
}

/** Render summary and case tables as Markdown, using n/a when no outcome rate is available. */
export function renderScorecardMarkdown(scorecard: EvaluationScorecard): string {
  const { summary } = scorecard
  const acceptableRate =
    summary.acceptableOutcomeRatePercent === null
      ? 'n/a'
      : `${summary.acceptableOutcomeRatePercent}%`
  const rows = scorecard.cases.map(
    (result) =>
      `| ${markdownCell(result.caseName)} | ${markdownCell(result.expectedOutcome)} | ${markdownCell(result.actualOutcome)} | ${markdownCell(result.baselineVerdict)} | ${markdownCell(result.patchedVerdict)} | ${result.attempts} | ${formatElapsed(result.elapsedMs)} | ${result.category} |`,
  )

  return [
    `# ${scorecard.suiteName}`,
    '',
    `Evaluated cases: **${summary.evaluatedCases}/${summary.totalCases}**`,
    '',
    `Acceptable outcomes among evaluated cases: **${summary.acceptableOutcomes}/${summary.evaluatedCases} (${acceptableRate})**`,
    '',
    '| Category | Count |',
    '| --- | ---: |',
    `| Fixed | ${summary.categoryCounts.fixed} |`,
    `| Correct give-up/report-only | ${summary.categoryCounts['correct-give-up-or-report-only']} |`,
    `| Incorrect patch | ${summary.categoryCounts['incorrect-patch']} |`,
    `| Failed repair | ${summary.categoryCounts['failed-repair']} |`,
    `| Not evaluated | ${summary.categoryCounts['not-evaluated']} |`,
    '',
    `Total attempts: **${summary.totalAttempts}**`,
    '',
    `Total elapsed time: **${formatElapsed(summary.totalElapsedMs)}**`,
    '',
    '| Case | Expected | Actual | Baseline | Patched | Attempts | Elapsed | Category |',
    '| --- | --- | --- | --- | --- | ---: | ---: | --- |',
    ...rows,
    '',
  ].join('\n')
}
