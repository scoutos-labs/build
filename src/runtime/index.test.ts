import { describe, expect, it, vi } from 'vitest'
import { appInit, type AppEffect, type AppMsg } from '../store'
import { runAgent } from '../agent'
import { interpretEffect } from './index'

vi.mock('../agent', async importOriginal => ({
  ...await importOriginal<typeof import('../agent')>(),
  runAgent: vi.fn(),
}))

function recorder() {
  const messages: AppMsg[] = []
  return { messages, dispatch: (msg: AppMsg) => { messages.push(msg) }, getState: () => appInit() }
}

describe('effect runtime', () => {
  it('persists settings with trimmed fields', async () => {
    const setItem = vi.fn()
    const effect: AppEffect = { domain: 'settings', payload: { type: 'persist_settings', provider: 'ollama', apiKey: ' key ', ollamaUrl: ' http://x/ ', model: ' m ' } }
    const r = recorder()
    await interpretEffect(effect, r.dispatch, r.getState, { storage: { setItem } })
    expect(setItem.mock.calls).toEqual([
      ['agent-provider', 'ollama'],
      ['openrouter-key', 'key'],
      ['ollama-url', 'http://x/'],
      ['agent-model', 'm'],
    ])
  })

  it('tests ollama with trailing slash trimmed and dispatches model names', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ models: [{ name: 'llama' }, { name: 'qwen' }] }) })) as unknown as typeof fetch
    const r = recorder()
    await interpretEffect({ domain: 'settings', payload: { type: 'test_ollama_connection', url: 'http://localhost:11434/' } }, r.dispatch, r.getState, { fetch: fetchMock, locationOrigin: 'http://app' })
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:11434/api/tags')
    expect(r.messages).toEqual([{ type: 'settings', msg: { type: 'connection_status_changed', status: 'Ollama reachable. Models: llama, qwen' } }])
  })

  it('reports ollama CORS troubleshooting on failure', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('failed') }) as unknown as typeof fetch
    const r = recorder()
    await interpretEffect({ domain: 'settings', payload: { type: 'test_ollama_connection', url: 'http://bad' } }, r.dispatch, r.getState, { fetch: fetchMock, locationOrigin: 'http://app' })
    expect(r.messages[0]).toEqual({ type: 'settings', msg: { type: 'connection_status_changed', status: 'Could not reach Ollama. If Ollama is running, this is likely CORS. Try: OLLAMA_ORIGINS=http://app ollama serve. Details: failed' } })
  })

  it('posts inspector messages through injected preview window', async () => {
    const postMessage = vi.fn()
    const r = recorder()
    await interpretEffect({ domain: 'preview', payload: { type: 'post_inspector_message', message: 'BUILD_INSPECTOR_ENABLE' } }, r.dispatch, r.getState, { previewWindow: () => ({ postMessage }) as unknown as Window })
    expect(postMessage).toHaveBeenCalledWith({ type: 'BUILD_INSPECTOR_ENABLE' }, '*')
  })

  it('old agent finally does not clear a newer active controller', async () => {
    type Pending = { signal: AbortSignal; reject: (error: unknown) => void }
    const pending: Pending[] = []
    vi.mocked(runAgent).mockImplementation(args => new Promise((_, reject) => {
      pending.push({ signal: args.signal!, reject })
    }))
    const r = recorder()
    const call = (requestId: string): AppEffect => ({ domain: 'agent', payload: { type: 'call_agent', requestId, provider: 'openrouter', apiKey: 'k', ollamaUrl: 'u', model: 'm', userPrompt: 'p', files: [], messages: [] } })

    const first = interpretEffect(call('a'), r.dispatch, r.getState, { locationOrigin: 'http://app' })
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    await interpretEffect({ domain: 'agent', payload: { type: 'abort_agent' } }, r.dispatch, r.getState)
    expect(pending[0].signal.aborted).toBe(true)

    const second = interpretEffect(call('b'), r.dispatch, r.getState, { locationOrigin: 'http://app' })
    await vi.waitFor(() => expect(pending).toHaveLength(2))
    pending[0].reject(new DOMException('Aborted', 'AbortError'))
    await first

    await interpretEffect({ domain: 'agent', payload: { type: 'abort_agent' } }, r.dispatch, r.getState)
    expect(pending[1].signal.aborted).toBe(true)
    pending[1].reject(new DOMException('Aborted', 'AbortError'))
    await second
  })
})
