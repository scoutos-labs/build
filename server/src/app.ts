import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import type { Db, UserRow } from './db.js'
import type { KeyCrypto } from './key-crypto.js'
import type { OpenRouterClient } from './openrouter.js'
import { buildModelMessages, extractJson, type AgentRequestBody } from './prompt.js'
import type { RateLimiter } from './rate-limit.js'
import { normalizeTier, tierConfig } from './tiers.js'

/**
 * Caps raw request parsing only. Model spend is bounded separately: context
 * selection in prompt.ts stubs low-relevance files to keep the assembled
 * prompt under MAX_PROMPT_CHARS, so large projects are accepted here.
 */
export const MAX_BODY_BYTES = 2 * 1024 * 1024
/**
 * Rough token ceiling for the assembled prompt (~4 chars/token ≈ 50k tokens).
 * Backstop only — context selection keeps the files block under budget, so
 * this fires mainly on pathological chat histories.
 */
export const MAX_PROMPT_CHARS = 200_000

export type AuthResult = { userId: string; tier: string }

export type ClerkWebhookEvent = {
  type: string
  data: { id?: string }
}

export type AppDeps = {
  db: Db
  openrouter: OpenRouterClient
  keyCrypto: KeyCrypto
  rateLimiter: RateLimiter
  /** Verify a Clerk session JWT; throw on anything invalid. */
  verifyToken(token: string): Promise<AuthResult>
  /** Verify a svix-signed webhook; throw on bad signature. */
  verifyWebhook(rawBody: string, headers: Record<string, string | undefined>): ClerkWebhookEvent
  log?: (message: string) => void
}

function errorBody(code: string, message: string) {
  return { error: { code, message } }
}

// OpenRouter `limit_reset: monthly` resets on the first of the calendar month
// (UTC); surface that so the client can show "wait until {date}".
function budgetExhaustedBody() {
  const now = new Date()
  const resetAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString()
  return { error: { code: 'budget_exhausted', message: 'Monthly build budget used up', resetAt } }
}

async function provisionUser(deps: AppDeps, userId: string, tier: string): Promise<UserRow> {
  const config = tierConfig(tier)
  const provisioned = await deps.openrouter.createKey({
    name: `build-user-${userId}`,
    limitUsd: config.limitUsd,
  })
  const row = await deps.db.insertUser({
    clerkUserId: userId,
    orKeyHash: provisioned.hash,
    orKeyEnc: deps.keyCrypto.encrypt(provisioned.key),
    tier: normalizeTier(tier),
    model: config.model,
  })
  // Lost the insert race (webhook + lazy provision): the stored row wins, so
  // remove the key we just minted instead of leaking it.
  if (row.or_key_hash !== provisioned.hash) {
    await deps.openrouter.deleteKey(provisioned.hash).catch(() => {})
  }
  return row
}

async function loadOrProvisionUser(deps: AppDeps, auth: AuthResult): Promise<UserRow> {
  const existing = await deps.db.getUser(auth.userId)
  if (existing) return existing
  deps.log?.(`lazy-provisioning user ${auth.userId}`)
  return provisionUser(deps, auth.userId, auth.tier)
}

function isValidAgentBody(body: unknown): body is AgentRequestBody {
  if (!body || typeof body !== 'object') return false
  const candidate = body as Partial<AgentRequestBody>
  return (
    typeof candidate.userPrompt === 'string' &&
    candidate.userPrompt.length > 0 &&
    Array.isArray(candidate.files) &&
    candidate.files.every(f => typeof f?.path === 'string' && typeof f?.content === 'string') &&
    Array.isArray(candidate.messages) &&
    candidate.messages.every(
      m => (m?.role === 'user' || m?.role === 'assistant') && typeof m?.content === 'string',
    )
  )
}

export function createApp(deps: AppDeps) {
  const app = new Hono()

  app.get('/api/health', c => c.json({ ok: true }))

  const authenticate = async (c: { req: { header(name: string): string | undefined } }) => {
    const header = (c.req.header('Authorization') ?? '').trim()
    const bearer = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
    const token = bearer || getCookie(c as never, '__session') || ''
    if (!token) return null
    try {
      return await deps.verifyToken(token)
    } catch {
      return null
    }
  }

  app.post('/api/agent', async c => {
    const auth = await authenticate(c)
    if (!auth) return c.json(errorBody('unauthorized', 'Missing or invalid session token'), 401)

    if (!deps.rateLimiter.check(auth.userId)) {
      return c.json(errorBody('rate_limited', 'Too many requests; try again in a minute'), 429)
    }

    const declaredLength = Number(c.req.header('content-length') ?? '0')
    if (declaredLength > MAX_BODY_BYTES) {
      return c.json(errorBody('payload_too_large', 'Request body exceeds 2MB'), 413)
    }
    const rawBody = await c.req.text()
    if (rawBody.length > MAX_BODY_BYTES) {
      return c.json(errorBody('payload_too_large', 'Request body exceeds 2MB'), 413)
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(rawBody)
    } catch {
      return c.json(errorBody('bad_request', 'Body must be JSON'), 400)
    }
    if (!isValidAgentBody(parsed)) {
      return c.json(errorBody('bad_request', 'Body must include userPrompt, files, messages'), 400)
    }

    const modelMessages = buildModelMessages(parsed)
    const promptChars = modelMessages.reduce((total, m) => total + m.content.length, 0)
    if (promptChars > MAX_PROMPT_CHARS) {
      return c.json(errorBody('prompt_too_large', 'Project too large for one request'), 413)
    }

    let user: UserRow
    try {
      user = await loadOrProvisionUser(deps, auth)
    } catch (error) {
      deps.log?.(`provisioning failed for ${auth.userId}: ${String(error)}`)
      return c.json(errorBody('provisioning_failed', 'Could not provision account'), 503)
    }
    if (user.disabled) {
      return c.json(errorBody('payment_failed', 'Account is disabled'), 402)
    }

    const apiKey = deps.keyCrypto.decrypt(user.or_key_enc)
    const first = await deps.openrouter.chatCompletion({
      apiKey,
      model: user.model,
      messages: modelMessages,
    })
    if (first.kind === 'budget_exhausted') {
      return c.json(budgetExhaustedBody(), 402)
    }
    if (first.kind === 'error') {
      deps.log?.(`openrouter error for ${auth.userId}: ${first.status} ${first.message}`)
      return c.json(errorBody('upstream_error', 'Model call failed'), 502)
    }

    try {
      return c.json(extractJson(first.content))
    } catch (parseError) {
      deps.log?.(
        `unparseable model output for ${auth.userId} (${String(parseError)}); ` +
          `len=${first.content.length} head=${JSON.stringify(first.content.slice(0, 200))} ` +
          `tail=${JSON.stringify(first.content.slice(-120))}`,
      )
      // One repair round-trip, mirroring the old client behavior.
      const repair = await deps.openrouter.chatCompletion({
        apiKey,
        model: user.model,
        messages: [
          ...modelMessages,
          { role: 'assistant', content: first.content },
          {
            role: 'user',
            content:
              'Invalid response to repair. Return ONLY valid JSON with shape: {"reply":"summary","patches":[{"path":"file","content":"code"}]}',
          },
        ],
      })
      if (repair.kind === 'budget_exhausted') {
        return c.json(budgetExhaustedBody(), 402)
      }
      if (repair.kind === 'error') {
        return c.json(errorBody('upstream_error', 'Model call failed'), 502)
      }
      try {
        return c.json(extractJson(repair.content))
      } catch (repairError) {
        deps.log?.(
          `repair also unparseable for ${auth.userId} (${String(repairError)}); ` +
            `len=${repair.content.length} tail=${JSON.stringify(repair.content.slice(-120))}`,
        )
        return c.json(errorBody('bad_model_output', 'Model returned unusable output'), 502)
      }
    }
  })

  // ScoutOS publish keys are user-supplied and write-only: stored encrypted,
  // surfaced to clients only as a presence flag, decrypted only inside the
  // publish handler.
  const SCOUTOS_KEY_RE = /^sk_(live|test)_[A-Za-z0-9_-]{8,256}$/

  app.put('/api/credentials/scoutos', async c => {
    const auth = await authenticate(c)
    if (!auth) return c.json(errorBody('unauthorized', 'Missing or invalid session token'), 401)

    let body: { key?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json(errorBody('bad_request', 'Body must be JSON'), 400)
    }
    if (typeof body.key !== 'string' || !SCOUTOS_KEY_RE.test(body.key.trim())) {
      return c.json(errorBody('bad_request', 'Key must look like sk_live_... or sk_test_...'), 400)
    }

    await deps.db.upsertCredential(auth.userId, 'scoutos', deps.keyCrypto.encrypt(body.key.trim()))
    return c.json({ scoutos: true })
  })

  app.get('/api/credentials', async c => {
    const auth = await authenticate(c)
    if (!auth) return c.json(errorBody('unauthorized', 'Missing or invalid session token'), 401)

    const stored = await deps.db.getCredential(auth.userId, 'scoutos')
    return c.json({ scoutos: stored !== null })
  })

  app.delete('/api/credentials/scoutos', async c => {
    const auth = await authenticate(c)
    if (!auth) return c.json(errorBody('unauthorized', 'Missing or invalid session token'), 401)

    await deps.db.deleteCredential(auth.userId, 'scoutos')
    return c.json({ scoutos: false })
  })

  app.get('/api/me', async c => {
    const auth = await authenticate(c)
    if (!auth) return c.json(errorBody('unauthorized', 'Missing or invalid session token'), 401)

    let user: UserRow
    try {
      user = await loadOrProvisionUser(deps, auth)
    } catch (error) {
      deps.log?.(`provisioning failed for ${auth.userId}: ${String(error)}`)
      return c.json(errorBody('provisioning_failed', 'Could not provision account'), 503)
    }

    const keyInfo = await deps.openrouter.getKey(user.or_key_hash)
    return c.json({
      plan: user.tier,
      model: user.model,
      disabled: user.disabled,
      limit: keyInfo.limit,
      usage: keyInfo.usage,
      limitRemaining: keyInfo.limitRemaining,
    })
  })

  app.post('/webhooks/clerk', async c => {
    const rawBody = await c.req.text()
    let event: ClerkWebhookEvent
    try {
      event = deps.verifyWebhook(rawBody, {
        'svix-id': c.req.header('svix-id'),
        'svix-timestamp': c.req.header('svix-timestamp'),
        'svix-signature': c.req.header('svix-signature'),
      })
    } catch {
      return c.json(errorBody('invalid_signature', 'Webhook signature verification failed'), 400)
    }

    const userId = event.data.id
    if (!userId) return c.json({ received: true })

    if (event.type === 'user.created') {
      const existing = await deps.db.getUser(userId)
      if (!existing) {
        try {
          await provisionUser(deps, userId, 'free')
        } catch (error) {
          deps.log?.(`webhook provisioning failed for ${userId}: ${String(error)}`)
          // Non-2xx so svix redelivers; lazy provisioning also covers this.
          return c.json(errorBody('provisioning_failed', 'Provisioning failed'), 500)
        }
      }
    }

    if (event.type === 'user.deleted') {
      const existing = await deps.db.getUser(userId)
      if (existing) {
        await deps.openrouter.updateKey(existing.or_key_hash, { disabled: true }).catch(error => {
          deps.log?.(`disabling key for ${userId} failed: ${String(error)}`)
        })
        await deps.openrouter.deleteKey(existing.or_key_hash).catch(error => {
          deps.log?.(`deleting key for ${userId} failed: ${String(error)}`)
        })
        await deps.db.deleteUser(userId)
      }
    }

    return c.json({ received: true })
  })

  return app
}
