import { describe, expect, it, vi } from 'vitest'
import {
  BudgetExhaustedError,
  callManagedAgent,
  PaymentFailedError,
} from './managed-agent-client'

const payload = { userPrompt: 'add a button', files: [], messages: [] }

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('callManagedAgent', () => {
  it('fetches a fresh token per request and attaches it as a Bearer header', async () => {
    const getToken = vi.fn(async () => 'jwt-1')
    const fetchImpl = vi.fn(async () => jsonResponse(200, { reply: 'ok', patches: [] }))
    const result = await callManagedAgent(payload, { getToken, fetchImpl })

    expect(result).toEqual({ reply: 'ok', patches: [] })
    expect(getToken).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/agent')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer jwt-1')
    expect(JSON.parse(init.body as string)).toEqual(payload)
  })

  it('omits the Authorization header when no token is available (cookie fallback)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { reply: 'ok', patches: [] }))
    await callManagedAgent(payload, { getToken: async () => null, fetchImpl })
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.headers as Record<string, string>).not.toHaveProperty('Authorization')
  })

  it('maps 402 budget_exhausted to BudgetExhaustedError carrying the reset date', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(402, {
        error: { code: 'budget_exhausted', message: 'spent', resetAt: '2026-07-01T00:00:00.000Z' },
      }),
    )
    const error = await callManagedAgent(payload, { getToken: async () => 'jwt', fetchImpl }).catch(
      e => e,
    )
    expect(error).toBeInstanceOf(BudgetExhaustedError)
    expect((error as BudgetExhaustedError).resetAt).toBe('2026-07-01T00:00:00.000Z')
  })

  it('maps 402 payment_failed to PaymentFailedError', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(402, { error: { code: 'payment_failed', message: 'card declined' } }),
    )
    await expect(
      callManagedAgent(payload, { getToken: async () => 'jwt', fetchImpl }),
    ).rejects.toBeInstanceOf(PaymentFailedError)
  })

  it('surfaces 401 as a session-expired error', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, { error: { code: 'unauthorized' } }))
    await expect(
      callManagedAgent(payload, { getToken: async () => 'stale', fetchImpl }),
    ).rejects.toThrow(/sign in again/i)
  })

  it('rejects responses that do not match { reply, patches }', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { message: 'hi' }))
    await expect(
      callManagedAgent(payload, { getToken: async () => 'jwt', fetchImpl }),
    ).rejects.toThrow(/expected shape/i)
  })
})
