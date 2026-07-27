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
  assert next.messages == [chat.Message(chat.User, "hello", [])]
}

pub fn agent_ignores_stale_completion_test() {
  let #(running, _) =
    agent.update(agent.init(), agent.AgentRequestStarted("new", 1000))
  let #(next, effects) =
    agent.update(running, agent.AgentStepReturned("old", [], "ignored"))

  assert agent.is_running(next)
  assert effects == []
}

pub fn agent_completion_stops_the_timer_test() {
  let #(running, _) =
    agent.update(agent.init(), agent.AgentRequestStarted("req", 1000))
  let #(next, effects) =
    agent.update(running, agent.AgentStepReturned("req", [], "done"))

  assert next.lifecycle == agent.Idle
  // A turn that touched no package.json installs nothing. InstallDependencies
  // is now the ONLY install trigger — the old patch-list-inspecting
  // InstallIfNeeded was removed with the patch protocol.
  assert effects == [agent.StopElapsedTimer]
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

// ── Agent harness: the tool-calling loop ──────────────────────────────────────
// The loop is a pure state machine, so every one of these runs without mocks,
// without a WebContainer, and without a provider.

/// Start a turn and return the running state.
fn running_turn() -> agent.State {
  let #(state, _) =
    agent.update(agent.init(), agent.AgentRequestStarted("req", 1000))
  state
}

/// Inclusive integer range; `gleam/list` has no `range`.
fn int_range(from: Int, to: Int) -> List(Int) {
  case from > to {
    True -> []
    False -> [from, ..int_range(from + 1, to)]
  }
}

fn call(id: String, name: String) -> agent.ToolCall {
  agent.ToolCall(id: id, name: name, args_json: "{}")
}

/// Finish a call with no paths and no install.
fn finish(
  state: agent.State,
  id: String,
  summary: String,
) -> #(agent.State, List(agent.Effect)) {
  agent.update(
    state,
    agent.AgentToolFinished("req", id, agent.ToolDone, summary, [], False),
  )
}

pub fn agent_step_returning_no_calls_ends_the_turn_test() {
  let #(next, effects) =
    agent.update(running_turn(), agent.AgentStepReturned("req", [], "All done."))

  assert next.lifecycle == agent.Idle
  assert next.final_reply == "All done."
  // No package.json touched, so no install.
  assert effects == [agent.StopElapsedTimer]
}

pub fn agent_step_dispatches_one_execute_tool_per_call_test() {
  let #(next, effects) =
    agent.update(
      running_turn(),
      agent.AgentStepReturned("req", [call("c1", "fs_read"), call("c2", "fs_read")], ""),
    )

  assert next.step == 1
  assert list.length(next.pending_calls) == 2
  assert list.length(next.trail) == 2
  assert effects
    == [
      agent.ExecuteTool("req", call("c1", "fs_read")),
      agent.ExecuteTool("req", call("c2", "fs_read")),
    ]
}

pub fn agent_caps_calls_per_step_test() {
  let calls = [
    call("c1", "fs_read"),
    call("c2", "fs_read"),
    call("c3", "fs_read"),
    call("c4", "fs_read"),
  ]
  let #(next, effects) =
    agent.update(running_turn(), agent.AgentStepReturned("req", calls, ""))

  assert list.length(next.pending_calls) == agent.max_calls_per_step
  assert list.length(effects) == agent.max_calls_per_step
}

pub fn agent_takes_next_step_only_when_all_calls_finish_test() {
  let #(dispatched, _) =
    agent.update(
      running_turn(),
      agent.AgentStepReturned("req", [call("c1", "fs_read"), call("c2", "fs_read")], ""),
    )
  // First result: nothing yet — the step is not complete.
  let #(partial, first_effects) = finish(dispatched, "c1", "Read a file")
  assert first_effects == []
  assert list.length(partial.pending_calls) == 1

  // Second result completes the step.
  let #(complete, second_effects) = finish(partial, "c2", "Read a file")
  assert complete.pending_calls == []
  assert second_effects == [agent.CallAgentStep("req", 1)]
}

pub fn agent_stops_at_the_step_budget_test() {
  // Walk the turn to the ceiling, then assert the next round refuses to loop.
  let state =
    list.fold(int_range(1, agent.max_tool_steps), running_turn(), fn(acc, i) {
      let id = "c" <> int.to_string(i)
      let #(dispatched, _) =
        agent.update(acc, agent.AgentStepReturned("req", [call(id, "fs_read")], ""))
      let #(done, _) = finish(dispatched, id, "Read a file")
      done
    })

  assert state.step == agent.max_tool_steps

  // One more step's worth of calls must NOT dispatch.
  let #(next, effects) =
    agent.update(state, agent.AgentStepReturned("req", [call("over", "fs_read")], ""))
  assert next.lifecycle == agent.Idle
  assert next.pending_calls == []
  assert effects == [agent.StopElapsedTimer]
}

pub fn agent_step_budget_reached_ends_the_turn_test() {
  let #(dispatched, _) =
    agent.update(running_turn(), agent.AgentStepReturned("req", [call("c1", "fs_read")], ""))
  let #(next, effects) =
    agent.update(dispatched, agent.AgentStepBudgetReached("req"))

  assert next.lifecycle == agent.Idle
  assert next.pending_calls == []
  assert effects == [agent.StopElapsedTimer]
}

pub fn agent_touched_paths_dedupe_and_keep_first_write_order_test() {
  let #(dispatched, _) =
    agent.update(
      running_turn(),
      agent.AgentStepReturned("req", [call("c1", "fs_write"), call("c2", "fs_write")], ""),
    )
  let #(after_first, _) =
    agent.update(
      dispatched,
      agent.AgentToolFinished(
        "req",
        "c1",
        agent.ToolDone,
        "Wrote a file",
        ["src/App.tsx", "src/db.ts"],
        False,
      ),
    )
  let #(after_second, _) =
    agent.update(
      after_first,
      agent.AgentToolFinished(
        "req",
        "c2",
        agent.ToolDone,
        "Wrote a file",
        // src/App.tsx repeats and "" must be ignored entirely.
        ["src/index.css", "src/App.tsx", ""],
        False,
      ),
    )

  assert after_second.touched_paths
    == ["src/App.tsx", "src/db.ts", "src/index.css"]
}

pub fn agent_package_json_write_marks_dependencies_dirty_test() {
  let #(dispatched, _) =
    agent.update(running_turn(), agent.AgentStepReturned("req", [call("c1", "fs_write")], ""))
  let #(next, _) =
    agent.update(
      dispatched,
      agent.AgentToolFinished(
        "req",
        "c1",
        agent.ToolDone,
        "Wrote a file",
        ["package.json"],
        False,
      ),
    )

  assert next.pkg_dirty
}

pub fn agent_turn_end_installs_when_dependencies_are_dirty_test() {
  let #(dispatched, _) =
    agent.update(running_turn(), agent.AgentStepReturned("req", [call("c1", "fs_write")], ""))
  let #(dirty, _) =
    agent.update(
      dispatched,
      agent.AgentToolFinished(
        "req",
        "c1",
        agent.ToolDone,
        "Wrote a file",
        ["package.json"],
        False,
      ),
    )
  let #(finished, effects) =
    agent.update(dirty, agent.AgentStepReturned("req", [], "Added a package."))

  assert finished.lifecycle == agent.Idle
  assert effects == [agent.StopElapsedTimer, agent.InstallDependencies]
}

pub fn agent_successful_install_clears_dirty_so_the_turn_installs_once_test() {
  // package.json written, then the model runs npm install itself: the turn must
  // NOT install a second time at the end.
  let #(dispatched, _) =
    agent.update(running_turn(), agent.AgentStepReturned("req", [call("c1", "fs_write")], ""))
  let #(dirty, _) =
    agent.update(
      dispatched,
      agent.AgentToolFinished(
        "req",
        "c1",
        agent.ToolDone,
        "Wrote a file",
        ["package.json"],
        False,
      ),
    )
  assert dirty.pkg_dirty

  let #(installing, _) =
    agent.update(dirty, agent.AgentStepReturned("req", [call("c2", "exec")], ""))
  let #(installed, _) =
    agent.update(
      installing,
      agent.AgentToolFinished(
        "req",
        "c2",
        agent.ToolDone,
        "Installed 2 packages",
        [],
        True,
      ),
    )
  assert !installed.pkg_dirty

  let #(_, effects) =
    agent.update(installed, agent.AgentStepReturned("req", [], "Done."))
  assert effects == [agent.StopElapsedTimer]
}

pub fn agent_failed_install_leaves_dependencies_dirty_test() {
  // A failed install must not suppress the turn-end retry, or the project is
  // left missing the dependency the model just added.
  let #(dispatched, _) =
    agent.update(running_turn(), agent.AgentStepReturned("req", [call("c1", "fs_write")], ""))
  let #(dirty, _) =
    agent.update(
      dispatched,
      agent.AgentToolFinished(
        "req",
        "c1",
        agent.ToolDone,
        "Wrote a file",
        ["package.json"],
        False,
      ),
    )
  let #(attempted, _) =
    agent.update(dirty, agent.AgentStepReturned("req", [call("c2", "exec")], ""))
  let #(failed, _) =
    agent.update(
      attempted,
      // installed: False because the command exited nonzero.
      agent.AgentToolFinished(
        "req",
        "c2",
        agent.ToolFailed,
        "Install failed",
        [],
        False,
      ),
    )

  assert failed.pkg_dirty
  let #(_, effects) =
    agent.update(failed, agent.AgentStepReturned("req", [], "Hit a problem."))
  assert effects == [agent.StopElapsedTimer, agent.InstallDependencies]
}

pub fn agent_install_command_detection_test() {
  assert agent.is_install_command("npm", ["install"])
  assert agent.is_install_command("npm", ["install", "lucide-react"])
  assert agent.is_install_command("npm", ["i", "zod"])
  assert agent.is_install_command("npm", ["ci"])
  assert !agent.is_install_command("npm", ["run", "build"])
  assert !agent.is_install_command("npx", ["tsc", "--noEmit"])
  assert !agent.is_install_command("node", ["server.js"])
}

pub fn agent_trail_records_status_and_summary_test() {
  let #(dispatched, _) =
    agent.update(running_turn(), agent.AgentStepReturned("req", [call("c1", "exec")], ""))
  // Executor picks it up.
  let #(started, _) =
    agent.update(dispatched, agent.AgentToolStarted("req", "c1", "Checking it builds"))
  assert started.trail
    == [agent.TrailStep("c1", "exec", "Checking it builds", agent.ToolRunning)]

  // Finished rows read in past tense with the outcome.
  let #(done, _) = finish(started, "c1", "Built cleanly")
  assert done.trail
    == [agent.TrailStep("c1", "exec", "Built cleanly", agent.ToolDone)]
}

pub fn agent_trail_ignores_unknown_call_ids_test() {
  let #(dispatched, _) =
    agent.update(running_turn(), agent.AgentStepReturned("req", [call("c1", "fs_read")], ""))
  let #(next, effects) =
    agent.update(dispatched, agent.AgentToolStarted("req", "nope", "whatever"))

  assert next.trail == dispatched.trail
  assert effects == []
}

pub fn agent_keeps_last_non_empty_reply_across_steps_test() {
  // Models often narrate on an early step and stay silent later; the turn's
  // reply must not be blanked by the silent step.
  let #(narrated, _) =
    agent.update(
      running_turn(),
      agent.AgentStepReturned("req", [call("c1", "fs_read")], "Let me look."),
    )
  let #(after, _) = finish(narrated, "c1", "Read a file")
  let #(silent, _) =
    agent.update(after, agent.AgentStepReturned("req", [call("c2", "fs_write")], ""))
  assert silent.final_reply == "Let me look."

  let #(after2, _) = finish(silent, "c2", "Wrote a file")
  let #(final, _) =
    agent.update(after2, agent.AgentStepReturned("req", [], "Renamed the button."))
  assert final.final_reply == "Renamed the button."
}

pub fn agent_cancel_kills_exec_and_clears_the_turn_test() {
  let #(dispatched, _) =
    agent.update(running_turn(), agent.AgentStepReturned("req", [call("c1", "exec")], ""))
  let #(next, effects) = agent.update(dispatched, agent.AgentRequestCanceled)

  assert next.lifecycle == agent.Idle
  assert next.trail == []
  assert next.pending_calls == []
  assert next.touched_paths == []
  assert next.step == 0
  assert !next.pkg_dirty
  // KillExec is not optional: without it a wedged command outlives the turn.
  assert effects
    == [agent.StopElapsedTimer, agent.AbortAgent, agent.KillExec]
}

pub fn agent_timeout_kills_exec_and_rests_idle_test() {
  let #(dispatched, _) =
    agent.update(running_turn(), agent.AgentStepReturned("req", [call("c1", "exec")], ""))
  let #(next, effects) =
    agent.update(dispatched, agent.AgentTimeoutReached("req"))

  // Idle, not TimedOut: the user must be able to retry immediately.
  assert next.lifecycle == agent.Idle
  assert next.trail == []
  assert effects
    == [agent.StopElapsedTimer, agent.AbortAgent, agent.KillExec]
}

pub fn agent_failure_kills_exec_test() {
  let #(dispatched, _) =
    agent.update(running_turn(), agent.AgentStepReturned("req", [call("c1", "exec")], ""))
  let #(next, effects) =
    agent.update(dispatched, agent.AgentRequestFailed("req", "boom"))

  assert next.lifecycle == agent.Idle
  assert effects == [agent.StopElapsedTimer, agent.KillExec]
}

pub fn agent_budget_exhausted_mid_loop_ends_cleanly_test() {
  let #(dispatched, _) =
    agent.update(running_turn(), agent.AgentStepReturned("req", [call("c1", "fs_write")], ""))
  let #(next, effects) =
    agent.update(dispatched, agent.AgentBudgetExhausted("req", "2026-08-01"))

  assert next.lifecycle == agent.Idle
  assert next.budget_exhausted
  assert next.budget_reset_at == "2026-08-01"
  assert next.trail == []
  assert effects == [agent.StopElapsedTimer, agent.KillExec]
}

pub fn agent_ignores_stale_request_ids_at_every_entry_point_test() {
  let state = running_turn()
  let #(a, ea) =
    agent.update(state, agent.AgentStepReturned("old", [call("c1", "fs_read")], "x"))
  let #(b, eb) = agent.update(state, agent.AgentToolStarted("old", "c1", "x"))
  let #(c, ec) =
    agent.update(
      state,
      agent.AgentToolFinished("old", "c1", agent.ToolDone, "x", ["a.ts"], False),
    )
  let #(d, ed) = agent.update(state, agent.AgentStepBudgetReached("old"))
  let #(e, ee) = agent.update(state, agent.AgentTimeoutReached("old"))

  assert ea == []
  assert eb == []
  assert ec == []
  assert ed == []
  assert ee == []
  assert a == state
  assert b == state
  assert c == state
  assert d == state
  assert e == state
}

pub fn agent_new_turn_clears_the_previous_trail_test() {
  let #(dispatched, _) =
    agent.update(running_turn(), agent.AgentStepReturned("req", [call("c1", "fs_write")], ""))
  let #(dirty, _) =
    agent.update(
      dispatched,
      agent.AgentToolFinished(
        "req",
        "c1",
        agent.ToolDone,
        "Wrote a file",
        ["package.json"],
        False,
      ),
    )

  let #(fresh, _) =
    agent.update(dirty, agent.AgentRequestStarted("req2", 2000))
  assert fresh.trail == []
  assert fresh.touched_paths == []
  assert fresh.step == 0
  assert !fresh.pkg_dirty
  assert fresh.final_reply == ""
  assert fresh.lifecycle == agent.Running("req2", 2000)
}

pub fn agent_turn_summary_reads_as_prose_test() {
  let state = running_turn()
  let #(dispatched, _) =
    agent.update(
      state,
      agent.AgentStepReturned("req", [call("c1", "fs_write"), call("c2", "exec")], ""),
    )
  let #(wrote, _) =
    agent.update(
      dispatched,
      agent.AgentToolFinished(
        "req",
        "c1",
        agent.ToolDone,
        "Wrote a file",
        ["src/App.tsx"],
        False,
      ),
    )
  let #(checked, _) = finish(wrote, "c2", "Built cleanly")

  assert agent.turn_summary(checked)
    == "2 steps · 1 file · checked it builds"
}

pub fn agent_turn_summary_omits_verification_when_none_ran_test() {
  let #(dispatched, _) =
    agent.update(running_turn(), agent.AgentStepReturned("req", [call("c1", "fs_write")], ""))
  let #(wrote, _) =
    agent.update(
      dispatched,
      agent.AgentToolFinished(
        "req",
        "c1",
        agent.ToolDone,
        "Wrote a file",
        ["src/App.tsx"],
        False,
      ),
    )

  assert agent.turn_summary(wrote) == "1 step · 1 file"
}

pub fn agent_turn_summary_omits_verification_when_it_failed_test() {
  let #(dispatched, _) =
    agent.update(running_turn(), agent.AgentStepReturned("req", [call("c1", "exec")], ""))
  let #(failed, _) =
    agent.update(
      dispatched,
      agent.AgentToolFinished(
        "req",
        "c1",
        agent.ToolFailed,
        "Typechecked — 3 problems",
        [],
        False,
      ),
    )

  // "checked it builds" is a claim about correctness — it must not appear when
  // the check failed.
  assert agent.turn_summary(failed) == "1 step"
}

pub fn agent_trail_is_collapsed_by_default_and_toggles_test() {
  let state = running_turn()
  assert !state.trail_expanded
  let #(open, effects) = agent.update(state, agent.AgentTrailToggled)
  assert open.trail_expanded
  assert effects == []
  let #(closed, _) = agent.update(open, agent.AgentTrailToggled)
  assert !closed.trail_expanded
}

pub fn agent_new_turn_recollapses_the_trail_test() {
  // A previous turn left expanded must not leave the next turn's trail open —
  // the summary is the resting state.
  let #(open, _) = agent.update(running_turn(), agent.AgentTrailToggled)
  let #(fresh, _) = agent.update(open, agent.AgentRequestStarted("req2", 2000))
  assert !fresh.trail_expanded
}
