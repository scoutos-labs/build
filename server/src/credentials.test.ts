import { PGlite } from '@electric-sql/pglite'
import { describe, expect, it, vi } from 'vitest'
import { createApp, type AppDeps } from './app.js'
import { createDb, migrate, type Db } from './db.js'
import { createKeyCrypto } from './key-crypto.js'
import type { OpenRouterClient } from './openrouter.js'
import { createRateLimiter } from './rate-limit.js'

const keyCrypto = createKeyCrypto('test-secret')
const SCOUTOS_KEY = 'sk_live_abc123DEF456ghi789'

async function pgliteDb(): Promise<Db> {
  const pglite = new PGlite() // in-memory
  await migrate(pglite)
  return createDb(pglite)
}

function unusedOpenRouter(): OpenRouterClient {
  return {
    createKey: vi.fn(async () => ({ key: 'sk-or-v1-x', hash: 'hash-x' })),
    getKey: vi.fn(async () => ({ limit: 1, usage: 0, limitRemaining: 1, disabled: false })),
    updateKey: vi.fn(async () => {}),
    deleteKey: vi.fn(async () => {}),
    chatCompletion: vi.fn(async () => ({ kind: 'ok' as const, content: '{}' })),
  }
}

async function createCredentialApp(): Promise<{ app: ReturnType<typeof createApp>; db: Db }> {
  const db = await pgliteDb()
  const deps: AppDeps = {
    db,
    openrouter: unusedOpenRouter(),
    keyCrypto,
    rateLimiter: createRateLimiter(10, 60_000),
    verifyToken: vi.fn(async token => {
      if (token !== 'valid-token') throw new Error('bad token')
      return { userId: 'user_1', tier: 'free' }
    }),
    verifyWebhook: vi.fn((rawBody: string) => JSON.parse(rawBody)),
  }
  return { app: createApp(deps), db }
}

function authed(init: RequestInit = {}): RequestInit {
  return {
    headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' },
    ...init,
  }
}

describe('credential storage (against real PGlite)', () => {
  it('round-trips a key through encrypt/store/decrypt', async () => {
    const db = await pgliteDb()
    await db.upsertCredential('user_1', 'scoutos', keyCrypto.encrypt(SCOUTOS_KEY))
    const stored = await db.getCredential('user_1', 'scoutos')
    expect(stored).not.toBeNull()
    expect(keyCrypto.decrypt(stored!)).toBe(SCOUTOS_KEY)
    expect(stored!.toString('latin1')).not.toContain('sk_live_')
  })

  it('upsert overwrites the previous key', async () => {
    const db = await pgliteDb()
    await db.upsertCredential('user_1', 'scoutos', keyCrypto.encrypt('sk_live_oldoldoldold'))
    await db.upsertCredential('user_1', 'scoutos', keyCrypto.encrypt(SCOUTOS_KEY))
    expect(keyCrypto.decrypt((await db.getCredential('user_1', 'scoutos'))!)).toBe(SCOUTOS_KEY)
  })

  it('delete removes the key; unknown users have none', async () => {
    const db = await pgliteDb()
    await db.upsertCredential('user_1', 'scoutos', keyCrypto.encrypt(SCOUTOS_KEY))
    await db.deleteCredential('user_1', 'scoutos')
    expect(await db.getCredential('user_1', 'scoutos')).toBeNull()
    expect(await db.getCredential('nobody', 'scoutos')).toBeNull()
  })

  it('migration is idempotent over an existing data dir', async () => {
    const pglite = new PGlite()
    await migrate(pglite)
    const db = createDb(pglite)
    await db.upsertCredential('user_1', 'scoutos', keyCrypto.encrypt(SCOUTOS_KEY))
    await migrate(pglite) // boot again on the same data
    expect(keyCrypto.decrypt((await db.getCredential('user_1', 'scoutos'))!)).toBe(SCOUTOS_KEY)
  })
})

describe('credentials endpoints', () => {
  it.each([
    ['PUT /api/credentials/scoutos', 'PUT', '/api/credentials/scoutos'],
    ['GET /api/credentials', 'GET', '/api/credentials'],
    ['DELETE /api/credentials/scoutos', 'DELETE', '/api/credentials/scoutos'],
  ])('%s rejects unauthenticated requests with 401', async (_label, method, path) => {
    const { app } = await createCredentialApp()
    const res = await app.request(path, { method, body: method === 'PUT' ? '{}' : undefined })
    expect(res.status).toBe(401)
  })

  it('stores a valid key and reports presence without ever returning it', async () => {
    const { app } = await createCredentialApp()

    const put = await app.request('/api/credentials/scoutos', authed({
      method: 'PUT',
      body: JSON.stringify({ key: SCOUTOS_KEY }),
    }))
    expect(put.status).toBe(200)
    expect(await put.text()).not.toContain(SCOUTOS_KEY)

    const get = await app.request('/api/credentials', authed({ method: 'GET' }))
    expect(get.status).toBe(200)
    const getText = await get.text()
    expect(JSON.parse(getText)).toEqual({ scoutos: true })
    expect(getText).not.toContain(SCOUTOS_KEY)
  })

  it('accepts sk_test_ keys and trims whitespace', async () => {
    const { app, db } = await createCredentialApp()
    const res = await app.request('/api/credentials/scoutos', authed({
      method: 'PUT',
      body: JSON.stringify({ key: '  sk_test_0123456789abcdef  ' }),
    }))
    expect(res.status).toBe(200)
    expect(keyCrypto.decrypt((await db.getCredential('user_1', 'scoutos'))!)).toBe('sk_test_0123456789abcdef')
  })

  it.each([
    ['missing key', '{}'],
    ['non-string key', '{"key":42}'],
    ['wrong prefix', '{"key":"sk-or-v1-not-scoutos-key"}'],
    ['too short', '{"key":"sk_live_x"}'],
    ['not JSON', 'sk_live_abc123DEF456'],
  ])('rejects %s with 400 and stores nothing', async (_label, body) => {
    const { app, db } = await createCredentialApp()
    const res = await app.request('/api/credentials/scoutos', authed({ method: 'PUT', body }))
    expect(res.status).toBe(400)
    expect(await db.getCredential('user_1', 'scoutos')).toBeNull()
  })

  it('reports absence before any key is stored', async () => {
    const { app } = await createCredentialApp()
    const res = await app.request('/api/credentials', authed({ method: 'GET' }))
    expect(await res.json()).toEqual({ scoutos: false })
  })

  it('delete removes the stored key', async () => {
    const { app } = await createCredentialApp()
    await app.request('/api/credentials/scoutos', authed({
      method: 'PUT',
      body: JSON.stringify({ key: SCOUTOS_KEY }),
    }))

    const del = await app.request('/api/credentials/scoutos', authed({ method: 'DELETE' }))
    expect(del.status).toBe(200)
    expect(await del.json()).toEqual({ scoutos: false })

    const get = await app.request('/api/credentials', authed({ method: 'GET' }))
    expect(await get.json()).toEqual({ scoutos: false })
  })
})
