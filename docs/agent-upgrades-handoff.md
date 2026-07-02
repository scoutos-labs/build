# agent-upgrades — LFG handoff log

Append-only checkpoint log for the "agent-upgrades" LFG loop. Read this before
resuming the loop in a new session; details live in
`docs/agent-upgrades-prd.html` and `docs/agent-upgrades-progress.html`.

- 2026-07-01 begin — task: review working-tree changes (Tailwind pre-bake,
  Vite prompt switch, install-skip/flicker fixes — all tests green, kept),
  stabilize the app, and add three agent features: (1) non-technical visual
  "build story" post, (2) interview captures what/why + agent-maintained
  brain/wiki for how/design/engineering decisions, (3) coaching and branding
  help. Status: research done (live app is Gleam/Lustre; docs/architecture.md
  stale; templates duplicated TS+Gleam). Planner + diff-review subagents
  launched.
- 2026-07-01 plan-approved — judge passed PRD with 4 non-blocking notes
  (folded in: npm-test evidence for drift test, textual prompt parity, save
  seam for buildLog, ESC-close is new behavior).
- 2026-07-01 step-A-done — commits 7e785d4/0078f16/732d0da/5e5541d: baseline
  + review fixes (install exit-code gating, mount-relative reload window,
  remount serialization, pre-baked-Tailwind prompt rule, wider glob), drift
  test, parity tests, architecture.md rewrite. A5 manual pass deferred.
- 2026-07-01 step-B-done — commits 0ea5afe/7755061: BRAIN.md seed + prompt
  rules + budget guard; SavedProject.buildLog threaded Gleam→IndexedDB.
- 2026-07-01 step-C-done — commit 419122a: coaching + branding prompt rules,
  interview copy nudges. Next: Phase D (story derivation, view, HTML export).
- 2026-07-01 step-D-done — commit a037e63: story derivation + view + HTML
  export, 8 new tests.
- 2026-07-01 complete — impl judge approved with one blocking fix
  (createProject dropped buildLog on first-ever save) — fixed in 8564e60
  with create-path test; nice-to-haves applied. Final: 92 gleam + 99 vitest
  + 103 server tests green; npm run build green. Manual checklist remains
  in agent-upgrades-progress.html (browser flicker pass, live-model
  transcripts, story screenshots).
