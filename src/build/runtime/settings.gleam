import build/actors/settings

pub fn interpret(effect: settings.Effect) -> Nil {
  case effect {
    settings.LoadSettings -> load_settings()
    settings.PersistSettings(provider, api_key, ollama_url, model) ->
      persist_settings(
        settings.provider_to_string(provider),
        api_key,
        ollama_url,
        model,
      )
    settings.TestOllamaConnection(url) -> test_ollama_connection(url)
  }
}

@external(javascript, "../../gleam-externals/local_storage.mjs", "loadSettings")
fn load_settings() -> Nil

@external(javascript, "../../gleam-externals/local_storage.mjs", "persistSettings")
fn persist_settings(
  provider: String,
  api_key: String,
  ollama_url: String,
  model: String,
) -> Nil

@external(javascript, "../../gleam-externals/local_storage.mjs", "testOllamaConnection")
fn test_ollama_connection(url: String) -> Nil
