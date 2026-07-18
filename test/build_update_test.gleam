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
import build/pure/build_log
import build/pure/preview_inspector
import build/pure/story
import build/update
import gleam/list
import gleam/option
import gleam/string
import gleeunit

pub fn main() -> Nil {
  gleeunit.main()
}

pub fn init_app_loads_project_test() {
  let #(next, effects) = update.update(model.init(), msg.InitApp)

  assert next == model.init()
  assert effects
    == [
      effect.Settings(settings.LoadSettings),
      effect.Project(project.LoadInitialProject),
    ]
}

pub fn project_ready_boots_webcontainer_test() {
  let #(next, effects) =
    update.update(model.init(), msg.Project(project.ProjectReady))

  assert next.project.project_ready
  assert effects
    == [effect.WebContainer(webcontainer.BootContainer(next.project.files))]
}

pub fn improve_selected_element_starts_agent_test() {
  let selected =
    preview_inspector.SelectedPreviewElement(
      tag_name: "BUTTON",
      id: "cta",
      classes: [],
      text_content: "Start",
      outer_html: "<button>Start</button>",
      bounding_rect: preview_inspector.BoundingRect(0.0, 0.0, 10.0, 10.0),
      computed_styles: [],
    )
  let configured_settings =
    settings.State(
      ..settings.init(),
      model: "qwen/qwen3.6-35b-a3b",
      api_key: "sk-test",
      settings_open: False,
    )
  let app =
    model.Model(
      ..model.init(),
      settings: configured_settings,
      preview: preview.State(
        ..preview.init(),
        selected_element: option.Some(selected),
        element_comment: "Make it calmer",
      ),
      webcontainer: webcontainer.State(
        ..webcontainer.init(),
        boot_phase: webcontainer.Ready,
      ),
    )
  let #(next, effects) =
    update.update(app, msg.ImproveSelectedElement("imp", 1000))

  assert next.agent.lifecycle == agent.Running("imp", 1000)
  assert effects
    == [
      effect.Settings(settings.PersistSettings(
        provider: settings.OpenRouter,
        api_key: "sk-test",
        ollama_url: "http://localhost:11434",
        model: "qwen/qwen3.6-35b-a3b",
      )),
      effect.Agent(agent.StartElapsedTimer),
      effect.Agent(agent.CallAgent(
        request_id: "imp",
        provider: settings.OpenRouter,
        api_key: "sk-test",
        ollama_url: "http://localhost:11434",
        model: "qwen/qwen3.6-35b-a3b",
        user_prompt: "Improve the selected preview element based on the user comment.",
        files: app.project.files,
        messages: [],
        selected_element: option.Some(selected),
        element_comment: "Make it calmer",
      )),
      effect.ScrollMessagesToBottom,
    ]
}

pub fn submit_prompt_opens_settings_when_model_missing_test() {
  let app =
    model.Model(
      ..model.init(),
      chat: chat.State(messages: [], prompt: "make app", expanded_messages: []),
      webcontainer: webcontainer.State(
        ..webcontainer.init(),
        boot_phase: webcontainer.Ready,
      ),
    )
  let #(next, effects) = update.update(app, msg.SubmitPrompt("req", 1000))

  assert next.settings.settings_open
  assert effects == []
}

pub fn save_and_new_project_emit_effects_test() {
  let app = model.init()
  assert update.update(app, msg.SaveProject(True))
    == #(app, [
      effect.Project(project.SaveCurrentProject(
        name: "Untitled Project",
        files: app.project.files,
        messages: app.chat.messages,
        build_log: app.project.build_log,
        selected_path: app.project.selected_path,
        current_project_id: app.project.current_project_id,
        silent: True,
      )),
    ])
  assert update.update(app, msg.NewProject)
    == #(app, [effect.ConfirmNewProject])
  // NewProjectConfirmed now also starts the chat interview
  let #(created, create_effects) = update.update(app, msg.NewProjectConfirmed)
  assert created.interview.stage == interview.Asking(0)
  assert create_effects
    == [
      effect.Project(project.CreateProject(
        name: "Untitled Project",
        files: app.project.files,
        messages: [],
        selected_path: "src/main.tsx",
      )),
    ]
}

pub fn open_remove_and_export_project_emit_effects_test() {
  assert update.update(model.init(), msg.OpenProject("p1"))
    == #(model.init(), [effect.Project(project.OpenProject("p1"))])
  assert update.update(model.init(), msg.RemoveProject("p1"))
    == #(model.init(), [effect.ConfirmRemoveProject("p1")])
  assert update.update(model.init(), msg.RemoveProjectConfirmed("p1"))
    == #(model.init(), [effect.Project(project.DeleteProject("p1"))])
  assert update.update(model.init(), msg.ExportZip)
    == #(model.init(), [effect.ExportZip(model.init().project.files)])
}

pub fn editor_file_changes_debounce_container_write_and_schedule_autosave_test() {
  let app =
    model.Model(
      ..model.init(),
      webcontainer: webcontainer.State(
        ..webcontainer.init(),
        boot_phase: webcontainer.Ready,
        hydrated: True,
      ),
    )
  let #(next, effects) =
    update.update(
      app,
      msg.Project(project.FileEdited("src/main.tsx", "new content")),
    )

  assert next.project.save_status == "Saving..."
  assert effects
    == [
      effect.Project(project.DebouncedWriteFileToContainer(
        2000,
        "src/main.tsx",
        "new content",
      )),
      effect.Project(project.ScheduleSave(
        900,
        next.project.project_name,
        next.project.files,
        next.chat.messages,
        next.project.build_log,
        next.project.selected_path,
        next.project.current_project_id,
      )),
    ]
}

pub fn file_changes_schedule_autosave_when_hydrated_test() {
  let app =
    model.Model(
      ..model.init(),
      webcontainer: webcontainer.State(
        ..webcontainer.init(),
        boot_phase: webcontainer.Ready,
        hydrated: True,
      ),
    )
  let #(next, effects) =
    update.update(
      app,
      msg.Project(project.FileApplied("src/main.tsx", "new content")),
    )

  assert next.project.save_status == "Saving..."
  assert effects
    == [
      effect.Project(project.WriteFileToContainer("src/main.tsx", "new content")),
      effect.Project(project.ScheduleSave(
        900,
        next.project.project_name,
        next.project.files,
        next.chat.messages,
        next.project.build_log,
        next.project.selected_path,
        next.project.current_project_id,
      )),
    ]
}

pub fn agent_success_applies_patches_and_replies_test() {
  let app =
    model.Model(
      ..model.init(),
      agent: agent.State(
        ..agent.init(),
        lifecycle: agent.Running("req", 1000),
      ),
      webcontainer: webcontainer.State(
        ..webcontainer.init(),
        boot_phase: webcontainer.Ready,
        hydrated: True,
      ),
    )
  let #(next, effects) =
    update.update(
      app,
      msg.Agent(
        agent.AgentRequestSucceeded("req", "Done", [
          agent.Patch("src/main.tsx", "patched"),
        ]),
      ),
    )

  assert next.agent.lifecycle == agent.Idle
  assert next.chat.messages == [chat.Message(chat.Assistant, "Done")]
  assert next.project.save_status == "Saving..."
  assert effects
    == [
      effect.Agent(agent.StopElapsedTimer),
      effect.Agent(
        agent.InstallIfNeeded([agent.Patch("src/main.tsx", "patched")]),
      ),
      effect.Project(project.WriteFileToContainer("src/main.tsx", "patched")),
      effect.ScrollMessagesToBottom,
      effect.Project(project.ScheduleSave(
        900,
        next.project.project_name,
        next.project.files,
        next.chat.messages,
        next.project.build_log,
        next.project.selected_path,
        next.project.current_project_id,
      )),
    ]
}

pub fn submit_prompt_appends_user_and_starts_agent_test() {
  let configured_settings =
    settings.State(
      ..settings.init(),
      model: "qwen/qwen3.6-35b-a3b",
      api_key: "sk-test",
      settings_open: False,
    )
  let app =
    model.Model(
      ..model.init(),
      settings: configured_settings,
      chat: chat.State(messages: [], prompt: "make app", expanded_messages: []),
      webcontainer: webcontainer.State(
        ..webcontainer.init(),
        boot_phase: webcontainer.Ready,
      ),
    )
  let #(next, effects) = update.update(app, msg.SubmitPrompt("req", 1000))

  assert next.chat.messages == [chat.Message(chat.User, "make app")]
  assert next.agent.lifecycle == agent.Running("req", 1000)
  assert effects
    == [
      effect.Settings(settings.PersistSettings(
        provider: settings.OpenRouter,
        api_key: "sk-test",
        ollama_url: "http://localhost:11434",
        model: "qwen/qwen3.6-35b-a3b",
      )),
      effect.Agent(agent.StartElapsedTimer),
      effect.Agent(agent.CallAgent(
        request_id: "req",
        provider: settings.OpenRouter,
        api_key: "sk-test",
        ollama_url: "http://localhost:11434",
        model: "qwen/qwen3.6-35b-a3b",
        user_prompt: "make app",
        files: app.project.files,
        messages: [],
        selected_element: option.None,
        element_comment: "",
      )),
      effect.ScrollMessagesToBottom,
    ]
}

pub fn build_from_plan_seeds_brain_test() {
  let configured_settings =
    settings.State(
      ..settings.init(),
      model: "anthropic/claude-3.5-sonnet",
      api_key: "sk-test",
      settings_open: False,
    )
  let app =
    model.Model(
      ..model.init(),
      settings: configured_settings,
      webcontainer: webcontainer.State(
        ..webcontainer.init(),
        boot_phase: webcontainer.Ready,
      ),
    )
  let #(next, effects) =
    update.update(
      app,
      msg.BuildFromPlan("Build an app for: dog walkers", "req", 1000),
    )

  // The seed exists in project files before the agent responds, so the What
  // & Why survives even if the model never maintains BRAIN.md.
  assert list.any(next.project.files, fn(file) {
    file.path == "BRAIN.md" && string.contains(file.content, "dog walkers")
  })
  assert next.agent.lifecycle == agent.Running("req", 1000)
  assert list.any(effects, fn(eff) {
    case eff {
      effect.Project(project.WriteFileToContainer("BRAIN.md", _)) -> True
      _ -> False
    }
  })
}

pub fn agent_success_appends_build_log_entry_test() {
  let app =
    model.Model(
      ..model.init(),
      agent: agent.State(
        ..agent.init(),
        lifecycle: agent.Running("req", 1234),
      ),
      chat: chat.State(
        messages: [chat.Message(chat.User, "make a todo app")],
        prompt: "",
        expanded_messages: [],
      ),
      webcontainer: webcontainer.State(
        ..webcontainer.init(),
        boot_phase: webcontainer.Ready,
        hydrated: True,
      ),
    )
  let #(next, _) =
    update.update(
      app,
      msg.Agent(
        agent.AgentRequestSucceeded("req", "Done", [
          agent.Patch("src/main.tsx", "patched"),
        ]),
      ),
    )

  assert next.project.build_log
    == [build_log.entry(1234, "make a todo app", "Done", ["src/main.tsx"])]
}

pub fn story_dialog_opens_and_closes_test() {
  let #(opened, open_effects) =
    update.update(model.init(), msg.Project(project.StoryDialogOpened))
  assert opened.project.story_open
  assert open_effects == []

  let #(closed, close_effects) =
    update.update(opened, msg.Project(project.StoryDialogClosed))
  assert !closed.project.story_open
  assert close_effects == []
}

pub fn export_story_emits_derived_story_test() {
  let #(_, effects) = update.update(model.init(), msg.ExportStory)

  assert effects
    == [
      effect.ExportStoryHtml(story.from_project(
        "Untitled Project",
        [],
        [],
        model.init().project.files,
      )),
    ]
}

// --- Landing idea seeding (pre-auth landing → post-boot dispatch) ---

pub fn landing_idea_answers_first_interview_question_test() {
  // Empty project hydrates: interview starts at question one.
  let #(booted, _) =
    update.update(model.init(), msg.Chat(chat.MessagesReplaced([])))
  assert booted.interview.stage == interview.Asking(0)

  let #(next, effects) =
    update.update(booted, msg.LandingIdeaArrived("A yoga booking app"))

  assert next.interview.stage == interview.Asking(1)
  assert list.first(next.interview.answers) == Ok("A yoga booking app")
  assert effects == []
}

pub fn landing_idea_falls_back_to_composer_with_history_test() {
  // A project with chat history hydrates: no interview, idea must not vanish.
  let loaded = [chat.Message(chat.User, "hi"), chat.Message(chat.Assistant, "yo")]
  let #(booted, _) =
    update.update(model.init(), msg.Chat(chat.MessagesReplaced(loaded)))
  assert booted.interview.stage == interview.Idle

  let #(next, effects) =
    update.update(booted, msg.LandingIdeaArrived("A yoga booking app"))

  assert next.interview.stage == interview.Idle
  assert next.chat.prompt == "A yoga booking app"
  assert effects == []
}

pub fn landing_idea_whitespace_does_not_advance_interview_test() {
  let #(booted, _) =
    update.update(model.init(), msg.Chat(chat.MessagesReplaced([])))

  let #(next, _) = update.update(booted, msg.LandingIdeaArrived("   "))

  // AnswerSubmitted trims: a blank idea must not skip the first question.
  assert next.interview.stage == interview.Asking(0)
}

// --- "Try to fix" preview-error card ---

fn with_preview_error(app: model.Model, text: String) -> model.Model {
  let #(preview_state, _) =
    preview.update(app.preview, preview.PreviewErrorReported(text))
  model.Model(..app, preview: preview_state)
}

pub fn preview_error_log_line_populates_card_test() {
  let #(next, _) =
    update.update(
      model.init(),
      msg.WebContainer(webcontainer.LogAppended(
        "[preview error] ReferenceError: foo is not defined",
      )),
    )

  assert next.preview.last_preview_error
    == option.Some("ReferenceError: foo is not defined")
  assert next.preview.code_panel_unread
}

pub fn fix_preview_error_calls_agent_with_error_text_test() {
  let configured =
    model.Model(
      ..model.init(),
      settings: settings.State(
        ..settings.init(),
        model: "qwen/qwen3.6-35b-a3b",
        api_key: "sk-test",
        settings_open: False,
      ),
    )
  let app = with_preview_error(configured, "ReferenceError: foo is not defined")

  let #(next, effects) =
    update.update(app, msg.FixPreviewError("fix-1", 1000))

  assert agent.is_running(next.agent)
  let has_error_in_prompt =
    list.any(effects, fn(eff) {
      case eff {
        effect.Agent(agent.CallAgent(user_prompt: prompt, ..)) ->
          string.contains(prompt, "ReferenceError: foo is not defined")
        _ -> False
      }
    })
  assert has_error_in_prompt
}

pub fn fix_preview_error_noop_without_error_or_mid_interview_test() {
  // No recorded error: nothing happens.
  let #(unchanged, effects) =
    update.update(model.init(), msg.FixPreviewError("fix-2", 1000))
  assert effects == []
  assert !agent.is_running(unchanged.agent)

  // Mid-interview: card is hidden and the msg must be inert.
  let #(interviewing, _) =
    update.update(model.init(), msg.Chat(chat.MessagesReplaced([])))
  let armed = with_preview_error(interviewing, "boom")
  let #(next, fix_effects) = update.update(armed, msg.FixPreviewError("fix-3", 1000))
  assert fix_effects == []
  assert !agent.is_running(next.agent)
}

pub fn agent_success_clears_preview_error_test() {
  let configured =
    model.Model(
      ..model.init(),
      settings: settings.State(
        ..settings.init(),
        model: "qwen/qwen3.6-35b-a3b",
        api_key: "sk-test",
        settings_open: False,
      ),
    )
  let armed = with_preview_error(configured, "boom")
  let #(running_app, _) = update.update(armed, msg.FixPreviewError("fix-4", 1000))

  let #(next, _) =
    update.update(
      running_app,
      msg.Agent(agent.AgentRequestSucceeded("fix-4", "fixed it", [])),
    )

  assert next.preview.last_preview_error == option.None
}
