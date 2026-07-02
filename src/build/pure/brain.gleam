//// BRAIN.md: the project's plain-language wiki. The What & Why is seeded
//// deterministically from the interview plan (so it exists even if the model
//// ignores every prompt rule); the agent maintains Brand, How it works, and
//// Decisions through ordinary file patches.

pub const brain_path = "BRAIN.md"

pub fn seed(plan_summary: String) -> String {
  "# Project Brain

Build keeps this file with your project. \"What & Why\" comes from your
interview and belongs to you; the agent records the brand, how the app
works, and dated decisions as it builds. Everything stays under 6,000
characters so it remains a summary, not a transcript.

## What & Why

"
  <> plan_summary
  <> "

## Brand

_Not chosen yet — the agent proposes a name, palette, and tone on the first build._

## How it works

_The agent keeps a plain-language summary of the app's moving parts here._

## Decisions

_Dated design and engineering decisions land here as the app evolves._
"
}
