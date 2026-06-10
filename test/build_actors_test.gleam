import build/actors/agent
import build/actors/chat
import build/actors/preview
import build/actors/project
import build/actors/settings
import build/actors/webcontainer
import build/pure/templates
import gleam/int
import gleam/list
import gleeunit

pub fn main() -> Nil {
  gleeunit.main()
}

pub fn settings_provider_defaults_model_test() {
  let #(state, effects) =
    settings.update(settings.init(), settings.ProviderChanged(settings.Ollama))

  assert state.provider == settings.Ollama
  assert state.model == "glm-5:cloud"
  assert effects == []
}

pub fn settings_loads_from_storage_test() {
  let #(state, effects) =
    settings.update(
      settings.init(),
      settings.SettingsLoaded(
        provider: "ollama",
        api_key: "key",
        ollama_url: "http://ollama",
        model: "glm-5:cloud",
      ),
    )

  assert state.provider == settings.Ollama
  assert state.api_key == "key"
  assert state.ollama_url == "http://ollama"
  assert state.model == "glm-5:cloud"
  assert state.settings_open == False
  assert effects == []
}

pub fn settings_test_ollama_emits_effect_test() {
  let #(state, effects) = settings.update(settings.init(), settings.TestOllama)

  assert state.connection_status == "Testing Ollama..."
  assert effects == [settings.TestOllamaConnection("http://localhost:11434")]
}

pub fn chat_user_message_clears_prompt_test() {
  let state = chat.State(messages: [], prompt: "hello", expanded_messages: [])
  let next = chat.update(state, chat.UserSentMessage("hello"))

  assert next.prompt == ""
  assert next.messages == [chat.Message(chat.User, "hello")]
}

pub fn agent_ignores_stale_success_test() {
  let #(running, _) =
    agent.update(agent.init(), agent.AgentRequestStarted("new", 1000))
  let #(next, effects) =
    agent.update(running, agent.AgentRequestSucceeded("old", "ignored", []))

  assert agent.is_running(next)
  assert effects == []
}

pub fn agent_success_stops_timer_and_installs_test() {
  let patch = agent.Patch(path: "package.json", content: "{}")
  let #(running, _) =
    agent.update(agent.init(), agent.AgentRequestStarted("req", 1000))
  let #(next, effects) =
    agent.update(running, agent.AgentRequestSucceeded("req", "done", [patch]))

  assert next.lifecycle == agent.Idle
  assert effects == [agent.StopElapsedTimer, agent.InstallIfNeeded([patch])]
}

pub fn project_file_applied_upserts_and_writes_test() {
  let #(next, effects) =
    project.update(
      project.init(),
      project.FileApplied("src/App.jsx", "new content"),
    )

  assert next.save_status == "Unsaved changes"
  assert project.upsert_file([], "src/App.jsx", "new content")
    == [templates.ProjectFile("src/App.jsx", "new content")]
  assert effects == [project.WriteFileToContainer("src/App.jsx", "new content")]
}

pub fn project_file_edited_debounces_container_write_test() {
  let #(next, effects) =
    project.update(
      project.init(),
      project.FileEdited("src/App.jsx", "new content"),
    )

  assert next.save_status == "Unsaved changes"
  assert project.upsert_file([], "src/App.jsx", "new content")
    == [
      templates.ProjectFile("src/App.jsx", "new content"),
    ]
  assert effects
    == [
      project.DebouncedWriteFileToContainer(2000, "src/App.jsx", "new content"),
    ]
}

pub fn project_open_dialog_refreshes_list_test() {
  let #(next, effects) =
    project.update(project.init(), project.ProjectsDialogOpened)

  assert next.projects_open
  assert effects == [project.RefreshProjectList]
}

pub fn preview_toggle_and_url_reenable_inspector_test() {
  let #(on, enable) =
    preview.update(preview.init(), preview.ElementSelectToggled)
  assert on.selecting_element
  assert enable == [preview.PostInspectorMessage(preview.BuildInspectorEnable)]

  let #(_, url_effects) =
    preview.update(on, preview.PreviewUrlChanged("http://localhost:5173"))
  assert url_effects
    == [preview.PostInspectorMessage(preview.BuildInspectorEnable)]

  let #(off, disable) = preview.update(on, preview.ElementSelectToggled)
  assert !off.selecting_element
  assert disable
    == [preview.PostInspectorMessage(preview.BuildInspectorDisable)]
}

pub fn webcontainer_boot_and_remount_test() {
  assert webcontainer.is_busy(webcontainer.init())
  let #(booting, _) =
    webcontainer.update(webcontainer.init(), webcontainer.BootStarted)
  assert booting.boot_phase == webcontainer.BootingContainer

  let #(ready, _) = webcontainer.update(booting, webcontainer.BootSucceeded)
  assert ready.boot_phase == webcontainer.Ready
  assert ready.hydrated

  let #(remounting, effects) =
    webcontainer.update(
      ready,
      webcontainer.RemountRequested(templates.starter_files()),
    )
  assert remounting.boot_phase == webcontainer.Remounting
  assert remounting.suppress_auto_save
  assert effects == [webcontainer.MountAndInstall(templates.starter_files())]
}

pub fn webcontainer_caps_logs_to_prior_200_plus_new_line_test() {
  let state = append_logs(webcontainer.init(), 0, 205)

  assert list.length(state.logs) == 201
  assert list.first(state.logs) == Ok("4")
}

fn append_logs(
  state: webcontainer.State,
  index: Int,
  limit: Int,
) -> webcontainer.State {
  case index >= limit {
    True -> state
    False -> {
      let #(next, _) =
        webcontainer.update(
          state,
          webcontainer.LogAppended(int.to_string(index)),
        )
      append_logs(next, index + 1, limit)
    }
  }
}
