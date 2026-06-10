import build/actors/agent
import build/actors/project
import build/actors/settings
import build/actors/webcontainer
import build/components/build_agent_chat
import build/components/build_editor
import build/components/build_element_picker
import build/components/build_preview
import build/components/build_project_nav
import build/components/build_projects_modal
import build/components/build_settings_modal
import build/components/build_terminal
import build/model
import build/msg
import build/pure/templates
import gleam/list
import lustre/attribute
import lustre/element.{type Element}
import lustre/element/html
import lustre/event

pub fn view(app: model.Model) -> Element(msg.Msg) {
  let selected = selected_file(app)
  let running = agent.is_running(app.agent)
  let busy = running || webcontainer.is_busy(app.webcontainer)
  html.div([attribute.class("app")], [
    html.aside([attribute.class("panel chat")], [
      html.header([], [
        title_row(),
        html.p([], [
          html.text(
            "Use an agent to create your application in a live browser workspace.",
          ),
        ]),
      ]),
      build_project_nav.view(
        app.project.project_name,
        app.project.save_status,
        app.project.name_editing,
        busy,
      ),
      build_settings_modal.view(app.settings, app.managed),
      build_projects_modal.view(app.project, busy),
      build_element_picker.view(
        app.preview.selected_element,
        app.preview.element_comment,
        busy,
      ),
      build_agent_chat.view(
        app.chat.messages,
        app.chat.expanded_messages,
        app.chat.prompt,
        running,
        busy,
        app.agent.budget_exhausted,
        app.agent.budget_reset_at,
      ),
    ]),
    html.main([attribute.class("workspace")], [
      build_preview.view(
        app.preview.preview_url,
        app.preview.selecting_element,
        running,
      ),
      html.section([attribute.class("bottom")], [
        files_pane(app.project.files, app.project.selected_path),
        build_editor.view(selected.path, selected.content),
        build_terminal.view(
          app.webcontainer.logs,
          app.project.project_ready && !running && app.preview.preview_url != "",
        ),
      ]),
    ]),
  ])
}

fn title_row() {
  html.div([attribute.class("titleRow")], [
    html.h1([], [html.text("Build")]),
    html.button(
      [
        attribute.type_("button"),
        attribute.class("secondary iconButton"),
        attribute.title("Model settings"),
        attribute.aria_label("Model settings"),
        event.on_click(msg.Settings(settings.SettingsOpened)),
      ],
      [html.text("⚙️")],
    ),
  ])
}

fn files_pane(files: List(templates.ProjectFile), selected_path: String) {
  html.div(
    [attribute.class("files")],
    list.map(files, fn(file) {
      html.button(
        [
          attribute.type_("button"),
          attribute.class(case file.path == selected_path {
            True -> "active"
            False -> ""
          }),
          event.on_click(msg.Project(project.SelectedPathChanged(file.path))),
        ],
        [html.text(file.path)],
      )
    }),
  )
}

fn selected_file(app: model.Model) {
  case
    list.find(app.project.files, fn(file) {
      file.path == app.project.selected_path
    })
  {
    Ok(file) -> file
    Error(_) ->
      case app.project.files {
        [first, ..] -> first
        [] -> templates.ProjectFile("", "")
      }
  }
}
