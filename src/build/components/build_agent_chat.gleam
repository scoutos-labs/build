import build/actors/agent
import build/actors/chat
import build/actors/settings
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
  agent_state: agent.State,
  settings_state: settings.State,
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
    approval_card(agent_state),
    trail_view(agent_state, running),
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
      // Model choice belongs where the work is chosen, not buried in settings:
      // picking how hard to think is part of composing a request.
      job_picker(settings_state, busy),
    ]),
  ])
}

/// The one gated moment in the harness.
///
/// `fs_*` and `exec` run unattended because they cannot escape the
/// WebContainer. `web_post` reaches out of it and changes something in the
/// world, so it stops and shows the user the whole request — method, host, and
/// the exact body. A card that summarized would be a card that hid something.
fn approval_card(state: agent.State) -> Element(msg.Msg) {
  case state.pending_approval {
    option.None -> html.text("")
    option.Some(approval) ->
      html.div([attribute.class("approvalCard")], [
        html.strong([], [
          html.text("hyper wants to send data to " <> host_of(approval.url)),
        ]),
        html.p([attribute.class("approvalTarget")], [
          html.text(approval.method <> " " <> approval.url),
        ]),
        html.pre([], [html.text(approval.body)]),
        case approval.blocked {
          "" ->
            html.div([attribute.class("actions")], [
              button(
                [
                  attribute.class("compact"),
                  event.on_click(msg.Agent(agent.AgentApprovalResolved(
                    approval_request_id(state),
                    True,
                  ))),
                ],
                "Send it",
              ),
              button(
                [
                  attribute.class("ghost compact"),
                  event.on_click(msg.Agent(agent.AgentApprovalResolved(
                    approval_request_id(state),
                    False,
                  ))),
                ],
                "Don't send",
              ),
            ])
          reason ->
            html.div([], [
              html.p([attribute.class("approvalBlocked")], [html.text(reason)]),
              html.div([attribute.class("actions")], [
                button(
                  [
                    attribute.class("ghost compact"),
                    event.on_click(msg.Agent(agent.AgentApprovalResolved(
                      approval_request_id(state),
                      False,
                    ))),
                  ],
                  "OK",
                ),
              ]),
            ])
        },
      ])
  }
}

fn approval_request_id(state: agent.State) -> String {
  case state.lifecycle {
    agent.Running(request_id, _) -> request_id
    _ -> ""
  }
}

/// Host only in the headline — the full URL is on its own line below, so the
/// question reads as a sentence rather than a URL.
fn host_of(url: String) -> String {
  case string.split(url, "//") {
    [_, rest, ..] ->
      case string.split(rest, "/") {
        [host, ..] -> host
        [] -> url
      }
    _ -> url
  }
}

/// The job picker.
///
/// Never shows a model id. A founder cannot evaluate "claude-sonnet-4.6 vs
/// gpt-5.5", but they can tell you whether this is a small tweak or a hard
/// problem — and the tradeoff they actually feel is their monthly budget, which
/// is what the option text talks about.
///
/// Hidden for Ollama: it has no tool mode and no catalog, so a job picker there
/// would promise a choice that does not exist.
fn job_picker(state: settings.State, busy: Bool) -> Element(msg.Msg) {
  case state.provider {
    settings.Ollama -> html.text("")
    settings.OpenRouter ->
      html.label([attribute.class("jobPicker")], [
        html.span([attribute.class("srOnly")], [html.text("How much thinking")]),
        html.select(
          [
            attribute.disabled(busy),
            attribute.title(settings.job_blurb(state.job)),
            event.on_input(fn(value) {
              msg.Settings(settings.JobChanged(settings.job_from_string(value)))
            }),
          ],
          list.map(settings.all_jobs(), fn(job) {
            html.option(
              [
                attribute.value(settings.job_to_string(job)),
                attribute.selected(job == state.job),
              ],
              settings.job_label(job),
            )
          }),
        ),
      ])
  }
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

// --- the activity trail ---
//
// Deliberately NOT a growing list of tool calls. While the agent works this is a
// single line that *changes*: bolt, a present-tense verb, and the file it is on.
// A twelve-row log would push the composer off a laptop screen and would read as
// CI output to a founder whose prompt explicitly forbids jargon and file paths.
//
// When the turn ends the line becomes one quiet summary — "3 steps · 1 file ·
// checked it builds" — that expands on click. The steps are receipts; the
// summary is the product.
//
// Amber appears on exactly one element at a time: the bolt on the active step.
// Finished rows are slate. That is the brand's working-state signature and it
// stops meaning anything if more than one thing wears it.

fn trail_view(state: agent.State, running: Bool) -> Element(msg.Msg) {
  // While an approval is up, the agent is not thinking — it is waiting on the
  // user, and the card right above says what for.
  case state.pending_approval {
    option.Some(_) ->
      html.div([attribute.class("thinking")], [
        build_bolt.glyph("boltPulse"),
        html.text("waiting for you"),
      ])
    option.None -> trail_working_view(state, running)
  }
}

fn trail_working_view(state: agent.State, running: Bool) -> Element(msg.Msg) {
  case running, state.trail {
    // Working, but no tool has been picked up yet.
    True, [] ->
      html.div([attribute.class("thinking")], [
        build_bolt.glyph("boltPulse"),
        html.text("hyper is thinking…"),
      ])

    // Working: one mutating line showing the step in flight.
    True, trail ->
      html.div([attribute.class("thinking")], [
        build_bolt.glyph("boltPulse"),
        html.text(active_summary(trail)),
      ])

    // Idle with nothing to show.
    False, [] -> html.text("")

    // Finished: the collapsed summary, expandable.
    False, trail ->
      html.div([attribute.class("trail")], [
        html.button(
          [
            attribute.class("trailSummary"),
            attribute.attribute("aria-expanded", case state.trail_expanded {
              True -> "true"
              False -> "false"
            }),
            event.on_click(msg.Agent(agent.AgentTrailToggled)),
          ],
          [
            html.span([attribute.class("trailCount")], [
              html.text(agent.turn_summary(state)),
            ]),
            html.span([attribute.class("trailChevron")], [
              html.text(case state.trail_expanded {
                True -> "Hide"
                False -> "Show"
              }),
            ]),
          ],
        ),
        // The counterweight to unattended writing. Offered only when the turn
        // actually changed files, and only for the most recent one — the
        // realistic regret is always "that last one made it worse".
        case agent.can_undo(state) {
          True ->
            html.div([attribute.class("trailUndo")], [
              button(
                [
                  attribute.class("ghost compact"),
                  event.on_click(msg.Agent(agent.AgentUndoRequested)),
                ],
                "Undo this build",
              ),
            ])
          False -> html.text("")
        },
        case state.trail_expanded {
          True ->
            html.ol(
              [attribute.class("trailSteps")],
              list.map(trail, trail_row),
            )
          False -> html.text("")
        },
      ])
  }
}

/// The line shown while working: the step currently in flight, or the most
/// recent finished one while the next request is in the air.
fn active_summary(trail: List(agent.TrailStep)) -> String {
  let running_step =
    list.find(trail, fn(step) { step.status == agent.ToolRunning })
  case running_step {
    Ok(step) ->
      case step.summary {
        "" -> "hyper is working…"
        text -> text
      }
    Error(_) ->
      case list.last(trail) {
        Ok(step) if step.summary != "" -> step.summary
        _ -> "hyper is working…"
      }
  }
}

fn trail_row(step: agent.TrailStep) -> Element(msg.Msg) {
  html.li(
    [
      attribute.class(case step.status {
        agent.ToolFailed -> "trailStep trailStepProblem"
        _ -> "trailStep"
      }),
    ],
    [
      html.text(case step.summary {
        "" -> "Working…"
        text -> text
      }),
    ],
  )
}
