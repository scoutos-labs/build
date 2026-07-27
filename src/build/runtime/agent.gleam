import build/actors/agent
import build/actors/chat
import build/actors/settings
import build/pure/preview_inspector
import build/pure/templates
import gleam/option

pub fn interpret(effect: agent.Effect) -> Nil {
  case effect {
    agent.CallAgent(request_id, provider, api_key, ollama_url, model, user_prompt, files, messages, selected_element, element_comment) ->
      call_agent(request_id, settings.provider_to_string(provider), model, user_prompt, api_key, ollama_url, files, messages, selected_element, element_comment)
    agent.CallAgentStep(request_id, step) -> call_agent_step(request_id, step)
    agent.ExecuteTool(request_id, call) ->
      execute_tool(request_id, call.id, call.name, call.args_json)
    agent.KillExec -> kill_exec()
    agent.StartElapsedTimer -> start_elapsed_timer()
    agent.StopElapsedTimer -> stop_elapsed_timer()
    agent.AbortAgent -> abort_agent()
    agent.InstallDependencies -> install_dependencies()
  }
}

@external(javascript, "../../gleam-externals/agent.mjs", "callAgent")
fn call_agent(request_id: String, provider: String, model: String, user_prompt: String, api_key: String, ollama_url: String, files: List(templates.ProjectFile), messages: List(chat.Message), selected_element: option.Option(preview_inspector.SelectedPreviewElement), element_comment: String) -> Nil

@external(javascript, "../../gleam-externals/agent.mjs", "callAgentStep")
fn call_agent_step(request_id: String, step: Int) -> Nil

/// The call is flattened to primitives so the JS side never has to know the
/// shape of a Gleam record.
@external(javascript, "../../gleam-externals/agent.mjs", "executeTool")
fn execute_tool(
  request_id: String,
  call_id: String,
  name: String,
  args_json: String,
) -> Nil

@external(javascript, "../../gleam-externals/agent.mjs", "killExec")
fn kill_exec() -> Nil

@external(javascript, "../../gleam-externals/agent.mjs", "installDependencies")
fn install_dependencies() -> Nil

@external(javascript, "../../gleam-externals/agent.mjs", "startElapsedTimer")
fn start_elapsed_timer() -> Nil

@external(javascript, "../../gleam-externals/agent.mjs", "stopElapsedTimer")
fn stop_elapsed_timer() -> Nil

@external(javascript, "../../gleam-externals/agent.mjs", "abortAgent")
fn abort_agent() -> Nil

