import build/actors/chat
import build/msg
import build/runtime/ids
import gleam/dynamic/decode
import gleam/int
import gleam/list
import gleam/string
import lustre/attribute
import lustre/element.{type Element, fragment}
import lustre/element/html
import lustre/event

pub fn view(
  messages: List(chat.Message),
  expanded_messages: List(Int),
  prompt: String,
  running: Bool,
  busy: Bool,
  budget_exhausted: Bool,
  budget_reset_at: String,
) -> Element(msg.Msg) {
  fragment([
    html.div([attribute.class("chatTools")], [
      html.span([], [
        html.text(int.to_string(list.length(messages)) <> " messages"),
      ]),
      button(
        [
          attribute.class("ghost compact"),
          attribute.disabled(messages == [] || busy),
          event.on_click(msg.Chat(chat.ChatCleared)),
        ],
        "Clear chat",
      ),
    ]),
    html.div([attribute.class("messages")], case messages {
      [] -> [
        html.p([attribute.class("empty")], [
          html.text(
            "Try: “Turn this into a CRM with contacts and notes saved to the database.”",
          ),
        ]),
      ]
      _ ->
        list.index_map(messages, fn(message, index) {
          message_view(message, index, list.contains(expanded_messages, index))
        })
    }),
    html.textarea(
      [
        attribute.placeholder("Describe the app change you want..."),
        event.on_input(fn(value) { msg.Chat(chat.PromptChanged(value)) }),
        event.on("keydown", submit_shortcut_decoder()),
      ],
      prompt,
    ),
    case running {
      True ->
        html.div([attribute.class("thinking")], [
          html.text("Model is thinking…"),
        ])
      False -> html.text("")
    },
    case budget_exhausted {
      True ->
        html.div([attribute.class("budgetExhausted")], [
          html.text(budget_exhausted_message(budget_reset_at)),
        ])
      False -> html.text("")
    },
    html.div([attribute.class("actions")], [
      button(
        [
          attribute.disabled(busy || budget_exhausted),
          event.on("click", submit_click_decoder()),
        ],
        case busy {
          True -> "Working..."
          False -> "Send"
        },
      ),
      case running {
        True ->
          button(
            [attribute.class("secondary"), event.on_click(msg.CancelAgent)],
            "Cancel",
          )
        False -> html.text("")
      },
      button(
        [
          attribute.class("secondary iconButton"),
          attribute.title("Export ZIP"),
          attribute.aria_label("Export ZIP"),
          event.on_click(msg.ExportZip),
        ],
        "⬇️",
      ),
      button(
        [
          attribute.class("secondary iconButton"),
          attribute.title("Reset to default app"),
          attribute.aria_label("Reset to default app"),
          event.on_click(msg.ResetProject),
        ],
        "↺",
      ),
    ]),
  ])
}

pub fn budget_exhausted_message(reset_at: String) -> String {
  case string.slice(reset_at, 0, 10) {
    "" -> "Monthly build budget used up. Upgrade to keep building."
    date ->
      "Monthly build budget used up. Upgrade or wait until " <> date <> "."
  }
}

/// Built inside a decoder so the id and timestamp are generated when the
/// event fires, not when the view renders.
fn submit_prompt_msg() -> msg.Msg {
  msg.SubmitPrompt(ids.new_request_id(), ids.now_ms())
}

pub fn submit_click_decoder() -> decode.Decoder(msg.Msg) {
  use _ <- decode.then(decode.success(Nil))
  decode.success(submit_prompt_msg())
}

pub fn submit_shortcut_decoder() -> decode.Decoder(msg.Msg) {
  use key <- decode.field("key", decode.string)
  use ctrl <- decode.field("ctrlKey", decode.bool)
  use meta <- decode.field("metaKey", decode.bool)
  case key == "Enter" && { ctrl || meta } {
    True -> decode.success(submit_prompt_msg())
    False -> decode.success(msg.NoOp)
  }
}

fn message_view(
  message: chat.Message,
  index: Int,
  expanded: Bool,
) -> Element(msg.Msg) {
  let role_class = case message.role, expanded {
    chat.User, True -> "msg user expanded"
    chat.User, False -> "msg user"
    chat.Assistant, True -> "msg assistant expanded"
    chat.Assistant, False -> "msg assistant"
  }
  html.button(
    [
      attribute.type_("button"),
      attribute.class(role_class),
      event.on_click(msg.Chat(chat.MessageToggled(index))),
    ],
    [html.text(message.content)],
  )
}

fn button(attrs, label: String) {
  html.button([attribute.type_("button"), ..attrs], [html.text(label)])
}
