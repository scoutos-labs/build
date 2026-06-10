# Phase 2 COEP spike — Clerk under `crossOriginIsolated`

The site ships `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` (required by WebContainers).
This spike validates that Clerk sign-in works under those headers **before**
any further Phase 2/3 work. See `docs/managed-openrouter-migration-plan.md`.

## What's already in place (code-side mitigations)

- Clerk is **bundled** via the `@clerk/clerk-js` npm package — no CDN-loaded
  script, so the main blocker (cross-origin script without CORP) is avoided.
- The whole flow is behind `VITE_MANAGED_AUTH=true` + `VITE_CLERK_PUBLISHABLE_KEY`;
  with the flag off the app is byte-for-byte the old behavior.
- Boot gate in `src/main-gleam.ts`: signed out → Clerk sign-in component on a
  full-screen overlay; the Gleam app / WebContainer / IndexedDB do not start
  until signed in. Sign-out reloads back to the gate.
- `src/gleam-externals/agent.mjs` calls `/api/agent` with a fresh
  `clerk.session.getToken()` per request (tokens live ~60s).

## How to run the spike

1. Create a Clerk dev instance; note the publishable key.
2. On a Render **preview deploy** of the static site set:
   - `VITE_MANAGED_AUTH=true`
   - `VITE_CLERK_PUBLISHABLE_KEY=pk_test_...`
   (Production COOP/COEP headers come from `render.yaml` as usual.)
3. Deploy `build-api` with `CLERK_SECRET_KEY` etc. so `/api/agent` works
   (`server/README.md`), or skip for the pure auth spike.

## Pass criteria (from the plan)

- [ ] Sign-in component renders; sign-up completes; `clerk.session.getToken()`
      returns a JWT (run `await window.Clerk?.session?.getToken()` or use the
      Network tab)
- [ ] `crossOriginIsolated === true` in the console on the same deploy, and a
      WebContainer boots after sign-in (`npm install` log in the terminal pane)
- [ ] No CORP/COEP errors in the console during sign-in — check avatar images
      specifically; if avatars are blocked, the known fix is marking
      Clerk-served `<img>` elements `crossorigin="anonymous"` (appearance
      customization or a small MutationObserver), or proxying the assets
- [ ] Token expiry: wait >60s after sign-in, then send a prompt — the request
      must still succeed (fresh token per request)

## Findings so far (local run, 2026-06-10, vite dev with prod COOP/COEP headers)

1. **`@clerk/clerk-js` from npm still loads its UI from Clerk's CDN by default**
   ("remote-hosted code"). `mountSignIn` threw `Clerk was not loaded with Ui
   components`. Fix shipped: bundle `@clerk/ui` and use the `no-rhc` entry
   points of both packages — `clerk.load({ ui })`. UI now renders with zero
   remote chunks.
2. **COOP `same-origin` breaks popup OAuth** (severed `window.opener`). Fix
   shipped: `mountSignIn(node, { oauthFlow: 'redirect' })`.
3. **Clerk bot protection (Cloudflare Turnstile) fails under COEP
   `require-corp`** — sign-up via Google ends at `/#/sso-callback` with
   "Authentication unsuccessful due to failed security validations".
   Turnstile's script/iframe from `challenges.cloudflare.com` carries no CORP
   and can't be proxied. Dev workaround: disable bot sign-up protection in the
   Clerk dashboard (Configure → Attack protection). **Production decision
   needed:** the migration plan lists "Clerk bot protection at sign-up" as a
   budget-gaming mitigation. Options: (a) accept no CAPTCHA and lean on low
   free budgets + rate limits, or (b) investigate `COEP: credentialless`
   (WebContainers supports it via `coep: 'credentialless'`), which admits
   credentialless cross-origin subresources and may let Turnstile load.

## Outcome (fill in after running on a Render preview)

- Result: _works as-is / needs asset proxy / needs auth-origin handoff_
- Browser/console notes:
- Follow-ups:
