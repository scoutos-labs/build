# layout-modes — LFG handoff log

- 2026-07-02 begin — task: journey-based layout modes for Build. Chat-only
  (full-screen chat) for new/booting projects, auto-switch to split
  (chat 1/3 + preview 2/3) when the preview URL arrives, segmented control
  to override; existing code panel becomes the "builder" state. Floating
  chat overlay explicitly deferred. Branch: layout-modes.
- 2026-07-02 plan-approved — judge PASS conditional; both conditions folded
  into PRD (Chat boot-status renders Error phase; returning-user journey in
  step 5). Notes: title_row gains params; .codeHidden rules re-home to .app
  classes; single CodePanelToggled dispatch site.
- 2026-07-02 steps-1-4-done — commit 1610e66: actor state machine (17 gleam
  tests), journey resets, segmented control + view classes, CSS. Smoke
  scripts/smoke-layout-modes.mjs 16/16 against live dev server (screenshots
  in scripts/.smoke/layout-modes/). Deviation: arrow-key roving focus on the
  control skipped (tab + aria-pressed instead).
- 2026-07-02 complete — impl judge PASS w/ conditions; B1 (real reveal
  animation), B2 (docs committed), N1-N5 all applied. Final: 103 gleam +
  107 vitest + build green; smoke 16/16. Remaining manual: real
  WebContainer boot journeys (fresh/returning), crash-restart via jsh,
  terminal refit round-trip.
