/**
 * Everything the graph persists goes through this port, scoped to one run at
 * construction time so no caller can write a row against another run. The
 * Postgres implementation lives in server/worker; tests use the in-memory one
 * below. See docs/backend-architecture.md#agent-tools.
 */
export type SandboxVerdict = 'pass' | 'fail' | 'timeout' | 'error'
export type ToolOutcome = 'ok' | 'error' | 'denied'
export type PatchOutcome = 'success' | 'failed_validation' | 'generation_error'

export interface ToolInvocationRecord {
  readonly tool: string
  readonly args: Record<string, unknown>
  readonly outcome: ToolOutcome
  readonly errorMessage?: string
  readonly startedAt: Date
}

export interface PatchAttemptRecord {
  readonly attemptNumber: number
  readonly candidateHash: string
  readonly patchDiff: string
  readonly outcome: PatchOutcome
  readonly failureReason?: string
}

export interface SandboxResultRecord {
  readonly attemptNumber: number
  readonly candidateHash: string
  readonly baseSha: string
  readonly commands: readonly string[]
  readonly verdict: SandboxVerdict
  readonly exitCode?: number
}

export interface PrPublicationRecord {
  readonly prNumber: number
  readonly prUrl: string
  readonly baseSha: string
  readonly candidateHash: string
}

export interface RunRecorder {
  audit(eventType: string, payload?: Record<string, unknown>): Promise<void>
  toolInvocation(record: ToolInvocationRecord): Promise<void>
  patchAttempt(record: PatchAttemptRecord): Promise<void>
  sandboxResult(record: SandboxResultRecord): Promise<void>
  prPublication(record: PrPublicationRecord): Promise<void>
  /** Verdict of the newest persisted sandbox_results row, or null if none. */
  latestSandboxVerdict(): Promise<SandboxVerdict | null>
  /** PR number persisted for this run, or null before one is opened. */
  publishedPrNumber(): Promise<number | null>
}

const SECRET_KEY_PARTS = ['token', 'secret', 'key', 'auth', 'password', 'credential', 'cookie']
const SECRET_VALUE_SHAPES: readonly RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bsk-[A-Za-z0-9-]{16,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bBearer\s+[A-Za-z0-9._-]{12,}/gi,
]

const REDACTED = '[redacted]'

/** Masks secret-shaped values anywhere in free text (logs, model output, PR bodies). */
export function redactText(value: string): string {
  return SECRET_VALUE_SHAPES.reduce((text, shape) => text.replace(shape, REDACTED), value)
}

function redactString(value: string): string {
  return redactText(value)
}

function redactValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return redactString(value)
  if (value === null || typeof value !== 'object') return value
  if (depth >= 4) return REDACTED
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1))

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      isSecretKey(key) ? REDACTED : redactValue(item, depth + 1),
    ]),
  )
}

function isSecretKey(key: string): boolean {
  const lowered = key.toLowerCase()
  return SECRET_KEY_PARTS.some((part) => lowered.includes(part))
}

/**
 * Applied to every tool argument and audit payload before it is stored. A
 * secret-shaped key loses its value outright; a secret-shaped value is masked
 * wherever it appears in free text.
 */
export function redact(input: Record<string, unknown>): Record<string, unknown> {
  return redactValue(input, 0) as Record<string, unknown>
}

export interface MemoryRecorder extends RunRecorder {
  readonly audits: { eventType: string; payload: Record<string, unknown> }[]
  readonly tools: ToolInvocationRecord[]
  readonly patches: PatchAttemptRecord[]
  readonly sandboxes: SandboxResultRecord[]
  readonly publications: PrPublicationRecord[]
}

/** In-memory recorder for tests and for a worker started without a database. */
export function createMemoryRecorder(): MemoryRecorder {
  const audits: { eventType: string; payload: Record<string, unknown> }[] = []
  const tools: ToolInvocationRecord[] = []
  const patches: PatchAttemptRecord[] = []
  const sandboxes: SandboxResultRecord[] = []
  const publications: PrPublicationRecord[] = []

  return {
    audits,
    tools,
    patches,
    sandboxes,
    publications,
    async audit(eventType, payload) {
      audits.push({ eventType, payload: redact(payload ?? {}) })
    },
    async toolInvocation(record) {
      tools.push({ ...record, args: redact(record.args) })
    },
    async patchAttempt(record) {
      patches.push(record)
    },
    async sandboxResult(record) {
      sandboxes.push(record)
    },
    async prPublication(record) {
      publications.push(record)
    },
    async latestSandboxVerdict() {
      return sandboxes.at(-1)?.verdict ?? null
    },
    async publishedPrNumber() {
      return publications.at(-1)?.prNumber ?? null
    },
  }
}
