import build/actors/agent
import build/actors/chat
import build/actors/settings
import build/actors/webcontainer
import build/components/build_agent_chat
import build/effect
import build/model
import build/msg
import build/update
import gleam/list

fn managed_ready_app() -> model.Model {
  model.Model(
    ..model.init(),
    managed: True,
    settings: settings.State(..settings.init(), settings_open: False),
    chat: chat.State(messages: [], prompt: "make app", expanded_messages: []),
    webcontainer: webcontainer.State(
      ..webcontainer.init(),
      boot_phase: webcontainer.Ready,
    ),
  )
}

pub fn managed_init_purges_legacy_settings_and_fetches_account_test() {
  let app = model.Model(..model.init(), managed: True)
  let #(_, effects) = update.update(app, msg.InitApp)

  assert list.contains(effects, effect.Settings(settings.PurgeLegacySettings))
  assert list.contains(effects, effect.Settings(settings.FetchAccountInfo))
  assert !list.contains(effects, effect.Settings(settings.LoadSettings))
}

pub fn unmanaged_init_loads_legacy_settings_test() {
  let #(_, effects) = update.update(model.init(), msg.InitApp)
  assert list.contains(effects, effect.Settings(settings.LoadSettings))
}

pub fn managed_submit_works_without_provider_or_key_test() {
  let app = managed_ready_app()
  let #(next, effects) = update.update(app, msg.SubmitPrompt("req-1", 1000))

  // No settings modal, a real agent call, and no legacy persist effect.
  assert !next.settings.settings_open
  assert list.any(effects, fn(e) {
    case e {
      effect.Agent(agent.CallAgent(..)) -> True
      _ -> False
    }
  })
  assert !list.any(effects, fn(e) {
    case e {
      effect.Settings(settings.PersistSettings(..)) -> True
      _ -> False
    }
  })
}

pub fn budget_exhausted_sets_state_and_blocks_submit_test() {
  let app = managed_ready_app()
  let #(running, _) = update.update(app, msg.SubmitPrompt("req-1", 1000))
  let #(exhausted, effects) =
    update.update(
      running,
      msg.Agent(agent.AgentBudgetExhausted("req-1", "2026-07-01T00:00:00.000Z")),
    )

  assert exhausted.agent.budget_exhausted
  assert exhausted.agent.budget_reset_at == "2026-07-01T00:00:00.000Z"
  assert list.contains(effects, effect.Agent(agent.StopElapsedTimer))

  // Submitting while exhausted is a no-op.
  let #(after_submit, submit_effects) =
    update.update(
      model.Model(
        ..exhausted,
        chat: chat.State(..exhausted.chat, prompt: "try again"),
      ),
      msg.SubmitPrompt("req-2", 2000),
    )
  assert submit_effects == []
  assert !agent.is_running(after_submit.agent)
}

pub fn stale_budget_exhausted_is_ignored_test() {
  let app = managed_ready_app()
  let #(running, _) = update.update(app, msg.SubmitPrompt("req-2", 1000))
  let #(next, _) =
    update.update(
      running,
      msg.Agent(agent.AgentBudgetExhausted("req-1", "2026-07-01")),
    )
  assert !next.agent.budget_exhausted
  assert agent.is_running(next.agent)
}

pub fn budget_exhausted_message_includes_reset_date_test() {
  assert build_agent_chat.budget_exhausted_message("2026-07-01T00:00:00.000Z")
    == "Monthly build budget used up. Upgrade or wait until 2026-07-01."
  assert build_agent_chat.budget_exhausted_message("")
    == "Monthly build budget used up. Upgrade to keep building."
}

pub fn account_loaded_updates_settings_state_test() {
  let #(state, effects) =
    settings.update(
      settings.init(),
      settings.AccountLoaded("free", "$0.75 of $1.00 remaining this month"),
    )
  assert state.account_plan == "free"
  assert state.account_budget == "$0.75 of $1.00 remaining this month"
  assert effects == []
}

pub fn sign_out_requested_emits_sign_out_effect_test() {
  let #(_, effects) = settings.update(settings.init(), settings.SignOutRequested)
  assert effects == [settings.SignOut]
}
