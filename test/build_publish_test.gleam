import build/actors/project
import build/actors/publish
import build/actors/settings
import build/effect
import build/model
import build/msg
import build/update
import gleam/option.{Some}
import gleeunit

pub fn main() -> Nil {
  gleeunit.main()
}

fn with_key(state: publish.State) -> publish.State {
  publish.State(..state, key_saved: True)
}

fn app_with_publish(state: publish.State) -> model.Model {
  model.Model(
    ..model.init(),
    publish: state,
    project: project.State(
      ..project.init(),
      current_project_id: Some("proj_1"),
    ),
  )
}

// ── subdomain validation (pre-network, mirrors the server) ─────────────────

pub fn check_subdomain_accepts_valid_names_test() {
  assert publish.check_subdomain("my-app") == Ok("my-app")
  assert publish.check_subdomain("  My-App ") == Ok("my-app")
  assert publish.check_subdomain("a") == Ok("a")
}

pub fn check_subdomain_rejects_bad_shapes_test() {
  assert publish.check_subdomain("") |> is_error
  assert publish.check_subdomain("-app") |> is_error
  assert publish.check_subdomain("app-") |> is_error
  assert publish.check_subdomain("my_app") |> is_error
  assert publish.check_subdomain("my.app") |> is_error
}

pub fn check_subdomain_rejects_reserved_names_test() {
  assert publish.check_subdomain("api") |> is_error
  assert publish.check_subdomain("WWW") |> is_error
}

fn is_error(result: Result(a, b)) -> Bool {
  case result {
    Error(_) -> True
    Ok(_) -> False
  }
}

// ── key shape gate ──────────────────────────────────────────────────────────

pub fn key_shape_test() {
  assert publish.key_shape_ok("sk_live_abc123def456")
  assert publish.key_shape_ok("  sk_test_abc123def456  ")
  assert !publish.key_shape_ok("sk-or-v1-not-a-scoutos-key")
  assert !publish.key_shape_ok("sk_live_x")
}

// ── actor state machine ─────────────────────────────────────────────────────

pub fn publish_without_key_routes_to_settings_test() {
  let #(state, effects) =
    publish.update(publish.init(), publish.PublishClicked("proj_1"))

  assert state.status == publish.NeedsKey
  assert state.dialog_open
  assert effects == []
}

pub fn publish_with_key_checks_deployment_test() {
  let #(state, effects) =
    publish.update(
      with_key(publish.init()),
      publish.PublishClicked("proj_1"),
    )

  assert state.status == publish.CheckingDeployment("proj_1")
  assert effects == [publish.FetchDeployment("proj_1")]
}

pub fn first_publish_prompts_for_subdomain_test() {
  let checking =
    publish.State(
      ..with_key(publish.init()),
      status: publish.CheckingDeployment("proj_1"),
    )
  let #(state, effects) =
    publish.update(
      checking,
      publish.DeploymentLoaded("proj_1", False, ""),
    )

  assert state.status == publish.Prompting("")
  assert effects == []
}

pub fn republish_skips_the_prompt_test() {
  let checking =
    publish.State(
      ..with_key(publish.init()),
      status: publish.CheckingDeployment("proj_1"),
    )
  let #(state, _) =
    publish.update(
      checking,
      publish.DeploymentLoaded("proj_1", True, "my-app"),
    )

  assert state.status == publish.Publishing("proj_1", "my-app")
}

pub fn invalid_subdomain_feedback_is_local_test() {
  let prompting =
    publish.State(
      ..with_key(publish.init()),
      status: publish.Prompting(""),
      subdomain_input: "Bad Name!",
    )
  let #(state, effects) =
    publish.update(prompting, publish.SubdomainSubmitted("proj_1"))

  assert effects == []
  assert case state.status {
    publish.Prompting(error) -> error != ""
    _ -> False
  }
}

pub fn accepted_publish_schedules_polling_test() {
  let #(state, effects) =
    publish.update(
      with_key(publish.init()),
      publish.PublishAccepted("bld_1", "my-app"),
    )

  assert state.status == publish.Polling("bld_1", "my-app")
  assert effects == [publish.SchedulePoll("bld_1", 2000)]
}

pub fn poll_cycle_runs_until_deployed_test() {
  let polling =
    publish.State(
      ..with_key(publish.init()),
      status: publish.Polling("bld_1", "my-app"),
    )

  let #(_, due_effects) = publish.update(polling, publish.PollDue("bld_1"))
  assert due_effects == [publish.PollStatus("bld_1")]

  let #(running, running_effects) =
    publish.update(
      polling,
      publish.StatusPolled("bld_1", "running", "", "", ""),
    )
  assert running.status == publish.Polling("bld_1", "my-app")
  assert running_effects == [publish.SchedulePoll("bld_1", 2000)]

  let #(deployed, deployed_effects) =
    publish.update(
      polling,
      publish.StatusPolled(
        "bld_1",
        "deployed",
        "https://my-app.scoutos.live",
        "",
        "",
      ),
    )
  assert deployed.status == publish.Deployed("https://my-app.scoutos.live")
  assert deployed_effects == []
}

pub fn stale_polls_are_ignored_test() {
  let polling =
    publish.State(
      ..with_key(publish.init()),
      status: publish.Polling("bld_2", "my-app"),
    )
  let #(state, effects) =
    publish.update(
      polling,
      publish.StatusPolled("bld_1", "deployed", "https://old.scoutos.live", "", ""),
    )

  assert state.status == publish.Polling("bld_2", "my-app")
  assert effects == []
}

pub fn failed_build_surfaces_logs_test() {
  let polling =
    publish.State(
      ..with_key(publish.init()),
      status: publish.Polling("bld_1", "my-app"),
    )
  let #(state, _) =
    publish.update(
      polling,
      publish.StatusPolled("bld_1", "failed", "", "npm failed", "log lines"),
    )

  assert state.status == publish.Failed("npm failed", "log lines")
}

pub fn subdomain_taken_reprompts_test() {
  let #(state, _) =
    publish.update(
      with_key(publish.init()),
      publish.PublishRejected("subdomain_taken", "That subdomain is taken"),
    )

  assert state.status == publish.Prompting("That subdomain is taken")
}

pub fn missing_key_error_resets_key_state_test() {
  let #(state, _) =
    publish.update(
      with_key(publish.init()),
      publish.PublishRejected("no_scoutos_key", "Add your key"),
    )

  assert state.status == publish.NeedsKey
  assert !state.key_saved
}

pub fn save_key_validates_shape_locally_test() {
  let bad =
    publish.State(..publish.init(), key_input: "not-a-key")
  let #(state, effects) = publish.update(bad, publish.SaveKeyClicked)
  assert effects == []
  assert state.key_status != ""

  let good =
    publish.State(..publish.init(), key_input: " sk_live_abc123def456 ")
  let #(saving, save_effects) = publish.update(good, publish.SaveKeyClicked)
  assert save_effects == [publish.SaveKey("sk_live_abc123def456")]
  assert saving.key_status == "Saving..."
}

pub fn key_saved_unblocks_needs_key_test() {
  let needs_key =
    publish.State(..publish.init(), status: publish.NeedsKey)
  let #(state, _) = publish.update(needs_key, publish.KeySaved)

  assert state.key_saved
  assert state.status == publish.Idle
  assert state.key_input == ""
}

// ── top-level wiring: files are attached when publishing starts ─────────────

pub fn entering_publishing_starts_publish_with_files_test() {
  let app =
    app_with_publish(publish.State(
      ..with_key(publish.init()),
      status: publish.CheckingDeployment("proj_1"),
    ))
  let #(next, effects) =
    update.update(
      app,
      msg.Publish(publish.DeploymentLoaded("proj_1", True, "my-app")),
    )

  assert next.publish.status == publish.Publishing("proj_1", "my-app")
  assert effects
    == [
      effect.Publish(publish.StartPublish(
        "proj_1",
        "my-app",
        app.project.files,
      )),
    ]
}

pub fn prompt_submission_starts_publish_with_files_test() {
  let app =
    app_with_publish(publish.State(
      ..with_key(publish.init()),
      status: publish.Prompting(""),
      subdomain_input: "fresh-name",
    ))
  let #(next, effects) =
    update.update(app, msg.Publish(publish.SubdomainSubmitted("proj_1")))

  assert next.publish.status == publish.Publishing("proj_1", "fresh-name")
  assert effects
    == [
      effect.Publish(publish.StartPublish(
        "proj_1",
        "fresh-name",
        app.project.files,
      )),
    ]
}

pub fn already_publishing_does_not_restart_test() {
  let app =
    app_with_publish(publish.State(
      ..with_key(publish.init()),
      status: publish.Publishing("proj_1", "my-app"),
    ))
  let #(_, effects) =
    update.update(app, msg.Publish(publish.SubdomainChanged("typing")))

  assert effects == []
}

pub fn managed_init_fetches_key_status_test() {
  let app = model.Model(..model.init(), managed: True)
  let #(_, effects) = update.update(app, msg.InitApp)

  assert effects
    == [
      effect.Settings(settings.PurgeLegacySettings),
      effect.Settings(settings.FetchAccountInfo),
      effect.Settings(settings.LoadPersona),
      effect.Publish(publish.FetchKeyStatus),
      effect.Project(project.LoadInitialProject),
    ]
}
