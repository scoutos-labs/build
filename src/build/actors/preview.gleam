import build/pure/preview_inspector.{type SelectedPreviewElement}
import gleam/option.{type Option}

pub type InspectorMessage {
  BuildInspectorEnable
  BuildInspectorDisable
}

/// Which arrangement of the two always-mounted surfaces (chat panel,
/// workspace) is visible. Ephemeral per-session UI state — deliberately not
/// persisted, so every session replays chat-during-boot → split reveal.
/// UI labels: Chat / App / Code.
pub type LayoutMode {
  ChatMode
  SplitMode
  // Full-bleed preview with the chat as a docked companion card. Manual
  // entry only; the journey logic never produces it.
  FocusMode
  BuilderMode
}

pub type State {
  State(
    preview_url: String,
    selecting_element: Bool,
    selected_element: Option(SelectedPreviewElement),
    element_comment: String,
    // ChatMode until the session's first preview URL arrives, then the app
    // auto-reveals SplitMode. BuilderMode adds the files/editor/terminal
    // strip (the old code panel). `layout_is_manual` records that the user
    // touched the segmented control this session: after that, the auto
    // reveal never fights them. `code_panel_unread` flags terminal output
    // (e.g. a preview error) that arrived while the strip was hidden.
    layout: LayoutMode,
    layout_is_manual: Bool,
    code_panel_unread: Bool,
  )
}

pub type Msg {
  PreviewUrlChanged(String)
  ElementSelectToggled
  ElementSelected(SelectedPreviewElement)
  ElementCommentChanged(comment: String)
  ElementCleared
  LayoutModeSelected(LayoutMode)
  CodePanelErrorSignaled
}

pub type Effect {
  PostInspectorMessage(InspectorMessage)
}

pub fn init() -> State {
  State(
    preview_url: "",
    selecting_element: False,
    selected_element: option.None,
    element_comment: "",
    layout: ChatMode,
    layout_is_manual: False,
    code_panel_unread: False,
  )
}

/// The files/editor/terminal strip is visible exactly in BuilderMode.
pub fn code_panel_open(state: State) -> Bool {
  state.layout == BuilderMode
}

pub fn update(state: State, msg: Msg) -> #(State, List(Effect)) {
  case msg {
    PreviewUrlChanged(url) -> {
      // The session's first URL is the reveal: the app now exists, show it.
      // Re-fires (crash restarts, reboots) are no-ops because by then the
      // layout is no longer an automatic ChatMode. An empty URL (the
      // non-browser fallback) must not reveal a permanently blank preview.
      let layout = case url != "", state.layout, state.layout_is_manual {
        True, ChatMode, False -> SplitMode
        _, _, _ -> state.layout
      }
      #(
        State(..state, preview_url: url, layout: layout),
        case state.selecting_element {
          True -> [PostInspectorMessage(BuildInspectorEnable)]
          False -> []
        },
      )
    }
    ElementSelectToggled -> {
      let selecting = !state.selecting_element
      #(State(..state, selecting_element: selecting), [
        PostInspectorMessage(case selecting {
          True -> BuildInspectorEnable
          False -> BuildInspectorDisable
        }),
      ])
    }
    ElementSelected(element) -> #(
      State(
        ..state,
        selected_element: option.Some(element),
        element_comment: "",
        selecting_element: False,
      ),
      [PostInspectorMessage(BuildInspectorDisable)],
    )
    ElementCommentChanged(comment) -> #(
      State(..state, element_comment: comment),
      [],
    )
    ElementCleared -> #(
      State(..state, selected_element: option.None, element_comment: ""),
      [],
    )
    LayoutModeSelected(mode) if mode == state.layout ->
      // Clicking the already-active segment is a no-op — in particular it
      // must not set layout_is_manual and silently kill the auto reveal.
      #(state, [])
    LayoutModeSelected(mode) -> {
      // Entering Builder reveals the strip, so the unread nudge is served;
      // leaving it keeps any existing badge (same rule as the old toggle).
      let unread = case mode {
        BuilderMode -> False
        _ -> state.code_panel_unread
      }
      // A hidden preview can't be aimed at: switching to Chat mid-selection
      // disarms the inspector.
      let disarm = state.selecting_element && mode == ChatMode
      #(
        State(
          ..state,
          layout: mode,
          layout_is_manual: True,
          code_panel_unread: unread,
          selecting_element: case disarm {
            True -> False
            False -> state.selecting_element
          },
        ),
        case disarm {
          True -> [PostInspectorMessage(BuildInspectorDisable)]
          False -> []
        },
      )
    }
    // Preview/build error arrived: badge the Code segment if the strip is
    // hidden so the user knows to look, but never yank the layout open.
    CodePanelErrorSignaled -> #(
      State(..state, code_panel_unread: state.layout != BuilderMode),
      [],
    )
  }
}

/// Journey reset for user-initiated project navigation (new / open / reset):
/// re-arm the auto reveal. Nobody is moved — the onboarding interview lives
/// in the chat panel now, so ChatMode users no longer need the preview
/// forced open to see it.
pub fn on_project_navigation(state: State) -> State {
  State(..state, layout_is_manual: False)
}

/// Store a preview URL WITHOUT the reveal — used while the interview is
/// active so vite booting mid-question never yanks the layout. Preserves
/// the inspector re-enable side effect of the normal URL path.
pub fn record_url(state: State, url: String) -> #(State, List(Effect)) {
  #(State(..state, preview_url: url), case state.selecting_element {
    True -> [PostInspectorMessage(BuildInspectorEnable)]
    False -> []
  })
}

/// The interview-end reveal: the moment the agent starts building (or the
/// founder opts out of the interview), show the app — if they haven't
/// manually chosen a layout and a preview URL exists. No-op otherwise;
/// dismissing before any URL leaves the normal URL-arrival reveal armed.
pub fn reveal(state: State) -> State {
  case state.layout, state.layout_is_manual, state.preview_url {
    ChatMode, False, url if url != "" -> State(..state, layout: SplitMode)
    _, _, _ -> state
  }
}
