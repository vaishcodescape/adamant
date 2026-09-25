import { type FailureContext } from './triage.ts'
import { redactText } from './recorder.ts'

/**
 * Task 4.7: the pull request states the cause, the evidence, the fix, what the
 * sandbox verified, and what it did not. Diagnosis and plan are model output,
 * so both go through redaction before they are published.
 */
export interface PrContent {
  readonly runId: string
  readonly failure: FailureContext
  readonly diagnostics: string
  readonly plan: string
  readonly commands: readonly string[]
  readonly attemptNumber: number
}

const MAX_SECTION_CHARS = 4_000

function section(text: string): string {
  const clean = redactText(text).trim()
  if (clean.length <= MAX_SECTION_CHARS) return clean || '_not recorded_'
  return `${clean.slice(0, MAX_SECTION_CHARS)}\n\n_(truncated)_`
}

export function buildPrTitle(failure: FailureContext): string {
  const subject = failure.firstError ?? failure.failingTests[0] ?? 'failing CI check'
  const oneLine = redactText(subject).split('\n')[0]?.trim() ?? 'failing CI check'
  const trimmed = oneLine.length > 60 ? `${oneLine.slice(0, 57)}...` : oneLine

  return `fix: ${trimmed}`
}

export function buildCommitMessage(failure: FailureContext, runId: string): string {
  return [buildPrTitle(failure), '', `Adamant run ${runId}.`].join('\n')
}

export function buildPrBody(content: PrContent): string {
  const tests =
    content.failure.failingTests.length > 0
      ? content.failure.failingTests.map((name) => `- \`${name}\``).join('\n')
      : '- _none named in the log_'

  return [
    `Automated repair by Adamant for run \`${content.runId}\`.`,
    '',
    '## Cause',
    section(content.diagnostics),
    '',
    '## Evidence',
    `- First error: \`${redactText(content.failure.firstError ?? 'not identified')}\``,
    `- Location: \`${content.failure.location ?? 'not identified'}\``,
    '- Failing tests:',
    tests,
    '',
    '## Fix',
    section(content.plan),
    '',
    '## Verified',
    `Candidate ${content.attemptNumber} passed in a sealed container with the network off:`,
    ...content.commands.map((command) => `- \`${command}\``),
    '',
    '## Not checked',
    '- Anything outside those commands: other workflows, runtime behaviour, and performance.',
    '- No human reviewed this change before it was opened.',
  ].join('\n')
}
