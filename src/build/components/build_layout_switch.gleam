//// The layout segmented control: Chat / App / Code. Visible in every mode
//// (it lives in the chat panel's title row, the one region all modes share)
//// and is the only way to override the journey-based auto layout.

import build/actors/preview
import build/msg
import gleam/dynamic/decode
import gleam/list
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
      segment("Focus", preview.FocusMode, layout, False),
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
      // Roving focus: only the active segment is tabbable; arrows move the
      // selection (radio-group convention), stopping at the ends.
      attribute.attribute("tabindex", case active {
        True -> "0"
        False -> "-1"
      }),
      event.on("keydown", rove_decoder(current)),
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

const mode_order = [
  preview.ChatMode,
  preview.SplitMode,
  preview.FocusMode,
  preview.BuilderMode,
]

fn neighbor(current: preview.LayoutMode, step: Int) -> Result(preview.LayoutMode, Nil) {
  let indexed = list.index_map(mode_order, fn(mode, index) { #(mode, index) })
  case list.find(indexed, fn(pair) { pair.0 == current }) {
    Ok(#(_, index)) ->
      list.drop(mode_order, index + step)
      |> list.first
      |> fn(found) {
        case index + step >= 0, found {
          True, Ok(mode) -> Ok(mode)
          _, _ -> Error(Nil)
        }
      }
    Error(_) -> Error(Nil)
  }
}

fn rove_decoder(current: preview.LayoutMode) -> decode.Decoder(msg.Msg) {
  use key <- decode.field("key", decode.string)
  let target = case key {
    "ArrowRight" -> neighbor(current, 1)
    "ArrowLeft" -> neighbor(current, -1)
    _ -> Error(Nil)
  }
  case target {
    Ok(mode) -> decode.success(msg.LayoutModeKeyed(mode))
    Error(_) -> decode.success(msg.NoOp)
  }
}
