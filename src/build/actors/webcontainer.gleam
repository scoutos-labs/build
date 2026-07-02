import build/pure/templates
import gleam/list

pub type BootPhase {
  LoadingIndexedDb
  BootingContainer
  Installing
  StartingDevServer
  Remounting
  Ready
  Error(message: String)
}

pub type State {
  State(
    boot_phase: BootPhase,
    logs: List(String),
    hydrated: Bool,
    suppress_auto_save: Bool,
  )
}

pub type Msg {
  BootStarted
  BootSucceeded
  BootFailed(message: String)
  PhaseChanged(BootPhase)
  LogAppended(line: String)
  ProjectHydrated
  SuppressAutoSaveChanged(Bool)
  RemountRequested(files: List(templates.ProjectFile))
  RemountFinished
  SyncFilesRequested
}

pub type Effect {
  BootContainer(files: List(templates.ProjectFile))
  MountAndInstall(files: List(templates.ProjectFile))
  StartDevServer
  RunNpmInstall
  ReadFilesFromContainer
}

pub fn init() -> State {
  State(
    boot_phase: LoadingIndexedDb,
    logs: [],
    hydrated: False,
    suppress_auto_save: False,
  )
}

pub fn is_busy(state: State) -> Bool {
  state.boot_phase != Ready
}

/// The agent only needs the in-memory project files, so chatting during the
/// initial boot (or after a boot failure) is fine — the only unsafe window
/// is a project-switch remount, when the file set is being swapped.
pub fn is_remounting(state: State) -> Bool {
  state.boot_phase == Remounting
}

pub fn update(state: State, msg: Msg) -> #(State, List(Effect)) {
  case msg {
    BootStarted -> #(State(..state, boot_phase: BootingContainer), [])
    BootSucceeded -> #(State(..state, boot_phase: Ready, hydrated: True), [])
    BootFailed(message) -> #(
      State(..state, boot_phase: Error(message), logs: append_log(state.logs, message)),
      [],
    )
    PhaseChanged(phase) -> #(State(..state, boot_phase: phase), [])
    LogAppended(line) -> #(State(..state, logs: append_log(state.logs, line)), [])
    ProjectHydrated -> #(State(..state, hydrated: True), [])
    SuppressAutoSaveChanged(value) -> #(State(..state, suppress_auto_save: value), [])
    RemountRequested(files) -> #(
      State(..state, boot_phase: Remounting, suppress_auto_save: True),
      [MountAndInstall(files)],
    )
    RemountFinished -> #(
      State(..state, boot_phase: Ready, suppress_auto_save: False),
      [],
    )
    SyncFilesRequested -> #(state, [ReadFilesFromContainer])
  }
}

fn append_log(logs: List(String), line: String) -> List(String) {
  let overflow = list.length(logs) - 200
  let prior = case overflow > 0 {
    True -> list.drop(logs, overflow)
    False -> logs
  }
  list.append(prior, [line])
}
