# build-api

Backend service for managed OpenRouter access (Phase 1 of
`docs/managed-openrouter-migration-plan.md`). Verifies Clerk JWTs, provisions
one budgeted OpenRouter key per user, and proxies agent calls so the browser
never sees providers, keys, or models.

## Endpoints

- `POST /api/agent` — auth required. Body `{ userPrompt, files, messages, selectedElement?, elementComment? }` → `{ reply, patches }`. Errors carry machine-readable codes: `unauthorized` (401), `rate_limited` (429), `payload_too_large` / `prompt_too_large` (413), `budget_exhausted` / `payment_failed` (402), `provisioning_failed` (503), `upstream_error` / `bad_model_output` (502).
- `GET /api/me` — auth required. `{ plan, model, disabled, limit, usage, limitRemaining }`.
- `POST /webhooks/clerk` — svix-verified. `user.created` provisions a key; `user.deleted` disables + deletes the key and row.
- `GET /api/health` — liveness.

Auth: `Authorization: Bearer <Clerk session JWT>`, with the `__session` cookie
as a same-origin fallback. Tier is read from verified claims only (`pla` claim
or `metadata.tier`), never from the request body.

## Env vars

| Var | Purpose |
|---|---|
| `CLERK_SECRET_KEY` | JWT verification (networkless via JWKS) |
| `CLERK_WEBHOOK_SIGNING_SECRET` | svix signature for `/webhooks/clerk` |
| `OPENROUTER_PROVISIONING_KEY` | Management API root credential — Render env only, rotate quarterly |
| `DATABASE_URL` | Render Postgres |
| `KEY_ENCRYPTION_SECRET` | Derives the AES-256-GCM key for `or_key_enc` at rest |

## Develop

```sh
npm install
npm test         # unit tests, no live services needed
npm run build    # tsc → dist/
npm run dev      # tsx watch (needs all env vars + Postgres)
```

The schema is applied at boot (`create table if not exists users ...`).

## Live verification checklist (needs real credentials + deploy)

These are the Phase 1 success criteria that cannot be asserted in unit tests.
Run them against a deployed instance with a Clerk dev instance and a real
provisioning key:

1. `curl -X POST -H "Authorization: Bearer <Clerk dev JWT>" https://<site>/api/agent -d '{"userPrompt":"add a button","files":[],"messages":[]}'` returns `{ reply, patches }` within 60s and the OpenRouter dashboard attributes the spend to that user's key.
2. Create a user in the Clerk dev instance → webhook fires → `users` row exists and `GET /api/v1/keys` shows the key with the tier `limit` and `limit_reset: monthly`.
3. Delete the row, call `/api/agent` → lazy provisioning recreates it.
4. Provision a key with `limit: 0.10`, exhaust it → `/api/agent` returns 402 `budget_exhausted`.
5. `GET /api/me` `limitRemaining` matches the OpenRouter dashboard.
6. `psql`: `select or_key_enc from users` — value does not start with `sk-or-`.
7. `curl https://<static-site>/api/health` → 200 through the rewrite rule (production URL path, not the service URL).
