pub type Provider {
  OpenRouter
  Ollama
}

pub type State {
  State(
    provider: Provider,
    api_key: String,
    ollama_url: String,
    model: String,
    settings_open: Bool,
    connection_status: String,
  )
}

pub type Msg {
  ProviderChanged(Provider)
  ApiKeyChanged(String)
  OllamaUrlChanged(String)
  ModelChanged(String)
  SettingsOpened
  SettingsToggled
  SettingsClosed
  ConnectionStatusChanged(String)
  SettingsLoaded(
    provider: String,
    api_key: String,
    ollama_url: String,
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
    model: String,
  )
  TestOllamaConnection(url: String)
}

pub fn init() -> State {
  State(
    provider: OpenRouter,
    api_key: "",
    ollama_url: "http://localhost:11434",
    model: "",
    settings_open: True,
    connection_status: "",
  )
}

pub fn provider_to_string(provider: Provider) -> String {
  case provider {
    OpenRouter -> "openrouter"
    Ollama -> "ollama"
  }
}

pub fn provider_from_string(value: String) -> Provider {
  case value {
    "ollama" -> Ollama
    _ -> OpenRouter
  }
}

pub fn persist_effect(state: State) -> Effect {
  PersistSettings(state.provider, state.api_key, state.ollama_url, state.model)
}

pub fn update(state: State, msg: Msg) -> #(State, List(Effect)) {
  case msg {
    ProviderChanged(provider) -> {
      let next_model = case state.model == "", provider {
        True, Ollama -> "glm-5:cloud"
        True, OpenRouter -> "anthropic/claude-3.5-sonnet"
        False, _ -> state.model
      }
      #(State(..state, provider: provider, model: next_model), [])
    }
    ApiKeyChanged(api_key) -> #(State(..state, api_key: api_key), [])
    OllamaUrlChanged(url) -> #(State(..state, ollama_url: url), [])
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
    SettingsLoaded(provider, api_key, ollama_url, model) -> #(
      State(
        ..state,
        provider: provider_from_string(provider),
        api_key: api_key,
        ollama_url: case ollama_url == "" {
          True -> "http://localhost:11434"
          False -> ollama_url
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
