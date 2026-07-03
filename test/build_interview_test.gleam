import build/actors/agent
import build/actors/chat
import build/actors/interview
import build/actors/preview
import build/actors/project
import build/actors/settings
import build/actors/webcontainer
import build/model
import build/msg
import build/pure/brain
import build/update
import gleam/list
import gleam/string

fn started() -> interview.State {
  interview.update(interview.init(), interview.InterviewStarted)
}

fn answer_all(state: interview.State, answers: List(String)) -> interview.State {
  list.fold(answers, state, fn(current, text) {
    interview.update(current, interview.AnswerSubmitted(text))
  })
}

// --- Step 1: actor + plan-summary golden ---

pub fn interview_plan_summary_matches_legacy_format_test() {
  // Golden: the exact output the iframe wizard produced for blank answers
  // (fallback strings from the legacy compact() calls). BRAIN.md seeding and
  // the agent prompt consume this verbatim.
  let expected =
    "Build an app for: A useful web app based on the interview answers"
    <> "\n\nTarget users: People who need a simpler workflow"
    <> "\n\nMain goal: Help users complete their core task quickly"
    <> "\n\nMust-have features: A polished dashboard, clear navigation, create/edit flows, and helpful empty states"
    <> "\n\nData model / persistence: Local app records with sensible fields and sample data"
    <> "\n\nVisual direction: Modern, friendly, responsive, and production-quality"
    <> "\n\nExtras / constraints: Keep it runnable in the browser with React, TypeScript, Vite, Tailwind CSS, shadcn/ui, and the hyper-zepto db helpers in src/db.ts when persistence is useful"

  assert interview.plan_summary(list.repeat("", 7)) == expected

  // Mixed answers: provided values are trimmed and used; blanks fall back.
  let mixed =
    interview.plan_summary([
      "  A dog-walking scheduler  ", "", "book walks fast", "", "", "warm and playful", "",
    ])
  assert string.contains(mixed, "Build an app for: A dog-walking scheduler\n\n")
  assert string.contains(mixed, "Target users: People who need a simpler workflow")
  assert string.contains(mixed, "Main goal: book walks fast")
  assert string.contains(mixed, "Visual direction: warm and playful")
}

pub fn skip_records_fallback_answer_test() {
  let state = started()
  let after_skip = interview.update(state, interview.QuestionSkipped)
  assert after_skip.stage == interview.Asking(1)
  assert list.first(after_skip.answers) == Ok("")
}

pub fn seventh_answer_moves_to_reviewing_test() {
  let state =
    answer_all(started(), ["a", "b", "c", "d", "e", "f", "g"])
  assert state.stage == interview.Reviewing
  assert state.answers == ["a", "b", "c", "d", "e", "f", "g"]
}

pub fn dismiss_returns_to_idle_test() {
  let state = answer_all(started(), ["a", "b"])
  let dismissed = interview.update(state, interview.InterviewDismissed)
  assert dismissed == interview.init()
  assert !interview.is_active(dismissed)
}

pub fn empty_answer_is_a_noop_test() {
  let state = started()
  let after = interview.update(state, interview.AnswerSubmitted("   "))
  assert after == state
}

pub fn asked_so_far_pairs_questions_with_answers_test() {
  let state = answer_all(started(), ["idea!", "parents"])
  let pairs = interview.asked_so_far(state)
  assert list.length(pairs) == 2
  assert list.map(pairs, fn(pair) { pair.1 }) == ["idea!", "parents"]
}
