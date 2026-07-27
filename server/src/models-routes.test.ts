/**
 * Route-level tests for the harness's model surface: GET /api/models,
 * PUT /api/me/model, and the harness fields added to GET /api/me.
 *
 * Kept separate from app.test.ts so the single-shot `/api/agent` suite stays
 * readable and its deps factory stays minimal.
 */
import { describe, expect, it, vi } from 'vitest'
import { createApp, type AppDeps } from './app.js'
import type { Db, UserRow } from './db.js'
import { createKeyCrypto } from './key-crypto.js'
import type { OpenRouterClient } from './openrouter.js'
import { createRateLimiter } from './rate-limit.js'
import type { ScoutLiveClient } from './scoutlive.js'
import { CURATED_CHAINS, JOB_IDS, type CatalogModel, type ModelCatalog } from './models.js'

const keyCrypto = createKeyCrypto('test-secret')
const TOOL_MODEL = CURATED_CHAINS.balanced.chain[0]!
const NO_TOOL_MODEL = 'someone/no-tools'

function makeUserRow(overrides: Partial<UserRow> = {}): UserRow {
  return {
    clerk_user_id: 'user_1',
    or_key_hash: 'hash-1',
    or_key_enc: keyCrypto.encrypt('sk-or-v1-user-key'),
    tier: 'free',
    model: TOOL_MODEL,
    disabled: false,
    created_at: new Date('2026-01-01'),
    ...overrides,
  }
}

function createFakeDb(initial: UserRow[] = [makeUserRow()]) {
  const rows = new Map(initial.map(row => [row.clerk_user_id, row]))
  const unsupported = () => {
    throw new Error('not used in these tests')
  }
  const db = {
    async getUser(id: string) {
      return rows.get(id) ?? null
    },
    async insertUser({ clerkUserId, model }: { clerkUserId: string; model: string }) {
      const row = rows.get(clerkUserId) ?? makeUserRow({ clerk_user_id: clerkUserId, model })
      rows.set(clerkUserId, row)
      return row
    },
    async updateModel(id: string, model: string) {
      const row = rows.get(id)
      if (row) rows.set(id, { ...row, model })
    },
    setDisabled: unsupported,
    deleteUser: unsupported,
    updateTier: unsupported,
    upsertCredential: unsupported,
    getCredential: unsupported,
    deleteCredential: unsupported,
    getDeployment: unsupported,
    getDeploymentByBuild: unsupported,
    upsertDeployment: unsupported,
    recordDeployOutcome: unsupported,
  } as unknown as Db
  return { db, rows }
}

function model(id: string, tools = true): CatalogModel {
  return {
    id,
    label: id.split('/')[1] ?? id,
    provider: id.split('/')[0] ?? '',
    contextLength: 128_000,
    promptPrice: 0.000001,
    completionPrice: 0.000002,
    tools,
  }
}

function fakeCatalog(overrides: Partial<ModelCatalog> = {}): ModelCatalog {
  const capable = [...new Set(JOB_IDS.flatMap(job => CURATED_CHAINS[job].chain))].map(id => model(id))
  return {
    async toolCapable() {
      return capable
    },
    async curated() {
      return JOB_IDS.map(id => ({
        id,
        label: CURATED_CHAINS[id].label,
        blurb: CURATED_CHAINS[id].blurb,
        model: CURATED_CHAINS[id].chain[0]!,
        fellBack: false,
      }))
    },
    async isToolCapable(id: string) {
      return id !== NO_TOOL_MODEL && capable.some(m => m.id === id)
    },
    ...overrides,
  }
}

function createFakeOpenRouter(): OpenRouterClient {
  return {
    createKey: vi.fn(async ({ name }) => ({ key: `sk-or-v1-${name}`, hash: `hash-${name}` })),
    getKey: vi.fn(async () => ({ limit: 5, usage: 1, limitRemaining: 4, disabled: false })),
    updateKey: vi.fn(async () => {}),
    deleteKey: vi.fn(async () => {}),
    chatCompletion: vi.fn(async () => ({ kind: 'ok' as const, content: '{}' })),
  }
}

function createDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    db: createFakeDb().db,
    openrouter: createFakeOpenRouter(),
    scoutlive: {} as ScoutLiveClient,
    keyCrypto,
    rateLimiter: createRateLimiter(10, 60_000),
    models: fakeCatalog(),
    verifyToken: vi.fn(async token => {
      if (token !== 'valid-token') throw new Error('bad token')
      return { userId: 'user_1', tier: 'free' }
    }),
    verifyWebhook: vi.fn((raw: string) => JSON.parse(raw)),
    ...overrides,
  }
}

const auth = { Authorization: 'Bearer valid-token' }

describe('GET /api/models', () => {
  it('returns exactly the three curated jobs plus a tool-capable catalog', async () => {
    const app = createApp(createDeps())
    const res = await app.request('/api/models', { headers: auth })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      curated: { id: string; label: string; model: string }[]
      catalog: CatalogModel[]
      defaultJob: string
    }
    expect(body.curated.map(job => job.id)).toEqual(JOB_IDS)
    expect(body.defaultJob).toBe('balanced')
    // A non-tool model in the catalog would silently break the harness.
    expect(body.catalog.every(m => m.tools)).toBe(true)
    expect(body.catalog.length).toBeGreaterThan(0)
  })

  it('never exposes a model id as a curated label', async () => {
    const app = createApp(createDeps())
    const body = (await (await app.request('/api/models', { headers: auth })).json()) as {
      curated: { label: string; blurb: string }[]
    }
    for (const job of body.curated) {
      expect(job.label).not.toContain('/')
      expect(job.blurb.length).toBeGreaterThan(0)
    }
  })

  it('rejects unauthenticated requests', async () => {
    const app = createApp(createDeps())
    expect((await app.request('/api/models')).status).toBe(401)
  })

  it('reports 503 when no catalog is configured rather than 500ing', async () => {
    const app = createApp(createDeps({ models: undefined }))
    const res = await app.request('/api/models', { headers: auth })
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: { code: 'not_configured' } })
  })
})

describe('PUT /api/me/model', () => {
  function put(app: ReturnType<typeof createApp>, body: unknown) {
    return app.request('/api/me/model', {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  }

  it('accepts a tool-capable id and persists it', async () => {
    const fake = createFakeDb()
    const app = createApp(createDeps({ db: fake.db }))
    const target = CURATED_CHAINS.deep.chain[0]!
    const res = await put(app, { model: target })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ model: target })
    expect(fake.rows.get('user_1')?.model).toBe(target)
  })

  it('rejects a non-tool-capable id with 400 model_not_tool_capable and stores nothing', async () => {
    const fake = createFakeDb()
    const app = createApp(createDeps({ db: fake.db }))
    const res = await put(app, { model: NO_TOOL_MODEL })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { code: 'model_not_tool_capable' } })
    expect(fake.rows.get('user_1')?.model).toBe(TOOL_MODEL)
  })

  it('explains the consequence rather than just refusing', async () => {
    // S7: a silent refusal is as bad as a silently broken harness.
    const app = createApp(createDeps())
    const body = (await (await put(app, { model: NO_TOOL_MODEL })).json()) as {
      error: { message: string }
    }
    expect(body.error.message.toLowerCase()).toContain('tools')
    expect(body.error.message).toMatch(/read files|run commands|check its own work/i)
  })

  it('rejects a missing or non-string model with 400', async () => {
    const app = createApp(createDeps())
    expect((await put(app, {})).status).toBe(400)
    expect((await put(app, { model: '' })).status).toBe(400)
    expect((await put(app, { model: '   ' })).status).toBe(400)
    expect((await put(app, { model: 42 })).status).toBe(400)
  })

  it('rejects a non-JSON body with 400', async () => {
    const app = createApp(createDeps())
    expect((await put(app, 'not json')).status).toBe(400)
  })

  it('rejects unauthenticated requests', async () => {
    const app = createApp(createDeps())
    const res = await app.request('/api/me/model', {
      method: 'PUT',
      body: JSON.stringify({ model: TOOL_MODEL }),
    })
    expect(res.status).toBe(401)
  })

  it('provisions a missing user before writing, so a pre-first-turn pick is not lost', async () => {
    const fake = createFakeDb([])
    const app = createApp(createDeps({ db: fake.db }))
    const res = await put(app, { model: TOOL_MODEL })
    expect(res.status).toBe(200)
    expect(fake.rows.get('user_1')?.model).toBe(TOOL_MODEL)
  })

  it('reports 503 when no catalog is configured', async () => {
    const app = createApp(createDeps({ models: undefined }))
    expect((await put(app, { model: TOOL_MODEL })).status).toBe(503)
  })
})

describe('GET /api/me — harness fields', () => {
  it('reports tool capability and the tier step ceiling', async () => {
    const app = createApp(createDeps())
    const body = (await (await app.request('/api/me', { headers: auth })).json()) as {
      toolCapable: boolean
      maxToolSteps: number
    }
    expect(body.toolCapable).toBe(true)
    // free tier gets the shorter leash
    expect(body.maxToolSteps).toBe(8)
  })

  it('gives pro the full step budget', async () => {
    const app = createApp(
      createDeps({
        db: createFakeDb([makeUserRow({ tier: 'pro' })]).db,
        verifyToken: vi.fn(async () => ({ userId: 'user_1', tier: 'pro' })),
      }),
    )
    const body = (await (await app.request('/api/me', { headers: auth })).json()) as {
      maxToolSteps: number
    }
    expect(body.maxToolSteps).toBe(12)
  })

  it('reports toolCapable false when the stored model lost tool support', async () => {
    const app = createApp(
      createDeps({ db: createFakeDb([makeUserRow({ model: NO_TOOL_MODEL })]).db }),
    )
    const body = (await (await app.request('/api/me', { headers: auth })).json()) as {
      toolCapable: boolean
    }
    expect(body.toolCapable).toBe(false)
  })
})
