import build/actors/publish
import build/actors/settings
import build/msg
import gleam/option.{type Option, None, Some}
import lustre/attribute
import lustre/element.{type Element}
import lustre/element/html
import lustre/event

pub fn view(
  state: publish.State,
  project_id: Option(String),
) -> Element(msg.Msg) {
  case state.dialog_open {
    False -> html.text("")
    True ->
      html.div(
        [attribute.class("modalBackdrop"), attribute.role("presentation")],
        [
          html.div(
            [
              attribute.class("modal"),
              attribute.role("dialog"),
              attribute.aria_modal(True),
              attribute.aria_labelledby("publish-title"),
            ],
            [header(), body(state, project_id)],
          ),
        ],
      )
  }
}

fn header() {
  html.div([attribute.class("modalHeader")], [
    html.div([], [
      html.h2([attribute.id("publish-title")], [html.text("Publish")]),
      html.p([], [html.text("Put this project live at a scoutos.live URL.")]),
    ]),
    html.button(
      [
        attribute.type_("button"),
        attribute.class("ghost iconButton"),
        attribute.aria_label("Close publish dialog"),
        event.on_click(msg.Publish(publish.DialogClosed)),
      ],
      [html.text("×")],
    ),
  ])
}

fn body(state: publish.State, project_id: Option(String)) {
  case state.status {
    publish.NeedsKey ->
      panel("publishNeedsKey", [
        html.p([], [
          html.text(
            "Publishing needs your ScoutOS API key. Add it once in settings; it is stored encrypted and never shown again.",
          ),
        ]),
        html.div([attribute.class("modalActions")], [
          html.button(
            [
              attribute.type_("button"),
              event.on_click(msg.Settings(settings.SettingsOpened)),
            ],
            [html.text("Open settings")],
          ),
        ]),
      ])
    publish.CheckingDeployment(_) ->
      panel("publishChecking", [
        html.p([], [html.text("Checking for an existing deployment...")]),
      ])
    publish.Prompting(error) ->
      panel("publishPrompt", [
        html.label([], [
          html.text("Choose a subdomain"),
          html.div([attribute.class("subdomainRow")], [
            html.input([
              attribute.value(state.subdomain_input),
              attribute.placeholder("my-app"),
              event.on_input(fn(value) {
                msg.Publish(publish.SubdomainChanged(value))
              }),
            ]),
            html.span([attribute.class("subdomainSuffix")], [
              html.text(".scoutos.live"),
            ]),
          ]),
        ]),
        case error {
          "" -> html.text("")
          _ -> html.small([attribute.class("status error")], [html.text(error)])
        },
        html.div([attribute.class("modalActions")], [
          publish_button(state, project_id, "Publish"),
        ]),
      ])
    publish.Publishing(_, subdomain) ->
      panel("publishInFlight", [
        html.p([], [
          html.text("Packaging and uploading " <> subdomain <> ".scoutos.live..."),
        ]),
      ])
    publish.Polling(_, subdomain) ->
      panel("publishPolling", [
        html.p([], [
          html.text(
            "Building and deploying " <> subdomain <> ".scoutos.live — this usually takes a minute or two.",
          ),
        ]),
      ])
    publish.Deployed(url) ->
      panel("publishDeployed", [
        html.p([], [html.text("Your app is live:")]),
        html.a(
          [
            attribute.href(url),
            attribute.target("_blank"),
            attribute.rel("noreferrer"),
            attribute.class("publishedUrl"),
          ],
          [html.text(url)],
        ),
        html.p([attribute.class("footnote")], [
          html.text("Publish again any time — the same URL updates with zero downtime."),
        ]),
      ])
    publish.Failed(message, logs) ->
      panel("publishFailed", [
        html.p([attribute.class("status error")], [
          html.text("Publish failed: " <> message),
        ]),
        case logs {
          "" -> html.text("")
          _ -> html.pre([attribute.class("publishLogs")], [html.text(logs)])
        },
        html.div([attribute.class("modalActions")], [
          publish_button(state, project_id, "Try again"),
        ]),
      ])
    publish.Idle ->
      panel("publishIdle", [
        html.p([], [
          html.text(
            "Publish packages this project and deploys it to Scout Live.",
          ),
        ]),
        html.div([attribute.class("modalActions")], [
          publish_button(state, project_id, "Publish"),
        ]),
      ])
  }
}

fn publish_button(
  state: publish.State,
  project_id: Option(String),
  label: String,
) -> Element(msg.Msg) {
  case project_id {
    None ->
      html.button([attribute.type_("button"), attribute.disabled(True)], [
        html.text("Waiting for project save..."),
      ])
    Some(id) ->
      html.button(
        [
          attribute.type_("button"),
          event.on_click(case state.status {
            publish.Prompting(_) -> msg.Publish(publish.SubdomainSubmitted(id))
            _ -> msg.Publish(publish.PublishClicked(id))
          }),
        ],
        [html.text(label)],
      )
  }
}

fn panel(class: String, children: List(Element(msg.Msg))) {
  html.div([attribute.class("publishPanel " <> class)], children)
}
