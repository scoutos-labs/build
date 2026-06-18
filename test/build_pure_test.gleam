import build/pure/design_guidance
import build/pure/editor
import build/pure/preview_inspector
import build/pure/templates
import gleam/list
import gleam/string
import gleeunit

pub fn main() -> Nil {
  gleeunit.main()
}

pub fn starter_files_include_runnable_project_test() {
  let files = templates.starter_files()
  let paths = list.map(files, fn(file) { file.path })

  assert list.contains(paths, "package.json")
  assert list.contains(paths, "index.html")
  assert list.contains(paths, "vite.config.ts")
  assert list.contains(paths, "zepto-bridge.js")
  assert list.contains(paths, "server.js")
  assert list.contains(paths, "src/main.tsx")
  assert list.contains(paths, "src/db.ts")
  assert list.contains(paths, "src/build-inspector.ts")
  assert list.contains(paths, "src/style.css")
  assert file_content(files, "package.json") |> string.contains("hyper-zepto")
  assert file_content(files, "package.json") |> string.contains("node server.js")
  assert file_content(files, "vite.config.ts")
    |> string.contains("from './zepto-bridge.js'")
  assert file_content(files, "src/db.ts") |> string.contains("/api/db")
  assert file_content(files, "src/main.tsx") |> string.contains("./build-inspector")
  assert file_content(files, "src/main.tsx") |> string.contains("BUILD_APP_FROM_PLAN")
  assert file_content(files, "src/main.tsx") |> string.contains("Welcome to Build")
  assert file_content(files, "src/build-inspector.ts") |> string.contains("BUILD_ELEMENT_SELECTED")
}

pub fn starter_files_include_production_server_test() {
  let files = templates.starter_files()

  // server.js exists and mounts the shared bridge that vite.config.ts uses.
  assert file_content(files, "server.js")
    |> string.contains("from './zepto-bridge.js'")
  assert file_content(files, "server.js") |> string.contains("/api/db")
  assert file_content(files, "server.js") |> string.contains("process.env.PORT")

  // Scout Live env mapping: strip the /_ports suffix from SCOUT_PORTS_URL
  // because hyper-zepto's remote adapters append it themselves.
  assert file_content(files, "zepto-bridge.js")
    |> string.contains("SCOUT_PORTS_URL")
  assert file_content(files, "zepto-bridge.js")
    |> string.contains("SCOUTOS_PORTS_URL")
  assert file_content(files, "zepto-bridge.js") |> string.contains("'/_ports'")
  assert file_content(files, "zepto-bridge.js")
    |> string.contains("createPorts({ mode: 'remote', baseUrl })")
  assert file_content(files, "zepto-bridge.js")
    |> string.contains("createPorts({ mode: 'local', dir: '.zepto' })")
}

pub fn files_to_tree_converts_flat_files_test() {
  let tree = templates.files_to_tree([
    templates.ProjectFile("package.json", "{}"),
    templates.ProjectFile("src/main.tsx", "console.log(1)"),
  ])

  assert templates.tree_get(tree, "package.json") == Ok(templates.File("{}"))
  assert templates.tree_get(tree, "src/main.tsx") == Ok(templates.File("console.log(1)"))
}

pub fn upsert_existing_file_test() {
  let files = [
    templates.ProjectFile("a.ts", "old"),
    templates.ProjectFile("b.ts", "same"),
  ]

  assert templates.upsert_file(files, "/a.ts", "new") == [
    templates.ProjectFile("a.ts", "new"),
    templates.ProjectFile("b.ts", "same"),
  ]
}

pub fn upsert_new_file_sorts_test() {
  assert templates.upsert_file([templates.ProjectFile("z.ts", "z")], "a.ts", "a") == [
    templates.ProjectFile("a.ts", "a"),
    templates.ProjectFile("z.ts", "z"),
  ]
}

pub fn preview_summary_test() {
  let element = selected_element()

  assert preview_inspector.summarize_selected_element(element) == "button#cta.primary"
  assert preview_inspector.summarize_selected_element(preview_inspector.SelectedPreviewElement(..element, id: "", classes: [])) == "button"
  assert preview_inspector.summarize_selected_element(preview_inspector.SelectedPreviewElement(..element, id: "", classes: ["card"])) == "button.card"
}

pub fn selected_element_prompt_contains_context_test() {
  let prompt = preview_inspector.build_selected_element_prompt("Make it calmer", selected_element())

  assert string.contains(prompt, "User comment")
  assert string.contains(prompt, "Make it calmer")
  assert string.contains(prompt, "button#cta.primary")
  assert string.contains(prompt, "<button id=\"cta\"")
  assert string.contains(prompt, "Computed styles")
}

pub fn design_guidance_prompt_combines_sources_test() {
  let prompt = design_guidance.design_guidance_prompt()

  assert string.contains(prompt, "Frontend design skill")
  assert string.contains(prompt, "Anthropic brand guide")
  assert string.contains(prompt, "Scout Studio observed brand styles")
}

pub fn language_for_known_paths_test() {
  assert editor.has_language_extension("package.json")
  assert editor.has_language_extension("index.html")
  assert editor.has_language_extension("src/style.css")
  assert editor.has_language_extension("src/main.tsx")
  assert editor.has_language_extension("src/util.ts")
  assert editor.has_language_extension("src/app.jsx")
  assert editor.has_language_extension("src/app.js")
}

pub fn language_for_unknown_path_test() {
  assert editor.language_for_path("README.md") == Error(Nil)
}

fn file_content(files: List(templates.ProjectFile), path: String) -> String {
  case list.find(files, fn(file) { file.path == path }) {
    Ok(file) -> file.content
    Error(_) -> ""
  }
}

fn selected_element() -> preview_inspector.SelectedPreviewElement {
  preview_inspector.SelectedPreviewElement(
    tag_name: "BUTTON",
    id: "cta",
    classes: ["primary", "large"],
    text_content: "Start now",
    outer_html: "<button id=\"cta\" class=\"primary large\">Start now</button>",
    bounding_rect: preview_inspector.BoundingRect(x: 1.0, y: 2.0, width: 100.0, height: 40.0),
    computed_styles: [#("color", "rgb(255, 255, 255)"), #("backgroundColor", "rgb(0, 0, 0)")],
  )
}
