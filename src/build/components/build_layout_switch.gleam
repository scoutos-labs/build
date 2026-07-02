//// The layout segmented control: Chat / App / Code. Visible in every mode
//// (it lives in the chat panel's title row, the one region all modes share)
//// and is the only way to override the journey-based auto layout.

import build/actors/preview
import build/msg
import lustre/attribute
import lustre/element.{type Element}
import lustre/element/html
import lustre/event

pub fn view(
  layout: preview.LayoutMode,
  code_panel_unread: Bool,
) -> Element(msg.Msg) {
  html.div(
    [
      attribute.class("layoutSwitch"),
      attribute.role("group"),
      attribute.aria_label("Layout"),
    ],
    [
      segment("Chat", preview.ChatMode, layout, False),
      segment("App", preview.SplitMode, layout, False),
      segment("Code", preview.BuilderMode, layout, code_panel_unread),
    ],
  )
}

fn segment(
  label: String,
  mode: preview.LayoutMode,
  current: preview.LayoutMode,
  unread: Bool,
) -> Element(msg.Msg) {
  let active = mode == current
  html.button(
    [
      attribute.type_("button"),
      attribute.class(case active {
        True -> "layoutSegment active"
        False -> "layoutSegment"
      }),
      attribute.aria_pressed(case active {
        True -> "true"
        False -> "false"
      }),
      event.on_click(msg.Preview(preview.LayoutModeSelected(mode))),
    ],
    [
      html.text(label),
      // The unread nudge from the old code toggle: terminal output arrived
      // while the strip was hidden. A hint, never an auto-open.
      case unread && !active {
        True ->
          html.span(
            [attribute.class("unreadDot"), attribute.title("New terminal output")],
            [],
          )
        False -> html.text("")
      },
    ],
  )
}
