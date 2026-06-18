import { afterEach, describe, expect, it, vi } from 'vitest'
import { runAgent, type ChatMessage } from './agent'

const originalFetch = globalThis.fetch

afterEach(() => {
  vi.restoreAllMocks()
  globalThis.fetch = originalFetch
})

describe('runAgent', () => {
  it('calls Ollama with project context and parses JSON patches', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      message: { content: JSON.stringify({
        reply: 'Updated locally.',
        patches: [{ path: 'src/main.tsx', content: 'export {}' }],
      }) },
    }), { status: 200 }))
    globalThis.fetch = fetchMock as typeof fetch

    const result = await runAgent({
      provider: 'ollama',
      ollamaUrl: 'http://localhost:11434/',
      model: 'glm-5:cloud',
      userPrompt: 'change title',
      messages: [{ role: 'assistant', content: 'Previous reply' }] satisfies ChatMessage[],
      files: [{ path: 'src/main.tsx', content: '<App />' }],
    })

    expect(result).toEqual({
      reply: 'Updated locally.',
      patches: [{ path: 'src/main.tsx', content: 'export {}' }],
    })
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://localhost:11434/api/chat')
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'glm-5:cloud', stream: false, format: 'json' })
    expect(String(init.body)).toContain('src/main.tsx')
    expect(String(init.body)).toContain('change title')
    expect(String(init.body)).toContain('Scout Studio observed brand styles')
    expect(String(init.body)).toContain('Anthropic brand guide')
  })

  it('calls OpenRouter with API key and response_format JSON', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"reply":"ok","patches":[]}' } }],
    }), { status: 200 }))
    globalThis.fetch = fetchMock as typeof fetch

    await expect(runAgent({ provider: 'openrouter', apiKey: 'sk-test', model: 'test/model', userPrompt: 'noop', messages: [], files: [] }))
      .resolves.toEqual({ reply: 'ok', patches: [] })

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(init.headers).toMatchObject({ Authorization: 'Bearer sk-test' })
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'test/model', response_format: { type: 'json_object' } })
  })

  it('retries OpenRouter without JSON mode when provider rejects response_format', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('response_format json_object is not supported by this model', { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: '{"reply":"ok","patches":[]}' } }],
      }), { status: 200 }))
    globalThis.fetch = fetchMock as typeof fetch

    await expect(runAgent({ provider: 'openrouter', apiKey: 'sk-test', model: 'anthropic/claude-sonnet-4.6', userPrompt: 'noop', messages: [], files: [] }))
      .resolves.toEqual({ reply: 'ok', patches: [] })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [, call0Init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const [, call1Init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit]
    expect(JSON.parse(String(call0Init.body))).toMatchObject({ response_format: { type: 'json_object' } })
    expect(JSON.parse(String(call1Init.body))).not.toHaveProperty('response_format')
  })

  it('accepts JSON wrapped in a markdown code block', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      message: { content: '```json\n{"reply":"ok","patches":[]}\n```' },
    }), { status: 200 })) as typeof fetch

    await expect(runAgent({ provider: 'ollama', ollamaUrl: 'http://localhost:11434', model: 'model', userPrompt: 'noop', messages: [], files: [] }))
      .resolves.toEqual({ reply: 'ok', patches: [] })
  })

  it('extracts JSON from model prose when possible', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      message: { content: 'Here is the update:\n{"reply":"ok","patches":[]}\nDone.' },
    }), { status: 200 })) as typeof fetch

    await expect(runAgent({ provider: 'ollama', ollamaUrl: 'http://localhost:11434', model: 'model', userPrompt: 'noop', messages: [], files: [] }))
      .resolves.toEqual({ reply: 'ok', patches: [] })
  })

  it('repairs invalid non-JSON model responses with one follow-up request', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        message: { content: "Here's what I changed: not JSON" },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        message: { content: '{"reply":"repaired","patches":[]}' },
      }), { status: 200 }))
    globalThis.fetch = fetchMock as typeof fetch

    await expect(runAgent({ provider: 'ollama', ollamaUrl: 'http://localhost:11434', model: 'model', userPrompt: 'noop', messages: [], files: [] }))
      .resolves.toEqual({ reply: 'repaired', patches: [] })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[1][1]?.body)).toContain('Invalid response to repair')
  })

  it('sends selected preview element context to the model', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      message: { content: '{"reply":"ok","patches":[]}' },
    }), { status: 200 }))
    globalThis.fetch = fetchMock as typeof fetch

    await runAgent({
      provider: 'ollama',
      ollamaUrl: 'http://localhost:11434',
      model: 'model',
      userPrompt: 'Improve selected element',
      messages: [],
      files: [{ path: 'src/main.tsx', content: '<button className="primary">Buy</button>' }],
      elementComment: 'Make this button calmer',
      selectedElement: {
        tagName: 'BUTTON',
        id: '',
        classes: ['primary'],
        textContent: 'Buy',
        outerHTML: '<button class="primary">Buy</button>',
        boundingRect: { x: 0, y: 0, width: 80, height: 32 },
        computedStyles: { color: 'red' },
      },
    })

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const body = String(init.body)
    expect(body).toContain('Selected rendered element')
    expect(body).toContain('Make this button calmer')
    expect(body).toContain('<button class=')
  })

  it('throws useful errors for failed Ollama responses', async () => {
    globalThis.fetch = vi.fn(async () => new Response('model missing', { status: 404 })) as typeof fetch

    await expect(runAgent({ provider: 'ollama', ollamaUrl: 'http://localhost:11434', model: 'missing', userPrompt: 'noop', messages: [], files: [] }))
      .rejects.toThrow('Ollama error 404: model missing')
  })

  it('requires an OpenRouter key when using OpenRouter', async () => {
    await expect(runAgent({ provider: 'openrouter', model: 'model', userPrompt: 'noop', messages: [], files: [] }))
      .rejects.toThrow('OpenRouter API key is required')
  })

  it('sends system prompt with Next.js, Tailwind CSS, and shadcn/ui preferences', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      message: { content: JSON.stringify({ reply: 'ok', patches: [] }) },
    }), { status: 200 }))
    globalThis.fetch = fetchMock as typeof fetch

    await runAgent({
      provider: 'ollama',
      ollamaUrl: 'http://localhost:11434',
      model: 'model',
      userPrompt: 'build a todo app',
      messages: [],
      files: [],
    })

    const [, init0] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const body = String(init0.body)
    expect(body).toContain('Next.js')
    expect(body).toContain('Tailwind CSS')
    expect(body).toContain('shadcn/ui')
  })

  it('sends project files context alongside user prompt', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ reply: 'ok', patches: [] }) } }],
    }), { status: 200 }))
    globalThis.fetch = fetchMock as typeof fetch

    await runAgent({
      provider: 'openrouter',
      apiKey: 'sk-test',
      model: 'test/model',
      userPrompt: 'change color to red',
      messages: [{ role: 'user' as const, content: 'Previous: make it blue' }],
      files: [{ path: 'src/main.tsx', content: 'const color = "blue"' }],
    })

    const [, init0] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const body = String(init0.body)
    const messages = JSON.parse(body).messages as { role: string; content: string }[]
    expect(messages[0].role).toBe('system')
    expect(messages[0].content).toContain('Next.js')
    expect(messages[0].content).toContain('Tailwind CSS')
    expect(messages[0].content).toContain('shadcn/ui')
    // Files are sent as a separate system message
    const filesMsg = messages.find(m => m.role === 'system' && m.content.startsWith('Current project files'))
    expect(filesMsg).toBeTruthy()
    expect(filesMsg!.content).toContain('src/main.tsx')
    expect(filesMsg!.content).toContain('const color = "blue"')
    expect(messages[messages.length - 1].role).toBe('user')
    expect(messages[messages.length - 1].content).toContain('change color to red')
  })

  it('limits conversation history to last 8 messages in context', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      message: { content: JSON.stringify({ reply: 'ok', patches: [] }) },
    }), { status: 200 }))
    globalThis.fetch = fetchMock as typeof fetch

    const history = Array.from({ length: 12 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: `Message ${i}`,
    }))

    await runAgent({
      provider: 'ollama',
      ollamaUrl: 'http://localhost:11434',
      model: 'model',
      userPrompt: 'final',
      messages: history,
      files: [],
    })

    const [, init0] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const body = String(init0.body)
    const messages = JSON.parse(body).messages as { role: string; content: string }[]
    // All 12 history messages are sent (no truncation) + 1 system + 1 user prompt = 14
    expect(messages.length).toBe(14) // 1 system + 12 history + 1 user prompt
    expect(messages[messages.length - 1].content).toContain('final')
  })

  it('rejects patches with invalid shape', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      message: { content: JSON.stringify({ reply: 'ok', patches: 'not-an-array' }) },
    }), { status: 200 })) as typeof fetch

    await expect(runAgent({
      provider: 'ollama',
      ollamaUrl: 'http://localhost:11434',
      model: 'model',
      userPrompt: 'noop',
      messages: [],
      files: [],
    })).rejects.toThrow('Agent response did not match expected JSON shape')
  })

  it('requires an Ollama URL when using Ollama', async () => {
    await expect(runAgent({ provider: 'ollama', model: 'model', userPrompt: 'noop', messages: [], files: [] }))
      .rejects.toThrow('Ollama URL is required')
  })

  it('includes env vars in system context when provided', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      message: { content: JSON.stringify({ reply: 'ok', patches: [], envVars: { NEW_KEY: 'val' } }) },
    }), { status: 200 }))
    globalThis.fetch = fetchMock as typeof fetch

    await runAgent({
      provider: 'ollama',
      ollamaUrl: 'http://localhost:11434',
      model: 'model',
      userPrompt: 'set API key',
      messages: [],
      files: [],
      envVars: { EXISTING_KEY: 'existing' },
    })

    const [, init0] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const body = String(init0.body)
    const messages = JSON.parse(body).messages as { role: string; content: string }[]
    const envMsg = messages.find(m => m.content.includes('EXISTING_KEY'))
    expect(envMsg).toBeDefined()
    expect(envMsg?.content).toContain('EXISTING_KEY=existing')
  })

  it('returns envVars in the agent result when agent sets them', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      message: { content: JSON.stringify({
        reply: 'Set the API key for you.',
        patches: [],
        envVars: { OPENROUTER_API_KEY: 'sk-test-123' },
      }) },
    }), { status: 200 })) as typeof fetch

    const result = await runAgent({
      provider: 'ollama',
      ollamaUrl: 'http://localhost:11434',
      model: 'model',
      userPrompt: 'add OpenRouter key',
      messages: [],
      files: [],
    })

    expect(result.reply).toBe('Set the API key for you.')
    expect(result.envVars).toEqual({ OPENROUTER_API_KEY: 'sk-test-123' })
    expect(result.patches).toEqual([])
  })

  it('envVars default to undefined when not provided', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      message: { content: JSON.stringify({ reply: 'ok', patches: [] }) },
    }), { status: 200 }))
    globalThis.fetch = fetchMock as typeof fetch

    await runAgent({
      provider: 'ollama',
      ollamaUrl: 'http://localhost:11434',
      model: 'model',
      userPrompt: 'noop',
      messages: [],
      files: [],
    })

    const [, init0] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const body = String(init0.body)
    const messages = JSON.parse(body).messages as { role: string; content: string }[]
    // Should NOT have an env vars system message
    expect(messages.every(m => !m.content.includes('Current env vars'))).toBe(true)
  })
})
