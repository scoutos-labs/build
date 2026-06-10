import type { ModelMessage } from './prompt.js'

const BASE_URL = 'https://openrouter.ai/api/v1'

export type ProvisionedKey = {
  key: string
  hash: string
}

export type KeyInfo = {
  limit: number | null
  usage: number
  limitRemaining: number | null
  disabled: boolean
}

export type ChatResult =
  | { kind: 'ok'; content: string }
  | { kind: 'budget_exhausted' }
  | { kind: 'error'; status: number; message: string }

export type OpenRouterClient = {
  createKey(args: { name: string; limitUsd: number }): Promise<ProvisionedKey>
  getKey(hash: string): Promise<KeyInfo>
  updateKey(hash: string, patch: { disabled?: boolean; limit?: number }): Promise<void>
  deleteKey(hash: string): Promise<void>
  chatCompletion(args: {
    apiKey: string
    model: string
    messages: ModelMessage[]
    responseFormatJson?: boolean
    signal?: AbortSignal
  }): Promise<ChatResult>
}

export function createOpenRouterClient(opts: {
  provisioningKey: string
  fetchImpl?: typeof fetch
}): OpenRouterClient {
  const fetchImpl = opts.fetchImpl ?? fetch
  const managementHeaders = {
    Authorization: `Bearer ${opts.provisioningKey}`,
    'Content-Type': 'application/json',
  }

  async function managementRequest(method: string, path: string, body?: unknown) {
    const response = await fetchImpl(`${BASE_URL}${path}`, {
      method,
      headers: managementHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`OpenRouter management API ${method} ${path} failed (${response.status}): ${text}`)
    }
    return response.json() as Promise<Record<string, unknown>>
  }

  return {
    async createKey({ name, limitUsd }) {
      const data = await managementRequest('POST', '/keys', {
        name,
        limit: limitUsd,
        limit_reset: 'monthly',
      })
      const key = data.key
      const meta = data.data as { hash?: string } | undefined
      if (typeof key !== 'string' || !meta?.hash) {
        throw new Error('OpenRouter key creation response missing key or hash')
      }
      return { key, hash: meta.hash }
    },

    async getKey(hash) {
      const data = await managementRequest('GET', `/keys/${hash}`)
      const meta = (data.data ?? data) as {
        limit?: number | null
        usage?: number
        limit_remaining?: number | null
        disabled?: boolean
      }
      const limit = meta.limit ?? null
      const usage = meta.usage ?? 0
      return {
        limit,
        usage,
        limitRemaining: meta.limit_remaining ?? (limit === null ? null : Math.max(0, limit - usage)),
        disabled: meta.disabled ?? false,
      }
    },

    async updateKey(hash, patch) {
      await managementRequest('PATCH', `/keys/${hash}`, patch)
    },

    async deleteKey(hash) {
      await managementRequest('DELETE', `/keys/${hash}`)
    },

    async chatCompletion({ apiKey, model, messages, responseFormatJson = true, signal }) {
      const headers = {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      }
      const request = (body: Record<string, unknown>) =>
        fetchImpl(`${BASE_URL}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal,
        })

      let response = await request(
        responseFormatJson
          ? { model, messages, response_format: { type: 'json_object' } }
          : { model, messages },
      )

      // Some providers reject response_format; retry once without it.
      if (!response.ok && response.status === 400 && responseFormatJson) {
        const errorText = await response.text().catch(() => '')
        if (errorText.includes('response_format')) {
          response = await request({ model, messages })
        } else {
          return { kind: 'error', status: 400, message: errorText }
        }
      }

      if (response.status === 402) return { kind: 'budget_exhausted' }
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        return { kind: 'error', status: response.status, message: text || response.statusText }
      }

      const data = (await response.json()) as { choices?: { message?: { content?: string } }[] }
      const content = data.choices?.[0]?.message?.content
      if (!content) return { kind: 'error', status: 502, message: 'OpenRouter response missing content' }
      return { kind: 'ok', content }
    },
  }
}
