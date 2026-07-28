# Migration plan: managed OpenRouter access (Clerk + provisioned keys)

## Goal

Replace "paste your own API key and pick a provider" with: **sign up → get a budgeted OpenRouter key automatically → start building**. Users never see providers, keys, or model plumbing. Budgets are enforced by OpenRouter per-key spending limits, tiered by Clerk plan.

## Current state

- Client-only Vite + Gleam (Lustre/TEA) SPA, deployed as a Render **static site** with COOP/COEP headers (required by WebContainers).
- Two providers (OpenRouter, Ollama) selected in a settings modal; keys stored in plaintext `localStorage`; `src/agent.ts` calls `openrouter.ai` directly from the browser.
- No backend, no auth, no user accounts. Projects live in IndexedDB locally.
- A dead parallel TS implementation (`src/store.ts`, `src/actors/`, `src/runtime/`) still ships in the repo.

## Target state

- **Clerk** authenticates users; plan (free/pro/…) determines budget.
- A small **backend service** (same Render account) verifies Clerk JWTs and proxies agent calls to OpenRouter using a **per-user provisioned key** stored server-side.
- **OpenRouter Management API** mints one key per user with `limit` (USD) + `limit_reset: monthly`; OpenRouter returns 402 when exhausted — the hard budget lives at OpenRouter, not in our code.
- The settings modal becomes an account panel (plan, remaining budget, sign out). No provider choice, no key fields.

---

## Phase 0 — Pre-flight cleanup (before any auth code)

These reduce the surface we have to migrate and close holes that become dangerous once real money/tokens flow through the app.

1. **Delete the dead TS tree**: `src/store.ts`, `src/actors/*`, `src/runtime/*` and their tests. One implementation to change, not two.
2. **Fix the hardcoded request id**: `build_agent_chat.gleam` dispatches `SubmitPrompt("gleam-request", 0)` for every send. Generate unique ids + real timestamps (FFI helper). Stale-response and cancel correctness matter once requests cost budget.
3. **Lock down `postMessage`**: `main-gleam.ts` accepts `BUILD_APP_FROM_PLAN` / `BUILD_ELEMENT_SELECTED` from any origin. Verify `event.source === previewIframe.contentWindow` before dispatching. The preview runs untrusted AI-generated code; after this migration a hijacked dispatch spends the user's budget.

**Success criteria:**

- [x] `src/store.ts`, `src/actors/`, `src/runtime/` no longer exist; `npm run build` (gleam + tsc + vite) passes — also excluded the Gleam-copied `build/**` duplicates from vitest discovery
- [x] `gleam test` and `npx vitest run` pass with zero skipped tests (40 gleam + 49 vitest)
- [x] Two prompts submitted back-to-back produce two distinct request ids (`test/build_request_ids_test.gleam` runs the click/keydown decoders twice); elapsed timer shows seconds-since-submit, not ~1.7e9
- [x] Canceling request A then submitting request B: A's late response is discarded (unit test on `agent.update` with the real id flow)
- [ ] A `postMessage` sent from the test page's own window (not the preview iframe) does **not** dispatch `BuildFromPlan` or element selection (unit tests on `isTrustedPreviewMessage` done in `src/preview-message-guard.test.ts`; manual DevTools check still pending)

## Phase 1 — Backend service (deployable independently, no frontend changes)

New `server/` directory (Node 22 + Hono or Express; TypeScript), second service in `render.yaml`, plus Render Postgres.

**Env vars:** `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SIGNING_SECRET`, `OPENROUTER_PROVISIONING_KEY`, `DATABASE_URL`, `KEY_ENCRYPTION_SECRET`.

**Schema:**

```sql
create table users (
  clerk_user_id text primary key,
  or_key_hash   text not null,          -- OpenRouter key hash (for management API calls)
  or_key_enc    bytea not null,         -- the runtime key, AES-GCM encrypted at rest
  tier          text not null default 'free',
  model         text not null,          -- server-assigned model for this user/tier
  disabled      boolean not null default false,
  created_at    timestamptz not null default now()
);
```

**Endpoints:**

- `POST /api/agent` — verify Clerk JWT (networkless via JWKS); load row; decrypt key; build the same system prompt + messages currently assembled in `src/agent.ts`; call OpenRouter `chat/completions` with the **server-chosen model**; return the existing `{ reply, patches }` shape. JSON extraction/repair logic moves here from the client.
- `GET /api/me` — plan, model, and `limit_remaining` (proxied from `GET /api/v1/keys/{hash}`) for the account panel.
- `POST /webhooks/clerk` — svix-verified. `user.created` → `POST /api/v1/keys` with tier budget (`limit`, `limit_reset: "monthly"`), encrypt + store. `user.deleted` → `PATCH disabled: true`, then delete row.
- **Lazy-provision fallback**: if `/api/agent` finds no row (missed webhook), provision inline.

**Abuse controls:** per-user rate limit (e.g. 10 req/min), request body size cap, reject prompts over a token ceiling.

**Routing:** add a Render **rewrite rule** on the static site: `/api/* → build-api service`. Same-origin means no CORS, and Clerk's `__session` cookie works as a fallback to the Authorization header.

> **Status (2026-06-10):** `server/` implemented (Hono + TS, DI app factory) with 37 unit tests green: 401 with no OpenRouter call, 402 `budget_exhausted` vs `payment_failed`, 429 on the 11th req/min, 413 body cap + prompt ceiling, AES-GCM round-trip + tamper rejection, webhook signature rejection, idempotent `user.created`, lazy provisioning (incl. losing the insert race without leaking the minted key). `render.yaml` has the `build-api` service, Postgres, and the `/api/*` + `/webhooks/*` rewrites. The criteria below need a deploy with real `CLERK_*` / `OPENROUTER_PROVISIONING_KEY` credentials — runbook in `server/README.md`.

**Success criteria:**

- [ ] `curl -H "Authorization: Bearer <valid Clerk dev JWT>" POST /api/agent` with a test prompt returns `{ reply, patches }` within 60s, and the OpenRouter dashboard shows the spend attributed to **that user's key** (not the provisioning key or an org key)
- [ ] Same request with no/expired/garbage JWT → `401` with no OpenRouter call made (assert via key usage unchanged)
- [ ] Creating a user in the Clerk dev instance fires the webhook and produces: a `users` row, a provisioned key visible in `GET /api/v1/keys`, with the tier's `limit` and `limit_reset: "monthly"` set
- [ ] Deleting the row and calling `/api/agent` triggers lazy provisioning (row recreated, request succeeds)
- [ ] A key provisioned with `limit: 0.10` returns `402` from `/api/agent` after spend exceeds it, and the response body carries a machine-readable `budget_exhausted` code
- [ ] `GET /api/me` returns plan, model, and a `limit_remaining` that matches the OpenRouter dashboard for that key
- [ ] 11th request inside one minute from one user → `429`; request with >256KB body → `413`
- [ ] `or_key_enc` in Postgres is not the plaintext key (verify with `psql`: value doesn't start with `sk-or-`); decryption round-trips in a unit test
- [ ] Webhook endpoint rejects requests with an invalid svix signature → `400`
- [ ] `/api/*` rewrite on the static site routes to the service (curl the production URL path, not the service URL)

## Phase 2 — Clerk in the SPA (the COEP spike comes first)

> **Spike (do first, it's the biggest unknown):** the site ships `Cross-Origin-Embedder-Policy: require-corp` for WebContainers. Clerk's CDN-loaded script will likely be blocked. Mitigation: use the bundled **`@clerk/clerk-js` npm package** (no cross-origin script), and mark Clerk-served images (avatars) `crossorigin="anonymous"`. Validate sign-in + `getToken()` under `crossOriginIsolated` on a preview deploy **before** building anything else in this phase. If it fails, fallback options: self-host Clerk assets via proxy, or a separate auth origin that hands off a token.

1. Add `@clerk/clerk-js`; publishable key via `VITE_CLERK_PUBLISHABLE_KEY`.
2. Boot gate in `main-gleam.ts`: load Clerk → if signed out, mount Clerk's sign-in component; if signed in, start the Gleam app as today.
3. `gleam-externals/agent.mjs`: fetch a fresh token via `clerk.session.getToken()` per request (Clerk tokens are short-lived) and send `Authorization: Bearer <jwt>` to `/api/agent`.

> **Status (2026-06-10):** Code side implemented behind `VITE_MANAGED_AUTH` (off by default; old behavior unchanged): bundled `@clerk/clerk-js` (code-split chunk, no CDN script), boot gate in `src/main-gleam.ts` (`src/managed-auth.ts`), fresh `getToken()` per request to `/api/agent` (`src/managed-agent-client.ts`, unit-tested incl. 402 code mapping). Spike **validation** still requires a Render preview deploy with a Clerk dev instance — runbook in `docs/phase2-coep-spike.md`.
>
> **Status (2026-07-28): the COEP half of the spike PASSES.** Measured by serving
> a real `VITE_MANAGED_AUTH=true` production build behind the same
> `COEP: require-corp` + `COOP: same-origin` headers `render.yaml` sets, then
> driving it in Chrome: `crossOriginIsolated === true` (so WebContainers still
> work), Clerk's chunks load and initialize, **zero external origins are
> requested**, and nothing is blocked by COEP. The `no-rhc` + bundled
> `@clerk/ui` approach does what it was supposed to. Managed auth also builds
> cleanly — ~240 code-split chunks, 4.4 MB total, none of it in the entry chunk.
>
> Still unvalidated, and needing real credentials: the **OAuth redirect
> round-trip** (it leaves the origin and comes back, which a placeholder key
> cannot exercise) and the **managed agent loop** — `/api/agent/step`,
> `web_search`, `web_fetch`, `web_post` have only ever seen fixtures.

**Success criteria (spike — gate for the rest of the phase):**

- [ ] On a Render preview deploy with the production COOP/COEP headers: Clerk sign-in component renders, sign-up completes, and `clerk.session.getToken()` returns a JWT
- [ ] `crossOriginIsolated === true` in the console on that same deploy, and a WebContainer boots (`npm install` log visible in the terminal pane)
- [ ] No CORP/COEP errors in the browser console during sign-in (avatar images included)
- [ ] Spike outcome written up (works as-is / needs asset proxy / needs auth-origin handoff) before phase work continues

**Success criteria (phase):**

- [ ] Signed-out visit shows the sign-in screen; the Gleam app, WebContainer boot, and IndexedDB access do not start until signed in
- [ ] After sign-in, a full agent round-trip works on the preview deploy via `/api/agent` with the Clerk token attached
- [ ] Token expiry mid-session is handled: a request sent after the session token expires still succeeds (fresh `getToken()` per request), verified by waiting out the 60s token lifetime
- [ ] Sign-out returns to the sign-in screen and a subsequent `/api/agent` call from DevTools with the old token → `401`

## Phase 3 — Remove provider friction (frontend rework)

> **Status (2026-06-10):** Implemented **flag-gated** rather than by deletion —
> production has no backend yet, so the legacy bring-your-own-key path must
> keep working while `VITE_MANAGED_AUTH` is off; the deletion pass (criterion
> 2's grep, removing the Ollama/OpenRouter client paths and `AgentProvider`)
> moves to post-Phase-5 cleanup. With the flag ON: no provider/key/model
> required to submit (`settings_missing` short-circuits), settings modal
> renders as an account panel (plan + budget via `/api/me`, sign out), legacy
> localStorage keys purged at boot, legacy persist effects skipped, and 402 →
> distinct budget-exhausted banner with the server-provided reset date +
> submit blocked (`budget_exhausted` state in the agent actor). Covered by
> `test/build_managed_test.gleam` (8 tests); all suites green.

1. **`src/agent.ts`** shrinks to a thin client: `runAgent` posts `{ userPrompt, files, messages, selectedElement, elementComment }` to `/api/agent`. Delete the Ollama path, OpenRouter direct path, JSON repair, and system prompts (now server-side). `AgentProvider` type disappears.
2. **Gleam settings actor** loses `provider`, `api_key`, `ollama_url` and their messages/effects; `CallAgent` effect drops credentials entirely.
3. **Settings modal → account panel**: shows plan, remaining monthly budget (`GET /api/me`), sign-out button. No model field by default — the server assigns the model per tier. (Optional later: a model picker constrained to a tier allowlist, enforced server-side.)
4. **Purge legacy localStorage**: remove `openrouter-key`, `ollama-url`, `agent-provider`, `agent-model` reads/writes and delete stale entries on first load.
5. **Budget-exhausted UX**: map server 402 to a distinct chat state — "Monthly build budget used up. Upgrade or wait until {reset date}" — instead of a generic error string.

**Success criteria:**

- [ ] **The friction test:** a brand-new user (fresh browser profile) goes from landing page → signed up → first generated app rendering in the preview, without ever seeing a key field, provider dropdown, or model name. Timed; target under 2 minutes excluding `npm install`
- [ ] `grep -rin 'ollama\|scoutos\|api.key\|apiKey' src/` returns no hits outside the account panel and this docs folder
- [ ] `localStorage` after first load of the new version contains none of: `openrouter-key`, `ollama-url`, `agent-provider`, `agent-model` (verified in DevTools after loading with legacy values pre-seeded)
- [ ] No request from the browser goes to `openrouter.ai` (verify in the Network tab during a full build session — only `/api/*` and Clerk)
- [ ] Account panel shows plan name and remaining budget matching `GET /api/me`; sign-out works from it
- [ ] Exhausting a test key's budget mid-session shows the "budget used up — upgrade or wait until {date}" state in chat, not a raw error string; submitting is blocked while exhausted
- [ ] `gleam test` + `vitest` green; settings-actor tests rewritten for the credential-free state shape (no test asserts a provider or key field exists)

## Phase 4 — Tiers and billing

1. Define Clerk **Billing** (B2C) plans: e.g. Free ($0 → $1/mo budget, economy model) and Pro ($20/mo → $10 budget, premium model). Plan is readable from the JWT / `has()` server-side.
2. Clerk subscription webhooks → `PATCH /api/v1/keys/{hash}` to raise/lower `limit` and update `model`/`tier` in the DB. Downgrade/cancel → reduce limit at period end; delinquent → `disabled: true`.
3. Account panel shows usage vs budget (`usage_monthly` / `limit_remaining`).

**Caveats:** Clerk Billing is **beta** (Stripe-only, USD-only, no tax handling) — pin SDK versions. If beta limitations bite, fallback is plain Stripe Checkout + a `tier` claim in Clerk user metadata; the OpenRouter side is identical either way.

**Margin note:** OpenRouter charges 5.5% (min $0.80) on credit purchases; Clerk Billing + Stripe take 3.6% + $0.30 per transaction. Price tiers at ≥ ~1.10× the granted budget.

**Success criteria:**

- [ ] Upgrading a test user Free → Pro in checkout results, within 60s, in: the OpenRouter key's `limit` raised to the Pro budget, `tier`/`model` updated in the DB, and the account panel reflecting the new plan
- [ ] Downgrade/cancel schedules the limit reduction at period end (verify the key's `limit` is unchanged immediately, changed after the period-end webhook)
- [ ] Failed payment (Stripe test card `4000 0000 0000 0341`) → key `disabled: true`; `/api/agent` for that user → 402-class response with a `payment_failed` code distinct from `budget_exhausted`
- [ ] Webhook replay (svix redelivery) is idempotent: re-sending the same subscription event does not double-patch the limit or create a second key
- [ ] A user's plan claim in the JWT matches what the server enforces: tampering the tier client-side does not change the model or budget used (server reads plan from verified claims/DB only)
- [ ] Tier pricing sheet checked in: each tier's price ≥ 1.10× granted budget after the 5.5% + 3.6% + $0.30 fees

## Phase 5 — Rollout

1. Deploy backend (inert — nothing calls it yet).
2. Frontend behind `VITE_MANAGED_AUTH` on a Render preview; team dogfood with real provisioned keys at small limits.
3. Flip production. Existing users see the sign-in screen; their old pasted keys are purged from localStorage (they were the users' own keys — note this in the release message so they know nothing was lost).
4. **Decision point:** keep a bring-your-own-key escape hatch for power users? Recommendation: **no** for launch (it's the friction being removed and doubles every test matrix); revisit on demand.

**Success criteria:**

- [ ] Backend deployed to production and health-checked (`GET /api/health` → 200) with zero frontend traffic for ≥ 24h and no error-rate alerts
- [ ] Preview deploy dogfooded by the team: ≥ 3 people each complete sign-up → build → budget display with keys at small limits; issues triaged to zero blockers
- [ ] Production flip: day-one funnel measured — sign-up completion rate and first-build success rate recorded as the baseline (instrument before the flip, not after)
- [ ] Rollback rehearsed: flipping `VITE_MANAGED_AUTH` off on the preview restores the old build (pre-flip bundle) in one deploy, documented in the runbook
- [ ] Release note published explaining that previously pasted keys were the user's own and have been cleared locally
- [ ] First 48h after flip: zero provisioning failures in logs, 402 rate < 5% of agent calls, no support reports of lost projects (IndexedDB untouched by the migration)

## Phase 6 — Operations

- **Provisioning key** is a root credential: Render env only, rotate quarterly; runbook = create new → swap env → revoke old.
- **Per-user key rotation/compromise:** create replacement key, update row, delete old — zero downtime.
- **Monitoring:** alert on provisioning failures, webhook DLQ, spike in 402s (pricing signal), spike in per-user request rate (abuse signal).
- **Streaming** responses from the proxy is a natural later enhancement; current UX is request/response with an elapsed timer, so it's not in the critical path.

**Success criteria:**

- [ ] Provisioning-key rotation runbook executed once end-to-end in production (create new → swap env → revoke old) with zero failed agent calls during the swap
- [ ] Per-user key rotation tested on a live user: replacement key created, row swapped, old key deleted; the user's next request succeeds without redeploy
- [ ] Alerts firing verifiably (test each by inducing the condition in staging): provisioning failure, webhook signature failures, 402 rate spike, per-user RPM spike
- [ ] Dashboard exists showing: daily spend per tier, top-10 users by spend, provisioning success rate, p95 `/api/agent` latency
- [ ] On-call doc covers: user reports "budget gone but I didn't use it" (check key usage vs our logs), suspected key leak (rotate + audit), OpenRouter outage (status comms)

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| COEP `require-corp` breaks Clerk components | Medium | Phase 2 spike first; bundled `@clerk/clerk-js`; proxy assets if needed |
| Clerk Billing beta churn | Medium | Pin SDKs; Stripe-direct fallback keeps OpenRouter side unchanged |
| Provisioned key leak from DB | Low | AES-GCM at rest, key only decrypted in the request path, OpenRouter limit caps blast radius |
| Webhook delivery misses | Medium | Lazy-provision fallback on first agent call |
| Budget gaming (free-tier farming) | Medium | Low free budget, per-user rate limits, Clerk bot protection at sign-up |

## Sequencing summary

Phase 0 and Phase 1 are independent and can run in parallel. Phase 2's spike gates everything user-facing. Phases 3–4 are sequential. Total: roughly 5 working phases, each independently shippable, with the product switch happening only at Phase 5.
