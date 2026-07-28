import build/actors/agent
import build/components/build_agent_chat
import build/components/build_element_picker
import build/msg
import build/runtime/ids
import gleam/dynamic
import gleam/dynamic/decode

fn keydown_event(key: String, meta: Bool) -> dynamic.Dynamic {
  dynamic.properties([
    #(dynamic.string("key"), dynamic.string(key)),
    #(dynamic.string("ctrlKey"), dynamic.bool(False)),
    #(dynamic.string("metaKey"), dynamic.bool(meta)),
  ])
}

pub fn submit_click_dispatches_unique_ids_and_real_timestamps_test() {
  let assert Ok(msg.SubmitPrompt(first_id, first_now)) =
    decode.run(dynamic.nil(), build_agent_chat.submit_click_decoder())
  let assert Ok(msg.SubmitPrompt(second_id, second_now)) =
    decode.run(dynamic.nil(), build_agent_chat.submit_click_decoder())

  assert first_id != second_id
  // A real epoch timestamp, not the hardcoded 0 (2026 > 1.7e12 ms).
  assert first_now > 1_700_000_000_000
  assert second_now >= first_now
}

pub fn submit_shortcut_dispatches_unique_ids_test() {
  let assert Ok(msg.SubmitPrompt(first_id, _)) =
    decode.run(
      keydown_event("Enter", True),
      build_agent_chat.submit_shortcut_decoder(),
    )
  let assert Ok(msg.SubmitPrompt(second_id, _)) =
    decode.run(
      keydown_event("Enter", True),
      build_agent_chat.submit_shortcut_decoder(),
    )
  let assert Ok(msg.NoOp) =
    decode.run(
      keydown_event("Enter", False),
      build_agent_chat.submit_shortcut_decoder(),
    )

  assert first_id != second_id
}

pub fn improve_click_dispatches_unique_ids_test() {
  let assert Ok(msg.ImproveSelectedElement(first_id, first_now)) =
    decode.run(dynamic.nil(), build_element_picker.improve_click_decoder())
  let assert Ok(msg.ImproveSelectedElement(second_id, _)) =
    decode.run(dynamic.nil(), build_element_picker.improve_click_decoder())

  assert first_id != second_id
  assert first_now > 1_700_000_000_000
}

pub fn elapsed_tick_counts_seconds_since_submit_test() {
  let started_at = ids.now_ms()
  let #(running, _) =
    agent.update(
      agent.init(),
      agent.AgentRequestStarted(ids.new_request_id(), started_at, []),
    )
  let #(ticked, _) =
    agent.update(running, agent.AgentElapsedTick(started_at + 2500))

  assert ticked.elapsed_seconds == 2
}

pub fn canceled_request_late_response_is_discarded_test() {
  let request_a = ids.new_request_id()
  let request_b = ids.new_request_id()

  let #(running_a, _) =
    agent.update(
      agent.init(),
      agent.AgentRequestStarted(request_a, ids.now_ms(), []),
    )
  let #(canceled, cancel_effects) =
    agent.update(running_a, agent.AgentRequestCanceled)
  // KillExec joined this list with the tool harness: under the loop a cancel
  // can land while a command is running, and a wedged process that outlives the
  // turn quietly degrades the container.
  assert cancel_effects
    == [agent.StopElapsedTimer, agent.AbortAgent, agent.KillExec]

  let #(running_b, _) =
    agent.update(canceled, agent.AgentRequestStarted(request_b, ids.now_ms(), []))

  // A's late response arrives after B started: ignored, B keeps running.
  // Under the harness this matters more than it did: a late step response that
  // matched would drive tool execution into the wrong turn's project.
  let #(after_late_a, late_effects) =
    agent.update(
      running_b,
      agent.AgentStepReturned(request_a, [], "stale reply"),
    )
  assert after_late_a == running_b
  assert late_effects == []
  assert agent.is_running(after_late_a)

  // B's own response still lands.
  let #(after_b, b_effects) =
    agent.update(
      after_late_a,
      agent.AgentStepReturned(request_b, [], "fresh reply"),
    )
  assert !agent.is_running(after_b)
  assert after_b.final_reply == "fresh reply"
  assert b_effects == [agent.StopElapsedTimer]
}
