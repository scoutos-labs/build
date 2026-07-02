//// The build log is the per-project record the Build Story is derived from:
//// one entry per successful agent turn, storing a truncated prompt/reply and
//// the touched paths — never file contents, so it stays tiny in IndexedDB.

import gleam/string

pub type Entry {
  Entry(at: Int, prompt: String, reply: String, paths: List(String))
}

const prompt_max_chars = 200

const reply_max_chars = 500

/// Timestamps come from the request-start clock the JS side already supplies
/// (epoch milliseconds); Gleam never reads a clock itself.
pub fn entry(
  at: Int,
  prompt: String,
  reply: String,
  paths: List(String),
) -> Entry {
  Entry(
    at: at,
    prompt: truncate(prompt, prompt_max_chars),
    reply: truncate(reply, reply_max_chars),
    paths: paths,
  )
}

fn truncate(text: String, max: Int) -> String {
  case string.length(text) > max {
    True -> string.slice(text, 0, max) <> "…"
    False -> text
  }
}
