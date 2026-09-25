import { createHash } from 'node:crypto'
import { type AgentState } from './state.ts'
import { type AgentDependencies, type PreviousAttempt } from './deps.ts'
import { SecureGitClient } from './tools.ts'
import { parseFailure } from './triage.ts'
import { buildCommitMessage, buildPrBody, buildPrTitle } from './pr.ts'

const candidateHash = (patch: string) => createHash('sha256').update(patch).digest('hex')

/**
 * What the last candidate got wrong, handed to the next diagnose. Without it a
 * retry re-sends the identical prompt and gets the identical patch, so this is
 * what makes the loop converge instead of repeating itself.
 */
function previousAttempt(state: AgentState): PreviousAttempt | null {
  if (state.attemptNumber < 1 || !state.candidatePatch || !state.lastAttemptFailure) {
    return null
  }

  return {
    attemptNumber: state.attemptNumber,
    patch: state.candidatePatch,
    failure: state.lastAttemptFailure,
  }
}

export const createNodes = (deps: AgentDependencies) => {
  const gateway = (state: AgentState) => new SecureGitClient(deps.git, state.runId, deps.recorder)

  return {
    retrieveNode: async (state: AgentState): Promise<Partial<AgentState>> => {
      const git = gateway(state)
      await git.fetch(state.repository)
      await git.checkout(state.baseSha)

      // Parsed here, once. Retries reuse it instead of re-downloading the log.
      const failure = parseFailure(await git.getFailureLogs())
      await deps.recorder.audit('run.retrieved', {
        baseSha: state.baseSha,
        location: failure.location,
        failingTests: failure.failingTests,
      })

      return { failure, status: 'diagnosing' }
    },

    diagnoseNode: async (state: AgentState): Promise<Partial<AgentState>> => {
      if (!state.failure) {
        throw new Error('Failure context missing before diagnose phase')
      }

      const diagnostics = await deps.llm.diagnose({
        failure: state.failure,
        previousAttempt: previousAttempt(state),
      })

      return { diagnostics, status: 'planning' }
    },

    planNode: async (state: AgentState): Promise<Partial<AgentState>> => {
      if (!state.failure || !state.diagnostics) {
        throw new Error('Diagnostics missing before planning phase')
      }

      const plan = await deps.llm.plan({ failure: state.failure, diagnostics: state.diagnostics })

      return { plan, status: 'patching' }
    },

    /**
     * Writes the candidate into the worktree. A diff that does not apply is an
     * attempt that failed, not a crashed run: it is recorded and fed back so
     * the next pass can correct it.
     */
    patchNode: async (state: AgentState): Promise<Partial<AgentState>> => {
      if (!state.failure || !state.diagnostics || !state.plan) {
        throw new Error('Plan missing before patching phase')
      }

      const patch = await deps.llm.patch({
        failure: state.failure,
        diagnostics: state.diagnostics,
        plan: state.plan,
        previousAttempt: previousAttempt(state),
      })

      const attemptNumber = state.attemptNumber + 1
      const hash = candidateHash(patch)

      try {
        await gateway(state).applyPatch(patch)
      } catch (error) {
        const failureReason = error instanceof Error ? error.message : String(error)
        await deps.recorder.patchAttempt({
          attemptNumber,
          candidateHash: hash,
          patchDiff: patch,
          outcome: 'generation_error',
          failureReason,
        })

        return {
          attemptNumber,
          candidatePatch: patch,
          candidateHash: hash,
          lastAttemptFailure: `The diff did not apply: ${failureReason}`,
          sandboxResult: null,
          status: 'diagnosing',
        }
      }

      return {
        attemptNumber,
        candidatePatch: patch,
        candidateHash: hash,
        lastAttemptFailure: null,
        status: 'sandboxing',
      }
    },

    sandboxNode: async (state: AgentState): Promise<Partial<AgentState>> => {
      if (!state.candidatePatch || !state.candidateHash) {
        throw new Error('Candidate patch missing before sandbox phase')
      }

      const outcome = await deps.sandbox.runValidation({
        attemptNumber: state.attemptNumber,
        candidateHash: state.candidateHash,
      })

      // The merge gate reads this row back, so it is written before any push.
      await deps.recorder.sandboxResult({
        attemptNumber: state.attemptNumber,
        candidateHash: state.candidateHash,
        baseSha: state.baseSha,
        commands: outcome.commands,
        verdict: outcome.verdict,
        ...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
      })

      await deps.recorder.patchAttempt({
        attemptNumber: state.attemptNumber,
        candidateHash: state.candidateHash,
        patchDiff: state.candidatePatch,
        outcome: outcome.verdict === 'pass' ? 'success' : 'failed_validation',
        ...(outcome.verdict === 'pass' ? {} : { failureReason: `sandbox ${outcome.verdict}` }),
      })

      return {
        sandboxResult: {
          verdict: outcome.verdict,
          commands: outcome.commands,
          ...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
        },
        lastAttemptFailure:
          outcome.verdict === 'pass'
            ? null
            : `Candidate ${state.attemptNumber} still fails (${outcome.verdict}):\n${outcome.output}`,
      }
    },

    openPrNode: async (state: AgentState): Promise<Partial<AgentState>> => {
      if (state.sandboxResult?.verdict !== 'pass') {
        throw new Error('Cannot open PR without a passing sandbox result.')
      }
      if (!state.failure || !state.candidateHash) {
        throw new Error('Candidate missing before publish phase')
      }

      const git = gateway(state)
      const branch = git.agentBranch

      // One push, after the pass. See docs/performance.md.
      await git.commit(buildCommitMessage(state.failure, state.runId))
      await git.push(branch)

      const pr = await git.openPr(
        branch,
        state.repository.defaultBranch,
        buildPrTitle(state.failure),
        buildPrBody({
          runId: state.runId,
          failure: state.failure,
          diagnostics: state.diagnostics ?? '',
          plan: state.plan ?? '',
          commands: state.sandboxResult.commands,
          attemptNumber: state.attemptNumber,
        }),
      )

      await deps.recorder.prPublication({
        prNumber: pr.number,
        prUrl: pr.url,
        baseSha: state.baseSha,
        candidateHash: state.candidateHash,
      })

      return { prNumber: pr.number, prUrl: pr.url, status: 'publishing' }
    },

    mergePrNode: async (state: AgentState): Promise<Partial<AgentState>> => {
      if (!state.prNumber) {
        throw new Error('PR number missing before merge phase')
      }

      try {
        await gateway(state).mergePr(state.prNumber, state.prNumber)
        await deps.recorder.audit('run.merged', { prNumber: state.prNumber, prUrl: state.prUrl })

        return { status: 'completed' }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await deps.recorder.audit('run.merge_failed', { prNumber: state.prNumber, error: message })

        return { error: message, status: 'failed' }
      }
    },

    giveUpNode: async (state: AgentState): Promise<Partial<AgentState>> => {
      const error = `Repair stopped after ${state.attemptNumber} attempt(s) without a passing sandbox.`
      await deps.recorder.audit('run.gave_up', {
        attempts: state.attemptNumber,
        lastFailure: state.lastAttemptFailure,
      })

      return { status: 'failed', error }
    },
  }
}
