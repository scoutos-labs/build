import type { AgentProvider } from '../agent'

export type SettingsState = {
  readonly provider: AgentProvider
  readonly apiKey: string
  readonly ollamaUrl: string
  readonly scoutosApiKey: string
  readonly scoutosBaseUrl: string
  readonly model: string
  readonly settingsOpen: boolean
  readonly connectionStatus: string
}

export type SettingsMsg =
  | { type: 'provider_changed'; provider: AgentProvider }
  | { type: 'api_key_changed'; apiKey: string }
  | { type: 'ollama_url_changed'; url: string }
  | { type: 'scoutos_url_changed'; url: string }
  | { type: 'scoutos_api_key_changed'; apiKey: string }
  | { type: 'model_changed'; model: string }
  | { type: 'settings_opened' }
  | { type: 'settings_toggled' }
  | { type: 'settings_closed' }
  | { type: 'connection_status_changed'; status: string }
  | { type: 'test_ollama' }

export type SettingsEffect =
  | { type: 'persist_settings'; provider: AgentProvider; apiKey: string; ollamaUrl: string; scoutosApiKey: string; scoutosBaseUrl: string; model: string }
  | { type: 'test_ollama_connection'; url: string }

export function init(storage: Pick<Storage, 'getItem'> | null = typeof localStorage === 'undefined' ? null : localStorage): SettingsState {
  return {
    provider: (storage?.getItem('agent-provider') as AgentProvider | null) ?? 'openrouter',
    apiKey: storage?.getItem('openrouter-key') ?? '',
    ollamaUrl: storage?.getItem('ollama-url') ?? 'http://localhost:11434',
    scoutosApiKey: storage?.getItem('scoutos-key') ?? '',
    scoutosBaseUrl: storage?.getItem('scoutos-url') ?? 'https://api.scoutos.com',
    model: storage?.getItem('agent-model') ?? '',
    settingsOpen: !storage?.getItem('agent-model'),
    connectionStatus: '',
  }
}

export function persistEffect(state: SettingsState): SettingsEffect {
  return { type: 'persist_settings', provider: state.provider, apiKey: state.apiKey, ollamaUrl: state.ollamaUrl, scoutosApiKey: state.scoutosApiKey, scoutosBaseUrl: state.scoutosBaseUrl, model: state.model }
}

export function update(state: SettingsState, msg: SettingsMsg): [SettingsState, SettingsEffect[]] {
  switch (msg.type) {
    case 'provider_changed': {
      const nextModel = state.model.trim()
        ? state.model
        : msg.provider === 'ollama'
          ? 'glm-5:cloud'
          : msg.provider === 'scoutos'
            ? ''
            : 'anthropic/claude-3.5-sonnet'
      return [{ ...state, provider: msg.provider, model: nextModel }, []]
    }
    case 'api_key_changed':
      return [{ ...state, apiKey: msg.apiKey }, []]
    case 'ollama_url_changed':
      return [{ ...state, ollamaUrl: msg.url }, []]
    case 'scoutos_url_changed':
      return [{ ...state, scoutosBaseUrl: msg.url }, []]
    case 'scoutos_api_key_changed':
      return [{ ...state, scoutosApiKey: msg.apiKey }, []]
    case 'model_changed':
      return [{ ...state, model: msg.model }, []]
    case 'settings_opened':
      return [{ ...state, settingsOpen: true }, []]
    case 'settings_toggled':
      return [{ ...state, settingsOpen: !state.settingsOpen }, []]
    case 'settings_closed':
      return [{ ...state, settingsOpen: false }, []]
    case 'connection_status_changed':
      return [{ ...state, connectionStatus: msg.status }, []]
    case 'test_ollama':
      return [{ ...state, connectionStatus: 'Testing Ollama...' }, [{ type: 'test_ollama_connection', url: state.ollamaUrl }]]
    default: {
      const _exhaustive: never = msg
      return [state, []]
    }
  }
}
