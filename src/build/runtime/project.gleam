import build/actors/chat
import build/actors/project
import build/pure/build_log
import build/pure/templates
import gleam/option

pub fn interpret(effect: project.Effect) -> Nil {
  case effect {
    project.LoadInitialProject -> load_initial_project()
    project.SaveCurrentProject(
      name,
      files,
      messages,
      build_log,
      selected_path,
      current_project_id,
      silent,
    ) -> {
      // Keep the agent's file snapshot in step with the model. Every path that
      // changes a file funnels through a save, so publishing here means
      // `fs_read`/`fs_list` always see what `project.files` holds — never the
      // container's lossy replica.
      publish_project_files(files)
      save_current_project(
        name,
        files,
        messages,
        build_log,
        selected_path,
        option.unwrap(current_project_id, ""),
        silent,
      )
    }
    project.CreateProject(name, files, messages, selected_path) ->
      create_project(name, files, messages, selected_path)
    project.OpenProject(id) -> open_project(id)
    project.DeleteProject(id) -> delete_project(id)
    project.RefreshProjectList -> refresh_project_list()
    project.PersistCurrentProjectId(id) ->
      persist_current_project_id(option.unwrap(id, ""))
    project.WriteFileToContainer(path, content) -> {
      // Keep the agent's snapshot current on EVERY applied file, not only when
      // an autosave happens to run. Autosave is gated on the container being
      // hydrated, so relying on it alone left `fs_list` and `fs_read` reading an
      // empty project — the agent was blind to the very files it had written.
      publish_project_file(path, content)
      write_file_to_container(path, content)
    }
    project.DebouncedWriteFileToContainer(delay, path, content) ->
      schedule_write_file_to_container(delay, path, content)
    project.RemountProject(_) -> remount_project()
    project.ScheduleSave(
      delay,
      name,
      files,
      messages,
      build_log,
      selected_path,
      current_project_id,
    ) -> {
      publish_project_files(files)
      schedule_save(
        delay,
        name,
        files,
        messages,
        build_log,
        selected_path,
        option.unwrap(current_project_id, ""),
      )
    }
  }
}

/// Publish the current file set for the agent's tool executors.
///
/// `project.files` is the source of truth and the container FS is a lossy
/// replica, so `fs_read`/`fs_list` must read the model, not the disk.
@external(javascript, "../../gleam-externals/projects.mjs", "publishProjectFiles")
fn publish_project_files(files: List(templates.ProjectFile)) -> Nil

/// Upsert a single file into the snapshot, for the write path that fires
/// regardless of autosave.
@external(javascript, "../../gleam-externals/projects.mjs", "publishProjectFile")
fn publish_project_file(path: String, content: String) -> Nil

@external(javascript, "../../gleam-externals/projects.mjs", "loadInitialProject")
fn load_initial_project() -> Nil

@external(javascript, "../../gleam-externals/projects.mjs", "saveCurrentProject")
fn save_current_project(
  name: String,
  files: List(templates.ProjectFile),
  messages: List(chat.Message),
  build_log: List(build_log.Entry),
  selected_path: String,
  current_project_id: String,
  silent: Bool,
) -> Nil

@external(javascript, "../../gleam-externals/projects.mjs", "createProject")
fn create_project(
  name: String,
  files: List(templates.ProjectFile),
  messages: List(chat.Message),
  selected_path: String,
) -> Nil

@external(javascript, "../../gleam-externals/projects.mjs", "openProject")
fn open_project(id: String) -> Nil

@external(javascript, "../../gleam-externals/projects.mjs", "deleteProject")
fn delete_project(id: String) -> Nil

@external(javascript, "../../gleam-externals/projects.mjs", "refreshProjectList")
fn refresh_project_list() -> Nil

@external(javascript, "../../gleam-externals/projects.mjs", "persistCurrentProjectId")
fn persist_current_project_id(id: String) -> Nil

@external(javascript, "../../gleam-externals/webcontainer.mjs", "writeFileToContainer")
fn write_file_to_container(path: String, content: String) -> Nil

@external(javascript, "../../gleam-externals/webcontainer.mjs", "scheduleWriteFileToContainer")
fn schedule_write_file_to_container(
  delay: Int,
  path: String,
  content: String,
) -> Nil

@external(javascript, "../../gleam-externals/webcontainer.mjs", "remountProject")
fn remount_project() -> Nil

@external(javascript, "../../gleam-externals/projects.mjs", "scheduleSave")
fn schedule_save(
  delay: Int,
  name: String,
  files: List(templates.ProjectFile),
  messages: List(chat.Message),
  build_log: List(build_log.Entry),
  selected_path: String,
  current_project_id: String,
) -> Nil
