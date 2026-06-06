import { afterEach, describe, expect, it, vi } from 'vitest'
import { followUpWithToolResults, scoutosAtomsRequest, type ScoutosFollowUpArgs, type ScoutosAtomsRequestArgs } from './scoutos-client'
import type { ChatMessage } from './atoms-protocol'

const originalFetch = globalThis.fetch

afterEach(() => {
  vi.restoreAllMocks()
  globalThis.fetch = originalFetch
})

function buildSseResponse(events: string[], status = 200) {
  const encoder = new TextEncoder()
  const chunks = events.map((e) => encoder.encode(`${e}\n\n`))
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      },
    }),
    { status, headers: { 'content-type': 'text/event-stream' } },
  )
}

const baseArgs: ScoutosAtomsRequestArgs = {
  baseUrl: 'https://api.scoutos.com',
  apiKey: 'sk-test',
  instructions: 'Build a React component',
  context: {
    messages: [
      { id: '1', role: 'user', content: 'Hello' },
    ] satisfies ChatMessage[],
  },
  model: 'scoutos-model',
  tools: ['file_editor'],
}

const baseFollowUpArgs: ScoutosFollowUpArgs = {
  ...baseArgs,
  toolResults: [
    {
      id: 'tr-1',
      tool_name: 'file_editor',
      input_data: { path: 'src/main.tsx' },
      result: { ok: true },
    },
  ],
}

describe('scoutosAtomsRequest', () => {
  it('posts to /atoms with correct body and headers', async () => {
    const fetchMock = vi.fn(async () =>
      buildSseResponse([
        'event: message\ndata: {"atom_type":"text_delta","data":{"id":"a1","text":"Sure thing"}}',
        'event: message\ndata: {"atom_type":"final_answer","data":{"id":"a2","text":"Done"}}',
      ]),
    )
    globalThis.fetch = fetchMock as typeof fetch

    const result = await scoutosAtomsRequest(baseArgs)
    expect(result).not.toBeInstanceOf(Error)
    if (result instanceof Error) return
    expect(result.reply).toBe('Sure thing')
    expect(result.finalAnswer).toBe('Done')
    expect(result.toolIntents).toEqual([])

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.scoutos.com/atoms')
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({
      'content-type': 'application/json',
      authorization: 'Bearer sk-test',
    })

    const body = JSON.parse(String(init.body))
    expect(body).toMatchObject({
      atoms: expect.any(Object),
      instructions: 'Build a React component',
      context: { messages: [{ id: '1', role: 'user', content: 'Hello' }] },
      cache: { read: false, write: false },
      agent: { model: 'scoutos-model', tools: ['file_editor'] },
    })
  })

  it('collects text_delta and tool_intent atoms', async () => {
    const fetchMock = vi.fn(async () =>
      buildSseResponse([
        'event: message\ndata: {"atom_type":"text_delta","data":{"id":"t1","text":"Step 1: "}}',
        'event: message\ndata: {"atom_type":"text_delta","data":{"id":"t2","text":"open file"}}',
        'event: message\ndata: {"atom_type":"tool_intent","data":{"id":"i1","tool_name":"file_editor","input_data":{"path":"src/App.tsx"},"reason":"create component"}}',
        'event: message\ndata: {"atom_type":"final_answer","data":{"id":"f1","text":"All set!"}}',
      ]),
    )
    globalThis.fetch = fetchMock as typeof fetch

    const result = await scoutosAtomsRequest(baseArgs)
    expect(result).not.toBeInstanceOf(Error)
    if (result instanceof Error) return

    expect(result.reply).toBe('Step 1: open file')
    expect(result.toolIntents).toEqual([
      {
        id: 'i1',
        tool_name: 'file_editor',
        input_data: { path: 'src/App.tsx' },
        reason: 'create component',
      },
    ])
    expect(result.finalAnswer).toBe('All set!')
  })

  it('ignores non-message events and malformed lines', async () => {
    const fetchMock = vi.fn(async () =>
      buildSseResponse([
        'event: ping\ndata: {}',
        'event: message\ndata: not-json',
        'event: message\ndata: {"atom_type":"text_delta","data":{"id":"x","text":"hi"}}',
        'event: message\ndata:',
      ]),
    )
    globalThis.fetch = fetchMock as typeof fetch

    const result = await scoutosAtomsRequest(baseArgs)
    expect(result).not.toBeInstanceOf(Error)
    if (result instanceof Error) return
    expect(result.reply).toBe('hi')
  })

  it('handles multiple text_delta atoms concatenated', async () => {
    const fetchMock = vi.fn(async () =>
      buildSseResponse([
        'event: message\ndata: {"atom_type":"text_delta","data":{"id":"a","text":"H"}}',
        'event: message\ndata: {"atom_type":"text_delta","data":{"id":"b","text":"e"}}',
        'event: message\ndata: {"atom_type":"text_delta","data":{"id":"c","text":"llo"}}',
      ]),
    )
    globalThis.fetch = fetchMock as typeof fetch

    const result = await scoutosAtomsRequest(baseArgs)
    expect(result).not.toBeInstanceOf(Error)
    if (result instanceof Error) return
    expect(result.reply).toBe('Hello')
  })

  it('returns Error for 401 unauthorized', async () => {
    const fetchMock = vi.fn(async () => new Response('Unauthorized', { status: 401 }))
    globalThis.fetch = fetchMock as typeof fetch

    const result = await scoutosAtomsRequest(baseArgs)
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toContain('401')
  })

  it('returns Error for 500 server error', async () => {
    const fetchMock = vi.fn(async () => new Response('Internal Server Error', { status: 500 }))
    globalThis.fetch = fetchMock as typeof fetch

    const result = await scoutosAtomsRequest(baseArgs)
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toContain('500')
  })

  it('returns Error on network failure', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    globalThis.fetch = fetchMock as typeof fetch

    const result = await scoutosAtomsRequest(baseArgs)
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toContain('Network error')
  })

  it('trims trailing slash from baseUrl', async () => {
    const fetchMock = vi.fn(async () =>
      buildSseResponse([
        'event: message\ndata: {"atom_type":"final_answer","data":{"id":"z","text":"ok"}}',
      ]),
    )
    globalThis.fetch = fetchMock as typeof fetch

    await scoutosAtomsRequest({ ...baseArgs, baseUrl: 'https://api.scoutos.com/' })
    const [url] = fetchMock.mock.calls[0] as unknown as [string]
    expect(url).toBe('https://api.scoutos.com/atoms')
  })

  it('uses default empty tools array when not provided', async () => {
    const fetchMock = vi.fn(async () =>
      buildSseResponse([
        'event: message\ndata: {"atom_type":"final_answer","data":{"id":"z","text":"ok"}}',
      ]),
    )
    globalThis.fetch = fetchMock as typeof fetch

    const { tools: _tools, ...argsNoTools } = baseArgs
    await scoutosAtomsRequest(argsNoTools)

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(String(init.body))
    expect(body.agent.tools).toEqual([])
  })
})

describe('followUpWithToolResults', () => {
  it('posts tool_results in the body', async () => {
    const fetchMock = vi.fn(async () =>
      buildSseResponse([
        'event: message\ndata: {"atom_type":"text_delta","data":{"id":"r1","text":"Got it"}}',
        'event: message\ndata: {"atom_type":"final_answer","data":{"id":"r2","text":"Completed"}}',
      ]),
    )
    globalThis.fetch = fetchMock as typeof fetch

    const result = await followUpWithToolResults(baseFollowUpArgs)
    expect(result).not.toBeInstanceOf(Error)
    if (result instanceof Error) return
    expect(result.reply).toBe('Got it')
    expect(result.finalAnswer).toBe('Completed')

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(String(init.body))
    expect(body.tool_results).toEqual(baseFollowUpArgs.toolResults)
    expect(body.cache).toEqual({ read: false, write: false })
  })

  it('returns Error on 403 forbidden', async () => {
    const fetchMock = vi.fn(async () => new Response('Forbidden', { status: 403 }))
    globalThis.fetch = fetchMock as typeof fetch

    const result = await followUpWithToolResults(baseFollowUpArgs)
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toContain('403')
  })

  it('ignores tool_intent atoms during follow-up (not expected)', async () => {
    const fetchMock = vi.fn(async () =>
      buildSseResponse([
        'event: message\ndata: {"atom_type":"tool_intent","data":{"id":"i","tool_name":"x","input_data":{}}}',
        'event: message\ndata: {"atom_type":"text_delta","data":{"id":"t","text":"Final"}}',
      ]),
    )
    globalThis.fetch = fetchMock as typeof fetch

    const result = await followUpWithToolResults(baseFollowUpArgs)
    expect(result).not.toBeInstanceOf(Error)
    if (result instanceof Error) return
    expect(result.reply).toBe('Final')
    expect(result.finalAnswer).toBeUndefined()
  })
})
