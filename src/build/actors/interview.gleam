//// The onboarding interview, rendered natively in the chat panel. Questions
//// and answers are VIRTUAL bubbles derived from this state — they are never
//// appended to chat.messages, so persistence, the agent context, and the
//// Build Story see only the final plan message that BuildFromPlan appends.
////
//// This module is also the single source of truth for the plan summary
//// format (previously duplicated inside the starter template's wizard):
//// "Build an app for: ...\n\nTarget users: ..." — consumed verbatim by
//// build_from_plan and BRAIN.md seeding, so the wording is load-bearing.

import gleam/list
import gleam/string

pub type Stage {
  Idle
  // 0-based index into questions()
  Asking(index: Int)
  Reviewing
}

pub type State {
  State(stage: Stage, answers: List(String))
}

pub type Question {
  Question(key: String, label: String, helper: String, placeholder: String)
}

pub type Msg {
  InterviewStarted
  // Empty/whitespace answers are a no-op: Enter-happy founders must not
  // skip questions silently — Skip is the explicit affordance.
  AnswerSubmitted(String)
  QuestionSkipped
  InterviewDismissed
}

pub fn init() -> State {
  State(stage: Idle, answers: [])
}

pub fn is_active(state: State) -> Bool {
  state.stage != Idle
}

pub fn questions() -> List(Question) {
  [
    Question(
      "idea",
      "What do you want to build?",
      "Name the app idea in one or two sentences.",
      "A booking app for local yoga instructors, a client portal for my agency...",
    ),
    Question(
      "audience",
      "Who is it for?",
      "Describe the people who will use this app.",
      "Busy parents, freelance designers, restaurant managers...",
    ),
    Question(
      "problem",
      "What should it help them do?",
      "Focus on the main job, frustration, or outcome — and why it matters to them.",
      "Track leads, schedule appointments, organize tasks, learn a skill...",
    ),
    Question(
      "features",
      "What are the must-have features?",
      "List the screens, actions, or workflows you know you need.",
      "Dashboard, profiles, search, comments, status filters, admin view...",
    ),
    Question(
      "data",
      "What information should it save?",
      "Mention important records, fields, or relationships.",
      "Customers with name/email/status, projects with tasks and due dates...",
    ),
    Question(
      "style",
      "How should it look and feel?",
      "Pick a vibe or an app to resemble — and share a working name if you have one.",
      "Clean and modern like Linear, playful and colorful, premium SaaS...",
    ),
    Question(
      "integrations",
      "Any extras or constraints?",
      "Auth, payments, uploads, charts, mobile-first, or anything to avoid.",
      "Login later, no payments yet, mobile-first, local browser database is fine...",
    ),
  ]
}

pub fn question_count() -> Int {
  list.length(questions())
}

pub fn current_question(state: State) -> Result(Question, Nil) {
  case state.stage {
    Asking(index) -> list.drop(questions(), index) |> list.first
    _ -> Error(Nil)
  }
}

/// Questions already answered, paired with the founder's (possibly empty)
/// answers — what the view renders as the virtual transcript so far.
pub fn asked_so_far(state: State) -> List(#(Question, String)) {
  let answered = case state.stage {
    Idle -> 0
    Asking(index) -> index
    Reviewing -> question_count()
  }
  list.zip(list.take(questions(), answered), list.take(state.answers, answered))
}

pub fn update(state: State, msg: Msg) -> State {
  case msg {
    InterviewStarted ->
      State(stage: Asking(0), answers: list.repeat("", question_count()))
    AnswerSubmitted(text) ->
      case state.stage, string.trim(text) {
        Asking(_), "" -> state
        Asking(index), trimmed -> advance(state, index, trimmed)
        _, _ -> state
      }
    QuestionSkipped ->
      case state.stage {
        Asking(index) -> advance(state, index, "")
        _ -> state
      }
    InterviewDismissed -> init()
  }
}

fn advance(state: State, index: Int, answer: String) -> State {
  let answers =
    list.index_map(state.answers, fn(existing, position) {
      case position == index {
        True -> answer
        False -> existing
      }
    })
  let stage = case index + 1 < question_count() {
    True -> Asking(index + 1)
    False -> Reviewing
  }
  State(stage: stage, answers: answers)
}

/// The exact plan summary the iframe wizard used to produce — format and
/// fallback strings are golden-tested against the legacy template output.
pub fn plan_summary(answers: List(String)) -> String {
  let field = fn(index, fallback) {
    let value =
      list.drop(answers, index)
      |> list.first
      |> fn(result) {
        case result {
          Ok(text) -> string.trim(text)
          Error(_) -> ""
        }
      }
    case value {
      "" -> fallback
      trimmed -> trimmed
    }
  }
  "Build an app for: "
  <> field(0, "A useful web app based on the interview answers")
  <> "\n\nTarget users: "
  <> field(1, "People who need a simpler workflow")
  <> "\n\nMain goal: "
  <> field(2, "Help users complete their core task quickly")
  <> "\n\nMust-have features: "
  <> field(
    3,
    "A polished dashboard, clear navigation, create/edit flows, and helpful empty states",
  )
  <> "\n\nData model / persistence: "
  <> field(4, "Local app records with sensible fields and sample data")
  <> "\n\nVisual direction: "
  <> field(5, "Modern, friendly, responsive, and production-quality")
  <> "\n\nExtras / constraints: "
  <> field(
    6,
    "Keep it runnable in the browser with React, TypeScript, Vite, Tailwind CSS, shadcn/ui, and the hyper-zepto db helpers in src/db.ts when persistence is useful",
  )
}
