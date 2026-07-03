import build/actors/agent
import build/actors/chat
import build/actors/interview
import build/actors/preview
import build/actors/project
import build/actors/publish
import build/actors/settings
import build/actors/webcontainer
import build/effect
import build/model
import build/msg
import build/pure/brain
import build/pure/build_log
import build/pure/story
import build/pure/templates
import gleam/list
import gleam/option
import gleam/string

pub fn update(
  app: model.Model,
  message: msg.Msg,
) -> #(model.Model, List(effect.Effect)) {
  case message {
    msg.NoOp -> #(app, [])
    msg.InitApp ->
      case app.managed {
        True -> #(app, [
          effect.Settings(settings.PurgeLegacySettings),
          effect.Settings(settings.FetchAccountInfo),
          effect.Publish(publish.FetchKeyStatus),
          effect.Project(project.LoadInitialProject),
        ])
        False -> #(app, [
          effect.Settings(settings.LoadSettings),
          effect.Project(project.LoadInitialProject),
        ])
      }
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
        build_log: app.project.build_log,
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
        model.Model(
          ..app,
          agent: agent_state,
          preview: preview.on_project_navigation(app.preview),
          interview: interview.update(
            interview.init(),
            interview.InterviewStarted,
          ),
        ),
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
    msg.SubmitPrompt(request_id, now) ->
      case app.interview.stage {
        // Mid-interview the composer answers questions, not the agent.
        // Deliberately not gated on remounting or budget: answering touches
        // no container and no model. Empty submits are a no-op inside the
        // interview actor.
        interview.Asking(_) -> {
          let interview_state =
            interview.update(
              app.interview,
              interview.AnswerSubmitted(app.chat.prompt),
            )
          let chat_state = chat.update(app.chat, chat.PromptChanged(""))
          #(
            model.Model(..app, interview: interview_state, chat: chat_state),
            [effect.ScrollMessagesToBottom],
          )
        }
        _ -> submit_prompt(app, request_id, now)
      }
    msg.BuildFromPlan(plan_summary, request_id, now) ->
      build_from_plan(app, plan_summary, request_id, now)
    msg.ImproveSelectedElement(request_id, now) ->
      improve_selected_element(app, request_id, now)
    msg.ExportZip -> #(app, [effect.ExportZip(app.project.files)])
    msg.ExportStory -> #(app, [
      effect.ExportStoryHtml(story.from_project(
        app.project.project_name,
        app.chat.messages,
        app.project.build_log,
        app.project.files,
      )),
    ])
    msg.CancelAgent -> {
      let #(agent_state, effects) =
        agent.update(app.agent, agent.AgentRequestCanceled)
      #(model.Model(..app, agent: agent_state), list.map(effects, effect.Agent))
    }
    msg.ResetProject -> {
      let #(project_state, project_effects) =
        project.update(app.project, project.ResetToStarter)
      let chat_state = chat.update(app.chat, chat.ChatCleared)
      #(
        model.Model(
          ..app,
          project: project_state,
          chat: chat_state,
          preview: preview.on_project_navigation(app.preview),
          interview: interview.update(
            interview.init(),
            interview.InterviewStarted,
          ),
        ), [
        effect.Agent(agent.AbortAgent),
        ..list.map(project_effects, effect.Project)
      ])
    }
    msg.OpenProject(id) -> {
      let #(agent_state, agent_effects) =
        agent.update(app.agent, agent.AgentRequestCanceled)
      // Discard in-flight answers immediately: a mid-interview switch must
      // never seed another project's plan. MessagesReplaced re-evaluates
      // eligibility once the opened project's history hydrates.
      #(
        model.Model(
          ..app,
          agent: agent_state,
          preview: preview.on_project_navigation(app.preview),
          interview: interview.init(),
        ),
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
    msg.Interview(interview_msg) -> {
      let interview_state = interview.update(app.interview, interview_msg)
      let next = model.Model(..app, interview: interview_state)
      case interview_msg {
        // Opting out is an interview end: reveal the app if it's ready.
        interview.InterviewDismissed -> #(
          model.Model(..next, preview: preview.reveal(next.preview)),
          [effect.ScrollMessagesToBottom],
        )
        _ -> #(next, [effect.ScrollMessagesToBottom])
      }
    }
    msg.InterviewBuild(request_id, now) ->
      case app.interview.stage {
        interview.Reviewing ->
          build_from_plan(
            app,
            interview.plan_summary(app.interview.answers),
            request_id,
            now,
          )
        _ -> #(app, [])
      }
    msg.Chat(chat_msg) -> {
      let chat_state = chat.update(app.chat, chat_msg)
      case chat_msg {
        // A project's chat history just hydrated (boot or open): re-evaluate
        // interview eligibility against the loaded project. build_log is
        // already hydrated — ProjectLoaded dispatches before MessagesReplaced.
        chat.MessagesReplaced(loaded) -> {
          let interview_state = case loaded == [] && app.project.build_log == [] {
            True -> interview.update(interview.init(), interview.InterviewStarted)
            False -> interview.init()
          }
          #(
            model.Model(..app, chat: chat_state, interview: interview_state),
            [],
          )
        }
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
        project.ProjectReady -> {
          // Boot settled (messages hydrate before ProjectReady): a project
          // that has never chatted or built gets the onboarding interview.
          let interview_state = case
            app.chat.messages == [] && state.build_log == []
          {
            True ->
              interview.update(interview.init(), interview.InterviewStarted)
            False -> app.interview
          }
          #(
            model.Model(..app, project: state, interview: interview_state),
            [
              effect.WebContainer(webcontainer.BootContainer(state.files)),
              ..base_effects
            ],
          )
        }
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
    msg.LayoutModeKeyed(mode) -> {
      let #(state, effects) =
        preview.update(app.preview, preview.LayoutModeSelected(mode))
      #(
        model.Model(..app, preview: state),
        list.append(list.map(effects, effect.Preview), [
          effect.FocusLayoutSegment,
        ]),
      )
    }
    msg.Preview(preview_msg) -> {
      // While the interview is running, an arriving URL must not yank the
      // full-screen chat mid-question — the reveal moves to interview end.
      let #(state, effects) = case preview_msg, app.interview.stage {
        preview.PreviewUrlChanged(url), interview.Asking(_) ->
          preview.record_url(app.preview, url)
        preview.PreviewUrlChanged(url), interview.Reviewing ->
          preview.record_url(app.preview, url)
        _, _ -> preview.update(app.preview, preview_msg)
      }
      #(model.Model(..app, preview: state), list.map(effects, effect.Preview))
    }
    msg.WebContainer(webcontainer_msg) -> {
      let #(state, effects) =
        webcontainer.update(app.webcontainer, webcontainer_msg)
      let next = model.Model(..app, webcontainer: state)
      // A preview/build error lands in the terminal log (main-gleam.ts tags it
      // "[preview error]"). If the code panel is hidden the user can't see it,
      // so badge the toggle.
      let next = case webcontainer_msg {
        webcontainer.LogAppended(line) ->
          case string.contains(line, "[preview error]") {
            True -> {
              let #(preview_state, _) =
                preview.update(next.preview, preview.CodePanelErrorSignaled)
              model.Model(..next, preview: preview_state)
            }
            False -> next
          }
        _ -> next
      }
      #(next, list.map(effects, effect.WebContainer))
    }
    msg.Publish(publish_msg) -> update_publish(app, publish_msg)
  }
}

/// The publish actor decides *whether* to publish; this layer supplies the
/// project file map it can't see. Whenever a publish message lands the state
/// in Publishing, kick off the actual request.
fn update_publish(
  app: model.Model,
  publish_msg: publish.Msg,
) -> #(model.Model, List(effect.Effect)) {
  let #(state, effects) = publish.update(app.publish, publish_msg)
  let mapped = list.map(effects, effect.Publish)
  let start = case app.publish.status, state.status {
    publish.Publishing(_, _), _ -> []
    _, publish.Publishing(project_id, subdomain) -> [
      effect.Publish(publish.StartPublish(
        project_id,
        subdomain,
        app.project.files,
      )),
    ]
    _, _ -> []
  }
  #(model.Model(..app, publish: state), list.append(mapped, start))
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
          // Record the turn for the Build Story: request-start timestamp,
          // truncated prompt/reply, and the touched paths only.
          let started_at = case app.agent.lifecycle {
            agent.Running(_, at) -> at
            _ -> 0
          }
          let log_entry =
            build_log.entry(
              started_at,
              last_user_prompt(app.chat.messages),
              reply,
              list.map(patches, fn(patch) { patch.path }),
            )
          let #(project_state, _) =
            project.update(project_state, project.BuildLogAppended(log_entry))
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

fn last_user_prompt(messages: List(chat.Message)) -> String {
  list.fold(messages, "", fn(acc, message) {
    case message.role {
      chat.User -> message.content
      chat.Assistant -> acc
    }
  })
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
          app.project.build_log,
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
  && !webcontainer.is_remounting(app.webcontainer)
  && !app.agent.budget_exhausted
}

fn can_improve_selected_element(app: model.Model) -> Bool {
  app.preview.element_comment != ""
  && !agent.is_running(app.agent)
  && !webcontainer.is_busy(app.webcontainer)
  && !app.agent.budget_exhausted
}

// Managed users never see providers or keys; the server owns both.
fn settings_missing(app: model.Model) -> Bool {
  !app.managed
  && {
    app.settings.model == ""
    || {
      app.settings.provider == settings.OpenRouter && app.settings.api_key == ""
    }
  }
}

// Persisting provider settings only applies to the bring-your-own-key flow;
// in managed mode it would re-create the localStorage keys we purge at boot.
fn legacy_persist_effects(app: model.Model) -> List(effect.Effect) {
  case app.managed {
    True -> []
    False -> [effect.Settings(settings.persist_effect(app.settings))]
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
          // Element improvement is agent-bound work: defensively end any
          // active interview, same as call_agent_with_prompt.
          let #(interview_state, preview_state) = case
            interview.is_active(app.interview)
          {
            True -> #(interview.init(), preview.reveal(app.preview))
            False -> #(app.interview, app.preview)
          }
          #(
            model.Model(
              ..app,
              chat: chat_state,
              agent: agent_state,
              interview: interview_state,
              preview: preview_state,
            ),
            list.append(
              legacy_persist_effects(app),
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
  case
    !agent.is_running(app.agent)
    && !webcontainer.is_remounting(app.webcontainer)
  {
    False -> #(app, [])
    True -> {
      // Seed BRAIN.md before the agent call so the What & Why exists (and is
      // sent as context) regardless of whether the model maintains it.
      let #(project_state, project_effects) =
        project.update(
          app.project,
          project.FileApplied(brain.brain_path, brain.seed(plan_summary)),
        )
      let seeded = model.Model(..app, project: project_state)
      let #(next, effects) =
        call_agent_with_prompt(seeded, user_message, agent_prompt, request_id, now)
      #(next, list.append(list.map(project_effects, effect.Project), effects))
    }
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
      // The agent actually starting is the interview's end (from the Build
      // button, the legacy wizard postMessage, or a free-form prompt at the
      // recap) — idle it and fire the interview-end reveal. Gated dispatches
      // never reach here, so a blocked Build keeps Reviewing and its answers.
      let #(interview_state, preview_state) = case
        interview.is_active(app.interview)
      {
        True -> #(interview.init(), preview.reveal(app.preview))
        False -> #(app.interview, app.preview)
      }
      #(
        model.Model(
          ..app,
          chat: chat_state,
          agent: agent_state,
          interview: interview_state,
          preview: preview_state,
        ),
        list.append(
          legacy_persist_effects(app),
          list.append(
            list.map(list.append(agent_effects, [call_agent]), effect.Agent),
            [effect.ScrollMessagesToBottom],
          ),
        ),
      )
    }
  }
}
