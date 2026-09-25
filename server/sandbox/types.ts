import type { ChildProcess } from 'node:child_process'

export type SandboxFailureReason = 'COMPLETED' | 'TIMEOUT' | 'INFRA_FAILURE' | 'INVALID_WORKSPACE'

export interface SandboxExecutionOptions {
  /** Traceable run ID for tool_invocations / audit_events */
  runId?: string
  /** Absolute path to disposable workspace clone */
  workspacePath: string
  /** Command to execute inside container */
  command: string
  /** Max execution time in milliseconds (default: 60000ms) */
  timeoutMs?: number
  /** Docker image (default: "node:22-bookworm-slim") */
  image?: string
  /** Memory cap (default: "1g") */
  memoryLimit?: string
  /** CPU cap (default: "1.0") */
  cpuLimit?: string
  /** PID limit to prevent fork bombs (default: "100") */
  pidsLimit?: string
  /** User to execute inside container (default: "node") */
  user?: string
  /** Safe environment variables (filtered for secrets) */
  env?: Record<string, string>
}

export interface SandboxResult {
  success: boolean
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  durationMs: number
  reason: SandboxFailureReason
  error?: string
}

export type SpawnFunction = (command: string, args: string[]) => ChildProcess
