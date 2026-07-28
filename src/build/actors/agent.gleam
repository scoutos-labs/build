//// The agent actor owns one *turn*.
////
//// Historically a turn was one model call returning `{reply, patches}`. Under
//// the tool-calling harness a turn is a bounded loop: a step returns tool calls,
//// Build executes them against the WebContainer, and the results feed the next
//// step — until the model answers with prose or the step budget runs out.
////
//// What lives here and what deliberately does not:
////
//// - **Here:** the step counter, the activity trail (names, statuses, summaries),
////   the union of touched paths, and whether dependencies need installing.
////   All of it is plain data a pure `update()` can reason about and tests can
////   assert on without mocks.
//// - **Not here:** the provider transcript. Opaque JSON (assistant `tool_calls`
////   arrays, raw tool result bodies) stays in `gleam-externals/agent.mjs`.
////   Modeling it in Gleam would buy nothing and would put file contents and
////   fetched page bodies into the app model.
////
//// The step counter lives in `State`, not in `Lifecycle.Running`. It is
//// turn-level bookkeeping rather than a distinct lifecycle, and keeping
//// `Running(request_id, started_at)` at two fields means every existing `case`
//// over it still compiles.

import build/actors/chat
import build/actors/settings
import build/pure/preview_inspector.{type SelectedPreviewElement}
import build/pure/templates.{type ProjectFile}
import gleam/int
import gleam/list
import gleam/option.{type Option}
import gleam/string

/// Hard ceiling on tool steps in one turn. Mirrors `MAX_TOOL_STEPS` in
/// `server/src/step-token.ts`, which enforces it server-side too — the client
/// drives the loop, so it cannot be the only thing counting.
pub const max_tool_steps = 12

/// Tool calls honored from a single step response. Extra calls are dropped rather
/// than queued: a model asking for six things at once is guessing, and the next
/// step can ask again with results in hand.
pub const max_calls_per_step = 3

/// The file whose change means `npm install` has to run.
pub const package_json = "package.json"

pub type Lifecycle {
  Idle
  Running(request_id: String, started_at: Int)
  TimedOut(request_id: String)
}

/// A tool call the model asked for, normalized and ready to execute.
///
/// `args_json` is the raw JSON string the provider sent — parsed by the executor,
/// so a malformed blob stays a recoverable tool error rather than a decode crash.
pub type ToolCall {
  ToolCall(id: String, name: String, args_json: String)
}

/// A `web_post` the model wants to make, paused for the user.
///
/// The only gated action in the harness. `fs_*` and `exec` run unattended
/// because they cannot escape the WebContainer; this one reaches out of it and
/// changes something in the world, so it stops and asks — showing the exact
/// method, URL, and body rather than a summary.
pub type Approval {
  Approval(
    call_id: String,
    url: String,
    method: String,
    body: String,
    /// Non-empty when the request cannot proceed at all (the turn already read
    /// from the web). Shown instead of the buttons.
    blocked: String,
  )
}

pub type ToolStatus {
  ToolRunning
  ToolDone
  ToolFailed
}

/// One row of the activity trail.
///
/// `summary` is founder-facing copy written by the executor ("Read your app
/// file", "Typechecked — 3 problems"), never a tool name and never file contents
/// or a response body. The trail is model-visible on the next step, so leaking
/// content here would smuggle it back into the prompt.
pub type TrailStep {
  TrailStep(call_id: String, name: String, summary: String, status: ToolStatus)
}

pub type State {
  State(
    lifecycle: Lifecycle,
    elapsed_seconds: Int,
    budget_exhausted: Bool,
    budget_reset_at: String,
    /// Steps consumed by the current turn.
    step: Int,
    /// Chronological activity trail for the current turn.
    trail: List(TrailStep),
    /// Every path written this turn, deduped, in first-write order. Becomes the
    /// single `chat.Message.paths` and build-log `paths` at turn end.
    touched_paths: List(String),
    /// `package.json` changed and no successful install has happened since.
    pkg_dirty: Bool,
    /// Calls dispatched but not yet finished. When this empties, the turn takes
    /// its next step.
    pending_calls: List(ToolCall),
    /// Assistant prose accumulated across steps; the last non-empty value is the
    /// turn's reply.
    final_reply: String,
    /// The project's files as they were when this turn started, and the paths it
    /// went on to change.
    ///
    /// The counterweight to unattended writing: "trust the sandbox" means a turn
    /// can rewrite six files without asking, so there has to be a way back. Only
    /// the most recent turn is undoable — a stack would need persistence and a
    /// UI, and the realistic regret is always "that last one made it worse".
    snapshot: Option(List(ProjectFile)),
    /// A web_post waiting on the user. While set, the turn is paused rather
    /// than finished — the model is owed a result either way.
    pending_approval: Option(Approval),
    /// Whether the finished turn's trail is expanded. Collapsed by default: the
    /// summary is the product, the steps are the receipts.
    trail_expanded: Bool,
  )
}

pub type Msg {
  /// `files` is the project as it stands right now — the point undo returns to.
  AgentRequestStarted(
    request_id: String,
    started_at: Int,
    files: List(ProjectFile),
  )
  AgentElapsedTick(now: Int)
  AgentRequestFailed(request_id: String, message: String)
  AgentRequestCanceled
  AgentTimeoutReached(request_id: String)
  AgentBudgetExhausted(request_id: String, reset_at: String)
  /// A step came back. `tool_calls` empty means the model answered.
  AgentStepReturned(
    request_id: String,
    tool_calls: List(ToolCall),
    assistant_content: String,
  )
  /// The executor picked up a call (drives the "working" row).
  AgentToolStarted(request_id: String, call_id: String, summary: String)
  /// A call finished. `paths` are files it wrote; `installed` is True only for an
  /// `exec` that successfully installed dependencies.
  AgentToolFinished(
    request_id: String,
    call_id: String,
    status: ToolStatus,
    summary: String,
    paths: List(String),
    installed: Bool,
  )
  AgentStepBudgetReached(request_id: String)
  /// A step the SERVER already ran (a web read, or an approved send).
  ///
  /// Distinct from AgentToolStarted because that one updates an existing row and
  /// deliberately ignores unknown ids — server steps have no row to update, and
  /// routing them through it silently discarded every web_search, every
  /// web_fetch, and the injection warning with them.
  AgentServerStepRecorded(request_id: String, name: String, summary: String)
  /// The model wants to send something out of the sandbox.
  AgentApprovalRequested(request_id: String, approval: Approval)
  /// The user decided. Either way the model is told what happened.
  AgentApprovalResolved(request_id: String, approved: Bool)
  /// Put the project back as it was before the last turn.
  AgentUndoRequested
  /// Expand or collapse the finished turn's trail. Pure UI.
  AgentTrailToggled
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
  /// Ask for the next step of the current turn. The transcript and tool results
  /// live JS-side, keyed by `request_id`, so this carries only the bookkeeping
  /// the loop itself needs.
  CallAgentStep(request_id: String, step: Int)
  /// Run one tool call against the WebContainer / project actor.
  ExecuteTool(request_id: String, call: ToolCall)
  /// Put the project back to a snapshot.
  ///
  /// Carries the files explicitly because `project.RemountProject` discards its
  /// argument at the interpreter and remounts a JS-side cache that is not
  /// necessarily the project — restoring through it would silently mount
  /// whatever was last *mounted*, possibly several turns stale.
  RestoreSnapshot(files: List(ProjectFile))
  /// Kill any agent-owned process. Paired with `AbortAgent` on every terminal
  /// transition — without it a wedged command outlives the turn and quietly
  /// degrades the container.
  KillExec
  /// Send an approved web_post, then continue the turn with its result.
  SendApprovedPost(request_id: String, call_id: String)
  /// Tell the model the user declined, then continue the turn.
  DeclineApprovedPost(request_id: String, call_id: String)
  StartElapsedTimer
  StopElapsedTimer
  AbortAgent
  /// The **only** thing that can trigger `npm install`.
  ///
  /// Driven by `pkg_dirty` rather than by inspecting a patch list, so a model
  /// that installs explicitly does not get a second install at turn end, and a
  /// model that forgets still gets one. The old `InstallIfNeeded(patches)` was
  /// removed with the patch protocol — two triggers could both fire.
  InstallDependencies
}

pub fn init() -> State {
  State(
    lifecycle: Idle,
    elapsed_seconds: 0,
    budget_exhausted: False,
    budget_reset_at: "",
    step: 0,
    trail: [],
    touched_paths: [],
    pkg_dirty: False,
    pending_calls: [],
    final_reply: "",
    snapshot: option.None,
    pending_approval: option.None,
    trail_expanded: False,
  )
}

pub fn is_running(state: State) -> Bool {
  case state.lifecycle {
    Running(_, _) -> True
    _ -> False
  }
}

/// True when the model asked for a command that installs dependencies. Used to
/// clear `pkg_dirty` so a turn does not install twice.
pub fn is_install_command(command: String, args: List(String)) -> Bool {
  case command, args {
    "npm", ["install", ..] -> True
    "npm", ["i", ..] -> True
    "npm", ["ci", ..] -> True
    _, _ -> False
  }
}

/// Reset per-turn bookkeeping, keeping budget state (account-level, not
/// turn-level).
fn clear_turn(state: State) -> State {
  State(
    ..state,
    step: 0,
    trail: [],
    touched_paths: [],
    pkg_dirty: False,
    pending_calls: [],
    final_reply: "",
    pending_approval: option.None,
    trail_expanded: False,
    // `snapshot` is deliberately NOT cleared here: undo has to outlive the turn
    // that produced it. It is replaced when the next turn starts, and dropped on
    // project navigation (which resets the whole actor).
  )
}

/// Append paths not already seen this turn, preserving first-write order so the
/// chips read in the order the agent worked.
fn merge_paths(existing: List(String), incoming: List(String)) -> List(String) {
  list.fold(incoming, existing, fn(acc, path) {
    case path == "" || list.contains(acc, path) {
      True -> acc
      False -> list.append(acc, [path])
    }
  })
}

fn touches_package_json(paths: List(String)) -> Bool {
  list.any(paths, fn(path) { path == package_json })
}

/// Effects that end a turn: stop the timer, and install if `package.json` changed
/// without a successful install following it.
fn finish_effects(state: State) -> List(Effect) {
  case state.pkg_dirty {
    True -> [StopElapsedTimer, InstallDependencies]
    False -> [StopElapsedTimer]
  }
}

fn set_trail_status(
  trail: List(TrailStep),
  call_id: String,
  status: ToolStatus,
  summary: String,
) -> List(TrailStep) {
  list.map(trail, fn(entry) {
    case entry.call_id == call_id {
      True -> TrailStep(..entry, status: status, summary: summary)
      False -> entry
    }
  })
}

fn has_trail_entry(trail: List(TrailStep), call_id: String) -> Bool {
  list.any(trail, fn(entry) { entry.call_id == call_id })
}

pub fn update(state: State, msg: Msg) -> #(State, List(Effect)) {
  case msg {
    AgentRequestStarted(request_id, started_at, files) -> #(
      State(
        ..clear_turn(state),
        lifecycle: Running(request_id, started_at),
        elapsed_seconds: 0,
        snapshot: option.Some(files),
      ),
      [StartElapsedTimer],
    )

    AgentElapsedTick(now) ->
      case state.lifecycle {
        Running(_, started_at) -> #(
          State(..state, elapsed_seconds: { now - started_at } / 1000),
          [],
        )
        _ -> #(state, [])
      }

    AgentRequestFailed(request_id, _) ->
      case state.lifecycle {
        Running(active_id, _) if active_id == request_id -> #(
          State(..clear_turn(state), lifecycle: Idle, elapsed_seconds: 0),
          // A failure mid-loop can leave a command running; tear it down.
          [StopElapsedTimer, KillExec],
        )
        _ -> #(state, [])
      }

    AgentRequestCanceled ->
      case state.lifecycle {
        Running(_, _) -> #(
          State(
            ..clear_turn(state),
            lifecycle: Idle,
            elapsed_seconds: 0,
            snapshot: option.None,
          ),
          [StopElapsedTimer, AbortAgent, KillExec],
        )
        // Idle is NOT a no-op. Project new/open/reset all dispatch this, and
        // between turns the lifecycle is Idle — leaving the snapshot behind let
        // the finished-turn card (and its Undo button) survive a project switch
        // and restore the OLD project's files over the new one.
        _ -> #(
          State(..clear_turn(state), snapshot: option.None),
          [],
        )
      }

    AgentTimeoutReached(request_id) ->
      case state.lifecycle {
        Running(active_id, _) if active_id == request_id -> #(
          // Rest in Idle, not TimedOut: TimedOut cannot accept the next turn and
          // the user must be able to retry immediately.
          State(..clear_turn(state), lifecycle: Idle, elapsed_seconds: 0),
          [StopElapsedTimer, AbortAgent, KillExec],
        )
        _ -> #(state, [])
      }

    AgentBudgetExhausted(request_id, reset_at) ->
      case state.lifecycle {
        Running(active_id, _) if active_id == request_id -> #(
          State(
            ..clear_turn(state),
            lifecycle: Idle,
            elapsed_seconds: 0,
            budget_exhausted: True,
            budget_reset_at: reset_at,
          ),
          [StopElapsedTimer, KillExec],
        )
        _ -> #(state, [])
      }

    AgentStepReturned(request_id, tool_calls, assistant_content) ->
      case state.lifecycle {
        Running(active_id, _) if active_id == request_id -> {
          let reply = case assistant_content {
            "" -> state.final_reply
            content -> content
          }
          let calls = list.take(tool_calls, max_calls_per_step)
          case calls {
            // No calls: the model answered — unless a web_post is waiting on
            // the user, in which case the turn is paused, not finished.
            [] if state.pending_approval != option.None -> #(
              State(..state, final_reply: reply),
              [],
            )
            [] -> #(
              State(
                ..state,
                lifecycle: Idle,
                elapsed_seconds: 0,
                final_reply: reply,
              ),
              finish_effects(state),
            )
            _ ->
              case state.step + 1 > max_tool_steps {
                // Budget spent. Stop looping; the caller narrates it.
                True -> #(
                  State(
                    ..state,
                    lifecycle: Idle,
                    elapsed_seconds: 0,
                    final_reply: reply,
                  ),
                  finish_effects(state),
                )
                False -> {
                  let rows =
                    list.map(calls, fn(call) {
                      TrailStep(
                        call_id: call.id,
                        name: call.name,
                        summary: "",
                        status: ToolRunning,
                      )
                    })
                  #(
                    State(
                      ..state,
                      step: state.step + 1,
                      pending_calls: calls,
                      trail: list.append(state.trail, rows),
                      final_reply: reply,
                    ),
                    list.map(calls, fn(call) { ExecuteTool(request_id, call) }),
                  )
                }
              }
          }
        }
        _ -> #(state, [])
      }

    AgentToolStarted(request_id, call_id, summary) ->
      case state.lifecycle {
        Running(active_id, _) if active_id == request_id ->
          case has_trail_entry(state.trail, call_id) {
            True -> #(
              State(
                ..state,
                trail: set_trail_status(
                  state.trail,
                  call_id,
                  ToolRunning,
                  summary,
                ),
              ),
              [],
            )
            False -> #(state, [])
          }
        _ -> #(state, [])
      }

    AgentToolFinished(request_id, call_id, status, summary, paths, installed) ->
      case state.lifecycle {
        Running(active_id, _) if active_id == request_id -> {
          let still_pending =
            list.filter(state.pending_calls, fn(call) { call.id != call_id })
          let touched = merge_paths(state.touched_paths, paths)
          // A successful install clears the flag; writing package.json sets it.
          // Order matters: a turn that installs and *then* edits package.json is
          // still dirty.
          let dirty = case installed {
            True -> touches_package_json(paths)
            False -> state.pkg_dirty || touches_package_json(paths)
          }
          let next =
            State(
              ..state,
              pending_calls: still_pending,
              touched_paths: touched,
              pkg_dirty: dirty,
              trail: set_trail_status(state.trail, call_id, status, summary),
            )
          case still_pending, next.pending_approval {
            // Every call for this step is in — take the next step. Unless a
            // web_post is waiting on the user: resolving it will continue the
            // turn, and stepping now would put two requests in flight sharing
            // one turn's transcript.
            [], option.None -> #(next, [CallAgentStep(request_id, next.step)])
            _, _ -> #(next, [])
          }
        }
        _ -> #(state, [])
      }

    AgentServerStepRecorded(request_id, name, summary) ->
      case state.lifecycle {
        Running(active_id, _) if active_id == request_id -> #(
          State(
            ..state,
            trail: list.append(state.trail, [
              TrailStep(
                // Server steps are already finished when we hear about them, so
                // they carry no call id to correlate — the id only exists to keep
                // rows distinct.
                call_id: request_id <> "-srv-" <> int.to_string(list.length(state.trail)),
                name: name,
                summary: summary,
                status: ToolDone,
              ),
            ]),
          ),
          [],
        )
        _ -> #(state, [])
      }

    AgentApprovalRequested(request_id, approval) ->
      case state.lifecycle {
        Running(active_id, _) if active_id == request_id -> #(
          State(..state, pending_approval: option.Some(approval)),
          [],
        )
        _ -> #(state, [])
      }

    AgentApprovalResolved(request_id, approved) ->
      case state.lifecycle, state.pending_approval {
        Running(active_id, _), option.Some(approval) if active_id == request_id -> {
          let cleared = State(..state, pending_approval: option.None)
          // Mirror of the guard above: if client tools from this same step are
          // still running, record the decision but let their completion drive
          // the next step, so only one request is ever in flight.
          let send = case approved && approval.blocked == "" {
            True -> SendApprovedPost(request_id, approval.call_id)
            False -> DeclineApprovedPost(request_id, approval.call_id)
          }
          // Only ONE thing may drive the next step. If client tools from this
          // same step are still running, their completion drives it and this
          // just records the decision; otherwise nothing else will, so drive it
          // here. Both driving would send a transcript whose still-running call
          // has no answering result — the exact orphan the provider rejects.
          case state.pending_calls {
            [] -> #(cleared, [send, CallAgentStep(request_id, state.step)])
            _ -> #(cleared, [send])
          }
        }
        _, _ -> #(state, [])
      }

    // Only offered between turns, and only when the turn actually wrote
    // something — see `can_undo`.
    AgentUndoRequested ->
      case can_undo(state), state.snapshot {
        True, option.Some(files) -> #(
          State(..state, snapshot: option.None, touched_paths: [], trail: []),
          [RestoreSnapshot(files)],
        )
        _, _ -> #(state, [])
      }

    AgentTrailToggled -> #(
      State(..state, trail_expanded: !state.trail_expanded),
      [],
    )

    AgentStepBudgetReached(request_id) ->
      case state.lifecycle {
        Running(active_id, _) if active_id == request_id -> #(
          State(..state, lifecycle: Idle, elapsed_seconds: 0, pending_calls: []),
          finish_effects(state),
        )
        _ -> #(state, [])
      }
  }
}

/// Undo is offered only between turns, and only when the last one actually
/// changed something — an undo button after a turn that just read files would
/// promise to reverse nothing.
pub fn can_undo(state: State) -> Bool {
  !is_running(state) && state.snapshot != option.None && state.touched_paths != []
}

/// Collapsed one-line summary of a finished turn, e.g.
/// `"5 steps · 3 files · checked it builds"`.
///
/// Lives here rather than in the view so the phrasing has one home and is
/// unit-testable. Deliberately carries no step counter of the "4/12" kind: a
/// budget is not progress.
pub fn turn_summary(state: State) -> String {
  let steps = list.length(state.trail)
  let files = list.length(state.touched_paths)
  let verified =
    list.any(state.trail, fn(entry) {
      entry.name == "exec" && entry.status == ToolDone
    })
  let parts = case steps {
    1 -> ["1 step"]
    n -> [int.to_string(n) <> " steps"]
  }
  let parts = case files {
    0 -> parts
    1 -> list.append(parts, ["1 file"])
    n -> list.append(parts, [int.to_string(n) <> " files"])
  }
  let parts = case verified {
    True -> list.append(parts, ["checked it builds"])
    False -> parts
  }
  string.join(parts, " · ")
}
