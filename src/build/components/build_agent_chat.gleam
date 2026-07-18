import build/actors/chat
import build/actors/interview
import build/components/build_bolt
import build/msg
import build/runtime/ids
import gleam/dynamic/decode
import gleam/int
import gleam/list
import gleam/option.{type Option}
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
  interview_state: interview.State,
  preview_error: Option(String),
) -> Element(msg.Msg) {
  let interviewing = interview.is_active(interview_state)
  fragment([
    html.div([attribute.class("chatTools")], [
      html.span([], [
        html.text(case interviewing {
          True -> "Interview"
          False -> int.to_string(list.length(messages)) <> " messages"
        }),
      ]),
      html.div([attribute.class("chatToolButtons")], [
        button(
          [
            attribute.class("ghost compact"),
            attribute.disabled(messages == [] || busy),
            event.on_click(msg.Chat(chat.ChatCleared)),
          ],
          "Clear chat",
        ),
        button(
          [
            attribute.class("ghost compact"),
            attribute.title("Export ZIP"),
            attribute.aria_label("Export ZIP"),
            event.on_click(msg.ExportZip),
          ],
          "⬇️",
        ),
        button(
          [
            attribute.class("ghost compact"),
            attribute.title("Reset to default app"),
            attribute.aria_label("Reset to default app"),
            event.on_click(msg.ResetProject),
          ],
          "↺",
        ),
      ]),
    ]),
    html.div([attribute.class("messages")], case interviewing, messages {
      True, _ -> interview_thread(interview_state)
      False, [] -> [
        html.p([attribute.class("empty")], [
          html.text(
            "Try: “Turn this into a CRM with contacts and notes saved to the database.”",
          ),
        ]),
      ]
      False, _ ->
        list.index_map(messages, fn(message, index) {
          message_view(message, index, list.contains(expanded_messages, index))
        })
    }),
    // Preview-error card: the scariest moment becomes a one-click ritual.
    // Sits above the composer, in the reading path from messages to input.
    // Never shown mid-interview (no app of yours is running yet).
    case preview_error, interviewing {
      option.Some(error_text), False ->
        html.div([attribute.class("previewErrorCard")], [
          html.strong([], [html.text("The preview hit an error")]),
          html.pre([], [html.text(error_text)]),
          html.div([attribute.class("actions")], [
            button(
              [
                attribute.class("compact"),
                attribute.disabled(busy || budget_exhausted),
                event.on("click", fix_click_decoder()),
              ],
              "Try to fix",
            ),
          ]),
        ])
      _, _ -> html.text("")
    },
    html.textarea(
      [
        attribute.placeholder(case
          interview.current_question(interview_state),
          interview_state.stage
        {
          Ok(question), _ -> question.placeholder
          Error(_), interview.Reviewing ->
            "Want to add anything before I build?"
          Error(_), _ -> "Describe the app change you want..."
        }),
        event.on_input(fn(value) { msg.Chat(chat.PromptChanged(value)) }),
        event.on("keydown", submit_shortcut_decoder()),
      ],
      prompt,
    ),
    case running {
      True ->
        html.div([attribute.class("thinking")], [
          build_bolt.glyph("boltPulse"),
          html.text("hyper is thinking…"),
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
          // Answering interview questions touches no container and no model:
          // the button must stay live through remounts and budget exhaustion
          // (the update layer already accepts answers then).
          attribute.disabled(case interviewing {
            True -> False
            False -> busy || budget_exhausted
          }),
          event.on("click", submit_click_decoder()),
        ],
        case busy && !interviewing {
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
    ]),
  ])
}

// --- the onboarding interview, rendered as a conversation ---
// Virtual bubbles derived from interview state: visually chat, never
// persisted. One question at a time; helper text rides inside the bubble;
// the composer (with the question's placeholder) is the answer box.

fn interview_thread(state: interview.State) -> List(Element(msg.Msg)) {
  // Skipped questions leave no trace — a stack of unanswered bubbles reads
  // as a broken conversation, and the recap restates everything anyway.
  let history =
    list.flat_map(interview.asked_so_far(state), fn(pair) {
      let #(question, answer) = pair
      case answer {
        "" -> []
        _ -> [
          question_bubble(question),
          html.div([attribute.class("msg user interviewMsg")], [
            html.text(answer),
          ]),
        ]
      }
    })
  case state.stage {
    interview.Asking(index) ->
      list.append(history, [
        case interview.current_question(state) {
          Ok(question) -> question_bubble(question)
          Error(_) -> html.text("")
        },
        html.div([attribute.class("interviewActions")], [
          button(
            [
              attribute.class("ghost compact"),
              event.on_click(msg.Interview(interview.QuestionSkipped)),
            ],
            "Skip",
          ),
          case index == 0 {
            True ->
              button(
                [
                  attribute.class("ghost compact"),
                  event.on_click(msg.Interview(interview.InterviewDismissed)),
                ],
                "Just describe it instead",
              )
            False -> html.text("")
          },
        ]),
      ])
    interview.Reviewing ->
      list.append(history, [
        html.div([attribute.class("msg assistant interviewMsg")], [
          html.text("Here's what I heard — I'll build from this plan:"),
          html.span([attribute.class("interviewHelper")], [
            html.text(interview.plan_summary(state.answers)),
          ]),
        ]),
        html.div([attribute.class("interviewActions")], [
          html.button(
            [
              attribute.type_("button"),
              event.on("click", interview_build_decoder()),
            ],
            [html.text("Build my app")],
          ),
          button(
            [
              attribute.class("ghost compact"),
              event.on_click(msg.Interview(interview.InterviewStarted)),
            ],
            "Start over",
          ),
        ]),
      ])
    interview.Idle -> history
  }
}

fn question_bubble(question: interview.Question) -> Element(msg.Msg) {
  html.div([attribute.class("msg assistant interviewMsg")], [
    html.text(question.label),
    html.span([attribute.class("interviewHelper")], [
      html.text(question.helper),
    ]),
  ])
}

/// Built inside a decoder so the id and timestamp are generated when the
/// event fires, not when the view renders.
fn interview_build_msg() -> msg.Msg {
  msg.InterviewBuild(ids.new_request_id(), ids.now_ms())
}

fn interview_build_decoder() -> decode.Decoder(msg.Msg) {
  use _ <- decode.then(decode.success(Nil))
  decode.success(interview_build_msg())
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

pub fn fix_click_decoder() -> decode.Decoder(msg.Msg) {
  use _ <- decode.then(decode.success(Nil))
  decode.success(msg.FixPreviewError(ids.new_request_id(), ids.now_ms()))
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
  let bubble =
    html.button(
      [
        attribute.type_("button"),
        attribute.class(role_class),
        event.on_click(msg.Chat(chat.MessageToggled(index))),
      ],
      [html.text(message.content)],
    )
  // Narration chips: the files this turn touched, as a quiet sibling row —
  // outside the bubble so the 5-line clamp never hides or stretches them.
  case message.paths {
    [] -> bubble
    paths ->
      fragment([
        bubble,
        html.div(
          [attribute.class("msgChips")],
          list.map(paths, fn(path) {
            html.span([attribute.class("msgChip")], [html.text(path)])
          }),
        ),
      ])
  }
}

fn button(attrs, label: String) {
  html.button([attribute.type_("button"), ..attrs], [html.text(label)])
}
