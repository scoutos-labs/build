import build/actors/chat
import build/actors/preview
import build/actors/webcontainer
import build/model
import build/msg
import build/update
import gleeunit

pub fn main() -> Nil {
  gleeunit.main()
}

pub fn starts_in_chat_mode_test() {
  let state = preview.init()
  assert state.layout == preview.ChatMode
  assert !state.layout_is_manual
  assert !state.code_panel_unread
  assert !preview.code_panel_open(state)
}

pub fn first_preview_url_auto_switches_to_split_test() {
  let #(state, _) =
    preview.update(preview.init(), preview.PreviewUrlChanged("http://p"))
  assert state.layout == preview.SplitMode
  assert state.preview_url == "http://p"
  // the reveal is automatic, not a manual choice
  assert !state.layout_is_manual
}

pub fn url_refire_does_not_change_split_or_builder_test() {
  // crash restarts and reboots re-fire the URL; the layout must not move
  let split = preview.State(..preview.init(), layout: preview.SplitMode)
  let #(after_split, _) =
    preview.update(split, preview.PreviewUrlChanged("http://p2"))
  assert after_split.layout == preview.SplitMode

  let builder = preview.State(..preview.init(), layout: preview.BuilderMode)
  let #(after_builder, _) =
    preview.update(builder, preview.PreviewUrlChanged("http://p2"))
  assert after_builder.layout == preview.BuilderMode
}

pub fn manual_chat_choice_blocks_auto_switch_test() {
  // a deliberate switch back to Chat (from another mode) is manual: the
  // auto reveal must never fight it
  let split = preview.State(..preview.init(), layout: preview.SplitMode)
  let #(chose_chat, _) =
    preview.update(split, preview.LayoutModeSelected(preview.ChatMode))
  assert chose_chat.layout_is_manual

  let #(state, _) =
    preview.update(chose_chat, preview.PreviewUrlChanged("http://p"))
  assert state.layout == preview.ChatMode
}

pub fn selecting_builder_clears_unread_test() {
  let unread = preview.State(..preview.init(), code_panel_unread: True)
  let #(state, _) =
    preview.update(unread, preview.LayoutModeSelected(preview.BuilderMode))
  assert state.layout == preview.BuilderMode
  assert preview.code_panel_open(state)
  assert !state.code_panel_unread
}

pub fn error_outside_builder_sets_unread_test() {
  let #(in_chat, _) =
    preview.update(preview.init(), preview.CodePanelErrorSignaled)
  assert in_chat.code_panel_unread

  let split = preview.State(..preview.init(), layout: preview.SplitMode)
  let #(in_split, _) = preview.update(split, preview.CodePanelErrorSignaled)
  assert in_split.code_panel_unread
}

pub fn error_in_builder_does_not_badge_test() {
  let builder = preview.State(..preview.init(), layout: preview.BuilderMode)
  let #(state, _) = preview.update(builder, preview.CodePanelErrorSignaled)
  assert !state.code_panel_unread
}

pub fn switching_to_chat_disables_element_selection_test() {
  // selection can only be armed while the preview is visible, so the
  // scenario starts from SplitMode
  let selecting =
    preview.State(
      ..preview.init(),
      layout: preview.SplitMode,
      selecting_element: True,
    )
  let #(state, effects) =
    preview.update(selecting, preview.LayoutModeSelected(preview.ChatMode))
  assert !state.selecting_element
  assert effects
    == [preview.PostInspectorMessage(preview.BuildInspectorDisable)]
}

pub fn switching_to_split_keeps_element_selection_test() {
  let selecting = preview.State(..preview.init(), selecting_element: True)
  let #(state, effects) =
    preview.update(selecting, preview.LayoutModeSelected(preview.SplitMode))
  assert state.selecting_element
  assert effects == []
}

// --- unread badge routed through the top-level update (ports of the old
// code-panel tests) ---

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

pub fn preview_error_does_not_badge_in_builder_test() {
  let app =
    model.Model(
      ..model.init(),
      preview: preview.State(..preview.init(), layout: preview.BuilderMode),
    )
  let #(next, _) =
    update.update(
      app,
      msg.WebContainer(webcontainer.LogAppended("[preview error] boom")),
    )
  assert !next.preview.code_panel_unread
}

// --- journey resets on user-initiated project navigation ---

fn app_with_preview(state: preview.State) -> model.Model {
  model.Model(..model.init(), preview: state)
}

pub fn new_project_exits_chat_mode_when_url_exists_test() {
  // even a manual chat choice: creating a project is a navigation, and the
  // new starter app IS the interview wizard — it must be visible
  let app =
    app_with_preview(preview.State(
      ..preview.init(),
      layout: preview.ChatMode,
      layout_is_manual: True,
      preview_url: "http://p",
    ))
  let #(next, _) = update.update(app, msg.NewProjectConfirmed)
  assert next.preview.layout == preview.SplitMode
  assert !next.preview.layout_is_manual
}

pub fn new_project_stays_chat_before_first_boot_test() {
  // no URL yet (session still booting): stay in chat; the reveal handles it
  let #(next, _) = update.update(model.init(), msg.NewProjectConfirmed)
  assert next.preview.layout == preview.ChatMode
}

pub fn open_project_keeps_builder_mode_test() {
  let app =
    app_with_preview(preview.State(
      ..preview.init(),
      layout: preview.BuilderMode,
      layout_is_manual: True,
      preview_url: "http://p",
    ))
  let #(next, _) = update.update(app, msg.OpenProject("p1"))
  assert next.preview.layout == preview.BuilderMode
}

pub fn open_project_rearms_auto_switch_test() {
  let app =
    app_with_preview(preview.State(
      ..preview.init(),
      layout: preview.SplitMode,
      layout_is_manual: True,
      preview_url: "http://p",
    ))
  let #(next, _) = update.update(app, msg.OpenProject("p1"))
  assert !next.preview.layout_is_manual
}

pub fn reset_project_exits_chat_when_url_exists_test() {
  let app =
    app_with_preview(preview.State(
      ..preview.init(),
      layout: preview.ChatMode,
      layout_is_manual: True,
      preview_url: "http://p",
    ))
  let #(next, _) = update.update(app, msg.ResetProject)
  assert next.preview.layout == preview.SplitMode
}

pub fn empty_url_does_not_reveal_test() {
  // the non-browser fallback fires onUrl("") — never reveal a blank preview
  let #(state, _) = preview.update(preview.init(), preview.PreviewUrlChanged(""))
  assert state.layout == preview.ChatMode
}

pub fn clicking_active_segment_is_a_noop_test() {
  // an idle click on the already-active Chat segment must not arm the
  // manual flag and silently kill the auto reveal
  let #(state, effects) =
    preview.update(preview.init(), preview.LayoutModeSelected(preview.ChatMode))
  assert state == preview.init()
  assert effects == []

  let #(revealed, _) =
    preview.update(state, preview.PreviewUrlChanged("http://p"))
  assert revealed.layout == preview.SplitMode
}
