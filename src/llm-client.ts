/**
 * Fetch-based LLM adapter — the concrete implementation of the LLMClient port.
 *
 * Uses global `fetch` to call Ollama or OpenRouter API endpoints.
 * Accepts a custom `fetchFn` for test injection.
 */

import type {
  LLMClient,
  LLMCallParams,
  LLMResult,
  LLMStepParams,
  LLMStepResult,
  ModelMessage,
  ToolCall,
} from './llm-port'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

/**
 * Keep only well-formed calls: a call with no id cannot be answered, because the
 * follow-up `tool` message must reference it. Providers emit partial entries when
 * a generation is truncated.
 */
export function normalizeToolCalls(raw: unknown, maxCalls: number): ToolCall[] {
  if (!Array.isArray(raw)) return []
  const out: ToolCall[] = []
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

/** Extract a JSON object from potentially prose-wrapped text. */
function findJsonObject(text: string): string {
  const trimmed = text.trim()
  const unfenced = trimmed.startsWith('```')
    ? trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim()
    : trimmed

  if (unfenced.startsWith('{')) return unfenced

  const start = unfenced.indexOf('{')
  if (start === -1) throw new Error(`Agent response was not JSON. It began with: ${unfenced.slice(0, 80)}`)

  let depth = 0
  for (let i = start; i < unfenced.length; i++) {
    const char = unfenced[i]
    if (char === '{') depth++
    else if (char === '}') {
      depth--
      if (depth === 0) return unfenced.slice(start, i + 1)
    }
  }

  throw new Error('Agent response contained an unclosed JSON object.')
}

/** Parse an LLM response string into the AgentResult shape.
 * Throws on parse errors OR invalid shape — the caller handles retry. */
function extractJson(text: string): LLMResult {
  const raw = findJsonObject(text)
  const parsed = JSON.parse(raw) as Record<string, unknown>
  if (!Array.isArray(parsed.patches) || typeof parsed.reply !== 'string') {
    throw new Error('Agent response did not match expected JSON shape')
  }
  return parsed as LLMResult
}

export class FetchLLMClient implements LLMClient {
  private readonly fetchFn: typeof fetch

  constructor(fetchFn?: typeof fetch) {
    // Bound to globalThis: stored as a bare reference and invoked as
    // `this.fetchFn(...)`, the browser sees `this` as the client instance and
    // throws "Illegal invocation". Injected test doubles are plain functions and
    // are unaffected, which is why unit tests never caught it.
    this.fetchFn = fetchFn ?? globalThis.fetch.bind(globalThis)
  }

  async call(params: LLMCallParams): Promise<LLMResult> {
    const url = this.buildUrl(params)
    const headers = this.buildHeaders(params)
    const body = JSON.stringify(this.buildBody(params))

    let response = await this.fetchFn(url, {
      method: 'POST',
      headers,
      body,
      signal: params.signal,
    })

    // OpenRouter fallback: retry without response_format on 400
    if (!response.ok && params.provider === 'openrouter' && response.status === 400) {
      const text = await response.text().catch(() => '')
      if (text.includes('response_format')) {
        response = await this.fetchFn(url, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: params.model,
            messages: params.messages.map(m => ({ role: m.role, content: m.content })),
          }),
          signal: params.signal,
        })
      }
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      const name = params.provider === 'ollama' ? 'Ollama' : 'OpenRouter'
      throw new Error(`${name} error ${response.status}: ${text || response.statusText}`)
    }

    const content = await this.extractContent(response, params.provider)
    if (!content) {
      const name = params.provider === 'ollama' ? 'Ollama' : 'OpenRouter'
      throw new Error(`${name} response missing content`)
    }

    try {
      return extractJson(content)
    } catch {
      return this.retryWithRepair(params, content)
    }
  }

  /**
   * One tool-enabled step. OpenRouter only (see `LLMStepParams.provider`).
   *
   * Sends no `response_format`: providers reject it alongside `tools`, and JSON
   * mode is meaningless when the answer is expected to be tool calls.
   */
  async step(params: LLMStepParams): Promise<LLMStepResult> {
    if (!params.apiKey) throw new Error('OpenRouter API key is required')

    const response = await this.fetchFn(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${params.apiKey}`,
      },
      body: JSON.stringify({
        model: params.model,
        messages: params.messages,
        tools: params.tools,
        tool_choice: 'auto',
      }),
      signal: params.signal,
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`OpenRouter error ${response.status}: ${text || response.statusText}`)
    }

    const json = (await response.json()) as {
      choices?: { message?: { content?: string | null; tool_calls?: unknown } }[]
    }
    const message = json.choices?.[0]?.message
    if (!message) throw new Error('OpenRouter response missing message')

    const toolCalls = normalizeToolCalls(message.tool_calls, params.maxCalls)
    const content = typeof message.content === 'string' ? message.content : ''
    // A pure tool-call response has content: null — the expected shape here.
    // Only a message with neither content nor a usable call is unusable.
    if (!content && toolCalls.length === 0) {
      throw new Error('OpenRouter response had no content and no tool calls')
    }
    return { content, toolCalls }
  }

  private async extractContent(response: Response, provider: string): Promise<string | null> {
    const json = await response.json()
    if (provider === 'ollama') {
      return (json as { message?: { content: string } }).message?.content ?? null
    }
    return ((json as { choices?: { message?: { content: string } }[] }).choices?.[0]?.message?.content) ?? null
  }

  private async retryWithRepair(params: LLMCallParams, lastContent: string): Promise<LLMResult> {
    const repairMessages: ModelMessage[] = [
      ...params.messages.map(m => ({ role: m.role, content: m.content })),
      { role: 'assistant', content: lastContent },
      { role: 'user', content: 'Invalid response to repair. Return ONLY valid JSON with shape: {"reply":"summary","patches":[{"path":"file","content":"code"}]}' },
    ]
    const repairParams: LLMCallParams = { ...params, messages: repairMessages }
    const url = this.buildUrl(repairParams)
    const headers = this.buildHeaders(repairParams)
    const body = JSON.stringify(this.buildBody(repairParams))

    const response = await this.fetchFn(url, {
      method: 'POST',
      headers,
      body,
      signal: params.signal,
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      const name = params.provider === 'ollama' ? 'Ollama' : 'OpenRouter'
      throw new Error(`${name} repair error ${response.status}: ${text || response.statusText}`)
    }

    const content = await this.extractContent(response, params.provider)
    if (!content) throw new Error('Repair response missing content')
    return extractJson(content)
  }

  private buildBody(params: LLMCallParams): Record<string, unknown> {
    const base = {
      model: params.model,
      messages: params.messages.map(m => ({ role: m.role, content: m.content })),
    }

    if (params.provider === 'ollama') {
      return { ...base, stream: false, format: 'json' }
    }
    if (params.formatJson) {
      return { ...base, response_format: { type: 'json_object' } }
    }
    return base
  }

  private buildUrl(params: LLMCallParams): string {
    if (params.provider === 'ollama') {
      if (!params.ollamaUrl) throw new Error('Ollama URL is required')
      return `${params.ollamaUrl.replace(/\/$/, '')}/api/chat`
    }
    if (!params.apiKey) throw new Error('OpenRouter API key is required')
    return 'https://openrouter.ai/api/v1/chat/completions'
  }

  private buildHeaders(params: LLMCallParams): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (params.provider === 'openrouter' && params.apiKey) {
      headers.Authorization = `Bearer ${params.apiKey}`
    }
    return headers
  }
}
