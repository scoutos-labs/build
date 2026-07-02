import build/actors/chat
import build/pure/build_log
import build/pure/templates
import gleam/list
import gleam/option.{type Option, None, Some}

pub type SavedProject {
  SavedProject(id: String, name: String, updated_at: String)
}

pub type State {
  State(
    project_name: String,
    current_project_id: Option(String),
    saved_projects: List(SavedProject),
    save_status: String,
    project_ready: Bool,
    name_editing: Bool,
    projects_open: Bool,
    files: List(templates.ProjectFile),
    selected_path: String,
    build_log: List(build_log.Entry),
  )
}

pub type Msg {
  ProjectLoaded(
    id: Option(String),
    name: String,
    files: List(templates.ProjectFile),
    selected_path: String,
    updated_at: String,
    build_log: List(build_log.Entry),
  )
  ProjectListRefreshed(projects: List(SavedProject))
  ProjectCreated(
    id: String,
    name: String,
    files: List(templates.ProjectFile),
    selected_path: String,
  )
  ProjectNameChanged(name: String)
  ProjectNameEditingToggled
  ProjectNameEditingSet(editing: Bool)
  ProjectsDialogToggled
  ProjectsDialogClosed
  ProjectsDialogOpened
  ProjectReady
  SaveStatusChanged(status: String)
  FilesUpdated(files: List(templates.ProjectFile), status: String)
  FileApplied(path: String, content: String)
  FileEdited(path: String, content: String)
  SelectedPathChanged(path: String)
  ResetToStarter
  BuildLogAppended(entry: build_log.Entry)
}

pub type Effect {
  LoadInitialProject
  SaveCurrentProject(
    name: String,
    files: List(templates.ProjectFile),
    messages: List(chat.Message),
    build_log: List(build_log.Entry),
    selected_path: String,
    current_project_id: Option(String),
    silent: Bool,
  )
  CreateProject(
    name: String,
    files: List(templates.ProjectFile),
    messages: List(chat.Message),
    selected_path: String,
  )
  // CreateProject always starts with an empty build log.
  OpenProject(id: String)
  DeleteProject(id: String)
  RefreshProjectList
  PersistCurrentProjectId(id: Option(String))
  WriteFileToContainer(path: String, content: String)
  DebouncedWriteFileToContainer(delay: Int, path: String, content: String)
  RemountProject(files: List(templates.ProjectFile))
  ScheduleSave(
    delay: Int,
    name: String,
    files: List(templates.ProjectFile),
    messages: List(chat.Message),
    build_log: List(build_log.Entry),
    selected_path: String,
    current_project_id: Option(String),
  )
}

pub fn init() -> State {
  State(
    project_name: "Untitled Project",
    current_project_id: None,
    saved_projects: [],
    save_status: "Not saved",
    project_ready: False,
    name_editing: False,
    projects_open: False,
    files: templates.starter_files(),
    selected_path: "src/main.tsx",
    build_log: [],
  )
}

pub fn update(state: State, msg: Msg) -> #(State, List(Effect)) {
  case msg {
    ProjectLoaded(id, name, files, selected_path, updated_at, build_log) -> {
      let next_files = case files {
        [] -> templates.starter_files()
        _ -> files
      }
      let path = case selected_path {
        "" -> "src/main.tsx"
        _ -> selected_path
      }
      let status = case updated_at {
        "" -> state.save_status
        _ -> "Loaded " <> updated_at
      }
      #(
        State(
          ..state,
          current_project_id: id,
          project_name: name,
          files: next_files,
          selected_path: path,
          save_status: status,
          build_log: build_log,
        ),
        [],
      )
    }
    ProjectListRefreshed(projects) -> #(
      State(..state, saved_projects: projects),
      [],
    )
    ProjectCreated(id, name, files, selected_path) -> #(
      State(
        ..state,
        current_project_id: Some(id),
        project_name: name,
        files: files,
        selected_path: selected_path,
        save_status: "Saved just now",
        build_log: [],
      ),
      [],
    )
    ProjectNameChanged(name) -> #(State(..state, project_name: name), [])
    ProjectNameEditingToggled -> #(
      State(..state, name_editing: !state.name_editing),
      [],
    )
    ProjectNameEditingSet(editing) -> #(
      State(..state, name_editing: editing),
      [],
    )
    ProjectsDialogToggled -> #(
      State(..state, projects_open: !state.projects_open),
      [],
    )
    ProjectsDialogOpened -> #(State(..state, projects_open: True), [
      RefreshProjectList,
    ])
    ProjectsDialogClosed -> #(State(..state, projects_open: False), [])
    ProjectReady -> #(State(..state, project_ready: True), [])
    SaveStatusChanged(status) -> #(State(..state, save_status: status), [])
    FilesUpdated(files, status) -> #(
      State(..state, files: files, save_status: status),
      [],
    )
    FileApplied(path, content) -> #(
      State(
        ..state,
        files: templates.upsert_file(state.files, path, content),
        save_status: "Unsaved changes",
      ),
      [WriteFileToContainer(path, content)],
    )
    FileEdited(path, content) -> #(
      State(
        ..state,
        files: templates.upsert_file(state.files, path, content),
        save_status: "Unsaved changes",
      ),
      [DebouncedWriteFileToContainer(2000, path, content)],
    )
    SelectedPathChanged(path) -> #(State(..state, selected_path: path), [])
    ResetToStarter -> #(
      State(
        ..state,
        files: templates.starter_files(),
        selected_path: "src/main.tsx",
        save_status: "Unsaved changes",
        build_log: [],
      ),
      [RemountProject(templates.starter_files())],
    )
    BuildLogAppended(entry) -> #(
      State(..state, build_log: list.append(state.build_log, [entry])),
      [],
    )
  }
}

pub fn upsert_file(
  files: List(templates.ProjectFile),
  path: String,
  content: String,
) -> List(templates.ProjectFile) {
  templates.upsert_file(files, path, content)
}
