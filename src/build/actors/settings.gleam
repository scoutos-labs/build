pub type Provider {
  OpenRouter
  Ollama
}

/// What the user picks instead of a model.
///
/// Labelled by the JOB, never by the model: a founder cannot evaluate
/// "claude-sonnet-4.6 vs gpt-5.5", but they can absolutely tell you whether this
/// is a quick tweak or a hard problem. The tradeoff they actually feel is
/// budget, not speed, so the copy says so.
///
/// `Quick`/`Standard`/`Hard` are internal ids; `job_label` is what ships.
pub type Job {
  Quick
  Standard
  Hard
}

pub const default_job = Standard

pub fn all_jobs() -> List(Job) {
  [Quick, Standard, Hard]
}

pub fn job_label(job: Job) -> String {
  case job {
    Quick -> "Quick changes"
    Standard -> "Most work"
    Hard -> "Hard problems"
  }
}

pub fn job_blurb(job: Job) -> String {
  case job {
    Quick -> "Fastest, and easiest on your monthly budget. Good for small edits."
    Standard -> "The default. Strong at writing and fixing app code."
    Hard ->
      "Slower, and uses more of your monthly budget. For tricky bugs and big rewrites."
  }
}

/// First choice of each curated chain. Mirrors CURATED_CHAINS in
/// `server/src/models.ts`; `src/prompt-parity.test.ts` guards the pair, because
/// a model the server would reject as non-tool-capable must never be offered
/// here.
pub fn job_model(job: Job) -> String {
  case job {
    Quick -> "qwen/qwen3.6-35b-a3b"
    Standard -> "anthropic/claude-sonnet-4.6"
    Hard -> "openai/gpt-5.5"
  }
}

pub fn job_from_string(value: String) -> Job {
  case value {
    "quick" -> Quick
    "hard" -> Hard
    _ -> Standard
  }
}

pub fn job_to_string(job: Job) -> String {
  case job {
    Quick -> "quick"
    Standard -> "standard"
    Hard -> "hard"
  }
}

pub type State {
  State(
    provider: Provider,
    api_key: String,
    ollama_url: String,
    model: String,
    settings_open: Bool,
    connection_status: String,
    account_plan: String,
    account_budget: String,
    /// The user's chosen job. Drives `model` for OpenRouter; Ollama keeps its
    /// own model field because it has no tool mode and no catalog.
    job: Job,
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
  AccountLoaded(plan: String, budget: String)
  JobChanged(Job)
  SignOutRequested
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
  FetchAccountInfo
  PurgeLegacySettings
  /// Record the chosen job. In managed mode this also tells the server, which
  /// re-validates tool capability and refuses a model that cannot call tools.
  PersistJob(job: String, model: String)
  SignOut
}

pub fn init() -> State {
  State(
    provider: OpenRouter,
    api_key: "",
    ollama_url: "http://localhost:11434",
    model: "",
    settings_open: True,
    connection_status: "",
    account_plan: "",
    account_budget: "",
    job: default_job,
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
        True, OpenRouter -> "qwen/qwen3.6-35b-a3b"
        False, _ -> state.model
      }
      #(State(..state, provider: provider, model: next_model), [])
    }
    ApiKeyChanged(api_key) -> #(State(..state, api_key: api_key), [])
    OllamaUrlChanged(url) -> #(State(..state, ollama_url: url), [])
    ModelChanged(model) -> #(State(..state, model: model), [])
    // Picking a job picks the model. Ollama is left alone: it has no tool mode
    // and no catalog, so its model stays whatever the user typed.
    JobChanged(job) ->
      case state.provider {
        Ollama -> #(State(..state, job: job), [])
        OpenRouter -> {
          let model = job_model(job)
          #(State(..state, job: job, model: model), [
            PersistJob(job_to_string(job), model),
          ])
        }
      }
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
    AccountLoaded(plan, budget) -> #(
      State(..state, account_plan: plan, account_budget: budget),
      [],
    )
    SignOutRequested -> #(state, [SignOut])
  }
}
