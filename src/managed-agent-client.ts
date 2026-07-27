import type { AgentResult } from './agent'
import type { SelectedPreviewElement } from './preview-inspector'
import type { ProjectFile } from './templates'

export type ManagedAgentPayload = {
  userPrompt: string
  files: ProjectFile[]
  messages: { role: 'user' | 'assistant'; content: string }[]
  selectedElement?: SelectedPreviewElement
  elementComment?: string
}

export class BudgetExhaustedError extends Error {
  readonly code = 'budget_exhausted'
  constructor(readonly resetAt: string = '') {
    super('Monthly build budget used up.')
  }
}

export class PaymentFailedError extends Error {
  readonly code = 'payment_failed'
  constructor() {
    super('Your account is disabled — check your payment method.')
  }
}

/**
 * Calls the server-side agent proxy. A fresh token is fetched per request
 * (Clerk session tokens expire after ~60s); the server picks the model and
 * holds the OpenRouter key.
 */
export async function callManagedAgent(
  payload: ManagedAgentPayload,
  options: {
    getToken: () => Promise<string | null>
    signal?: AbortSignal
    fetchImpl?: typeof fetch
  },
): Promise<AgentResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const token = await options.getToken()
  const response = await fetchImpl('/api/agent', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
    signal: options.signal,
  })

  if (response.status === 402) {
    const error = await errorDetails(response)
    if (error.code === 'payment_failed') throw new PaymentFailedError()
    throw new BudgetExhaustedError(error.resetAt ?? '')
  }
  if (response.status === 401) throw new Error('Session expired — sign in again.')
  if (response.status === 429) throw new Error('Too many requests — wait a minute and retry.')
  if (!response.ok) {
    const error = await errorDetails(response)
    throw new Error(`Agent request failed (${response.status}${error.code ? `: ${error.code}` : ''})`)
  }

  const result = (await response.json()) as AgentResult
  if (typeof result?.reply !== 'string' || !Array.isArray(result?.patches)) {
    throw new Error('Agent response did not match expected shape')
  }
  return result
}

export type StepPayload = {
  turnId: string
  stepIndex: number
  stepToken?: string
  tree: { path: string; bytes: number }[]
  fullFiles: { path: string; content: string }[]
  messages: { role: 'user' | 'assistant'; content: string }[]
  toolCalls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  toolResults: { toolCallId: string; name?: string; content: string }[]
  userPrompt?: string
  selectedElement?: SelectedPreviewElement
  elementComment?: string
  /** True once anything has been read from the web this turn. The server holds
   * no turn state, so the client carries the taint between steps — and the
   * server re-checks it before any web_post actually sends. */
  webRead?: boolean
}

/** A web_post the model wants to make, paused for the user. */
export type ApprovalRequest = {
  toolCallId: string
  tool: 'web_post'
  url: string
  method: string
  body: string
  contentType: string
  title: string
  /** Non-empty when the request cannot proceed at all (tainted turn). */
  blocked: string
}

export type StepResponse = {
  toolCalls: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  approval: ApprovalRequest | null
  serverSteps: { name: string; summary: string; warn?: string }[]
  assistantContent: string
  done: boolean
  usedLegacyAdapter: boolean
  webRead: boolean
  stepToken: string
  maxToolSteps: number
}

/**
 * One step of the agent loop.
 *
 * Shares the error taxonomy with `callManagedAgent` deliberately: a mid-turn
 * budget exhaustion or session expiry must read to the user exactly as it did
 * before the harness. A fresh Clerk token is fetched per step because they
 * expire in ~60s and a multi-step turn easily outlives one.
 */
export async function callAgentStep(
  payload: StepPayload,
  options: {
    getToken: () => Promise<string | null>
    signal?: AbortSignal
    fetchImpl?: typeof fetch
  },
): Promise<StepResponse> {
  const fetchImpl = options.fetchImpl ?? fetch
  const token = await options.getToken()
  const response = await fetchImpl('/api/agent/step', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
    signal: options.signal,
  })

  if (response.status === 402) {
    const error = await errorDetails(response)
    if (error.code === 'payment_failed') throw new PaymentFailedError()
    throw new BudgetExhaustedError(error.resetAt ?? '')
  }
  if (response.status === 401) throw new Error('Session expired — sign in again.')
  if (response.status === 429) throw new Error('Too many requests — wait a minute and retry.')
  if (!response.ok) {
    const error = await errorDetails(response)
    throw new Error(`Agent request failed (${response.status}${error.code ? `: ${error.code}` : ''})`)
  }

  const result = (await response.json()) as StepResponse
  if (!Array.isArray(result?.toolCalls) || typeof result?.done !== 'boolean') {
    throw new Error('Agent step response did not match expected shape')
  }
  return result
}

async function errorDetails(response: Response): Promise<{ code: string; resetAt?: string }> {
  try {
    const body = (await response.json()) as { error?: { code?: string; resetAt?: string } }
    return { code: body.error?.code ?? '', resetAt: body.error?.resetAt }
  } catch {
    return { code: '' }
  }
}
