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

/** A tool call as the provider reports it. `arguments` is a JSON *string* in the
 * OpenAI/OpenRouter wire format — parsed by the caller, not here, so a malformed
 * blob stays recoverable. */
export type ProviderToolCall = {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/**
 * Result of a tool-enabled completion.
 *
 * Distinct from ChatResult for one load-bearing reason: a pure tool-call
 * response has `content: null`, which `chatCompletion` treats as a 502 error.
 * That is correct for the single-shot JSON protocol (no content = nothing to
 * parse) and exactly wrong for a tool loop, so the two paths do not share a
 * result type.
 */
export type ToolChatResult =
  | { kind: 'ok'; content: string; toolCalls: ProviderToolCall[] }
  | { kind: 'budget_exhausted' }
  | { kind: 'error'; status: number; message: string }

/** An OpenAI-format tool definition. Opaque here — the harness owns the schemas. */
export type ToolSpec = {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

/** Keep only well-formed calls: a call with no id cannot be answered, because
 * the follow-up `tool` message must reference it. Providers occasionally emit
 * partial entries when a generation is truncated. */
export function normalizeToolCalls(raw: unknown, maxCalls: number): ProviderToolCall[] {
  if (!Array.isArray(raw)) return []
  const out: ProviderToolCall[] = []
  for (const entry of raw) {
    const call = entry as Record<string, any> | null
    const id = typeof call?.id === 'string' ? call.id : ''
    const name = typeof call?.function?.name === 'string' ? call.function.name : ''
    if (!id || !name) continue
    const args = typeof call?.function?.arguments === 'string' ? call.function.arguments : '{}'
    out.push({ id, type: 'function', function: { name, arguments: args } })
    if (out.length >= maxCalls) break
  }
  return out
}

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
  /**
   * Tool-enabled completion for the agent harness.
   *
   * Never sends `response_format` — providers reject it alongside `tools`, and
   * JSON-mode is meaningless when the model is expected to answer with tool
   * calls. Returns content and tool calls together, because a model may narrate
   * and call a tool in the same message.
   */
  toolCompletion(args: {
    apiKey: string
    model: string
    messages: ModelMessage[]
    tools: ToolSpec[]
    maxCalls: number
    signal?: AbortSignal
  }): Promise<ToolChatResult>
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

    async toolCompletion({ apiKey, model, messages, tools, maxCalls, signal }) {
      const response = await fetchImpl(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        // No response_format: providers reject it alongside tools.
        body: JSON.stringify({ model, messages, tools, tool_choice: 'auto' }),
        signal,
      })

      if (response.status === 402) return { kind: 'budget_exhausted' }
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        return { kind: 'error', status: response.status, message: text || response.statusText }
      }

      const data = (await response.json()) as {
        choices?: { message?: { content?: string | null; tool_calls?: unknown } }[]
      }
      const message = data.choices?.[0]?.message
      if (!message) return { kind: 'error', status: 502, message: 'OpenRouter response missing message' }

      const toolCalls = normalizeToolCalls(message.tool_calls, maxCalls)
      const content = typeof message.content === 'string' ? message.content : ''
      // A pure tool-call response has content: null and that is the *expected*
      // shape here — only a message with neither content nor a usable call is an
      // error. (chatCompletion treats missing content as a 502, which is right
      // for the JSON protocol and wrong for this one.)
      if (!content && toolCalls.length === 0) {
        return { kind: 'error', status: 502, message: 'OpenRouter response had no content and no tool calls' }
      }
      return { kind: 'ok', content, toolCalls }
    },
  }
}
