import build/pure/preview_inspector.{type SelectedPreviewElement}
import gleam/option.{type Option}

pub type InspectorMessage {
  BuildInspectorEnable
  BuildInspectorDisable
}

pub type State {
  State(
    preview_url: String,
    selecting_element: Bool,
    selected_element: Option(SelectedPreviewElement),
    element_comment: String,
    // The files/editor/terminal strip. Hidden by default — the agent drives
    // most changes, so the preview gets the full workspace until a user opts
    // into the developer view. `code_panel_unread` flags terminal output
    // (e.g. a preview error) that arrived while the panel was hidden.
    code_panel_open: Bool,
    code_panel_unread: Bool,
  )
}

pub type Msg {
  PreviewUrlChanged(String)
  ElementSelectToggled
  ElementSelected(SelectedPreviewElement)
  ElementCommentChanged(comment: String)
  ElementCleared
  CodePanelToggled
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
    code_panel_open: False,
    code_panel_unread: False,
  )
}

pub fn update(state: State, msg: Msg) -> #(State, List(Effect)) {
  case msg {
    PreviewUrlChanged(url) -> #(
      State(..state, preview_url: url),
      case state.selecting_element {
        True -> [PostInspectorMessage(BuildInspectorEnable)]
        False -> []
      },
    )
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
    CodePanelToggled -> {
      let open = !state.code_panel_open
      #(
        State(..state, code_panel_open: open, code_panel_unread: case open {
          // Opening clears the indicator; closing leaves it as-is.
          True -> False
          False -> state.code_panel_unread
        }),
        [],
      )
    }
    // Preview/build error arrived: badge the toggle if the panel is hidden so
    // the user knows to look, but never yank the layout open mid-edit.
    CodePanelErrorSignaled -> #(
      State(..state, code_panel_unread: case state.code_panel_open {
        True -> False
        False -> True
      }),
      [],
    )
  }
}
