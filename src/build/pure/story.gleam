//// Derives the Build Story — a non-technical narrative of how the app came
//// to be — from data the project already persists: chat history, the build
//// log, and BRAIN.md. Derivation is deterministic and happens at render
//// time, so the story is always current and costs no tokens to maintain.

import build/actors/chat
import build/pure/build_log
import build/pure/templates
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/string

pub type Chapter {
  Chapter(at: Int, ask: String, outcome: String, areas: List(String))
}

pub type Story {
  Story(
    title: String,
    origin: String,
    // "" when the agent has not recorded a brand yet
    brand: String,
    chapters: List(Chapter),
    decisions: List(String),
  )
}

pub fn from_project(
  title: String,
  messages: List(chat.Message),
  entries: List(build_log.Entry),
  files: List(templates.ProjectFile),
) -> Story {
  let brain = brain_content(files)
  Story(
    title: title,
    origin: origin(brain, messages),
    brand: section_body(brain, "Brand"),
    chapters: chapters(entries, messages),
    decisions: decisions(brain),
  )
}

/// First hex color recorded under ## Brand, used to tint the story with the
/// app's own identity. Falls back to Build's accent.
pub fn accent(story: Story) -> String {
  case first_hex(story.brand) {
    Some(color) -> color
    None -> "#d97757"
  }
}

fn brain_content(files: List(templates.ProjectFile)) -> String {
  case list.find(files, fn(file) { file.path == "BRAIN.md" }) {
    Ok(file) -> file.content
    Error(_) -> ""
  }
}

fn origin(brain: String, messages: List(chat.Message)) -> String {
  let from_brain = section_body(brain, "What & Why")
  case from_brain {
    "" ->
      case first_user_message(messages) {
        Some(content) -> content
        None -> "This app is just getting started."
      }
    text -> text
  }
}

fn first_user_message(messages: List(chat.Message)) -> Option(String) {
  case messages {
    [] -> None
    [chat.Message(chat.User, content), ..] -> Some(content)
    [_, ..rest] -> first_user_message(rest)
  }
}

/// Extracts the body of a "## <name>" section, dropping scaffold placeholder
/// lines (which the seed writes as _italic guidance_).
fn section_body(brain: String, name: String) -> String {
  // prepend a newline so a brain whose FIRST line is "## ..." still parses
  let sections = string.split("\n" <> brain, "\n## ")
  let found =
    list.find(sections, fn(section) {
      string.starts_with(section, name <> "\n")
      || string.starts_with(section, name <> "\r\n")
      || section == name
    })
  case found {
    Error(_) -> ""
    Ok(section) ->
      section
      |> string.drop_start(string.length(name))
      |> string.split("\n")
      |> list.filter(fn(line) {
        let trimmed = string.trim(line)
        trimmed != "" && !string.starts_with(trimmed, "_")
      })
      |> string.join("\n")
      |> string.trim
  }
}

fn decisions(brain: String) -> List(String) {
  section_body(brain, "Decisions")
  |> string.split("\n")
  |> list.map(string.trim)
  |> list.filter_map(fn(line) {
    case string.starts_with(line, "- ") {
      True -> Ok(string.drop_start(line, 2))
      False -> Error(Nil)
    }
  })
}

fn chapters(
  entries: List(build_log.Entry),
  messages: List(chat.Message),
) -> List(Chapter) {
  case entries {
    // Projects saved before the build log existed: fall back to chat pairs,
    // without file chips (we honestly don't know what each turn touched).
    [] -> chapters_from_messages(messages)
    _ ->
      list.map(entries, fn(entry) {
        Chapter(
          at: entry.at,
          ask: clean_ask(entry.prompt),
          outcome: entry.reply,
          areas: areas(entry.paths),
        )
      })
  }
}

// Plan builds record a system-flavored preamble before the founder's plan;
// the story should read like the founder's own words.
const plan_preamble = "Build this app from the interview plan."

fn clean_ask(prompt: String) -> String {
  case string.starts_with(prompt, plan_preamble) {
    True ->
      case string.trim(string.drop_start(prompt, string.length(plan_preamble))) {
        "" -> prompt
        rest -> rest
      }
    False -> prompt
  }
}

fn chapters_from_messages(messages: List(chat.Message)) -> List(Chapter) {
  case messages {
    [chat.Message(chat.User, ask), chat.Message(chat.Assistant, outcome), ..rest] ->
      [Chapter(at: 0, ask: ask, outcome: outcome, areas: []), ..chapters_from_messages(rest)]
    [_, ..rest] -> chapters_from_messages(rest)
    [] -> []
  }
}

/// Friendly, non-technical labels for what a turn touched. Never leaks file
/// paths into the story.
fn areas(paths: List(String)) -> List(String) {
  paths
  |> list.map(area_label)
  |> list.unique
}

fn area_label(path: String) -> String {
  case path {
    "BRAIN.md" -> "project brain"
    "package.json" -> "capabilities"
    _ ->
      case string.ends_with(path, ".css") {
        True -> "look & feel"
        False ->
          case
            path == "server.js"
            || path == "zepto-bridge.js"
            || path == "vite.config.ts"
          {
            True -> "behind the scenes"
            False -> "screens & logic"
          }
      }
  }
}

fn first_hex(text: String) -> Option(String) {
  case string.split(text, "#") {
    [_] | [] -> None
    [_, ..candidates] -> find_hex(candidates)
  }
}

fn find_hex(candidates: List(String)) -> Option(String) {
  case candidates {
    [] -> None
    [candidate, ..rest] -> {
      let hex = string.slice(candidate, 0, 6)
      // reject longer hex runs (e.g. #deadbeef) to match the export renderer
      let seventh = string.slice(candidate, 6, 1)
      let boundary = seventh == "" || !is_hex(seventh)
      case string.length(hex) == 6 && is_hex(hex) && boundary {
        True -> Some("#" <> hex)
        False -> find_hex(rest)
      }
    }
  }
}

fn is_hex(text: String) -> Bool {
  text
  |> string.lowercase
  |> string.to_graphemes
  |> list.all(fn(char) { string.contains("0123456789abcdef", char) })
}
