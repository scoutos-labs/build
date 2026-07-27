/**
 * Transport tests for the tool-calling path.
 *
 * The case that matters most is `content: null` + `tool_calls: [...]` — the exact
 * shape of a pure tool-call response, which the pre-existing `chatCompletion`
 * treats as a 502. That is right for the single-shot JSON protocol and would have
 * broken the harness on its first step.
 */
import { describe, expect, it, vi } from 'vitest'
import { createOpenRouterClient, normalizeToolCalls, type ToolSpec } from './openrouter.js'

const TOOLS: ToolSpec[] = [
  {
    type: 'function',
    function: { name: 'fs_read', description: 'read a file', parameters: { type: 'object' } },
  },
]

function call(id: string, name = 'fs_read', args = '{"path":"a.ts"}') {
  return { id, type: 'function', function: { name, arguments: args } }
}

function response(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

function clientWith(fetchImpl: typeof fetch) {
  return createOpenRouterClient({ provisioningKey: 'sk-or-prov', fetchImpl })
}

function bodyOf(fetchMock: ReturnType<typeof vi.fn>) {
  return JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)
}

const args = { apiKey: 'sk-or-user', model: 'a/model', messages: [], tools: TOOLS, maxCalls: 3 }

describe('normalizeToolCalls', () => {
  it('drops calls with no id — they cannot be answered', () => {
    // The follow-up `tool` message must reference the call id; providers emit
    // partial entries when a generation is truncated.
    const calls = normalizeToolCalls([call('c1'), { function: { name: 'fs_read' } }], 5)
    expect(calls.map(c => c.id)).toEqual(['c1'])
  })

  it('drops calls with no function name', () => {
    expect(normalizeToolCalls([{ id: 'c1', function: {} }], 5)).toEqual([])
  })

  it('caps at maxCalls', () => {
    const calls = normalizeToolCalls([call('a'), call('b'), call('c'), call('d')], 2)
    expect(calls.map(c => c.id)).toEqual(['a', 'b'])
  })

  it('defaults non-string arguments to an empty object literal', () => {
    // arguments is a JSON *string* on the wire; an object would break JSON.parse
    // downstream, so coerce rather than pass through.
    const [only] = normalizeToolCalls([{ id: 'c1', function: { name: 'x', arguments: { a: 1 } } }], 5)
    expect(only!.function.arguments).toBe('{}')
  })

  it('returns [] for a non-array', () => {
    expect(normalizeToolCalls(undefined, 3)).toEqual([])
    expect(normalizeToolCalls(null, 3)).toEqual([])
  })
})

describe('toolCompletion', () => {
  it('accepts content: null with tool calls — the pure tool-call shape', async () => {
    const fetchMock = vi.fn(async () =>
      response({ choices: [{ message: { content: null, tool_calls: [call('c1')] } }] }),
    )
    const result = await clientWith(fetchMock as unknown as typeof fetch).toolCompletion(args)
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.content).toBe('')
    expect(result.toolCalls.map(c => c.id)).toEqual(['c1'])
  })

  it('returns content and tool calls together when the model narrates and calls', async () => {
    const fetchMock = vi.fn(async () =>
      response({ choices: [{ message: { content: 'Reading it now.', tool_calls: [call('c1')] } }] }),
    )
    const result = await clientWith(fetchMock as unknown as typeof fetch).toolCompletion(args)
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.content).toBe('Reading it now.')
    expect(result.toolCalls).toHaveLength(1)
  })

  it('accepts content with no tool calls — the final answer', async () => {
    const fetchMock = vi.fn(async () => response({ choices: [{ message: { content: 'All done.' } }] }))
    const result = await clientWith(fetchMock as unknown as typeof fetch).toolCompletion(args)
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.content).toBe('All done.')
    expect(result.toolCalls).toEqual([])
  })

  it('errors only when there is neither content nor a usable call', async () => {
    const fetchMock = vi.fn(async () => response({ choices: [{ message: { content: null } }] }))
    const result = await clientWith(fetchMock as unknown as typeof fetch).toolCompletion(args)
    expect(result.kind).toBe('error')
    if (result.kind !== 'error') return
    expect(result.status).toBe(502)
  })

  it('never sends response_format alongside tools', async () => {
    // Providers reject the combination, and JSON mode is meaningless when the
    // answer is expected to be tool calls.
    const fetchMock = vi.fn(async () => response({ choices: [{ message: { content: 'ok' } }] }))
    await clientWith(fetchMock as unknown as typeof fetch).toolCompletion(args)
    const sent = bodyOf(fetchMock)
    expect(sent.response_format).toBeUndefined()
    expect(sent.tools).toEqual(TOOLS)
    expect(sent.tool_choice).toBe('auto')
  })

  it('sends the per-user key, never the provisioning key', async () => {
    const fetchMock = vi.fn(async () => response({ choices: [{ message: { content: 'ok' } }] }))
    await clientWith(fetchMock as unknown as typeof fetch).toolCompletion(args)
    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer sk-or-user')
    expect(headers.Authorization).not.toContain('sk-or-prov')
  })

  it('maps 402 to budget_exhausted so a mid-turn cap ends the turn cleanly', async () => {
    const fetchMock = vi.fn(async () => response({}, { ok: false, status: 402 }))
    const result = await clientWith(fetchMock as unknown as typeof fetch).toolCompletion(args)
    expect(result).toEqual({ kind: 'budget_exhausted' })
  })

  it('surfaces other non-ok statuses as errors', async () => {
    const fetchMock = vi.fn(async () => response({ e: 'boom' }, { ok: false, status: 500 }))
    const result = await clientWith(fetchMock as unknown as typeof fetch).toolCompletion(args)
    expect(result.kind).toBe('error')
    if (result.kind !== 'error') return
    expect(result.status).toBe(500)
  })

  it('honors maxCalls', async () => {
    const fetchMock = vi.fn(async () =>
      response({ choices: [{ message: { content: null, tool_calls: [call('a'), call('b'), call('c')] } }] }),
    )
    const client = clientWith(fetchMock as unknown as typeof fetch)
    const result = await client.toolCompletion({ ...args, maxCalls: 2 })
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.toolCalls.map(c => c.id)).toEqual(['a', 'b'])
  })

  it('errors on a response with no message at all', async () => {
    const fetchMock = vi.fn(async () => response({ choices: [] }))
    const result = await clientWith(fetchMock as unknown as typeof fetch).toolCompletion(args)
    expect(result.kind).toBe('error')
  })
})

describe('chatCompletion is unaffected', () => {
  it('still sends response_format by default and still 502s on missing content', async () => {
    // The JSON protocol's success condition is unchanged — this is the guard
    // against the tool path leaking into it.
    const fetchMock = vi.fn(async () => response({ choices: [{ message: { content: null } }] }))
    const client = clientWith(fetchMock as unknown as typeof fetch)
    const result = await client.chatCompletion({ apiKey: 'sk-or-user', model: 'a/model', messages: [] })
    expect(result.kind).toBe('error')
    expect(bodyOf(fetchMock).response_format).toEqual({ type: 'json_object' })
    expect(bodyOf(fetchMock).tools).toBeUndefined()
  })
})
