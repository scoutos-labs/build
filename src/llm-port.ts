/**
 * Port (interface) for LLM interaction.
 *
 * Separates the build agent's domain logic from the concrete HTTP mechanism.
 * The domain depends on this interface; the concrete adapter uses global fetch.
 *
 * This makes the LLM call injectable — callers can swap adapters for testing
 * or future providers without changing the agent logic.
 */

export type ModelMessage = { role: 'system' | 'user' | 'assistant'; content: string }

export interface LLMClient {
  /**
   * Send a completion request to the LLM provider.
   * @param params The request parameters (provider-specific)
   * @returns The parsed agent result
   */
  call(params: LLMCallParams): Promise<LLMResult>
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

export type LLMResult = {
  reply: string
  patches: Array<{ path: string; content: string }>
  envVars?: Record<string, string>
}
