import build/pure/story

pub fn export_story_html(payload: story.Story) -> Nil {
  export_story_html_ffi(payload)
}

@external(javascript, "../../gleam-externals/story.mjs", "exportStoryHtml")
fn export_story_html_ffi(payload: story.Story) -> Nil
