import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, MAX_PROMPT_CHARS, type AppDeps } from './app.js'
import type { Db, UserRow } from './db.js'
import { createKeyCrypto } from './key-crypto.js'
import type { ChatResult, OpenRouterClient } from './openrouter.js'
import { createRateLimiter } from './rate-limit.js'

const keyCrypto = createKeyCrypto('test-secret')

function makeUserRow(overrides: Partial<UserRow> = {}): UserRow {
  return {
    clerk_user_id: 'user_1',
    or_key_hash: 'hash-1',
    or_key_enc: keyCrypto.encrypt('sk-or-v1-user-key'),
    tier: 'free',
    model: 'anthropic/claude-3.5-haiku',
    disabled: false,
    created_at: new Date('2026-01-01'),
    ...overrides,
  }
}

function createFakeDb(initial: UserRow[] = []) {
  const rows = new Map(initial.map(row => [row.clerk_user_id, row]))
  const db: Db = {
    async getUser(id) {
      return rows.get(id) ?? null
    },
    async insertUser({ clerkUserId, orKeyHash, orKeyEnc, tier, model }) {
      const existing = rows.get(clerkUserId)
      if (existing) return existing
      const row = makeUserRow({
        clerk_user_id: clerkUserId,
        or_key_hash: orKeyHash,
        or_key_enc: orKeyEnc,
        tier,
        model,
      })
      rows.set(clerkUserId, row)
      return row
    },
    async setDisabled(id, disabled) {
      const row = rows.get(id)
      if (row) rows.set(id, { ...row, disabled })
    },
    async deleteUser(id) {
      rows.delete(id)
    },
    async updateTier(id, tier, model) {
      const row = rows.get(id)
      if (row) rows.set(id, { ...row, tier, model })
    },
  }
  return { db, rows }
}

function createFakeOpenRouter(chatResult: ChatResult = { kind: 'ok', content: '{"reply":"done","patches":[]}' }) {
  const client: OpenRouterClient = {
    createKey: vi.fn(async ({ name }) => ({ key: `sk-or-v1-minted-${name}`, hash: `hash-${name}` })),
    getKey: vi.fn(async () => ({ limit: 1, usage: 0.25, limitRemaining: 0.75, disabled: false })),
    updateKey: vi.fn(async () => {}),
    deleteKey: vi.fn(async () => {}),
    chatCompletion: vi.fn(async () => chatResult),
  }
  return client
}

function createDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    db: createFakeDb([makeUserRow()]).db,
    openrouter: createFakeOpenRouter(),
    keyCrypto,
    rateLimiter: createRateLimiter(10, 60_000),
    verifyToken: vi.fn(async token => {
      if (token !== 'valid-token') throw new Error('bad token')
      return { userId: 'user_1', tier: 'free' }
    }),
    verifyWebhook: vi.fn((rawBody: string) => JSON.parse(rawBody)),
    ...overrides,
  }
}

const agentBody = JSON.stringify({ userPrompt: 'add a button', files: [], messages: [] })

function agentRequest(app: ReturnType<typeof createApp>, init: RequestInit = {}) {
  return app.request('/api/agent', {
    method: 'POST',
    headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' },
    body: agentBody,
    ...init,
  })
}

describe('GET /api/health', () => {
  it('returns 200', async () => {
    const app = createApp(createDeps())
    const res = await app.request('/api/health')
    expect(res.status).toBe(200)
  })
})

describe('POST /api/agent auth', () => {
  it.each([
    ['no token', {}],
    ['garbage token', { Authorization: 'Bearer garbage' }],
    ['malformed header', { Authorization: 'garbage' }],
  ])('rejects %s with 401 and makes no OpenRouter call', async (_label, headers) => {
    const openrouter = createFakeOpenRouter()
    const app = createApp(createDeps({ openrouter }))
    const res = await app.request('/api/agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: agentBody,
    })
    expect(res.status).toBe(401)
    expect(openrouter.chatCompletion).not.toHaveBeenCalled()
    expect(openrouter.createKey).not.toHaveBeenCalled()
  })

  it('accepts the Clerk __session cookie as fallback', async () => {
    const app = createApp(createDeps())
    const res = await app.request('/api/agent', {
      method: 'POST',
      headers: { Cookie: '__session=valid-token', 'Content-Type': 'application/json' },
      body: agentBody,
    })
    expect(res.status).toBe(200)
  })
})

describe('POST /api/agent happy path', () => {
  it('returns { reply, patches } using the user key and server-chosen model', async () => {
    const openrouter = createFakeOpenRouter()
    const app = createApp(createDeps({ openrouter }))
    const res = await agentRequest(app)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ reply: 'done', patches: [] })
    expect(openrouter.chatCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'sk-or-v1-user-key',
        model: 'anthropic/claude-3.5-haiku',
      }),
    )
  })

  it('repairs unparseable model output with one retry', async () => {
    const openrouter = createFakeOpenRouter()
    vi.mocked(openrouter.chatCompletion)
      .mockResolvedValueOnce({ kind: 'ok', content: 'sorry, not json' })
      .mockResolvedValueOnce({ kind: 'ok', content: '{"reply":"fixed","patches":[]}' })
    const app = createApp(createDeps({ openrouter }))
    const res = await agentRequest(app)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ reply: 'fixed', patches: [] })
    expect(openrouter.chatCompletion).toHaveBeenCalledTimes(2)
  })
})

describe('POST /api/agent lazy provisioning', () => {
  it('provisions inline when no row exists, then succeeds', async () => {
    const { db, rows } = createFakeDb([])
    const openrouter = createFakeOpenRouter()
    const app = createApp(createDeps({ db, openrouter }))
    const res = await agentRequest(app)
    expect(res.status).toBe(200)
    expect(openrouter.createKey).toHaveBeenCalledWith({ name: 'build-user-user_1', limitUsd: 1 })
    const row = rows.get('user_1')
    expect(row).toBeDefined()
    expect(row?.or_key_enc.toString('latin1')).not.toContain('sk-or-')
  })

  it('returns 503 provisioning_failed when key minting fails', async () => {
    const { db } = createFakeDb([])
    const openrouter = createFakeOpenRouter()
    vi.mocked(openrouter.createKey).mockRejectedValue(new Error('management API down'))
    const app = createApp(createDeps({ db, openrouter }))
    const res = await agentRequest(app)
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error.code).toBe('provisioning_failed')
  })
})

describe('POST /api/agent budget and account state', () => {
  it('maps OpenRouter 402 to budget_exhausted with a reset date', async () => {
    const app = createApp(createDeps({ openrouter: createFakeOpenRouter({ kind: 'budget_exhausted' }) }))
    const res = await agentRequest(app)
    expect(res.status).toBe(402)
    const body = await res.json()
    expect(body.error.code).toBe('budget_exhausted')
    expect(body.error.resetAt).toMatch(/^\d{4}-\d{2}-01T00:00:00/)
  })

  it('returns payment_failed (distinct code) for a disabled account without calling OpenRouter', async () => {
    const { db } = createFakeDb([makeUserRow({ disabled: true })])
    const openrouter = createFakeOpenRouter()
    const app = createApp(createDeps({ db, openrouter }))
    const res = await agentRequest(app)
    expect(res.status).toBe(402)
    const body = await res.json()
    expect(body.error.code).toBe('payment_failed')
    expect(openrouter.chatCompletion).not.toHaveBeenCalled()
  })
})

describe('POST /api/agent abuse controls', () => {
  it('returns 429 on the 11th request inside one minute', async () => {
    const app = createApp(createDeps())
    for (let i = 0; i < 10; i++) {
      expect((await agentRequest(app)).status).toBe(200)
    }
    const res = await agentRequest(app)
    expect(res.status).toBe(429)
  })

  it('returns 413 for a body over 256KB', async () => {
    const app = createApp(createDeps())
    const big = JSON.stringify({
      userPrompt: 'x'.repeat(300 * 1024),
      files: [],
      messages: [],
    })
    const res = await agentRequest(app, { body: big })
    expect(res.status).toBe(413)
    const body = await res.json()
    expect(body.error.code).toBe('payload_too_large')
  })

  it('returns 413 prompt_too_large when the assembled prompt exceeds the token ceiling', async () => {
    const openrouter = createFakeOpenRouter()
    const app = createApp(createDeps({ openrouter }))
    // ~220k chars of file content: under the 256KB body cap, over the
    // 200k-char prompt ceiling.
    const files = Array.from({ length: 5 }, (_, i) => ({
      path: `src/f${i}.ts`,
      content: 'y'.repeat(44 * 1024),
    }))
    const body = JSON.stringify({ userPrompt: 'small', files, messages: [] })
    expect(body.length).toBeLessThan(256 * 1024)
    expect(body.length).toBeGreaterThan(MAX_PROMPT_CHARS)
    const res = await agentRequest(app, { body })
    expect(res.status).toBe(413)
    const errorPayload = await res.json()
    expect(errorPayload.error.code).toBe('prompt_too_large')
    expect(openrouter.chatCompletion).not.toHaveBeenCalled()
  })

  it('rejects malformed bodies with 400', async () => {
    const app = createApp(createDeps())
    const res = await agentRequest(app, { body: JSON.stringify({ nope: true }) })
    expect(res.status).toBe(400)
  })
})

describe('GET /api/me', () => {
  it('returns plan, model, and budget from the key info', async () => {
    const app = createApp(createDeps())
    const res = await app.request('/api/me', {
      headers: { Authorization: 'Bearer valid-token' },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      plan: 'free',
      model: 'anthropic/claude-3.5-haiku',
      disabled: false,
      limit: 1,
      usage: 0.25,
      limitRemaining: 0.75,
    })
  })

  it('rejects unauthenticated requests', async () => {
    const app = createApp(createDeps())
    const res = await app.request('/api/me')
    expect(res.status).toBe(401)
  })
})

describe('POST /webhooks/clerk', () => {
  function webhookRequest(app: ReturnType<typeof createApp>, event: unknown) {
    return app.request('/webhooks/clerk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    })
  }

  it('rejects an invalid svix signature with 400 and provisions nothing', async () => {
    const openrouter = createFakeOpenRouter()
    const app = createApp(
      createDeps({
        openrouter,
        verifyWebhook: vi.fn(() => {
          throw new Error('bad signature')
        }),
      }),
    )
    const res = await webhookRequest(app, { type: 'user.created', data: { id: 'user_9' } })
    expect(res.status).toBe(400)
    expect(openrouter.createKey).not.toHaveBeenCalled()
  })

  it('user.created provisions a key with the free-tier limit and stores an encrypted row', async () => {
    const { db, rows } = createFakeDb([])
    const openrouter = createFakeOpenRouter()
    const app = createApp(createDeps({ db, openrouter }))
    const res = await webhookRequest(app, { type: 'user.created', data: { id: 'user_9' } })
    expect(res.status).toBe(200)
    expect(openrouter.createKey).toHaveBeenCalledWith({ name: 'build-user-user_9', limitUsd: 1 })
    const row = rows.get('user_9')
    expect(row?.tier).toBe('free')
    expect(row?.or_key_enc.toString('latin1')).not.toContain('sk-or-')
  })

  it('user.created is idempotent on redelivery', async () => {
    const { db } = createFakeDb([])
    const openrouter = createFakeOpenRouter()
    const app = createApp(createDeps({ db, openrouter }))
    await webhookRequest(app, { type: 'user.created', data: { id: 'user_9' } })
    await webhookRequest(app, { type: 'user.created', data: { id: 'user_9' } })
    expect(openrouter.createKey).toHaveBeenCalledTimes(1)
  })

  it('user.deleted disables and deletes the key, then removes the row', async () => {
    const { db, rows } = createFakeDb([makeUserRow()])
    const openrouter = createFakeOpenRouter()
    const app = createApp(createDeps({ db, openrouter }))
    const res = await webhookRequest(app, { type: 'user.deleted', data: { id: 'user_1' } })
    expect(res.status).toBe(200)
    expect(openrouter.updateKey).toHaveBeenCalledWith('hash-1', { disabled: true })
    expect(openrouter.deleteKey).toHaveBeenCalledWith('hash-1')
    expect(rows.has('user_1')).toBe(false)
  })
})
