import { createSign } from 'node:crypto'

/**
 * The GitHub App side of the agent's tools. An installation token is minted
 * for each call and kept in a local, never stored on a run, in a checkpoint,
 * in a prompt or in the sandbox (docs/backend-architecture.md#identity).
 */
export interface GitHubAppConfig {
  readonly appId: string
  /** PKCS#8 or PKCS#1 PEM. Read from the environment by the worker only. */
  readonly privateKey: string
  readonly apiBaseUrl?: string
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

const DEFAULT_API = 'https://api.github.com'
const JWT_LIFETIME_SECONDS = 540
const MAX_JOB_LOG_CHARS = 200_000
const USER_AGENT = 'adamant-heal-agent'

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

/** Short-lived App JWT. Only used to mint an installation token. */
function appJwt(config: GitHubAppConfig, now = Math.floor(Date.now() / 1000)): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = base64url(
    JSON.stringify({ iat: now - 60, exp: now + JWT_LIFETIME_SECONDS, iss: config.appId }),
  )
  const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(config.privateKey)

  return `${header}.${payload}.${base64url(signature)}`
}

export interface WorkflowJob {
  readonly id: number
  readonly name: string
  readonly conclusion: string | null
}

export interface GitHubClient {
  installationToken(installationId: string): Promise<string>
  failedJobLogs(input: {
    installationId: string
    owner: string
    name: string
    headSha: string
  }): Promise<string>
  createPullRequest(input: {
    installationId: string
    owner: string
    name: string
    head: string
    base: string
    title: string
    body: string
  }): Promise<{ number: number; url: string }>
  mergePullRequest(input: {
    installationId: string
    owner: string
    name: string
    prNumber: number
    commitTitle: string
  }): Promise<void>
}

export class GitHubApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'GitHubApiError'
    this.status = status
  }
}

export function createGitHubClient(config: GitHubAppConfig, fetchImpl?: FetchLike): GitHubClient {
  const api = (config.apiBaseUrl ?? DEFAULT_API).replace(/\/$/, '')
  const doFetch: FetchLike = fetchImpl ?? ((url, init) => fetch(url, init))

  async function call(
    token: string,
    method: string,
    path: string,
    body?: unknown,
    accept = 'application/vnd.github+json',
  ): Promise<Response> {
    const response = await doFetch(`${api}${path}`, {
      method,
      headers: {
        accept,
        authorization: `Bearer ${token}`,
        'user-agent': USER_AGENT,
        'x-github-api-version': '2022-11-28',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })

    if (!response.ok) {
      // The body can echo request headers; only the status and path are kept.
      throw new GitHubApiError(
        response.status,
        `GitHub ${method} ${path} failed: ${response.status}`,
      )
    }

    return response
  }

  async function json<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
    const response = await call(token, method, path, body)
    return (await response.json()) as T
  }

  const client: GitHubClient = {
    async installationToken(installationId) {
      const response = await doFetch(`${api}/app/installations/${installationId}/access_tokens`, {
        method: 'POST',
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${appJwt(config)}`,
          'user-agent': USER_AGENT,
          'x-github-api-version': '2022-11-28',
        },
      })

      if (!response.ok) {
        throw new GitHubApiError(
          response.status,
          `Could not mint an installation token: ${response.status}`,
        )
      }

      const body = (await response.json()) as { token?: string }
      if (!body.token) {
        throw new GitHubApiError(response.status, 'Installation token response had no token')
      }

      return body.token
    },

    /** Failed jobs only. Downloading the whole run is the slow, noisy path. */
    async failedJobLogs({ installationId, owner, name, headSha }) {
      const token = await client.installationToken(installationId)
      const repo = `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`

      const runs = await json<{ workflow_runs?: { id: number; conclusion: string | null }[] }>(
        token,
        'GET',
        `/repos/${repo}/actions/runs?head_sha=${encodeURIComponent(headSha)}&status=completed&per_page=20`,
      )

      const failedRuns = (runs.workflow_runs ?? []).filter((run) => run.conclusion === 'failure')
      if (failedRuns.length === 0) {
        return ''
      }

      const sections: string[] = []
      for (const run of failedRuns) {
        const jobs = await json<{ jobs?: WorkflowJob[] }>(
          token,
          'GET',
          `/repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`,
        )

        for (const job of jobs.jobs ?? []) {
          if (job.conclusion !== 'failure') continue
          const logs = await call(
            token,
            'GET',
            `/repos/${repo}/actions/jobs/${job.id}/logs`,
            undefined,
            'text/plain',
          )
          const text = await logs.text()
          sections.push(`=== job: ${job.name} ===\n${text.slice(-MAX_JOB_LOG_CHARS)}`)
        }
      }

      return sections.join('\n\n')
    },

    async createPullRequest({ installationId, owner, name, head, base, title, body }) {
      const token = await client.installationToken(installationId)
      const repo = `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
      const pr = await json<{ number: number; html_url: string }>(
        token,
        'POST',
        `/repos/${repo}/pulls`,
        { title, head, base, body, maintainer_can_modify: true },
      )

      return { number: pr.number, url: pr.html_url }
    },

    async mergePullRequest({ installationId, owner, name, prNumber, commitTitle }) {
      const token = await client.installationToken(installationId)
      const repo = `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
      await json(token, 'PUT', `/repos/${repo}/pulls/${prNumber}/merge`, {
        merge_method: 'squash',
        commit_title: commitTitle,
      })
    },
  }

  return client
}

/** Worker-only. Returns null when the App is not configured, so callers fail closed. */
export function readGitHubAppConfig(env = process.env): GitHubAppConfig | null {
  const appId = env.GITHUB_APP_ID
  const privateKey = env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, '\n')

  if (!appId || !privateKey) return null

  return {
    appId,
    privateKey,
    ...(env.GITHUB_API_URL ? { apiBaseUrl: env.GITHUB_API_URL } : {}),
  }
}
