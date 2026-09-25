import * as crypto from 'crypto'

/**
 * Delivery ids are remembered in process until the webhook_deliveries table
 * is wired up. A repeated X-GitHub-Delivery is acknowledged and not turned
 * into a second run. The id is recorded only after handling succeeds, so a
 * 500 can still be retried by GitHub.
 */
const recordedDeliveries = new Map<string, string | null>()

export class WebhookService {
  static async processEvent(
    deliveryId: string,
    event: string,
    payload: unknown,
  ): Promise<{ runId: string | null }> {
    if (recordedDeliveries.has(deliveryId)) {
      throw new Error('Duplicate delivery')
    }

    const runId = await this.dispatch(deliveryId, event, payload)
    recordedDeliveries.set(deliveryId, runId)
    console.log(`Saved delivery ${deliveryId} linked to run ${runId}`)
    return { runId }
  }

  private static async dispatch(
    deliveryId: string,
    event: string,
    payload: unknown,
  ): Promise<string | null> {
    switch (event) {
      case 'ping':
      case 'installation':
        return this.handleInstallation(deliveryId, payload)
      case 'workflow_run':
        return this.handleWorkflowRun(deliveryId, payload)
      case 'pull_request':
        return this.handlePullRequest(deliveryId, payload)
      default:
        return null
    }
  }

  private static async handleInstallation(
    deliveryId: string,
    _payload: unknown,
  ): Promise<string | null> {
    console.log(`Handling installation for delivery ${deliveryId}`)
    return null
  }

  private static async handleWorkflowRun(
    deliveryId: string,
    payload: unknown,
  ): Promise<string | null> {
    const p = payload as { action?: string; workflow_run?: { conclusion?: string } }
    if (p.action !== 'completed') {
      return null
    }
    if (p.workflow_run?.conclusion !== 'failure') {
      return null
    }

    const runId = crypto.randomUUID()
    console.log(`Creating run ${runId} for failed workflow_run ${deliveryId}`)

    // TODO: Insert runs (queued) and enqueue graph_step.
    return runId
  }

  private static async handlePullRequest(
    deliveryId: string,
    payload: unknown,
  ): Promise<string | null> {
    const p = payload as { action?: string; pull_request?: { merged?: boolean; number?: number } }
    if (p.action !== 'closed' || !p.pull_request?.merged) {
      return null
    }

    console.log(`Handling merged pull_request ${p.pull_request.number} for delivery ${deliveryId}`)

    // TODO: If pr_number matches a run, mark that run merged.
    return null
  }
}
