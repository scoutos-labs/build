import build/actors/preview
import build/msg
import lustre/attribute
import lustre/element.{type Element}
import lustre/element/html
import lustre/event

pub fn view(
  preview_url: String,
  selecting: Bool,
  running: Bool,
) -> Element(msg.Msg) {
  html.section(
    [attribute.class("preview")],
    [
      html.div(
        [attribute.class("bar")],
        [
          html.strong([], [html.text("Preview")]),
          html.span([], [html.text(case preview_url { "" -> "starting..." _ -> preview_url })]),
          button(
            [
              attribute.class(case selecting { True -> "selectingButton" False -> "ghost compact" }),
              event.on_click(msg.Preview(preview.ElementSelectToggled)),
            ],
            case selecting { True -> "Selecting..." False -> "Select element" },
          ),
        ],
      ),
      html.div(
        [attribute.class("previewFrame")],
        [
          case preview_url {
            "" -> html.div([attribute.class("loading")], [html.text("Starting WebContainer...")])
            _ -> html.iframe([attribute.src(preview_url), attribute.title("preview")])
          },
          case running {
            True -> overlay()
            False -> html.text("")
          },
        ],
      ),
    ],
  )
}

fn overlay() {
  html.div([attribute.class("previewOverlay")], [
    html.div([attribute.class("pulseOrb")], []),
    html.strong([], [html.text("Agent is updating your app")]),
    html.span([], [html.text("Waiting for model response…")]),
  ])
}

fn button(attrs, label: String) {
  html.button([attribute.type_("button"), ..attrs], [html.text(label)])
}
