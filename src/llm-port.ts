/**
 * Port (interface) for LLM interaction.
 *
 * Separates the build agent's domain logic from the concrete HTTP mechanism.
 * The domain depends on this interface; the concrete adapter uses global fetch.
 *
 * This makes the LLM call injectable — callers can swap adapters for testing
 * or future providers without changing the agent logic.
 */

/** A tool call as the provider reports it. `arguments` is a JSON *string* in the
 * OpenAI/OpenRouter wire format. */
export type ToolCall = {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/** An OpenAI-format tool definition. Opaque to the port — the harness owns the
 * schemas. */
export type ToolSpec = {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

/**
 * A message on the wire to the provider.
 *
 * The `tool` role plus the two optional fields are what make a tool loop
 * expressible: an assistant turn that called tools carries `tool_calls`, and each
 * result comes back as a `tool` message whose `tool_call_id` references it.
 * Providers reject a `tool_calls` array with no matching `tool` message, so the
 * two must always be emitted as a pair.
 */
export type ModelMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

export interface LLMClient {
  /**
   * Send a completion request to the LLM provider.
   * @param params The request parameters (provider-specific)
   * @returns The parsed agent result
   */
  call(params: LLMCallParams): Promise<LLMResult>
  /**
   * Send a tool-enabled completion for one step of the agent harness.
   *
   * Separate from `call` because the two have incompatible success conditions: a
   * pure tool-call response has no content at all, which `call` treats as a
   * provider error (correct for the JSON protocol, wrong for a tool loop).
   *
   * Only OpenRouter implements this. Ollama is deliberately excluded — see
   * `LLMStepParams.provider`.
   */
  step(params: LLMStepParams): Promise<LLMStepResult>
}

export type LLMCallParams = {
  provider: 'ollama' | 'openrouter'
  model: string
  messages: ModelMessage[]
  apiKey?: string
  ollamaUrl?: string
  signal?: AbortSignal
  formatJson?: boolean
}

export type LLMStepParams = {
  /**
   * OpenRouter only, and the narrowing is deliberate rather than an oversight.
   * Ollama is excluded from tool mode because: its adapter forces
   * `format: 'json'` (which conflicts with `tools`); it returns
   * `tool_calls[].function.arguments` as an *object* rather than the JSON string
   * every other provider sends, so a shared normalizer would silently mis-parse;
   * and it exposes no capability metadata at all, which makes the pre-flight
   * tool-capability check unimplementable. Ollama users stay on the JSON
   * protocol via `call`, and the UI says so rather than degrading silently.
   */
  provider: 'openrouter'
  model: string
  messages: ModelMessage[]
  tools: ToolSpec[]
  /** Cap on tool calls honored from one response. Extra calls are dropped. */
  maxCalls: number
  apiKey?: string
  signal?: AbortSignal
}

export type LLMStepResult = {
  /** Assistant prose. May be empty when the model only called tools. */
  content: string
  /** Well-formed calls only; entries with no id are dropped (they cannot be
   * answered, because the follow-up `tool` message must reference the id). */
  toolCalls: ToolCall[]
}

export type LLMResult = {
  reply: string
  patches: Array<{ path: string; content: string }>
  envVars?: Record<string, string>
}
