pub type Provider {
  OpenRouter
  Ollama
  ScoutOS
}

pub type State {
  State(
    provider: Provider,
    api_key: String,
    ollama_url: String,
    scoutos_api_key: String,
    scoutos_base_url: String,
    model: String,
    settings_open: Bool,
    connection_status: String,
  )
}

pub type Msg {
  ProviderChanged(Provider)
  ApiKeyChanged(String)
  OllamaUrlChanged(String)
  ScoutOSApiKeyChanged(String)
  ScoutOSBaseUrlChanged(String)
  ModelChanged(String)
  SettingsOpened
  SettingsToggled
  SettingsClosed
  ConnectionStatusChanged(String)
  SettingsLoaded(
    provider: String,
    api_key: String,
    ollama_url: String,
    scoutos_api_key: String,
    scoutos_base_url: String,
    model: String,
  )
  TestOllama
}

pub type Effect {
  LoadSettings
  PersistSettings(
    provider: Provider,
    api_key: String,
    ollama_url: String,
    scoutos_api_key: String,
    scoutos_base_url: String,
    model: String,
  )
  TestOllamaConnection(url: String)
}

pub fn init() -> State {
  State(
    provider: OpenRouter,
    api_key: "",
    ollama_url: "http://localhost:11434",
    scoutos_api_key: "",
    scoutos_base_url: "https://api.scoutos.com",
    model: "",
    settings_open: True,
    connection_status: "",
  )
}

pub fn provider_to_string(provider: Provider) -> String {
  case provider {
    OpenRouter -> "openrouter"
    Ollama -> "ollama"
    ScoutOS -> "scoutos"
  }
}

pub fn provider_from_string(value: String) -> Provider {
  case value {
    "ollama" -> Ollama
    "scoutos" -> ScoutOS
    _ -> OpenRouter
  }
}

pub fn persist_effect(state: State) -> Effect {
  PersistSettings(
    state.provider,
    state.api_key,
    state.ollama_url,
    state.scoutos_api_key,
    state.scoutos_base_url,
    state.model,
  )
}

pub fn update(state: State, msg: Msg) -> #(State, List(Effect)) {
  case msg {
    ProviderChanged(provider) -> {
      let next_model = case state.model == "", provider {
        True, Ollama -> "glm-5:cloud"
        True, OpenRouter -> "anthropic/claude-3.5-sonnet"
        True, ScoutOS -> ""
        False, _ -> state.model
      }
      #(State(..state, provider: provider, model: next_model), [])
    }
    ApiKeyChanged(api_key) -> #(State(..state, api_key: api_key), [])
    OllamaUrlChanged(url) -> #(State(..state, ollama_url: url), [])
    ScoutOSApiKeyChanged(api_key) ->
      #(State(..state, scoutos_api_key: api_key), [])
    ScoutOSBaseUrlChanged(url) ->
      #(State(..state, scoutos_base_url: url), [])
    ModelChanged(model) -> #(State(..state, model: model), [])
    SettingsOpened -> #(State(..state, settings_open: True), [])
    SettingsToggled -> #(
      State(..state, settings_open: !state.settings_open),
      [],
    )
    SettingsClosed -> #(State(..state, settings_open: False), [])
    ConnectionStatusChanged(status) -> #(
      State(..state, connection_status: status),
      [],
    )
    SettingsLoaded(provider, api_key, ollama_url, scoutos_api_key, scoutos_base_url, model) -> #(
      State(
        ..state,
        provider: provider_from_string(provider),
        api_key: api_key,
        ollama_url: case ollama_url == "" {
          True -> "http://localhost:11434"
          False -> ollama_url
        },
        scoutos_api_key: scoutos_api_key,
        scoutos_base_url: case scoutos_base_url == "" {
          True -> "https://api.scoutos.com"
          False -> scoutos_base_url
        },
        model: model,
        settings_open: model == "",
      ),
      [],
    )
    TestOllama -> #(State(..state, connection_status: "Testing Ollama..."), [
      TestOllamaConnection(state.ollama_url),
    ])
  }
}
