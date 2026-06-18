import build/actors/publish
import build/pure/templates

pub fn interpret(effect: publish.Effect) -> Nil {
  case effect {
    publish.FetchKeyStatus -> fetch_key_status()
    publish.SaveKey(key) -> save_key(key)
    publish.DeleteKey -> delete_key()
    publish.FetchDeployment(project_id) -> fetch_deployment(project_id)
    publish.StartPublish(project_id, subdomain, files) ->
      start_publish(project_id, subdomain, files)
    publish.PollStatus(build_id) -> poll_status(build_id)
    publish.SchedulePoll(build_id, delay) -> schedule_poll(build_id, delay)
  }
}

@external(javascript, "../../gleam-externals/publish.mjs", "fetchKeyStatus")
fn fetch_key_status() -> Nil

@external(javascript, "../../gleam-externals/publish.mjs", "saveKey")
fn save_key(key: String) -> Nil

@external(javascript, "../../gleam-externals/publish.mjs", "deleteKey")
fn delete_key() -> Nil

@external(javascript, "../../gleam-externals/publish.mjs", "fetchDeployment")
fn fetch_deployment(project_id: String) -> Nil

@external(javascript, "../../gleam-externals/publish.mjs", "startPublish")
fn start_publish(
  project_id: String,
  subdomain: String,
  files: List(templates.ProjectFile),
) -> Nil

@external(javascript, "../../gleam-externals/publish.mjs", "pollStatus")
fn poll_status(build_id: String) -> Nil

@external(javascript, "../../gleam-externals/publish.mjs", "schedulePoll")
fn schedule_poll(build_id: String, delay: Int) -> Nil
