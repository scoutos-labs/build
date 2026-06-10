import build/actors/agent
import build/actors/chat
import build/actors/preview
import build/actors/project
import build/actors/settings
import build/actors/webcontainer
import build/effect
import build/model
import build/msg
import build/pure/templates
import gleam/list
import gleam/option

pub fn update(
  app: model.Model,
  message: msg.Msg,
) -> #(model.Model, List(effect.Effect)) {
  case message {
    msg.NoOp -> #(app, [])
    msg.InitApp -> #(app, [
      effect.Settings(settings.LoadSettings),
      effect.Project(project.LoadInitialProject),
    ])
    msg.SaveSettings -> #(
      model.Model(
        ..app,
        settings: settings.State(..app.settings, settings_open: False),
      ),
      [effect.Settings(settings.persist_effect(app.settings))],
    )
    msg.SaveProject(silent) -> #(app, [
      effect.Project(project.SaveCurrentProject(
        name: app.project.project_name,
        files: app.project.files,
        messages: app.chat.messages,
        selected_path: app.project.selected_path,
        current_project_id: app.project.current_project_id,
        silent: silent,
      )),
    ])
    msg.NewProject -> #(app, [effect.ConfirmNewProject])
    msg.NewProjectConfirmed -> {
      let #(agent_state, agent_effects) =
        agent.update(app.agent, agent.AgentRequestCanceled)
      #(
        model.Model(..app, agent: agent_state),
        list.append(list.map(agent_effects, effect.Agent), [
          effect.Project(project.CreateProject(
            name: "Untitled Project",
            files: templates.starter_files(),
            messages: [],
            selected_path: "src/main.tsx",
          )),
        ]),
      )
    }
    msg.SubmitPrompt(request_id, now) -> submit_prompt(app, request_id, now)
    msg.BuildFromPlan(plan_summary, request_id, now) ->
      build_from_plan(app, plan_summary, request_id, now)
    msg.ImproveSelectedElement(request_id, now) ->
      improve_selected_element(app, request_id, now)
    msg.ExportZip -> #(app, [effect.ExportZip(app.project.files)])
    msg.CancelAgent -> {
      let #(agent_state, effects) =
        agent.update(app.agent, agent.AgentRequestCanceled)
      #(model.Model(..app, agent: agent_state), list.map(effects, effect.Agent))
    }
    msg.ResetProject -> {
      let #(project_state, project_effects) =
        project.update(app.project, project.ResetToStarter)
      let chat_state = chat.update(app.chat, chat.ChatCleared)
      #(model.Model(..app, project: project_state, chat: chat_state), [
        effect.Agent(agent.AbortAgent),
        ..list.map(project_effects, effect.Project)
      ])
    }
    msg.OpenProject(id) -> {
      let #(agent_state, agent_effects) =
        agent.update(app.agent, agent.AgentRequestCanceled)
      #(
        model.Model(..app, agent: agent_state),
        list.append(list.map(agent_effects, effect.Agent), [
          effect.Project(project.OpenProject(id)),
        ]),
      )
    }
    msg.RemoveProject(id) -> #(app, [effect.ConfirmRemoveProject(id)])
    msg.RemoveProjectConfirmed(id) -> #(app, [
      effect.Project(project.DeleteProject(id)),
    ])
    msg.Settings(settings_msg) -> {
      let #(state, effects) = settings.update(app.settings, settings_msg)
      #(model.Model(..app, settings: state), list.map(effects, effect.Settings))
    }
    msg.Chat(chat_msg) -> {
      let chat_state = chat.update(app.chat, chat_msg)
      case chat_msg {
        chat.ChatCleared ->
          with_auto_save(
            model.Model(
              ..app,
              chat: chat_state,
              project: project.State(
                ..app.project,
                save_status: "Unsaved changes",
              ),
            ),
            [],
          )
        _ -> #(model.Model(..app, chat: chat_state), [])
      }
    }
    msg.Project(project_msg) -> {
      let #(state, effects) = project.update(app.project, project_msg)
      let base_effects = list.map(effects, effect.Project)
      case project_msg {
        project.ProjectReady -> #(model.Model(..app, project: state), [
          effect.WebContainer(webcontainer.BootContainer(state.files)),
          ..base_effects
        ])
        project.ProjectNameChanged(_)
        | project.FileApplied(_, _)
        | project.FileEdited(_, _)
        | project.FilesUpdated(_, _)
        | project.SelectedPathChanged(_)
        | project.ResetToStarter ->
          with_auto_save(model.Model(..app, project: state), base_effects)
        _ -> #(model.Model(..app, project: state), base_effects)
      }
    }
    msg.Agent(agent_msg) -> update_agent(app, agent_msg)
    msg.Preview(preview_msg) -> {
      let #(state, effects) = preview.update(app.preview, preview_msg)
      #(model.Model(..app, preview: state), list.map(effects, effect.Preview))
    }
    msg.WebContainer(webcontainer_msg) -> {
      let #(state, effects) =
        webcontainer.update(app.webcontainer, webcontainer_msg)
      #(
        model.Model(..app, webcontainer: state),
        list.map(effects, effect.WebContainer),
      )
    }
  }
}

fn update_agent(
  app: model.Model,
  agent_msg: agent.Msg,
) -> #(model.Model, List(effect.Effect)) {
  let #(agent_state, agent_effects) = agent.update(app.agent, agent_msg)
  let mapped_agent_effects = list.map(agent_effects, effect.Agent)
  case agent_msg {
    agent.AgentRequestSucceeded(request_id, reply, patches) ->
      case request_matches(app.agent, request_id) {
        True -> {
          let chat_state = chat.update(app.chat, chat.AssistantReplied(reply))
          let #(project_state, project_effects) =
            apply_patches(app.project, patches)
          with_auto_save(
            model.Model(
              ..app,
              agent: agent_state,
              chat: chat_state,
              project: project_state,
            ),
            list.append(
              mapped_agent_effects,
              list.append(list.map(project_effects, effect.Project), [
                effect.ScrollMessagesToBottom,
              ]),
            ),
          )
        }
        False -> #(model.Model(..app, agent: agent_state), mapped_agent_effects)
      }
    agent.AgentRequestFailed(request_id, message) ->
      case request_matches(app.agent, request_id) {
        True -> {
          let chat_state = chat.update(app.chat, chat.AssistantError(message))
          with_auto_save(
            model.Model(..app, agent: agent_state, chat: chat_state),
            list.append(mapped_agent_effects, [effect.ScrollMessagesToBottom]),
          )
        }
        False -> #(model.Model(..app, agent: agent_state), mapped_agent_effects)
      }
    _ -> #(model.Model(..app, agent: agent_state), mapped_agent_effects)
  }
}

fn request_matches(state: agent.State, request_id: String) -> Bool {
  case state.lifecycle {
    agent.Running(active_id, _) if active_id == request_id -> True
    _ -> False
  }
}

fn apply_patches(
  state: project.State,
  patches: List(agent.Patch),
) -> #(project.State, List(project.Effect)) {
  case patches {
    [] -> #(state, [])
    [agent.Patch(path, content), ..rest] -> {
      let #(next_state, effects) =
        project.update(state, project.FileApplied(path, content))
      let #(final_state, rest_effects) = apply_patches(next_state, rest)
      #(final_state, list.append(effects, rest_effects))
    }
  }
}

fn with_auto_save(
  app: model.Model,
  effects: List(effect.Effect),
) -> #(model.Model, List(effect.Effect)) {
  case app.webcontainer.hydrated && !app.webcontainer.suppress_auto_save {
    True -> #(
      model.Model(
        ..app,
        project: project.State(..app.project, save_status: "Saving..."),
      ),
      list.append(effects, [
        effect.Project(project.ScheduleSave(
          900,
          app.project.project_name,
          app.project.files,
          app.chat.messages,
          app.project.selected_path,
          app.project.current_project_id,
        )),
      ]),
    )
    False -> #(app, effects)
  }
}

fn can_submit_prompt(app: model.Model) -> Bool {
  app.chat.prompt != ""
  && !agent.is_running(app.agent)
  && !webcontainer.is_busy(app.webcontainer)
}

fn can_improve_selected_element(app: model.Model) -> Bool {
  app.preview.element_comment != ""
  && !agent.is_running(app.agent)
  && !webcontainer.is_busy(app.webcontainer)
}

fn settings_missing(app: model.Model) -> Bool {
  app.settings.model == ""
  || {
    app.settings.provider == settings.OpenRouter && app.settings.api_key == ""
  }
}

fn improve_selected_element(
  app: model.Model,
  request_id: String,
  now: Int,
) -> #(model.Model, List(effect.Effect)) {
  case app.preview.selected_element, can_improve_selected_element(app) {
    option.Some(selected), True ->
      case settings_missing(app) {
        True -> #(
          model.Model(
            ..app,
            settings: settings.State(..app.settings, settings_open: True),
          ),
          [],
        )
        False -> {
          let comment = app.preview.element_comment
          let prompt =
            "Improve the selected preview element based on the user comment."
          let chat_state =
            chat.update(
              app.chat,
              chat.UserSentMessage("Selected element: " <> comment),
            )
          let #(agent_state, agent_effects) =
            agent.update(app.agent, agent.AgentRequestStarted(request_id, now))
          let call_agent =
            agent.CallAgent(
              request_id: request_id,
              provider: app.settings.provider,
              api_key: app.settings.api_key,
              ollama_url: app.settings.ollama_url,
              model: app.settings.model,
              user_prompt: prompt,
              files: app.project.files,
              messages: app.chat.messages,
              selected_element: option.Some(selected),
              element_comment: comment,
            )
          #(
            model.Model(..app, chat: chat_state, agent: agent_state),
            list.append(
              [effect.Settings(settings.persist_effect(app.settings))],
              list.append(
                list.map(list.append(agent_effects, [call_agent]), effect.Agent),
                [effect.ScrollMessagesToBottom],
              ),
            ),
          )
        }
      }
    _, _ -> #(app, [])
  }
}

fn submit_prompt(
  app: model.Model,
  request_id: String,
  now: Int,
) -> #(model.Model, List(effect.Effect)) {
  case can_submit_prompt(app) {
    False -> #(app, [])
    True -> call_agent_with_prompt(app, app.chat.prompt, app.chat.prompt, request_id, now)
  }
}

fn build_from_plan(
  app: model.Model,
  plan_summary: String,
  request_id: String,
  now: Int,
) -> #(model.Model, List(effect.Effect)) {
  let user_message = "Build this app from the interview plan.\n\n" <> plan_summary
  let agent_prompt =
    "Replace the starter interview app with the new application described in this interview plan. Use the plan as the source of truth. Build a polished, runnable React + TypeScript app. Preserve src/build-inspector.ts and its import.\n\nApp plan:\n" <> plan_summary
  case !agent.is_running(app.agent) && !webcontainer.is_busy(app.webcontainer) {
    False -> #(app, [])
    True -> call_agent_with_prompt(app, user_message, agent_prompt, request_id, now)
  }
}

fn call_agent_with_prompt(
  app: model.Model,
  user_message: String,
  agent_prompt: String,
  request_id: String,
  now: Int,
) -> #(model.Model, List(effect.Effect)) {
  case settings_missing(app) {
    True -> #(
      model.Model(
        ..app,
        settings: settings.State(..app.settings, settings_open: True),
      ),
      [],
    )
    False -> {
      let chat_state = chat.update(app.chat, chat.UserSentMessage(user_message))
      let #(agent_state, agent_effects) =
        agent.update(app.agent, agent.AgentRequestStarted(request_id, now))
      let call_agent =
        agent.CallAgent(
          request_id: request_id,
          provider: app.settings.provider,
          api_key: app.settings.api_key,
          ollama_url: app.settings.ollama_url,
          model: app.settings.model,
          user_prompt: agent_prompt,
          files: app.project.files,
          messages: app.chat.messages,
          selected_element: option.None,
          element_comment: "",
        )
      #(
        model.Model(..app, chat: chat_state, agent: agent_state),
        list.append(
          [effect.Settings(settings.persist_effect(app.settings))],
          list.append(
            list.map(list.append(agent_effects, [call_agent]), effect.Agent),
            [effect.ScrollMessagesToBottom],
          ),
        ),
      )
    }
  }
}
