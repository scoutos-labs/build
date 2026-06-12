import { serve } from '@hono/node-server'
import { verifyToken as clerkVerifyToken } from '@clerk/backend'
import { PGlite } from '@electric-sql/pglite'
import { Webhook } from 'svix'
import { createApp, type AuthResult, type ClerkWebhookEvent } from './app.js'
import { createDb, migrate } from './db.js'
import { createKeyCrypto } from './key-crypto.js'
import { createOpenRouterClient } from './openrouter.js'
import { createRateLimiter } from './rate-limit.js'
import { normalizeTier } from './tiers.js'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env var ${name}`)
  return value
}

const clerkSecretKey = requireEnv('CLERK_SECRET_KEY')
// Optional: without it the webhook route rejects everything and provisioning
// happens lazily on the first /api/agent or /api/me call. Required in prod so
// user.deleted cleanup works.
const webhookSecret = process.env.CLERK_WEBHOOK_SIGNING_SECRET
const provisioningKey = requireEnv('OPENROUTER_PROVISIONING_KEY')
const keyEncryptionSecret = requireEnv('KEY_ENCRYPTION_SECRET')

// Embedded Postgres (PGlite). On Render this must point at the persistent
// disk mount (/var/data) — the service filesystem is wiped on deploy, and a
// lost users table orphans every provisioned OpenRouter key. Refuse to boot
// onto the ephemeral filesystem there rather than silently losing data.
if (process.env.RENDER && !process.env.PGLITE_DATA_DIR) {
  throw new Error('PGLITE_DATA_DIR must point at the persistent disk mount on Render')
}
const dataDir = process.env.PGLITE_DATA_DIR ?? '.data'
const pglite = new PGlite(dataDir)
await migrate(pglite)
console.log(`[build-api] pglite data dir: ${dataDir}`)

const webhook = webhookSecret ? new Webhook(webhookSecret) : null
if (!webhook) {
  console.warn('[build-api] CLERK_WEBHOOK_SIGNING_SECRET not set — /webhooks/clerk disabled, relying on lazy provisioning')
}

/**
 * Tier comes from verified JWT claims only. Clerk Billing exposes the plan via
 * the `pla` claim (e.g. "u:pro"); a `tier` value in public metadata works as
 * the pre-billing fallback. Client-supplied values are never consulted.
 */
function tierFromClaims(payload: Record<string, unknown>): string {
  const pla = typeof payload.pla === 'string' ? payload.pla : ''
  if (pla.includes('pro')) return 'pro'
  const metadata = payload.metadata as { tier?: string } | undefined
  return normalizeTier(metadata?.tier)
}

async function verifyToken(token: string): Promise<AuthResult> {
  const payload = await clerkVerifyToken(token, { secretKey: clerkSecretKey })
  if (!payload.sub) throw new Error('Token has no subject')
  return { userId: payload.sub, tier: tierFromClaims(payload as Record<string, unknown>) }
}

function verifyWebhook(
  rawBody: string,
  headers: Record<string, string | undefined>,
): ClerkWebhookEvent {
  if (!webhook) throw new Error('Webhook signing secret not configured')
  return webhook.verify(rawBody, headers as Record<string, string>) as ClerkWebhookEvent
}

const app = createApp({
  db: createDb(pglite),
  openrouter: createOpenRouterClient({ provisioningKey }),
  keyCrypto: createKeyCrypto(keyEncryptionSecret),
  rateLimiter: createRateLimiter(10, 60_000),
  verifyToken,
  verifyWebhook,
  log: message => console.log(`[build-api] ${message}`),
})

const port = Number(process.env.PORT ?? 3000)
serve({ fetch: app.fetch, port }, info => {
  console.log(`[build-api] listening on :${info.port}`)
})
