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
    agent.StartElapsedTimer -> start_elapsed_timer()
    agent.StopElapsedTimer -> stop_elapsed_timer()
    agent.AbortAgent -> abort_agent()
    agent.InstallIfNeeded(patches) -> install_if_needed(patches)
  }
}

@external(javascript, "../../gleam-externals/agent.mjs", "callAgent")
fn call_agent(request_id: String, provider: String, model: String, user_prompt: String, api_key: String, ollama_url: String, files: List(templates.ProjectFile), messages: List(chat.Message), selected_element: option.Option(preview_inspector.SelectedPreviewElement), element_comment: String) -> Nil

@external(javascript, "../../gleam-externals/agent.mjs", "startElapsedTimer")
fn start_elapsed_timer() -> Nil

@external(javascript, "../../gleam-externals/agent.mjs", "stopElapsedTimer")
fn stop_elapsed_timer() -> Nil

@external(javascript, "../../gleam-externals/agent.mjs", "abortAgent")
fn abort_agent() -> Nil

@external(javascript, "../../gleam-externals/agent.mjs", "installIfNeeded")
fn install_if_needed(patches: List(agent.Patch)) -> Nil
