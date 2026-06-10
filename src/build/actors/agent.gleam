import build/actors/chat
import build/actors/settings
import build/pure/preview_inspector.{type SelectedPreviewElement}
import build/pure/templates.{type ProjectFile}
import gleam/option.{type Option}

pub type Patch {
  Patch(path: String, content: String)
}

pub type Lifecycle {
  Idle
  Running(request_id: String, started_at: Int)
  TimedOut(request_id: String)
}

pub type State {
  State(lifecycle: Lifecycle, elapsed_seconds: Int)
}

pub type Msg {
  AgentRequestStarted(request_id: String, started_at: Int)
  AgentElapsedTick(now: Int)
  AgentRequestSucceeded(request_id: String, reply: String, patches: List(Patch))
  AgentRequestFailed(request_id: String, message: String)
  AgentRequestCanceled
  AgentTimeoutReached(request_id: String)
}

pub type Effect {
  CallAgent(
    request_id: String,
    provider: settings.Provider,
    api_key: String,
    ollama_url: String,
    model: String,
    user_prompt: String,
    files: List(ProjectFile),
    messages: List(chat.Message),
    selected_element: Option(SelectedPreviewElement),
    element_comment: String,
  )
  StartElapsedTimer
  StopElapsedTimer
  AbortAgent
  InstallIfNeeded(patches: List(Patch))
}

pub fn init() -> State {
  State(lifecycle: Idle, elapsed_seconds: 0)
}

pub fn is_running(state: State) -> Bool {
  case state.lifecycle {
    Running(_, _) -> True
    _ -> False
  }
}

pub fn update(state: State, msg: Msg) -> #(State, List(Effect)) {
  case msg {
    AgentRequestStarted(request_id, started_at) -> #(
      State(lifecycle: Running(request_id, started_at), elapsed_seconds: 0),
      [StartElapsedTimer],
    )
    AgentElapsedTick(now) ->
      case state.lifecycle {
        Running(_, started_at) -> #(State(..state, elapsed_seconds: { now - started_at } / 1000), [])
        _ -> #(state, [])
      }
    AgentRequestSucceeded(request_id, _, patches) ->
      case state.lifecycle {
        Running(active_id, _) if active_id == request_id -> #(
          State(lifecycle: Idle, elapsed_seconds: 0),
          [StopElapsedTimer, InstallIfNeeded(patches)],
        )
        _ -> #(state, [])
      }
    AgentRequestFailed(request_id, _) ->
      case state.lifecycle {
        Running(active_id, _) if active_id == request_id -> #(
          State(lifecycle: Idle, elapsed_seconds: 0),
          [StopElapsedTimer],
        )
        _ -> #(state, [])
      }
    AgentRequestCanceled ->
      case state.lifecycle {
        Running(_, _) -> #(State(lifecycle: Idle, elapsed_seconds: 0), [StopElapsedTimer, AbortAgent])
        _ -> #(state, [])
      }
    AgentTimeoutReached(request_id) ->
      case state.lifecycle {
        Running(active_id, _) if active_id == request_id -> #(
          State(lifecycle: TimedOut(request_id), elapsed_seconds: state.elapsed_seconds),
          [StopElapsedTimer, AbortAgent],
        )
        _ -> #(state, [])
      }
  }
}
