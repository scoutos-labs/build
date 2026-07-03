import build/actors/agent
import build/actors/chat
import build/actors/interview
import build/actors/preview
import build/actors/project
import build/actors/settings
import build/actors/webcontainer
import build/effect
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

// --- Step 2/3: wiring, triggers, composer routing, reveal rules ---

fn configured() -> settings.State {
  settings.State(
    ..settings.init(),
    model: "anthropic/claude-3.5-sonnet",
    api_key: "sk-test",
    settings_open: False,
  )
}

fn ready() -> webcontainer.State {
  webcontainer.State(..webcontainer.init(), boot_phase: webcontainer.Ready)
}

pub fn project_ready_starts_interview_for_fresh_project_test() {
  let #(next, _) =
    update.update(model.init(), msg.Project(project.ProjectReady))
  assert next.interview.stage == interview.Asking(0)
}

pub fn project_ready_skips_interview_for_built_project_test() {
  let app =
    model.Model(
      ..model.init(),
      chat: chat.State(
        messages: [chat.Message(chat.User, "hi")],
        prompt: "",
        expanded_messages: [],
      ),
    )
  let #(next, _) = update.update(app, msg.Project(project.ProjectReady))
  assert next.interview.stage == interview.Idle
}

pub fn saved_project_with_messages_never_reinterviews_test() {
  let mid_interview = model.Model(..model.init(), interview: started())
  let #(next, _) =
    update.update(
      mid_interview,
      msg.Chat(chat.MessagesReplaced([chat.Message(chat.User, "old chat")])),
    )
  assert next.interview.stage == interview.Idle
}

pub fn open_empty_project_restarts_interview_test() {
  // an opened never-chatted, never-built project gets a fresh interview
  let #(next, _) =
    update.update(model.init(), msg.Chat(chat.MessagesReplaced([])))
  assert next.interview.stage == interview.Asking(0)
  assert next.interview.answers == list.repeat("", 7)
}

pub fn open_project_discards_stale_answers_test() {
  let mid_interview =
    model.Model(
      ..model.init(),
      interview: answer_all(started(), ["stale", "answers", "here"]),
    )
  let #(next, _) = update.update(mid_interview, msg.OpenProject("p1"))
  assert next.interview == interview.init()
}

pub fn clear_chat_does_not_reinterview_test() {
  let app =
    model.Model(
      ..model.init(),
      chat: chat.State(
        messages: [chat.Message(chat.User, "hi")],
        prompt: "",
        expanded_messages: [],
      ),
    )
  let #(next, _) = update.update(app, msg.Chat(chat.ChatCleared))
  assert next.interview.stage == interview.Idle
}

pub fn answer_during_remount_is_accepted_test() {
  // answering a question touches no container and no model — it must work
  // even mid-remount and with the budget exhausted
  let app =
    model.Model(
      ..model.init(),
      interview: started(),
      chat: chat.State(messages: [], prompt: "  a CRM  ", expanded_messages: []),
      agent: agent.State(..agent.init(), budget_exhausted: True),
      webcontainer: webcontainer.State(
        ..webcontainer.init(),
        boot_phase: webcontainer.Remounting,
      ),
    )
  let #(next, _) = update.update(app, msg.SubmitPrompt("req", 1000))
  assert next.interview.stage == interview.Asking(1)
  assert list.first(next.interview.answers) == Ok("a CRM")
  assert next.chat.prompt == ""
  assert !agent.is_running(next.agent)
}

pub fn empty_submit_while_asking_is_noop_test() {
  let app =
    model.Model(
      ..model.init(),
      interview: started(),
      chat: chat.State(messages: [], prompt: "   ", expanded_messages: []),
    )
  let #(next, _) = update.update(app, msg.SubmitPrompt("req", 1000))
  assert next.interview.stage == interview.Asking(0)
  assert !agent.is_running(next.agent)
}

fn reviewing_app() -> model.Model {
  model.Model(
    ..model.init(),
    settings: configured(),
    interview: answer_all(started(), [
      "a dog-walking scheduler", "busy owners", "book walks", "calendar",
      "walks with dates", "warm", "none",
    ]),
    webcontainer: ready(),
  )
}

pub fn interview_build_seeds_brain_test() {
  let #(next, effects) =
    update.update(reviewing_app(), msg.InterviewBuild("req", 1000))

  assert agent.is_running(next.agent)
  assert next.interview.stage == interview.Idle
  assert list.any(next.project.files, fn(file) {
    file.path == brain.brain_path
    && string.contains(file.content, "a dog-walking scheduler")
  })
  assert list.any(effects, fn(eff) {
    case eff {
      effect.Project(project.WriteFileToContainer("BRAIN.md", _)) -> True
      _ -> False
    }
  })
}

pub fn gated_build_keeps_reviewing_test() {
  // agent already running: the dispatch is a no-op and the recap must keep
  // every answer — idling here would silently destroy the founder's input
  let app =
    model.Model(
      ..reviewing_app(),
      agent: agent.State(..agent.init(), lifecycle: agent.Running("other", 1)),
    )
  let #(next, effects) = update.update(app, msg.InterviewBuild("req", 1000))
  assert next.interview.stage == interview.Reviewing
  assert next.interview == app.interview
  assert effects == []

  // BYOK settings missing: modal opens, recap and answers survive
  let unconfigured =
    model.Model(..reviewing_app(), settings: settings.init())
  let #(after, _) = update.update(unconfigured, msg.InterviewBuild("req", 1000))
  assert after.settings.settings_open
  assert after.interview.stage == interview.Reviewing
}

pub fn url_during_interview_does_not_reveal_test() {
  let app = model.Model(..model.init(), interview: started())
  let #(next, _) =
    update.update(app, msg.Preview(preview.PreviewUrlChanged("http://p")))
  assert next.preview.layout == preview.ChatMode
  assert next.preview.preview_url == "http://p"
}

pub fn interview_end_reveals_split_test() {
  let app =
    model.Model(
      ..reviewing_app(),
      preview: preview.State(..preview.init(), preview_url: "http://p"),
    )
  let #(next, _) = update.update(app, msg.InterviewBuild("req", 1000))
  assert next.preview.layout == preview.SplitMode
}

pub fn interview_end_respects_manual_chat_test() {
  let app =
    model.Model(
      ..reviewing_app(),
      preview: preview.State(
        ..preview.init(),
        preview_url: "http://p",
        layout_is_manual: True,
      ),
    )
  let #(next, _) = update.update(app, msg.InterviewBuild("req", 1000))
  assert next.preview.layout == preview.ChatMode
}

pub fn dismiss_with_url_reveals_test() {
  let app =
    model.Model(
      ..model.init(),
      interview: started(),
      preview: preview.State(..preview.init(), preview_url: "http://p"),
    )
  let #(next, _) =
    update.update(app, msg.Interview(interview.InterviewDismissed))
  assert next.interview.stage == interview.Idle
  assert next.preview.layout == preview.SplitMode
}

pub fn dismiss_before_url_keeps_auto_reveal_test() {
  let app = model.Model(..model.init(), interview: started())
  let #(dismissed, _) =
    update.update(app, msg.Interview(interview.InterviewDismissed))
  assert dismissed.preview.layout == preview.ChatMode

  // interview idle now: the normal URL-arrival reveal is re-armed
  let #(next, _) =
    update.update(
      dismissed,
      msg.Preview(preview.PreviewUrlChanged("http://p")),
    )
  assert next.preview.layout == preview.SplitMode
}
