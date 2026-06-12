import { PGlite } from '@electric-sql/pglite'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import { createApp, type AppDeps } from './app.js'
import { createDb, migrate, type Db } from './db.js'
import { createKeyCrypto } from './key-crypto.js'
import type { OpenRouterClient } from './openrouter.js'
import { checkSubdomain, packageProject, PUBLISH_DOCKERFILE } from './publish.js'
import { createRateLimiter } from './rate-limit.js'
import type { DeployResult, ScoutLiveClient, StatusResult } from './scoutlive.js'
import { createTarGz } from './tar.js'

const keyCrypto = createKeyCrypto('test-secret')
const SCOUTOS_KEY = 'sk_live_publishtestkey123'
const PUBLISH_CODE = 'code-shown-once-by-platform'

// ── tar parsing helper: just enough USTAR to verify our writer ──────────────

type ParsedEntry = { path: string; content: string }

function parseTarGz(tarGz: Buffer): ParsedEntry[] {
  const tar = gunzipSync(tarGz)
  const entries: ParsedEntry[] = []
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '')
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/, ''), 8)
    const magic = header.subarray(257, 263).toString('utf8')
    expect(magic).toBe('ustar\0')

    const expected = parseInt(header.subarray(148, 156).toString('utf8').replace(/[\0 ].*$/, ''), 8)
    let sum = 0
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i]
    expect(sum).toBe(expected)

    const content = tar.subarray(offset + 512, offset + 512 + size).toString('utf8')
    entries.push({ path: prefix ? `${prefix}/${name}` : name, content })
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return entries
}

describe('createTarGz', () => {
  it('produces a USTAR archive with valid checksums that round-trips content', () => {
    const entries = parseTarGz(createTarGz([
      { path: 'package.json', content: '{"name":"x"}' },
      { path: 'src/main.tsx', content: 'console.log("hi")' },
    ]))
    expect(entries).toEqual([
      { path: 'package.json', content: '{"name":"x"}' },
      { path: 'src/main.tsx', content: 'console.log("hi")' },
    ])
  })

  it('splits paths over 100 chars into the USTAR prefix field', () => {
    const longDir = 'a'.repeat(80)
    const path = `${longDir}/${'b'.repeat(60)}.ts`
    const entries = parseTarGz(createTarGz([{ path, content: 'x' }]))
    expect(entries).toEqual([{ path, content: 'x' }])
  })

  it('rejects unsplittable paths instead of writing a corrupt header', () => {
    expect(() => createTarGz([{ path: 'c'.repeat(120), content: 'x' }])).toThrow(/too long/i)
  })
})

describe('packageProject', () => {
  it('injects Dockerfile and .dockerignore when the project has none', () => {
    const entries = parseTarGz(packageProject([{ path: 'package.json', content: '{}' }]))
    const paths = entries.map(entry => entry.path)
    expect(paths).toContain('Dockerfile')
    expect(paths).toContain('.dockerignore')
    expect(entries.find(entry => entry.path === 'Dockerfile')?.content).toBe(PUBLISH_DOCKERFILE)
  })

  it('keeps a project-supplied Dockerfile', () => {
    const custom = 'FROM scratch\nUSER 1000\n'
    const entries = parseTarGz(packageProject([
      { path: 'package.json', content: '{}' },
      { path: 'Dockerfile', content: custom },
    ]))
    expect(entries.filter(entry => entry.path === 'Dockerfile')).toEqual([
      { path: 'Dockerfile', content: custom },
    ])
  })

  it('ships a Dockerfile that passes the platform validation rules', () => {
    // Mirror of scout-live's validateDockerfile checks.
    const dangerous = [
      /USER\s+ROOT/i, /--privileged/i, /--cap-add/i,
      /curl.*\|\s*(ba)?sh/i, /wget.*\|\s*(ba)?sh/i, /\/dev\/tcp/i,
    ]
    for (const pattern of dangerous) expect(PUBLISH_DOCKERFILE).not.toMatch(pattern)

    const users = PUBLISH_DOCKERFILE.match(/^\s*USER\s+(.+)$/gim)!
    const lastUser = users[users.length - 1].replace(/^\s*USER\s+/i, '').trim()
    expect(lastUser).toMatch(/^\d+$/) // numeric for the runAsNonRoot securityContext
    expect(lastUser).not.toBe('0')
    expect(PUBLISH_DOCKERFILE).toMatch(/EXPOSE\s+3000/)
    expect(PUBLISH_DOCKERFILE).toContain('CMD ["node", "server.js"]')
  })
})

describe('checkSubdomain', () => {
  it.each(['my-app', 'a', 'app2', 'x'.repeat(63)])('accepts %s', raw => {
    expect(checkSubdomain(raw)).toEqual({ ok: true, subdomain: raw })
  })

  it('normalizes case and whitespace', () => {
    expect(checkSubdomain('  My-App ')).toEqual({ ok: true, subdomain: 'my-app' })
  })

  it.each(['', '-app', 'app-', 'my_app', 'my.app', 'x'.repeat(64)])('rejects %j as invalid', raw => {
    expect(checkSubdomain(raw)).toEqual({ ok: false, reason: 'invalid' })
  })

  it.each(['api', 'www', 'ADMIN', 'scoutos'])('rejects reserved name %s', raw => {
    expect(checkSubdomain(raw)).toEqual({ ok: false, reason: 'reserved' })
  })
})

// ── publish endpoints against real PGlite + fake Scout Live ────────────────

function unusedOpenRouter(): OpenRouterClient {
  return {
    createKey: vi.fn(async () => ({ key: 'sk-or-v1-x', hash: 'hash-x' })),
    getKey: vi.fn(async () => ({ limit: 1, usage: 0, limitRemaining: 1, disabled: false })),
    updateKey: vi.fn(async () => {}),
    deleteKey: vi.fn(async () => {}),
    chatCompletion: vi.fn(async () => ({ kind: 'ok' as const, content: '{}' })),
  }
}

type FakeScoutLive = ScoutLiveClient & {
  deploy: ReturnType<typeof vi.fn>
  getBuildStatus: ReturnType<typeof vi.fn>
}

function fakeScoutLive(
  deployResult: DeployResult = { kind: 'accepted', buildId: 'bld_1' },
  statusResult: StatusResult = { kind: 'ok', build: { status: 'queued' } },
): FakeScoutLive {
  return {
    deploy: vi.fn(async () => deployResult),
    getBuildStatus: vi.fn(async () => statusResult),
  }
}

async function publishApp(args: { scoutlive?: ScoutLiveClient; withKey?: boolean } = {}) {
  const pglite = new PGlite()
  await migrate(pglite)
  const db = createDb(pglite)
  if (args.withKey !== false) {
    await db.upsertCredential('user_1', 'scoutos', keyCrypto.encrypt(SCOUTOS_KEY))
  }
  const logs: string[] = []
  const scoutlive = args.scoutlive ?? fakeScoutLive()
  const deps: AppDeps = {
    db,
    openrouter: unusedOpenRouter(),
    scoutlive,
    keyCrypto,
    rateLimiter: createRateLimiter(10, 60_000),
    verifyToken: vi.fn(async token => {
      if (token !== 'valid-token') throw new Error('bad token')
      return { userId: 'user_1', tier: 'free' }
    }),
    verifyWebhook: vi.fn((rawBody: string) => JSON.parse(rawBody)),
    log: message => logs.push(message),
  }
  return { app: createApp(deps), db, logs, scoutlive }
}

const publishBody = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    projectId: 'proj_1',
    subdomain: 'my-app',
    files: [{ path: 'package.json', content: '{"scripts":{"build":"vite build"}}' }],
    ...overrides,
  })

function publishRequest(app: ReturnType<typeof createApp>, body: string) {
  return app.request('/api/publish', {
    method: 'POST',
    headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' },
    body,
  })
}

describe('POST /api/publish', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const { app, scoutlive } = await publishApp()
    const res = await app.request('/api/publish', { method: 'POST', body: publishBody() })
    expect(res.status).toBe(401)
    expect(scoutlive.deploy).not.toHaveBeenCalled()
  })

  it('returns no_scoutos_key when no key is stored', async () => {
    const { app, scoutlive } = await publishApp({ withKey: false })
    const res = await publishRequest(app, publishBody())
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('no_scoutos_key')
    expect(scoutlive.deploy).not.toHaveBeenCalled()
  })

  it.each([
    ['invalid', 'My App!', 'invalid_subdomain'],
    ['reserved', 'api', 'reserved_subdomain'],
  ])('rejects %s subdomains before any platform call', async (_label, subdomain, code) => {
    const { app, scoutlive } = await publishApp()
    const res = await publishRequest(app, publishBody({ subdomain }))
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe(code)
    expect(scoutlive.deploy).not.toHaveBeenCalled()
  })

  it('first publish deploys without a code and records the deployment', async () => {
    const { app, db, scoutlive } = await publishApp()
    const res = await publishRequest(app, publishBody())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ buildId: 'bld_1', subdomain: 'my-app' })

    expect(scoutlive.deploy).toHaveBeenCalledTimes(1)
    const call = scoutlive.deploy.mock.calls[0][0]
    expect(call.apiKey).toBe(SCOUTOS_KEY)
    expect(call.subdomain).toBe('my-app')
    expect(call.code).toBeUndefined()
    expect(parseTarGz(call.tarGz).map((e: ParsedEntry) => e.path)).toContain('Dockerfile')

    const record = await db.getDeployment('user_1', 'proj_1')
    expect(record?.subdomain).toBe('my-app')
    expect(record?.last_build_id).toBe('bld_1')
  })

  it('republish reuses the recorded subdomain and sends the stored code', async () => {
    const { app, db, scoutlive } = await publishApp()
    await db.upsertDeployment({
      clerkUserId: 'user_1',
      projectId: 'proj_1',
      subdomain: 'original-name',
      lastBuildId: 'bld_0',
    })
    await db.recordDeployOutcome({
      clerkUserId: 'user_1',
      projectId: 'proj_1',
      publishCodeEnc: keyCrypto.encrypt(PUBLISH_CODE),
      lastUrl: 'https://original-name.scoutos.live',
    })

    // Body asks for a different name; the stored record wins.
    const res = await publishRequest(app, publishBody({ subdomain: 'renamed' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ buildId: 'bld_1', subdomain: 'original-name' })

    const call = scoutlive.deploy.mock.calls[0][0]
    expect(call.subdomain).toBe('original-name')
    expect(call.code).toBe(PUBLISH_CODE)
  })

  it('maps a platform 409 to subdomain_taken', async () => {
    const { app } = await publishApp({ scoutlive: fakeScoutLive({ kind: 'subdomain_taken' }) })
    const res = await publishRequest(app, publishBody())
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('subdomain_taken')
  })

  it('maps a platform 429 to scoutlive_rate_limited with Retry-After', async () => {
    const { app } = await publishApp({
      scoutlive: fakeScoutLive({ kind: 'rate_limited', retryAfterSeconds: 120 }),
    })
    const res = await publishRequest(app, publishBody())
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('120')
    expect((await res.json()).error.code).toBe('scoutlive_rate_limited')
  })

  it('rejects oversize projects with a distinct message', async () => {
    const { app } = await publishApp()
    const res = await publishRequest(app, publishBody({
      files: [{ path: 'big.txt', content: 'x'.repeat(2 * 1024 * 1024 + 1) }],
    }))
    expect(res.status).toBe(413)
    expect((await res.json()).error.message).toContain('2MB')
  })

  it('never leaks the user key or publish code into responses or logs', async () => {
    const { app, db, logs } = await publishApp({
      scoutlive: fakeScoutLive(
        { kind: 'accepted', buildId: 'bld_1' },
        { kind: 'ok', build: { status: 'deployed', url: 'https://my-app.scoutos.live', publishCode: PUBLISH_CODE } },
      ),
    })

    const publish = await publishRequest(app, publishBody())
    const publishText = await publish.text()
    const status = await app.request('/api/publish/bld_1', {
      headers: { Authorization: 'Bearer valid-token' },
    })
    const statusText = await status.text()

    for (const text of [publishText, statusText, logs.join('\n')]) {
      expect(text).not.toContain(SCOUTOS_KEY)
      expect(text).not.toContain(PUBLISH_CODE)
    }
    // ...but the code is persisted (encrypted) for the next republish.
    const record = await db.getDeployment('user_1', 'proj_1')
    expect(keyCrypto.decrypt(record!.publish_code_enc!)).toBe(PUBLISH_CODE)
    expect(record!.last_url).toBe('https://my-app.scoutos.live')
  })
})

describe('GET /api/publish/:buildId', () => {
  it('404s for builds that are not the caller’s', async () => {
    const { app, scoutlive } = await publishApp()
    const res = await app.request('/api/publish/bld_unknown', {
      headers: { Authorization: 'Bearer valid-token' },
    })
    expect(res.status).toBe(404)
    expect(scoutlive.getBuildStatus).not.toHaveBeenCalled()
  })

  it('proxies non-terminal status without persisting anything', async () => {
    const { app, db } = await publishApp({
      scoutlive: fakeScoutLive(
        { kind: 'accepted', buildId: 'bld_1' },
        { kind: 'ok', build: { status: 'running' } },
      ),
    })
    await publishRequest(app, publishBody())
    const res = await app.request('/api/publish/bld_1', {
      headers: { Authorization: 'Bearer valid-token' },
    })
    expect(await res.json()).toEqual({
      buildId: 'bld_1',
      status: 'running',
      url: null,
      error: null,
      logs: null,
    })
    expect((await db.getDeployment('user_1', 'proj_1'))!.last_url).toBeNull()
  })

  it('surfaces failure logs for the UI', async () => {
    const { app } = await publishApp({
      scoutlive: fakeScoutLive(
        { kind: 'accepted', buildId: 'bld_1' },
        { kind: 'ok', build: { status: 'failed', error: 'npm run build failed', logs: 'vite: not found' } },
      ),
    })
    await publishRequest(app, publishBody())
    const res = await app.request('/api/publish/bld_1', {
      headers: { Authorization: 'Bearer valid-token' },
    })
    const body = await res.json()
    expect(body.status).toBe('failed')
    expect(body.error).toBe('npm run build failed')
    expect(body.logs).toBe('vite: not found')
  })

  it('keeps the stored publish code when a republish status omits it', async () => {
    const { app, db } = await publishApp({
      scoutlive: fakeScoutLive(
        { kind: 'accepted', buildId: 'bld_2' },
        { kind: 'ok', build: { status: 'deployed', url: 'https://my-app.scoutos.live' } },
      ),
    })
    await db.upsertDeployment({
      clerkUserId: 'user_1', projectId: 'proj_1', subdomain: 'my-app', lastBuildId: 'bld_1',
    })
    await db.recordDeployOutcome({
      clerkUserId: 'user_1', projectId: 'proj_1', publishCodeEnc: keyCrypto.encrypt(PUBLISH_CODE),
    })

    await publishRequest(app, publishBody())
    await app.request('/api/publish/bld_2', { headers: { Authorization: 'Bearer valid-token' } })

    const record = await db.getDeployment('user_1', 'proj_1')
    expect(keyCrypto.decrypt(record!.publish_code_enc!)).toBe(PUBLISH_CODE)
  })
})
