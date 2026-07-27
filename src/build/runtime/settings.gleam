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
    settings.FetchAccountInfo -> fetch_account_info()
    settings.PurgeLegacySettings -> purge_legacy_settings()
    settings.PersistJob(job, model) -> persist_job(job, model)
    settings.SignOut -> managed_sign_out()
  }
}

@external(javascript, "../../gleam-externals/managed.mjs", "fetchAccountInfo")
fn fetch_account_info() -> Nil

@external(javascript, "../../gleam-externals/managed.mjs", "purgeLegacySettings")
fn purge_legacy_settings() -> Nil

@external(javascript, "../../gleam-externals/managed.mjs", "managedSignOut")
fn managed_sign_out() -> Nil

/// Persist the chosen job locally, and in managed mode tell the server so it
/// re-validates tool capability against the live catalog.
@external(javascript, "../../gleam-externals/managed.mjs", "persistJob")
fn persist_job(job: String, model: String) -> Nil

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
