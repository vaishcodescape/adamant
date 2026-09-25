/**
 * The model never sees a raw job log. Actions logs are mostly setup noise and
 * can carry masked secrets, so the log is parsed here first and only the
 * parsed shape plus a bounded excerpt reach the prompt.
 * See docs/performance.md#phase-1-do-these.
 */
export interface FailureContext {
  readonly firstError: string | null
  /** `path/to/file.ts:42` when the log names one. */
  readonly location: string | null
  readonly failingTests: readonly string[]
  /** Bounded window around the first error, already stripped of log chrome. */
  readonly excerpt: string
}

const MAX_EXCERPT_CHARS = 6_000
const MAX_FAILING_TESTS = 20
const EXCERPT_LINES_BEFORE = 12
const EXCERPT_LINES_AFTER = 40

// Built at runtime so the escape character never sits in the source file.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g')
const ACTIONS_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s?/
const ACTIONS_COMMAND = /^##\[(?:group|endgroup|debug|command|section)\]/

/** Lines that name the actual fault. These are what a diagnosis is built from. */
const ERROR_PATTERNS: readonly RegExp[] = [
  /^\s*(?:error|fatal)\b[:\s]/i,
  /\berror\s+TS\d+\b/,
  /^\s*[A-Za-z_$][\w$]*Error\b/,
  /\b(?:AssertionError|SyntaxError|TypeError|ReferenceError)\b/,
  /^\s*Expected .* (?:to|but) /,
]

/**
 * Where a test runner announces a failure. Useful for anchoring the excerpt,
 * but `not ok 1 - adds two numbers` says less than the assertion under it, so
 * these only supply `firstError` when no real error line exists.
 */
const HARNESS_PATTERNS: readonly RegExp[] = [/^\s*(?:FAIL|not ok)\b/]

const LOCATION_PATTERNS: readonly RegExp[] = [
  // tsc: src/app.ts(12,4): error TS2345
  /([\w./-]+\.[A-Za-z]{1,6})\((\d+),\d+\)/,
  // node / jest / vitest: at src/app.ts:12:4, or src/app.ts:12
  /([\w./-]+\.[A-Za-z]{1,6}):(\d+)(?::\d+)?/,
]

const TEST_PATTERNS: readonly RegExp[] = [
  /^\s*not ok \d+\s*-\s*(.+?)\s*$/,
  /^\s*FAIL\s+(.+?)\s*$/,
  /^\s*\d+\)\s+(.+?)\s*$/,
]

/** Log chrome only. Never rewrites a value from the log body. */
function clean(line: string): string {
  return line
    .replace(ANSI, '')
    .replace(ACTIONS_TIMESTAMP, '')
    .replace(ACTIONS_COMMAND, '')
    .trimEnd()
}

function indexOfMatch(lines: readonly string[], patterns: readonly RegExp[]): number {
  return lines.findIndex((line) => patterns.some((pattern) => pattern.test(line)))
}

function findLocation(lines: readonly string[], from: number): string | null {
  for (let index = from; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line) continue
    for (const pattern of LOCATION_PATTERNS) {
      const match = pattern.exec(line)
      const file = match?.[1]
      const lineNumber = match?.[2]
      if (file && lineNumber && !file.startsWith('node_modules/')) {
        return `${file}:${lineNumber}`
      }
    }
  }
  return null
}

function findFailingTests(lines: readonly string[]): string[] {
  const names = new Set<string>()
  for (const line of lines) {
    for (const pattern of TEST_PATTERNS) {
      const name = pattern.exec(line)?.[1]?.trim()
      if (name && name.length > 1 && name.length <= 200) {
        names.add(name)
        break
      }
    }
    if (names.size >= MAX_FAILING_TESTS) break
  }
  return [...names]
}

/**
 * Parse an Actions job log into the shape the model is allowed to see. Safe on
 * an empty or unrecognised log: fields come back null/empty instead of
 * throwing, so a run whose logs are unreachable still reaches diagnose.
 */
export function parseFailure(logs: string, options?: { maxExcerptChars?: number }): FailureContext {
  const maxExcerptChars = options?.maxExcerptChars ?? MAX_EXCERPT_CHARS
  const lines = logs.split(/\r?\n/).map(clean)
  const errorIndex = indexOfMatch(lines, ERROR_PATTERNS)
  const harnessIndex = indexOfMatch(lines, HARNESS_PATTERNS)

  // Anchor on whichever came first so the window covers the whole failure,
  // but report the error line itself when there is one.
  const found = [errorIndex, harnessIndex].filter((index) => index !== -1)
  const anchor =
    found.length === 0 ? Math.max(0, lines.length - EXCERPT_LINES_AFTER) : Math.min(...found)
  const reportIndex = errorIndex === -1 ? harnessIndex : errorIndex

  const window = lines
    .slice(Math.max(0, anchor - EXCERPT_LINES_BEFORE), anchor + EXCERPT_LINES_AFTER)
    .filter((line) => line.trim().length > 0)
    .join('\n')

  return {
    firstError: reportIndex === -1 ? null : (lines[reportIndex]?.trim() ?? null),
    location: findLocation(lines, anchor),
    failingTests: findFailingTests(lines),
    excerpt: window.length > maxExcerptChars ? window.slice(-maxExcerptChars) : window,
  }
}

/** Stable text block for the prompt. Keep the field order fixed so it caches. */
export function describeFailure(failure: FailureContext): string {
  const tests = failure.failingTests.length > 0 ? failure.failingTests.join(', ') : 'not identified'

  return [
    `First error: ${failure.firstError ?? 'not identified'}`,
    `Location: ${failure.location ?? 'not identified'}`,
    `Failing tests: ${tests}`,
    '',
    'Log excerpt:',
    failure.excerpt || '(empty)',
  ].join('\n')
}
