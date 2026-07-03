# Build Architecture

Last rewritten: 2026-07-01. Build's UI is a **Gleam/Lustre** application. The
earlier React + TypeScript actor layout this document used to describe
(`src/App.tsx`, `src/store.ts`, `src/actors/*.ts`) no longer exists.

## Entry chain

```text
index.html
  → src/main.ts            (imports styles.css, then main-gleam)
  → src/main-gleam.ts      (registers editor/terminal web components,
                            managed-auth, trusted preview postMessage routing,
                            then calls main() from the compiled Gleam app)
  → build/dev/javascript/build/build_app.mjs   (compiled from src/build_app.gleam)
```

`npm run dev`/`npm run build` run `gleam build` first; the compiled output in
`build/dev/javascript/` is what the browser executes. Never edit files under
`build/` — edit the Gleam sources and rebuild.

## Gleam application (`src/build/`)

Elm-style model/update/view with domain actors and effect interpreters:

- `model.gleam`, `msg.gleam`, `update.gleam`, `view.gleam`, `effect.gleam`,
  `runtime.gleam` — the app core. `update.gleam` routes messages to domain
  actors and returns typed effects.
- `actors/` — pure domain `update()` state machines: `agent`, `chat`,
  `preview`, `project`, `publish`, `settings`, `webcontainer`.
- `components/` — view modules: `build_agent_chat`, `build_editor`,
  `build_element_picker`, `build_layout_switch`, `build_preview`,
  `build_project_nav`, `build_projects_modal`, `build_publish_modal`,
  `build_settings_modal`, `build_story_modal`, `build_terminal`.
- `runtime/` — effect interpreters per domain (`agent`, `ids`, `managed`,
  `preview`, `project`, `publish`, `settings`, `story`, `webcontainer`,
  `zip`).
- `pure/` — pure logic shared by update/view: `brain` (BRAIN.md seed),
  `build_log`, `design_guidance`, `editor`, `preview_inspector`, `story`
  (Build Story derivation), `templates`.

## JS interop (`src/gleam-externals/`)

Externals bridge Gleam effects to browser APIs and to the live TS modules:
`agent.mjs`, `browser.mjs`, `dom.mjs`, `editor.mjs`, `ids.mjs`,
`local_storage.mjs`, `managed.mjs`, `projects.mjs`, `publish.mjs`,
`runtime_bridge.mjs` (dispatches typed messages back into the Lustre runtime),
`story.mjs` (Build Story HTML export via `src/story-html.ts`),
`terminal.mjs`, `webcontainer.mjs`, `zip.mjs`.

`webcontainer.mjs` owns the remount/install lifecycle: it skips `npm install`
when `package.json` is unchanged since the last successful install (a failed
install disarms the skip), serializes overlapping remounts, and suppresses the
post-mount iframe hard-reload when vite already reloaded the preview after the
mount started. Pinned by `src/gleam-externals/webcontainer-externals.test.ts`.

## Live TypeScript modules (`src/`)

Still-live TS reached from externals or `main-gleam.ts`: `agent.ts` (LLM call +
client prompt assembly), `templates.ts` (starter files for the JS side),
`projects.ts` (IndexedDB persistence), `design-guidance.ts`, `editor.ts`,
`env-store.ts`, `managed-agent-client.ts`, `managed-auth.ts`,
`preview-inspector.ts`, `preview-message-guard.ts`, `publish-files.ts`,
`webcontainer.ts` (WebContainer process management, dev-server crash restart),
`zip.ts`.

## Intentional duplication and its guards

Two surfaces exist twice and are guarded by tests:

- **Starter template** — `src/templates.ts` (used by JS externals) and
  `src/build/pure/templates.gleam` (used by `update.gleam` for new/reset
  projects). Guard: the byte-for-byte drift test in `src/templates.test.ts`,
  which compares against the *compiled* Gleam module — run it via `npm test`
  (which runs `gleam build` first), not bare `vitest run`.
- **Agent prompt + context selection** — `src/agent.ts` (non-managed client)
  and `server/src/prompt.ts` (managed mode; declared source of truth). Guard:
  `src/prompt-parity.test.ts` compares the Rules block, context budget,
  `ALWAYS_FULL` set, and stub note across both sources. Client-only rules must
  be declared there explicitly. Full unification is planned in
  `docs/managed-openrouter-migration-plan.md` Phase 3.

## Layout modes

The preview actor owns a `LayoutMode` (`ChatMode` / `SplitMode` /
`BuilderMode`; UI labels Chat / App / Code) — ephemeral per-session UI state,
deliberately not persisted, so every session replays chat-during-boot → the
split reveal when the first preview URL arrives. `layout_is_manual` records a
segmented-control choice; after that the auto reveal never moves the user.
While the chat interview is active an arriving URL is recorded without the
reveal; the reveal fires at interview end — when the agent starts building
or the founder opts out. Project new/open/reset re-arms the manual flag and
moves nobody (the interview lives in chat, so nothing needs the preview
forced open). BuilderMode is the old code
panel: the files/editor/terminal strip with the unread-dot semantics moved
onto the Code segment. All modes render identical DOM — only the `.app`
class changes — so the preview iframe and xterm shell survive switches.
Smoke: `scripts/smoke-layout-modes.mjs`.

## Agent protocol

The model must return JSON `{"reply": string, "patches": [{path, content}]}`
with full replacement file contents (client-side additionally supports an
`envVars` object). Context selection sends the whole project under a
160,000-char budget; over budget, files the request plausibly touches stay
full and the rest are stubbed to their first lines. Requests time out
app-side after 5 minutes.

The onboarding interview lives natively in Build's chat panel
(`src/build/actors/interview.gleam` — also the single source of truth for the
plan-summary format). Its Q&A render as virtual bubbles derived from
interview state, never persisted; only the final plan message
(`BuildFromPlan`) enters chat history. The generated starter app is a calm
placeholder page. The legacy `BUILD_APP_FROM_PLAN` postMessage route stays
(guarded, one line in `main-gleam.ts`) because saved projects created before
this change still carry the old iframe wizard in their files.

## Persistence

Anonymous, local-first. Projects live in IndexedDB (`src/projects.ts`) as
`SavedProject {id, name, files, messages, selectedPath, createdAt, updatedAt,
buildLog?}` — `buildLog` records one truncated `{at, prompt, reply, paths}`
entry per successful agent turn and feeds the Build Story.
Model settings live in localStorage. Managed mode stores encrypted credentials
server-side (see `docs/scoutos-live-prd.md`).

## Validation

```bash
npm test          # gleam test + vitest (root)
npm run build     # gleam build + tsc -b + vite build
cd server && npm test
```
