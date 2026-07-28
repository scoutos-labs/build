import { dispatchSettingsLoaded, dispatchSettingsStatus } from './runtime_bridge.mjs'

export function loadSettings() {
  const settings = {
    provider: globalThis.localStorage?.getItem('agent-provider') ?? 'openrouter',
    apiKey: globalThis.localStorage?.getItem('openrouter-key') ?? '',
    ollamaUrl: globalThis.localStorage?.getItem('ollama-url') ?? 'http://localhost:11434',
    model: globalThis.localStorage?.getItem('agent-model') ?? '',
    // Without this the picker reset to the default on every reload, despite
    // persistJob having faithfully written the choice.
    job: globalThis.localStorage?.getItem('build.job') ?? '',
  }
  setTimeout(() => dispatchSettingsLoaded(settings), 0)
}

export function persistSettings(provider, apiKey, ollamaUrl, model) {
  globalThis.localStorage?.setItem('agent-provider', provider)
  globalThis.localStorage?.setItem('openrouter-key', String(apiKey).trim())
  globalThis.localStorage?.setItem('ollama-url', String(ollamaUrl).trim())
  globalThis.localStorage?.setItem('agent-model', String(model).trim())
  globalThis.localStorage?.removeItem('scoutos-key')
  globalThis.localStorage?.removeItem('scoutos-url')
}

export async function testOllamaConnection(url) {
  try {
    const baseUrl = String(url).trim().replace(/\/$/, '')
    const response = await fetch(`${baseUrl}/api/tags`)
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`)
    const data = await response.json()
    const names = data.models?.map(model => model.name).join(', ') || 'no models listed'
    dispatchSettingsStatus(`Ollama reachable. Models: ${names}`)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const origin = typeof location === 'undefined' ? 'http://localhost' : location.origin
    dispatchSettingsStatus(`Could not reach Ollama. If Ollama is running, this is likely CORS. Try: OLLAMA_ORIGINS=${origin} ollama serve. Details: ${detail}`)
  }
}
