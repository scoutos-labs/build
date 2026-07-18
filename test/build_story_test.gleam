import build/actors/chat
import build/pure/build_log
import build/pure/story
import build/pure/templates
import gleam/list

fn brain(content: String) -> templates.ProjectFile {
  templates.ProjectFile("BRAIN.md", content)
}

const full_brain = "# Project Brain

## What & Why

Build an app for: dog walkers
Target users: busy owners

## Brand

Name: PawPlanner
Palette: #2f6f4e, #f4f1ea
Tone: warm and practical

## How it works

A scheduling dashboard backed by local records.

## Decisions

- 2026-07-01 · Chose a weekly calendar over a list · easier to scan routes
- 2026-07-01 · Local-only storage · owners asked for privacy
"

pub fn story_from_full_data_test() {
  let entries = [
    build_log.entry(1000, "make a scheduler", "Built the weekly view", [
      "src/main.tsx", "src/style.css", "BRAIN.md",
    ]),
  ]
  let derived =
    story.from_project("PawPlanner", [], entries, [brain(full_brain)])

  assert derived.title == "PawPlanner"
  assert derived.origin == "Build an app for: dog walkers\nTarget users: busy owners"
  assert story.accent(derived) == "#2f6f4e"
  assert derived.decisions
    == [
      "2026-07-01 · Chose a weekly calendar over a list · easier to scan routes",
      "2026-07-01 · Local-only storage · owners asked for privacy",
    ]
  assert derived.chapters
    == [
      story.Chapter(at: 1000, ask: "make a scheduler", outcome: "Built the weekly view", areas: [
        "screens & logic", "look & feel", "project brain",
      ]),
    ]
}

pub fn story_falls_back_to_chat_pairs_without_build_log_test() {
  let messages = [
    chat.Message(chat.User, "build a crm", []),
    chat.Message(chat.Assistant, "Done: a simple CRM", []),
    chat.Message(chat.User, "add tags", []),
    chat.Message(chat.Assistant, "Tags added", []),
  ]
  let derived = story.from_project("CRM", messages, [], [])

  assert derived.origin == "build a crm"
  assert list.length(derived.chapters) == 2
  assert derived.chapters
    == [
      story.Chapter(at: 0, ask: "build a crm", outcome: "Done: a simple CRM", areas: []),
      story.Chapter(at: 0, ask: "add tags", outcome: "Tags added", areas: []),
    ]
}

pub fn story_from_empty_project_never_crashes_test() {
  let derived = story.from_project("Untitled Project", [], [], [])

  assert derived.origin == "This app is just getting started."
  assert derived.chapters == []
  assert derived.decisions == []
  assert derived.brand == ""
  assert story.accent(derived) == "#d97757"
}

pub fn story_tolerates_malformed_brain_test() {
  let derived =
    story.from_project(
      "App",
      [chat.Message(chat.User, "hello world", [])],
      [],
      [brain("just some prose without any sections")],
    )

  assert derived.origin == "hello world"
  assert derived.decisions == []
  assert derived.brand == ""
}

pub fn story_ignores_seed_placeholders_test() {
  let seeded =
    "# Project Brain

## What & Why

Build an app for: bakers

## Brand

_Not chosen yet — the agent proposes a name, palette, and tone on the first build._

## Decisions

_Dated design and engineering decisions land here as the app evolves._
"
  let derived = story.from_project("Bakery", [], [], [brain(seeded)])

  assert derived.origin == "Build an app for: bakers"
  // placeholder lines must not read as real brand/decision content
  assert derived.brand == ""
  assert derived.decisions == []
  assert story.accent(derived) == "#d97757"
}

pub fn story_parses_brain_without_title_preamble_test() {
  let no_preamble =
    "## What & Why

Build an app for: florists
"
  let derived = story.from_project("Florist", [], [], [brain(no_preamble)])

  assert derived.origin == "Build an app for: florists"
}

pub fn story_accent_rejects_longer_hex_runs_test() {
  let derived =
    story.from_project("App", [], [], [
      brain("## Brand\n\nPalette: #deadbeef then #2f6f4e\n"),
    ])

  // #deadbeef must not be read as #deadbe (the export renderer rejects it);
  // the next valid 6-digit color wins.
  assert story.accent(derived) == "#2f6f4e"
}

pub fn story_trims_plan_preamble_from_first_chapter_test() {
  let entries = [
    build_log.entry(
      1,
      "Build this app from the interview plan.\n\nBuild an app for: florists",
      "Done",
      ["src/main.tsx"],
    ),
  ]
  let derived = story.from_project("Florist", [], entries, [])

  assert derived.chapters
    == [
      story.Chapter(at: 1, ask: "Build an app for: florists", outcome: "Done", areas: [
        "screens & logic",
      ]),
    ]
}
