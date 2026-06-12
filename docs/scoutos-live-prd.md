# PRD: Publish to scoutos.live

**Status:** Approved — ready to build
**Owner:** Tom Wilson
**Updated:** 2026-06-12
**Supersedes:** zenbin.org/p/dev2-scoutos-publish-plan (v2, Rakis) — see Decisions for what changed and why.

## Overview

Add a Publish capability to Build: a signed-in user clicks Publish, their project is packaged server-side and deployed to Scout Live, and they get a stable live URL at `{subdomain}.scoutos.live`. Republishing the same project updates the same URL with zero downtime.

## Decisions already made (do not relitigate)

1. **hyper-zepto stays the template backend.** In the WebContainer preview it runs local adapters; deployed to Scout Live, the same code talks to the platform's managed ports. Generated app code (`db.create(...)` etc.) is identical in both environments.
2. **Packaging happens server-side, not in the browser.** The client sends the project file map as JSON to `/api/publish` (the same shape `/api/agent` receives; 2MB body cap). No browser tar, no Compression Streams, no Safari risk.
3. **ScoutOS API keys are user-supplied but stored server-side**, encrypted with the existing AES-256-GCM `keyCrypto` path, in the existing embedded PGlite database on the Render persistent disk (`/var/data/pglite`). **No new datastore** — no LMDB, no SQLite, no provisioned database server. Keys are write-only: never returned to the client, decrypted only inside the publish handler.
4. **Deployment records live server-side** (`deployments` table) so republish targets the same subdomain. The platform's `publishCode` is shown once at first deploy; storing it is mandatory.

## Scout Live API contract (verified against scoutos-labs/scout-live source, 2026-06-12)

- **Deploy:** `POST https://scoutos.live/api/build?subdomain={name}[&code={publishCode}]` — body is a raw tar.gz containing a `Dockerfile` at root; header `Authorization: Bearer sk_live_...` (scope `build`). Returns 202 with `{ buildId, statusUrl, logsUrl }`.
- **Poll:** `GET /api/build/{buildId}/status` (scope `read`). Status: `queued → running → deployed | failed | build_succeeded_deploy_failed`. Terminal responses include `url`, `publishCode`, `logs`.
- **Republish:** same POST with `&code={publishCode}`. Lost codes: `POST /apps/{subdomain}/regenerate-code`.
- **Delete:** `DELETE /apps/{subdomain}` (scope `delete`).
- **Subdomains:** 1–63 chars, lowercase alphanumeric + hyphens, no leading/trailing hyphen, reserved list (`api`, `docs`, `www`, ...). 409 if taken by another user.
- **Dockerfile constraints:** non-root `USER` required; `USER root`, `--privileged`, curl/wget pipes blocked; `EXPOSE` expected (defaults to 3000).
- **Runtime env injected by platform:** `SCOUT_PORTS_URL=http://127.0.0.1:3101/_ports` (auth-injecting sidecar), `PORT`, `NODE_ENV=production`. ⚠️ hyper-zepto auto mode reads `SCOUTOS_PORTS_URL` — the template server must bridge the two (Phase 0 verifies, Phase 1 implements).
- **Limits:** 20 deploys/hour per key; env vars max 100 per app.

---

## Phase 0 — Ports integration smoke test (de-risks everything else)

Manually deploy a minimal hyper-zepto app to scoutos.live: tiny Node server using `createPorts({ mode: 'remote', baseUrl: <from SCOUT_PORTS_URL> })`, exercising data-port create/find/update/delete against the platform.

**Success criteria:**
- [ ] A hand-built tar.gz deploys via `POST /api/build` and reaches `deployed`.
- [ ] The deployed app completes a data-port CRUD round trip through the sidecar (`SCOUT_PORTS_URL`).
- [x] **Env mapping (verified against hyper-zepto 0.1.0 `dist/index.js` and scout-live `src/sidecars/ports-proxy.ts` + `src/ports/data/router.ts`, 2026-06-12):** hyper-zepto's remote adapters append `/_ports/...` to `baseUrl` themselves, so the platform's `SCOUT_PORTS_URL` (`http://127.0.0.1:3101/_ports`) must have its trailing `/_ports` stripped before being passed as `baseUrl` (or as `SCOUTOS_PORTS_URL`): `baseUrl = SCOUT_PORTS_URL.replace(/\/_ports\/?$/, '')`. No token is needed — the sidecar injects the internal app auth header on every proxied request; hyper-zepto's optional `SCOUTOS_TOKEN` stays unset. Path joining then resolves to `http://127.0.0.1:3101/_ports/data/...`, which the sidecar rewrites to the gateway's `/ports/data/...` routes. All six data ops the template bridge uses (`create`, `get`, `find`, `update`, `delete`, `count`) match the platform router's paths, request bodies, and response shapes exactly. Known mismatches in ops the template does **not** use: hyper-zepto `createIndex`/`dropIndex` call `/index`//`/index/:name` while the platform serves `/indexes`//`/indexes/:name`, and hyper-zepto `data.health()` (`GET /_ports/data/health`) has no platform route — fix in hyper-zepto if ever needed.
- [ ] Republish with `publishCode` updates the same subdomain.

**If this fails** (wire-format mismatch between hyper-zepto remote adapters and the platform): stop and fix hyper-zepto (same org) before proceeding. Do not work around it in the template.

## Phase 1 — Production-deployable template

Add `server.js` to the starter template: serves built `dist/` statically and mounts the same `/api/db` bridge as the Vite plugin, with `createPorts()` resolving local (dev fallback) vs remote (Scout Live, via the Phase 0 env mapping). Refactor so the bridge logic is written once and used by both `vite.config.ts` (dev) and `server.js` (production). Update both template copies (`src/templates.ts` and `src/build/pure/templates.gleam` — Gleam is what the app uses at runtime) and the agent system prompts (client `src/agent.ts` + server `server/src/prompt.ts`) to preserve `server.js`.

**Success criteria:**
- [ ] In the WebContainer preview, nothing changes: dev server boots, `/api/db` CRUD works (existing behavior).
- [ ] Locally: `vite build && node server.js` serves the app and `/api/db` CRUD works without Vite.
- [ ] `node server.js` with the Scout Live env vars set (simulated) selects remote adapters.
- [ ] Both template copies and both prompt copies updated in sync; template tests assert `server.js` exists and contains the env mapping.
- [ ] All existing tests pass (`npm test` at root and in `server/`).

## Phase 2 — Server: credentials storage

New PGlite migration: `user_credentials` table (`clerk_user_id`, `provider` = 'scoutos', `key_enc bytea`, timestamps) — or equivalent column; reuse `keyCrypto`. New Clerk-authed endpoints:
- `PUT /api/credentials/scoutos` — encrypt + upsert; validate key shape (`sk_live_`/`sk_test_` prefix).
- `GET /api/me` extension or `GET /api/credentials` — returns `{ scoutos: true|false }` only (never the key).
- `DELETE /api/credentials/scoutos`.

Also: commit the pending `PGLITE_DATA_DIR` boot guard in `server/src/index.ts` with this phase.

**Success criteria:**
- [ ] Key round-trips through encrypt/store/decrypt in tests (PGlite-backed, like `db.test.ts`).
- [ ] No API response ever contains the stored key (test asserts presence-flag only).
- [ ] Unauthenticated requests are 401; malformed keys are 400.
- [ ] Migration is idempotent (server boots cleanly on an existing data dir).

## Phase 3 — Server: packaging + publish proxy

- Tar writer: minimal USTAR + gzip via Node `zlib` (or `tar-stream` if hand-rolling exceeds ~100 lines — only new dependency allowed in this feature).
- Dockerfile + `.dockerignore` injection (skip if project already has them): `node:20-alpine`, `npm ci`, `vite build`, non-root `USER node`, `EXPOSE 3000`, `CMD ["node", "server.js"]`. Must pass the platform's Dockerfile validation (no root, no curl pipes).
- `deployments` table: `clerk_user_id`, `project_id`, `subdomain`, `publish_code_enc`, `last_build_id`, `last_url`, timestamps.
- `POST /api/publish` (Clerk-authed, rate-limited): body `{ projectId, subdomain, files }` → validate subdomain client rules + reserved list → decrypt user key → package → POST to Scout Live (with `code` if a deployment record exists) → store/refresh deployment record → return `{ buildId }`.
- `GET /api/publish/:buildId` — proxies build status; on terminal `deployed`, persists `publishCode` and `url`.
- A `scoutlive.ts` client module mirroring the `openrouter.ts` pattern (injectable, faked in tests).

**Success criteria:**
- [ ] Generated tar.gz is accepted by a real `POST /api/build` (one live integration check, then faked in CI).
- [ ] First publish creates a deployment record; second publish for the same project sends `code` and reuses the subdomain (test with fake client).
- [ ] 409 from the platform (name taken) maps to a distinct error code the UI can render.
- [ ] User key and publishCode never appear in responses or logs.
- [ ] Missing stored key returns a distinct `no_scoutos_key` error (UI routes user to settings).
- [ ] All server tests pass.

## Phase 4 — Client UI (Gleam app)

- Settings: ScoutOS API key field (managed mode) → `PUT /api/credentials/scoutos`; shows set/not-set state only.
- Publish button + flow: subdomain prompt (pre-validated against naming rules; remembered per project), then status states `queued → running → deployed(url) | failed(logs link)` polling `GET /api/publish/:buildId`.
- Published URL displayed and clickable; republish reuses the stored subdomain without re-prompting.

**Success criteria:**
- [ ] Full happy path in the browser (verify like the hyper-zepto template run: headless Chromium against the dev server with a faked publish backend or test deploy).
- [ ] Invalid subdomain feedback appears before any network call; 409 and `no_scoutos_key` errors render actionable messages.
- [ ] Gleam tests cover the new msg/update/effect wiring; `gleam test` and `npm test` pass.

## Phase 5 — Rollout

- Docs: README section + this PRD updated with outcomes.
- **Gating:** publish requires managed auth (server-stored keys). Production has `VITE_MANAGED_AUTH=false`; PR previews have it on. Ship publish behind managed auth — it activates in production when Phase 5 of the managed-auth migration flips the flag. Confirm no publish UI leaks into non-managed mode.

**Success criteria:**
- [ ] End-to-end on a PR preview: sign in → save key → build an app with the agent → publish → live URL works → edit → republish → same URL updated.
- [ ] Non-managed mode shows no publish affordances.
- [ ] PR merged with all 100+ existing tests plus new coverage green.

## Risks

| Risk | Mitigation |
|---|---|
| hyper-zepto remote ↔ sidecar wire mismatch | Phase 0 catches it before any feature code; fix in hyper-zepto, not the template |
| Platform rate limit (20 deploys/hr/key) | Surface 429 + Retry-After in UI; no auto-retry loops |
| Project > 2MB body cap | Distinct error suggesting asset cleanup; raise cap only if real users hit it |
| Subdomain squatting/conflicts | 409 → user picks another name; publishCode prevents takeover of existing deployments |
| Lost publishCode (record deleted) | `POST /apps/{subdomain}/regenerate-code` recovery path, admin-triggered initially |

## Out of scope (this iteration)

Custom domains; build-log streaming (link to logs is enough); app deletion UI; auto-provisioning ScoutOS accounts/keys (revisit if ScoutOS adds a provisioning API — would remove the last manual step, matching the OpenRouter pattern); cache/blob port usage in the template.
