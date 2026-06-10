import build/actors/agent
import build/actors/chat
import build/actors/preview
import build/actors/project
import build/actors/settings
import build/actors/webcontainer
import build/effect
import build/model
import build/msg
import build/pure/preview_inspector
import build/update
import gleam/option
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
      model: "anthropic/claude-3.5-sonnet",
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
        model: "anthropic/claude-3.5-sonnet",
      )),
      effect.Agent(agent.StartElapsedTimer),
      effect.Agent(agent.CallAgent(
        request_id: "imp",
        provider: settings.OpenRouter,
        api_key: "sk-test",
        ollama_url: "http://localhost:11434",
        model: "anthropic/claude-3.5-sonnet",
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
        selected_path: app.project.selected_path,
        current_project_id: app.project.current_project_id,
        silent: True,
      )),
    ])
  assert update.update(app, msg.NewProject)
    == #(app, [effect.ConfirmNewProject])
  assert update.update(app, msg.NewProjectConfirmed)
    == #(app, [
      effect.Project(project.CreateProject(
        name: "Untitled Project",
        files: app.project.files,
        messages: [],
        selected_path: "src/main.tsx",
      )),
    ])
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
        lifecycle: agent.Running("req", 1000),
        elapsed_seconds: 0,
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
        next.project.selected_path,
        next.project.current_project_id,
      )),
    ]
}

pub fn submit_prompt_appends_user_and_starts_agent_test() {
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
        model: "anthropic/claude-3.5-sonnet",
      )),
      effect.Agent(agent.StartElapsedTimer),
      effect.Agent(agent.CallAgent(
        request_id: "req",
        provider: settings.OpenRouter,
        api_key: "sk-test",
        ollama_url: "http://localhost:11434",
        model: "anthropic/claude-3.5-sonnet",
        user_prompt: "make app",
        files: app.project.files,
        messages: [],
        selected_element: option.None,
        element_comment: "",
      )),
      effect.ScrollMessagesToBottom,
    ]
}
