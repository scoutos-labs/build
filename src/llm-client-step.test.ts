/**
 * Client-side transport tests for the tool-calling step (BYOK-OpenRouter).
 *
 * Mirrors server/src/openrouter-tools.test.ts. The important case is
 * `content: null` + `tool_calls: [...]` — a pure tool-call response, which the
 * pre-existing `call()` path treats as a hard error.
 */
import { describe, expect, it, vi } from 'vitest'
import { FetchLLMClient, normalizeToolCalls } from './llm-client'
import type { LLMStepParams, ToolCall, ToolSpec } from './llm-port'

const TOOLS: ToolSpec[] = [
  {
    type: 'function',
    function: { name: 'fs_read', description: 'read a file', parameters: { type: 'object' } },
  },
]

function toolCall(id: string, name = 'fs_read', args = '{"path":"a.ts"}'): ToolCall {
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

const baseParams: LLMStepParams = {
  provider: 'openrouter',
  model: 'a/model',
  messages: [{ role: 'user', content: 'hi' }],
  tools: TOOLS,
  maxCalls: 3,
  apiKey: 'sk-or-user',
}

function initOf(fetchMock: ReturnType<typeof vi.fn>): RequestInit {
  return fetchMock.mock.calls[0]?.[1] as RequestInit
}

function sentBody(fetchMock: ReturnType<typeof vi.fn>) {
  return JSON.parse(initOf(fetchMock).body as string)
}

describe('normalizeToolCalls', () => {
  it('drops calls with no id or no name', () => {
    const calls = normalizeToolCalls(
      [toolCall('c1'), { function: { name: 'x' } }, { id: 'c2', function: {} }],
      5,
    )
    expect(calls.map(c => c.id)).toEqual(['c1'])
  })

  it('caps at maxCalls', () => {
    const calls = normalizeToolCalls([toolCall('a'), toolCall('b'), toolCall('c')], 2)
    expect(calls.map(c => c.id)).toEqual(['a', 'b'])
  })

  it('coerces non-string arguments to an empty object literal', () => {
    const [only] = normalizeToolCalls([{ id: 'c1', function: { name: 'x', arguments: { a: 1 } } }], 5)
    expect(only!.function.arguments).toBe('{}')
  })

  it('returns [] for a non-array', () => {
    expect(normalizeToolCalls(null, 3)).toEqual([])
  })
})

describe('FetchLLMClient.step', () => {
  it('accepts content: null with tool calls', async () => {
    const fetchMock = vi.fn(async () =>
      response({ choices: [{ message: { content: null, tool_calls: [toolCall('c1')] } }] }),
    )
    const result = await new FetchLLMClient(fetchMock as unknown as typeof fetch).step(baseParams)
    expect(result.content).toBe('')
    expect(result.toolCalls.map(c => c.id)).toEqual(['c1'])
  })

  it('returns content and calls together', async () => {
    const fetchMock = vi.fn(async () =>
      response({ choices: [{ message: { content: 'Reading.', tool_calls: [toolCall('c1')] } }] }),
    )
    const result = await new FetchLLMClient(fetchMock as unknown as typeof fetch).step(baseParams)
    expect(result.content).toBe('Reading.')
    expect(result.toolCalls).toHaveLength(1)
  })

  it('accepts a final answer with no tool calls', async () => {
    const fetchMock = vi.fn(async () => response({ choices: [{ message: { content: 'Done.' } }] }))
    const result = await new FetchLLMClient(fetchMock as unknown as typeof fetch).step(baseParams)
    expect(result).toEqual({ content: 'Done.', toolCalls: [] })
  })

  it('throws only when there is neither content nor a usable call', async () => {
    const fetchMock = vi.fn(async () => response({ choices: [{ message: { content: null } }] }))
    await expect(
      new FetchLLMClient(fetchMock as unknown as typeof fetch).step(baseParams),
    ).rejects.toThrow(/no content and no tool calls/)
  })

  it('never sends response_format alongside tools', async () => {
    const fetchMock = vi.fn(async () => response({ choices: [{ message: { content: 'ok' } }] }))
    await new FetchLLMClient(fetchMock as unknown as typeof fetch).step(baseParams)
    const body = sentBody(fetchMock)
    expect(body.response_format).toBeUndefined()
    expect(body.tools).toEqual(TOOLS)
    expect(body.tool_choice).toBe('auto')
  })

  it('sends tool-role messages through unchanged, with their tool_call_id', async () => {
    // Providers reject a tool_calls array with no matching tool message, so the
    // transport must not drop or reshape either half of the pair.
    const fetchMock = vi.fn(async () => response({ choices: [{ message: { content: 'ok' } }] }))
    await new FetchLLMClient(fetchMock as unknown as typeof fetch).step({
      ...baseParams,
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '', tool_calls: [toolCall('c1')] },
        { role: 'tool', content: 'ok · 12 bytes', tool_call_id: 'c1' },
      ],
    })
    const body = sentBody(fetchMock)
    expect(body.messages[1].tool_calls[0].id).toBe('c1')
    expect(body.messages[2]).toEqual({
      role: 'tool',
      content: 'ok · 12 bytes',
      tool_call_id: 'c1',
    })
  })

  it('requires an API key', async () => {
    const fetchMock = vi.fn(async () => response({}))
    await expect(
      new FetchLLMClient(fetchMock as unknown as typeof fetch).step({ ...baseParams, apiKey: '' }),
    ).rejects.toThrow(/API key is required/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('surfaces a non-ok status with its body', async () => {
    const fetchMock = vi.fn(async () => response({ e: 'nope' }, { ok: false, status: 429 }))
    await expect(
      new FetchLLMClient(fetchMock as unknown as typeof fetch).step(baseParams),
    ).rejects.toThrow(/429/)
  })

  it('honors maxCalls', async () => {
    const fetchMock = vi.fn(async () =>
      response({
        choices: [{ message: { content: null, tool_calls: [toolCall('a'), toolCall('b'), toolCall('c')] } }],
      }),
    )
    const result = await new FetchLLMClient(fetchMock as unknown as typeof fetch).step({
      ...baseParams,
      maxCalls: 1,
    })
    expect(result.toolCalls.map(c => c.id)).toEqual(['a'])
  })

  it('passes the abort signal through', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn(async () => response({ choices: [{ message: { content: 'ok' } }] }))
    await new FetchLLMClient(fetchMock as unknown as typeof fetch).step({
      ...baseParams,
      signal: controller.signal,
    })
    expect(initOf(fetchMock).signal).toBe(controller.signal)
  })
})

describe('Ollama is excluded from tool mode', () => {
  it('has no tool-capable provider option in the step params type', () => {
    // Compile-time guard: LLMStepParams.provider is the literal 'openrouter'.
    // Ollama forces format:'json' (conflicting with tools), returns
    // tool_calls arguments as an object rather than a JSON string, and exposes
    // no capability metadata — so it stays on the JSON protocol.
    // @ts-expect-error 'ollama' is not assignable to provider: 'openrouter'
    const bad: LLMStepParams = { ...baseParams, provider: 'ollama' }
    expect(bad.provider).toBe('ollama')
  })

  it('the JSON call() path still forces format:json for ollama', async () => {
    const fetchMock = vi.fn(async () =>
      response({ message: { content: '{"reply":"hi","patches":[]}' } }),
    )
    await new FetchLLMClient(fetchMock as unknown as typeof fetch).call({
      provider: 'ollama',
      model: 'llama',
      messages: [{ role: 'user', content: 'hi' }],
      ollamaUrl: 'http://localhost:11434',
    })
    const body = sentBody(fetchMock)
    expect(body.format).toBe('json')
    expect(body.tools).toBeUndefined()
  })
})

describe('the BYOK tool-mode prompt', () => {
  it('never mentions a tool BYOK will not be offered', async () => {
    const { buildToolModePrompt } = await import('./agent')
    const prompt = buildToolModePrompt()
    for (const web of ['web_search', 'web_fetch', 'web_post']) {
      expect(prompt).not.toContain(web)
    }
  })

  it('still instructs the model to verify with exec', async () => {
    const { buildToolModePrompt } = await import('./agent')
    expect(buildToolModePrompt()).toContain('tsc --noEmit')
  })

  it('ships a file tree, not file contents', async () => {
    const { buildToolModeMessages } = await import('./agent')
    const messages = buildToolModeMessages({
      files: [
        { path: 'src/App.tsx', content: 'x'.repeat(5000) },
        { path: 'package.json', content: '{"name":"app"}' },
      ],
      messages: [],
      userPrompt: 'add a button',
    })
    const joined = messages.map(m => m.content).join('\n')
    expect(joined).toContain('src/App.tsx (5000 bytes)')
    // The big file's CONTENT must not travel — that is what makes multi-step
    // turns affordable.
    expect(joined).not.toContain('x'.repeat(5000))
    // package.json is in the always-full set, so it does.
    expect(joined).toContain('{"name":"app"}')
  })

  it('pairs echoed tool calls with their results', async () => {
    const { buildToolModeMessages } = await import('./agent')
    const messages = buildToolModeMessages({
      files: [],
      messages: [],
      toolCalls: [toolCall('c1')],
      toolResults: [{ toolCallId: 'c1', content: 'ok · 12 bytes' }],
    })
    const assistant = messages.find(m => m.role === 'assistant')
    const tool = messages.find(m => m.role === 'tool')
    expect(assistant?.tool_calls?.[0]?.id).toBe('c1')
    expect(tool?.tool_call_id).toBe('c1')
    expect(messages.indexOf(assistant!)).toBeLessThan(messages.indexOf(tool!))
  })
})

describe('the transcript window', () => {
  it('carries every call and result, not just the last step', async () => {
    // A one-step-wide window leaves the model with no memory of what it already
    // did, so it re-decides from the file tree every step and burns the whole
    // budget rediscovering the same thing — measured at 12 steps for work that
    // takes 2.
    const { buildToolModeMessages } = await import('./agent')
    const messages = buildToolModeMessages({
      files: [],
      messages: [],
      toolCalls: [toolCall('c1', 'fs_list', '{}'), toolCall('c2', 'fs_write', '{}')],
      toolResults: [
        { toolCallId: 'c1', content: 'listed 12 files' },
        { toolCallId: 'c2', content: 'ok · 40 bytes' },
      ],
    })
    const assistant = messages.find(m => m.role === 'assistant')
    const announced = new Set((assistant?.tool_calls ?? []).map(c => c.id))
    expect([...announced].sort()).toEqual(['c1', 'c2'])
    // Every result still references a call the model can see it made.
    const toolMessages = messages.filter(m => m.role === 'tool')
    expect(toolMessages).toHaveLength(2)
    for (const message of toolMessages) {
      expect(announced.has(message.tool_call_id!)).toBe(true)
    }
  })
})

describe('the user request survives the whole turn', () => {
  it('buildToolModeMessages includes the prompt whenever it is given', async () => {
    const { buildToolModeMessages } = await import('./agent')
    const messages = buildToolModeMessages({
      files: [],
      messages: [],
      userPrompt: 'add a footer',
      toolCalls: [toolCall('c1')],
      toolResults: [{ toolCallId: 'c1', content: 'file body' }],
    })
    const user = messages.filter(m => m.role === 'user').map(m => m.content)
    expect(user).toContain('add a footer')
  })

  it('the loop never conditions the prompt on the step index', async () => {
    // Source-level guard, because this lives in the externals layer that unit
    // tests do not execute. Sending userPrompt only on step 0 left the model
    // with tool results and no request from step 1 onward: it read files, found
    // nothing to act on, and answered "looks like you sent a blank message".
    // Three stubbed smokes and 500+ tests missed it; one live run found it.
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const source = readFileSync(resolve(__dirname, 'gleam-externals/agent.mjs'), 'utf-8')
    expect(source).not.toMatch(/userPrompt:\s*stepIndex\s*===\s*0/) // guard
    // Both transports must pass it unconditionally.
    const unconditional = source.match(/userPrompt:\s*turn\.userPrompt/g) ?? []
    expect(unconditional.length).toBeGreaterThanOrEqual(2)
  })
})
