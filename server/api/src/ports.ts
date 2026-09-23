// TODO: replace these temporary API-facing shapes with @adamant/contract once it lands.
export type RunStatus = 'queued'

export interface SessionPrincipal {
  userId: string
}

export interface RunRecord {
  id: string
  actorUserId: string
  installationId: string
  repositoryId: string
  baseSha: string
  targetBranch: string
  status: RunStatus
}

export interface PublicRun {
  id: string
  installationId: string
  repositoryId: string
  baseSha: string
  targetBranch: string
  status: RunStatus
}

export interface CreateRunCommand {
  actorUserId: string
  installationId: string
  repositoryId: string
  baseSha: string
  targetBranch: string
  idempotencyKey: string
}

export type CreateRunResult =
  | { kind: 'created'; run: RunRecord }
  | { kind: 'existing'; run: RunRecord }
  | { kind: 'forbidden' }
  | { kind: 'idempotency_conflict' }
  | { kind: 'unavailable' }

export type ReadRunResult =
  { kind: 'found'; run: RunRecord } | { kind: 'not_found' } | { kind: 'unavailable' }

export interface RunService {
  createRun(command: CreateRunCommand): Promise<CreateRunResult>
  readRun(runId: string, actorUserId: string): Promise<ReadRunResult>
}

export interface ApiDependencies {
  authenticate(authorization: string | undefined): Promise<SessionPrincipal | null>
  runs: RunService
}
