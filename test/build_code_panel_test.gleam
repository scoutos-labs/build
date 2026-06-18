import build/actors/preview
import build/actors/webcontainer
import build/model
import build/msg
import build/update
import gleeunit

pub fn main() -> Nil {
  gleeunit.main()
}

pub fn code_panel_hidden_by_default_test() {
  assert preview.init().code_panel_open == False
  assert preview.init().code_panel_unread == False
}

pub fn toggle_opens_and_closes_test() {
  let #(opened, effects) =
    preview.update(preview.init(), preview.CodePanelToggled)
  assert opened.code_panel_open
  assert effects == []

  let #(closed, _) = preview.update(opened, preview.CodePanelToggled)
  assert !closed.code_panel_open
}

pub fn opening_clears_the_unread_badge_test() {
  let unread =
    preview.State(..preview.init(), code_panel_unread: True)
  let #(opened, _) = preview.update(unread, preview.CodePanelToggled)
  assert opened.code_panel_open
  assert !opened.code_panel_unread
}

pub fn error_while_hidden_sets_unread_test() {
  let #(state, _) =
    preview.update(preview.init(), preview.CodePanelErrorSignaled)
  assert state.code_panel_unread
  assert !state.code_panel_open
}

pub fn error_while_open_does_not_badge_test() {
  let open = preview.State(..preview.init(), code_panel_open: True)
  let #(state, _) = preview.update(open, preview.CodePanelErrorSignaled)
  assert !state.code_panel_unread
}

// A preview-error log line, surfaced through the WebContainer actor, badges the
// hidden code panel via the top-level update.
pub fn preview_error_log_badges_hidden_panel_test() {
  let #(next, _) =
    update.update(
      model.init(),
      msg.WebContainer(webcontainer.LogAppended("[preview error] boom")),
    )
  assert next.preview.code_panel_unread
}

pub fn ordinary_log_does_not_badge_test() {
  let #(next, _) =
    update.update(
      model.init(),
      msg.WebContainer(webcontainer.LogAppended("vite ready in 300ms")),
    )
  assert !next.preview.code_panel_unread
}

pub fn preview_error_does_not_badge_when_open_test() {
  let app =
    model.Model(
      ..model.init(),
      preview: preview.State(..preview.init(), code_panel_open: True),
    )
  let #(next, _) =
    update.update(
      app,
      msg.WebContainer(webcontainer.LogAppended("[preview error] boom")),
    )
  assert !next.preview.code_panel_unread
}
