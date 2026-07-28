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

Rewritten 2026-07-27. The agent is a **bounded tool-calling loop**, not a
single-shot JSON producer. The old `{"reply", "patches"}` envelope is gone —
`agent.Patch`, `AgentRequestSucceeded`, `apply_patches`, and
`InstallIfNeeded(patches)` were all removed with it.

### The loop

A *turn* is one user request and may take several steps. The Gleam actor
(`src/build/actors/agent.gleam`) owns it: step counter, activity trail, the union
of touched paths, and `pkg_dirty`. The provider transcript deliberately does
**not** live in Gleam — opaque `tool_calls` arrays and raw tool bodies stay in
`src/gleam-externals/agent.mjs`, keyed by request id, so file contents and
fetched page bodies never enter the app model.

```text
callAgent          opens the turn, takes step 0
  → POST /api/agent/step   { turnId, stepIndex, stepToken, tree, fullFiles,
                             messages, toolCalls, toolResults, webRead }
      server: assemble → OpenRouter with tools
        ↳ web_search / web_fetch  → run INLINE, loop again (inner cap 4)
        ↳ fs_* / exec             → return to the client
        ↳ web_post                → return as an approval request
        ↳ final text              → done
  → client executes fs_*/exec against the WebContainer
  → CallAgentStep … until done, the step budget, or the turn deadline
```

The server is **stateless**: no transcript is persisted, which is what keeps
Build's local-first promise. The client carries the transcript and the `webRead`
taint flag; the server re-checks the taint before anything sends.

### Tools

| Tool | Runs | Gated |
| --- | --- | --- |
| `fs_list` / `fs_read` / `fs_write` / `fs_batch_write` | client | no |
| `exec` | client — `wc.spawn()` | no |
| `web_search` / `web_fetch` | server, inline (managed only) | no |
| `web_post` | server, on approval (managed only) | **yes** |

`exec` being `wc.spawn()` against the same container the preview runs in is the
harness's whole advantage: the agent can run `npx tsc --noEmit`, read real
diagnostics, fix them, and re-check before handing back.

### Load-bearing invariants

- **One write path.** Every agent write goes through `project.FileApplied`, which
  updates `state.files` *and* emits `WriteFileToContainer`. `project.files` is the
  source of truth; the container FS is a replica that `isSyncableTextFile`
  filters. A direct `wc.fs.writeFile` desyncs the editor, ZIP export, publish,
  autosave, and the next turn's context — silently.
- **One install trigger.** `InstallDependencies`, driven by `pkg_dirty`, cleared
  only on a *successful* install.
- **One bubble and one build-log entry per turn**, not per step — the Build Story
  is a narrative, and a twelve-step turn is still one thing the founder asked for.
- **The agent's file snapshot** (`globalThis.__buildProjectFiles`) is seeded on
  boot/remount, on project load, and upserted on every write. It must not depend
  on autosave, which is gated on the container being hydrated.
- **Trust the sandbox.** `fs_*` and `exec` run unattended; only `web_post` gates,
  because it is the one tool that reaches out of the WebContainer.
- **Tainted turn.** Any web read withdraws `web_post` for the rest of that turn.

### Guarded duplications

Four surfaces exist twice and are pinned by `src/prompt-parity.test.ts`: the
system prompt, the starter template, the tool specs
(`src/agent-tools.ts` ↔ `server/src/agent-tools.ts`), and the job→model map
(`settings.gleam` ↔ `server/src/models.ts`). Web tools are asserted present
server-side and absent client-side.

BYOK stays on the single-shot JSON protocol (Ollama has no tool mode at all), but
its response is adapted into the same synthetic `fs_batch_write`, so it goes
through identical machinery.

## Persistence

Anonymous, local-first. Projects live in IndexedDB (`src/projects.ts`) as
`SavedProject {id, name, files, messages, selectedPath, createdAt, updatedAt,
buildLog?}` — `buildLog` records one truncated `{at, prompt, reply, paths}`
entry per successful agent turn and feeds the Build Story.
Model settings live in localStorage. Managed mode stores encrypted credentials
server-side (see `docs/scoutos-live-prd.md`).

## Validation

```bash
npm test                              # gleam test + vitest (root)
npm run build                         # gleam build + tsc -b + vite build
cd server && npm test
cd server && npm run typecheck        # NOT covered by the above
node scripts/smoke-layout-modes.mjs   # needs a dev server on :5199
node scripts/smoke-interview.mjs
node scripts/smoke-agent-harness.mjs  # drives a real multi-step agent turn
```
