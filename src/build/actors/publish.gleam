import build/pure/templates
import gleam/list
import gleam/string

/// Publish-to-Scout-Live state machine. Effects that need the project file
/// map (StartPublish) are appended by the top-level update, which owns the
/// files; everything else round-trips through runtime/publish.gleam.
pub type Status {
  Idle
  /// Looking up an existing deployment record for the project.
  CheckingDeployment(project_id: String)
  /// First publish: asking the user for a subdomain.
  Prompting(error: String)
  /// POST /api/publish in flight.
  Publishing(project_id: String, subdomain: String)
  Polling(build_id: String, subdomain: String)
  Deployed(url: String)
  Failed(message: String, logs: String)
  /// No stored ScoutOS key — route the user to settings.
  NeedsKey
}

pub type State {
  State(
    dialog_open: Bool,
    status: Status,
    subdomain_input: String,
    key_saved: Bool,
    key_input: String,
    key_status: String,
  )
}

pub type Msg {
  PublishClicked(project_id: String)
  DialogClosed
  SubdomainChanged(value: String)
  SubdomainSubmitted(project_id: String)
  DeploymentLoaded(project_id: String, found: Bool, subdomain: String)
  PublishAccepted(build_id: String, subdomain: String)
  PublishRejected(code: String, message: String)
  PollDue(build_id: String)
  StatusPolled(
    build_id: String,
    status: String,
    url: String,
    error_message: String,
    logs: String,
  )
  KeyInputChanged(value: String)
  SaveKeyClicked
  KeySaved
  KeySaveFailed(message: String)
  KeyStatusLoaded(saved: Bool)
  DeleteKeyClicked
  KeyDeleted
}

pub type Effect {
  FetchKeyStatus
  SaveKey(key: String)
  DeleteKey
  FetchDeployment(project_id: String)
  StartPublish(
    project_id: String,
    subdomain: String,
    files: List(templates.ProjectFile),
  )
  PollStatus(build_id: String)
  SchedulePoll(build_id: String, delay: Int)
}

pub fn init() -> State {
  State(
    dialog_open: False,
    status: Idle,
    subdomain_input: "",
    key_saved: False,
    key_input: "",
    key_status: "",
  )
}

const poll_delay = 2000

/// Mirror of the server's reserved list (itself mirroring scout-live) so
/// invalid names fail before any network call.
const reserved_subdomains = [
  "api", "auth", "admin", "dashboard", "docs", "ports", "apps", "adapters",
  "api-keys", "www", "scoutos", "scout", "scout-live", "scoutlive", "mail",
  "smtp", "pop", "imap", "ftp", "sftp", "ns1", "ns2", "ns3", "ns4",
  "localhost", "local", "status", "health", "metrics", "grafana",
  "prometheus", "internal", "staging", "production", "registry", "cdn",
  "static", "assets", "blog", "support", "billing", "account", "login",
  "signup", "oauth", "sso", "webhook", "webhooks", "proxy", "gateway",
  "console", "panel",
]

pub fn check_subdomain(raw: String) -> Result(String, String) {
  let subdomain = raw |> string.trim |> string.lowercase
  let length = string.length(subdomain)
  let chars_ok =
    subdomain
    |> string.to_graphemes
    |> list.all(fn(char) {
      case char {
        "-" -> True
        _ -> string.contains("abcdefghijklmnopqrstuvwxyz0123456789", char)
      }
    })
  case
    length >= 1
    && length <= 63
    && chars_ok
    && !string.starts_with(subdomain, "-")
    && !string.ends_with(subdomain, "-")
  {
    False ->
      Error(
        "Use 1-63 lowercase letters, digits, and hyphens (no leading or trailing hyphen)",
      )
    True ->
      case list.contains(reserved_subdomains, subdomain) {
        True -> Error("That name is reserved by the platform")
        False -> Ok(subdomain)
      }
  }
}

pub fn key_shape_ok(key: String) -> Bool {
  let trimmed = string.trim(key)
  {
    string.starts_with(trimmed, "sk_live_")
    || string.starts_with(trimmed, "sk_test_")
  }
  && string.length(trimmed) >= 16
}

pub fn is_busy(state: State) -> Bool {
  case state.status {
    CheckingDeployment(_) | Publishing(_, _) | Polling(_, _) -> True
    _ -> False
  }
}

pub fn update(state: State, msg: Msg) -> #(State, List(Effect)) {
  case msg {
    PublishClicked(project_id) ->
      case state.key_saved {
        False -> #(State(..state, dialog_open: True, status: NeedsKey), [])
        True ->
          case is_busy(state) {
            True -> #(State(..state, dialog_open: True), [])
            False -> #(
              State(
                ..state,
                dialog_open: True,
                status: CheckingDeployment(project_id),
              ),
              [FetchDeployment(project_id)],
            )
          }
      }
    DialogClosed -> #(State(..state, dialog_open: False), [])
    SubdomainChanged(value) -> #(State(..state, subdomain_input: value), [])
    SubdomainSubmitted(project_id) ->
      case state.status {
        Prompting(_) ->
          case check_subdomain(state.subdomain_input) {
            Ok(subdomain) -> #(
              State(..state, status: Publishing(project_id, subdomain)),
              [],
            )
            Error(message) -> #(State(..state, status: Prompting(message)), [])
          }
        _ -> #(state, [])
      }
    DeploymentLoaded(project_id, found, subdomain) ->
      case state.status {
        CheckingDeployment(pending) if pending == project_id ->
          case found {
            // Already published: republish to the recorded name, no prompt.
            True -> #(
              State(..state, status: Publishing(project_id, subdomain)),
              [],
            )
            False -> #(State(..state, status: Prompting("")), [])
          }
        _ -> #(state, [])
      }
    PublishAccepted(build_id, subdomain) -> #(
      State(..state, status: Polling(build_id, subdomain)),
      [SchedulePoll(build_id, poll_delay)],
    )
    PublishRejected(code, message) ->
      case code {
        "no_scoutos_key" -> #(
          State(..state, status: NeedsKey, key_saved: False),
          [],
        )
        // Name conflicts re-prompt: the user picks another name.
        "subdomain_taken" | "invalid_subdomain" | "reserved_subdomain" -> #(
          State(..state, status: Prompting(message)),
          [],
        )
        _ -> #(State(..state, status: Failed(message, "")), [])
      }
    PollDue(build_id) ->
      case state.status {
        Polling(active, _) if active == build_id -> #(state, [
          PollStatus(build_id),
        ])
        _ -> #(state, [])
      }
    StatusPolled(build_id, status, url, error_message, logs) ->
      case state.status {
        Polling(active, _) if active == build_id ->
          case status {
            "deployed" -> #(State(..state, status: Deployed(url)), [])
            "failed" | "build_succeeded_deploy_failed" -> #(
              State(
                ..state,
                status: Failed(
                  case error_message {
                    "" -> "Build " <> status
                    _ -> error_message
                  },
                  logs,
                ),
              ),
              [],
            )
            _ -> #(state, [SchedulePoll(build_id, poll_delay)])
          }
        _ -> #(state, [])
      }
    KeyInputChanged(value) -> #(State(..state, key_input: value), [])
    SaveKeyClicked ->
      case key_shape_ok(state.key_input) {
        False -> #(
          State(
            ..state,
            key_status: "Keys look like sk_live_... or sk_test_...",
          ),
          [],
        )
        True -> #(State(..state, key_status: "Saving..."), [
          SaveKey(string.trim(state.key_input)),
        ])
      }
    KeySaved -> #(
      State(
        ..state,
        key_saved: True,
        key_input: "",
        key_status: "Key saved",
        // Unblock a publish that stalled on the missing key.
        status: case state.status {
          NeedsKey -> Idle
          other -> other
        },
      ),
      [],
    )
    KeySaveFailed(message) -> #(State(..state, key_status: message), [])
    KeyStatusLoaded(saved) -> #(State(..state, key_saved: saved), [])
    DeleteKeyClicked -> #(State(..state, key_status: "Removing..."), [
      DeleteKey,
    ])
    KeyDeleted -> #(State(..state, key_saved: False, key_status: ""), [])
  }
}
