# founders-ux — LFG handoff log

- 2026-07-03 begin — task: finish Build's founder-first UX. Candidate scope
  (deferred from layout-modes + agent-upgrades loops): (1) interview-in-chat
  — native chat onboarding replacing the iframe wizard; (2) Focus mode —
  full-bleed preview with floating chat (original "mode 2"); (3) chat-mode
  polish (dead void between empty state and composer, floating icon
  cluster, arrow-key focus on segmented control). Branch: founders-ux.
- 2026-07-03 plan-approved — judge REVISE→resolved: B1 Focus modal rule (no
  transform on .panel.chat; opacity-only enter; ghosting excluded while
  modal open; smoke-asserted), B2 Build idles only on successful dispatch
  (gated no-op keeps Reviewing + answers; reveal coupled to success), B3
  OpenProject discards stale answers, MessagesReplaced re-evaluates
  eligibility. Non-blocking notes folded (empty submit no-op, Improve
  defensive idle, record_url keeps inspector effect, legacy coexistence).
  Order A → C1/C2 → B → C3.
