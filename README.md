# Build

Use an agent to create your application in a live browser workspace.

Build is an anonymous browser-based app builder MVP. It runs a Vite/React project inside a StackBlitz WebContainer, shows a live preview, chats with an LLM through local Ollama or OpenRouter, and exports the generated code as a ZIP file.

## Features

- Browser-hosted development runtime via StackBlitz WebContainers
- Live preview pane with loading/waiting animations
- Agent chat powered by OpenRouter by default or local Ollama optionally
- 5-minute app-side agent request timeout with manual cancel support
- Starter React app with PGlite for browser-local Postgres-style storage
- In-browser CodeMirror source editor with syntax highlighting
- Interactive WebContainer terminal for commands like `npm install lucide-react`
- Sync files after terminal changes so editor/project/export state reflects WebContainer filesystem changes
- Select elements in the preview, comment on improvements, and send element context to the agent
- Bundled design guidance from Anthropic brand/frontend-design skills plus observed Scout Studio product styling
- Anonymous multi-project management stored locally in IndexedDB
- Auto-save, create, open, rename, and delete projects
- Cancel, reset, clear chat, and connection test controls
- Export current project as a compressed ZIP

## Local development

```bash
npm install
npm run dev
```

Open the shown local URL in Chrome/Chromium. WebContainers require cross-origin isolation; `vite.config.ts` sets the needed headers for local dev.

Run checks:

```bash
npm test
npm run build
```

## Architecture

Build uses a Gleam/Elm-style actor architecture:

- `src/App.tsx` is a thin React shell that reads from the app store and dispatches typed messages.
- `src/store.ts` composes app state, routes cross-domain messages, and emits typed effects.
- `src/actors/` contains pure domain `update()` functions for settings, chat, project, agent, preview, and WebContainer state.
- `src/runtime/` interprets effects for localStorage, IndexedDB, WebContainer, LLM requests, timers, and DOM messaging.
- `src/main.tsx` is only the React entrypoint.

See [`docs/architecture.md`](docs/architecture.md) for details.

## Project management

Build stores anonymous projects in browser IndexedDB. Projects auto-save after edits. Use the project controls in the sidebar to rename the current project with the pencil button, create a new project with the plus button, or open the Projects modal with the folder button to switch/delete projects.

Project storage includes source files, selected file, chat history, and project metadata. It does not currently snapshot the preview app's internal PGlite IndexedDB data.

## Publish to scoutos.live

With managed auth on, signed-in users can publish a project to [Scout Live](https://scoutos.live) and get a stable URL at `{subdomain}.scoutos.live`. Republishing the same project updates the same URL with zero downtime.

How it works (see [`docs/scoutos-live-prd.md`](docs/scoutos-live-prd.md)):

1. Add your ScoutOS API key (`sk_live_...`, scopes `build` + `read`) once in the account panel. It is stored server-side, encrypted with AES-256-GCM, and never returned to the client.
2. Click the rocket button in the project toolbar. The first publish prompts for a subdomain (validated against the platform naming rules and reserved list before any network call); later publishes reuse it automatically.
3. The server packages the project file map into a tar.gz (injecting a non-root `Dockerfile` that runs `vite build` and `node server.js`), deploys it through `POST https://scoutos.live/api/build`, and polls status until the app is live.

The starter template runs the same code in both environments: in the WebContainer preview, `zepto-bridge.js` serves `/api/db` with hyper-zepto's local adapters; deployed to Scout Live, `server.js` mounts the same bridge against the platform's managed ports via `SCOUT_PORTS_URL`.

Publishing requires managed auth — non-managed mode shows no publish UI.

## Model settings

Build opens the model settings modal on first load if no model is configured. OpenRouter is the default provider. Use the gear button beside the app title to change provider, model, API key, or Ollama URL.

Agent requests are canceled by the app after 5 minutes. This timeout is controlled in the app runtime, not by the selected model/provider. Providers may still enforce their own independent limits.

## Local Ollama

To use Ollama, choose the Ollama provider in model settings. The default Ollama URL is:

```text
http://localhost:11434
```

A good Ollama model value is:

```text
glm-5:cloud
```

If the browser cannot call Ollama because of CORS, restart Ollama with the app origin allowed:

```bash
OLLAMA_ORIGINS=http://localhost:5173 ollama serve
```

For a deployed Render URL, use that origin instead, for example:

```bash
OLLAMA_ORIGINS=https://build.onrender.com ollama serve
```

You can also use another installed model, such as `qwen3.6:27b-coding-nvfp4`.

## OpenRouter fallback

Switch the provider to OpenRouter in the UI and paste a personal OpenRouter API key. It is stored only in `localStorage` in your browser.

For production, replace browser-side model calls with a backend proxy for key protection, auth/rate limits, persistence, and billing.

## Deploy to Render

This repo includes `render.yaml` for a static Render deployment. The blueprint sets the required WebContainer headers:

- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: require-corp`

Render build command:

```bash
npm ci && npm run build
```

Publish directory:

```text
./dist
```
