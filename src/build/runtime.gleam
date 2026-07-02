import build/effect
import build/runtime/agent
import build/runtime/preview
import build/runtime/project
import build/runtime/publish
import build/runtime/settings
import build/runtime/story
import build/runtime/webcontainer
import build/runtime/zip

pub fn interpret(effect: effect.Effect) -> Nil {
  case effect {
    effect.Settings(payload) -> settings.interpret(payload)
    effect.Project(payload) -> project.interpret(payload)
    effect.Agent(payload) -> agent.interpret(payload)
    effect.Preview(payload) -> preview.interpret(payload)
    effect.WebContainer(payload) -> webcontainer.interpret(payload)
    effect.Publish(payload) -> publish.interpret(payload)
    effect.ExportZip(files) -> zip.export_zip(files)
    effect.ExportStoryHtml(payload) -> story.export_story_html(payload)
    effect.ConfirmNewProject -> confirm_new_project()
    effect.ConfirmRemoveProject(id) -> confirm_remove_project(id)
    effect.ScrollMessagesToBottom -> scroll_messages_to_bottom()
  }
}

@external(javascript, "../gleam-externals/dom.mjs", "scrollMessagesToBottom")
fn scroll_messages_to_bottom() -> Nil

@external(javascript, "../gleam-externals/browser.mjs", "confirmNewProject")
fn confirm_new_project() -> Nil

@external(javascript, "../gleam-externals/browser.mjs", "confirmRemoveProject")
fn confirm_remove_project(id: String) -> Nil

pub fn interpret_all(effects: List(effect.Effect)) -> Nil {
  case effects {
    [] -> Nil
    [first, ..rest] -> {
      interpret(first)
      interpret_all(rest)
    }
  }
}
