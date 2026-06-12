// Scout Live deploy API client, shaped like openrouter.ts: injectable
// fetch, faked in tests. Contract verified against scoutos-labs/scout-live
// src/routes/build.ts (see docs/scoutos-live-prd.md).

const BASE_URL = 'https://scoutos.live'

export type DeployAccepted = { kind: 'accepted'; buildId: string }
export type DeployResult =
  | DeployAccepted
  | { kind: 'subdomain_taken' } // 409: claimed by another user, or no code supplied
  | { kind: 'invalid_code' } // 403: wrong publish code
  | { kind: 'rate_limited'; retryAfterSeconds: number | null } // 429: 20 deploys/hr/key
  | { kind: 'error'; status: number; message: string }

export type BuildStatusInfo = {
  status: string // queued | running | deployed | failed | build_succeeded_deploy_failed
  url?: string
  /** Present only on the first deploy's terminal status; absent on republish. */
  publishCode?: string
  error?: string
  logs?: string
}

export type StatusResult =
  | { kind: 'ok'; build: BuildStatusInfo }
  | { kind: 'not_found' }
  | { kind: 'error'; status: number; message: string }

export type ScoutLiveClient = {
  deploy(args: {
    apiKey: string
    subdomain: string
    tarGz: Buffer
    code?: string
  }): Promise<DeployResult>
  getBuildStatus(args: { apiKey: string; buildId: string }): Promise<StatusResult>
}

export function createScoutLiveClient(opts: {
  baseUrl?: string
  fetchImpl?: typeof fetch
} = {}): ScoutLiveClient {
  const fetchImpl = opts.fetchImpl ?? fetch
  const baseUrl = (opts.baseUrl ?? BASE_URL).replace(/\/+$/, '')

  return {
    async deploy({ apiKey, subdomain, tarGz, code }) {
      const url = new URL(`${baseUrl}/api/build`)
      url.searchParams.set('subdomain', subdomain)
      if (code) url.searchParams.set('code', code)

      const response = await fetchImpl(url.toString(), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/gzip',
        },
        body: new Uint8Array(tarGz),
      })

      if (response.status === 409) return { kind: 'subdomain_taken' }
      if (response.status === 403) return { kind: 'invalid_code' }
      if (response.status === 429) {
        const retryAfter = Number(response.headers.get('retry-after'))
        return { kind: 'rate_limited', retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : null }
      }
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        return { kind: 'error', status: response.status, message: text || response.statusText }
      }

      const data = (await response.json()) as { buildId?: string }
      if (typeof data.buildId !== 'string') {
        return { kind: 'error', status: 502, message: 'Deploy response missing buildId' }
      }
      return { kind: 'accepted', buildId: data.buildId }
    },

    async getBuildStatus({ apiKey, buildId }) {
      const response = await fetchImpl(`${baseUrl}/api/build/${encodeURIComponent(buildId)}/status`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      })
      if (response.status === 404) return { kind: 'not_found' }
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        return { kind: 'error', status: response.status, message: text || response.statusText }
      }
      const data = (await response.json()) as BuildStatusInfo & { status?: unknown }
      if (typeof data.status !== 'string') {
        return { kind: 'error', status: 502, message: 'Status response missing status' }
      }
      return { kind: 'ok', build: data as BuildStatusInfo }
    },
  }
}
