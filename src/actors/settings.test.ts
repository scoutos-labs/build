import { describe, expect, it } from 'vitest'
import { init, persistEffect, update, type SettingsState } from './settings'

function storage(values: Record<string, string | null>) {
  return { getItem: (key: string) => values[key] ?? null }
}

describe('settings actor', () => {
  it('initializes from localStorage-compatible storage', () => {
    expect(init(storage({}))).toMatchObject({ provider: 'openrouter', apiKey: '', ollamaUrl: 'http://localhost:11434', model: '', settingsOpen: true })
    expect(init(storage({ 'agent-provider': 'ollama', 'openrouter-key': 'k', 'ollama-url': 'u', 'agent-model': 'm' }))).toMatchObject({ provider: 'ollama', apiKey: 'k', ollamaUrl: 'u', model: 'm', settingsOpen: false })
  })

  it('changes provider and fills a default model only when blank', () => {
    const base: SettingsState = init(storage({}))
    expect(update(base, { type: 'provider_changed', provider: 'ollama' })[0].model).toBe('glm-5:cloud')
    expect(update({ ...base, model: 'custom' }, { type: 'provider_changed', provider: 'ollama' })[0].model).toBe('custom')
  })

  it('creates an explicit persist effect and test ollama effect', () => {
    const state = { ...init(storage({})), provider: 'ollama' as const, apiKey: ' key ', ollamaUrl: ' http://x/ ', model: ' m ' }
    expect(persistEffect(state)).toEqual({ type: 'persist_settings', provider: 'ollama', apiKey: ' key ', ollamaUrl: ' http://x/ ', model: ' m ' })
    const [next, effects] = update(state, { type: 'test_ollama' })
    expect(next.connectionStatus).toBe('Testing Ollama...')
    expect(effects).toEqual([{ type: 'test_ollama_connection', url: ' http://x/ ' }])
  })
})
