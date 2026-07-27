/**
 * Tests for POST /api/agent/step — one step of the client-driven agent loop.
 */
import { describe, expect, it, vi } from 'vitest'
import { createApp, type AppDeps } from './app.js'
import type { Db, UserRow } from './db.js'
import { createKeyCrypto } from './key-crypto.js'
import type { OpenRouterClient, ToolChatResult } from './openrouter.js'
import { createAgentRateLimiters, createRateLimiter } from './rate-limit.js'
import type { ScoutLiveClient } from './scoutlive.js'
import { createStepTokens, MAX_TOOL_STEPS_FREE } from './step-token.js'
import { adaptLegacyPatches, buildFileTree, buildToolModeMessages } from './prompt.js'
import { STEP_BUDGET_NUDGE } from './agent-tools.js'

const keyCrypto = createKeyCrypto('test-secret')
const SECRET = 'root-secret-for-tests'

function makeUserRow(overrides: Partial<UserRow> = {}): UserRow {
  return {
    clerk_user_id: 'user_1',
    or_key_hash: 'hash-1',
    or_key_enc: keyCrypto.encrypt('sk-or-v1-user-key'),
    tier: 'free',
    model: 'a/model',
    disabled: false,
    created_at: new Date('2026-01-01'),
    ...overrides,
  }
}

function fakeDb(rows: UserRow[] = [makeUserRow()]) {
  const map = new Map(rows.map(row => [row.clerk_user_id, row]))
  const nope = () => {
    throw new Error('unused')
  }
  return {
    async getUser(id: string) {
      return map.get(id) ?? null
    },
    async insertUser({ clerkUserId }: { clerkUserId: string }) {
      const row = map.get(clerkUserId) ?? makeUserRow({ clerk_user_id: clerkUserId })
      map.set(clerkUserId, row)
      return row
    },
    updateModel: async () => {},
    setDisabled: nope,
    deleteUser: nope,
    updateTier: nope,
    upsertCredential: nope,
    getCredential: nope,
    deleteCredential: nope,
    getDeployment: nope,
    getDeploymentByBuild: nope,
    upsertDeployment: nope,
    recordDeployOutcome: nope,
  } as unknown as Db
}

function toolCall(id: string, name = 'fs_read', args = '{"path":"a.ts"}') {
  return { id, type: 'function' as const, function: { name, arguments: args } }
}

function fakeOpenRouter(result: ToolChatResult): OpenRouterClient {
  return {
    createKey: vi.fn(async () => ({ key: 'k', hash: 'h' })),
    getKey: vi.fn(async () => ({ limit: 5, usage: 0, limitRemaining: 5, disabled: false })),
    updateKey: vi.fn(async () => {}),
    deleteKey: vi.fn(async () => {}),
    chatCompletion: vi.fn(async () => ({ kind: 'ok' as const, content: '{}' })),
    toolCompletion: vi.fn(async () => result),
  }
}

function createDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    db: fakeDb(),
    openrouter: fakeOpenRouter({ kind: 'ok', content: 'Done.', toolCalls: [] }),
    scoutlive: {} as ScoutLiveClient,
    keyCrypto,
    rateLimiter: createRateLimiter(10, 60_000),
    agentLimiters: createAgentRateLimiters(),
    stepTokens: createStepTokens(SECRET),
    verifyToken: vi.fn(async token => {
      if (token !== 'valid-token') throw new Error('bad token')
      return { userId: 'user_1', tier: 'free' }
    }),
    verifyWebhook: vi.fn((raw: string) => JSON.parse(raw)),
    ...overrides,
  }
}

function stepBody(overrides: Record<string, unknown> = {}) {
  return {
    turnId: 'turn-1',
    stepIndex: 0,
    tree: [{ path: 'src/App.tsx', bytes: 120 }],
    fullFiles: [{ path: 'package.json', content: '{}' }],
    messages: [],
    toolResults: [],
    userPrompt: 'add a button',
    ...overrides,
  }
}

function post(app: ReturnType<typeof createApp>, body: unknown) {
  return app.request('/api/agent/step', {
    method: 'POST',
    headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

describe('POST /api/agent/step', () => {
  it('returns tool calls for the client to execute', async () => {
    const app = createApp(
      createDeps({
        openrouter: fakeOpenRouter({ kind: 'ok', content: '', toolCalls: [toolCall('c1')] }),
      }),
    )
    const res = await post(app, stepBody())
    expect(res.status).toBe(200)
    const body = (await res.json()) as { toolCalls: unknown[]; done: boolean; stepToken: string }
    expect(body.toolCalls).toHaveLength(1)
    expect(body.done).toBe(false)
    expect(body.stepToken.length).toBeGreaterThan(0)
  })

  it('reports done with the final answer when no tools are called', async () => {
    const app = createApp(createDeps())
    const body = (await (await post(app, stepBody())).json()) as {
      done: boolean
      assistantContent: string
    }
    expect(body.done).toBe(true)
    expect(body.assistantContent).toBe('Done.')
  })

  it('offers the client tool set', async () => {
    const openrouter = fakeOpenRouter({ kind: 'ok', content: 'ok', toolCalls: [] })
    const app = createApp(createDeps({ openrouter }))
    await post(app, stepBody())
    const call = (openrouter.toolCompletion as ReturnType<typeof vi.fn>).mock.calls[0]![0]
    expect(call.tools.map((t: { function: { name: string } }) => t.function.name)).toEqual([
      'fs_list',
      'fs_read',
      'fs_write',
      'fs_batch_write',
      'exec',
    ])
  })

  it('never offers a web tool — those are added only with the server web-tool unit', async () => {
    const openrouter = fakeOpenRouter({ kind: 'ok', content: 'ok', toolCalls: [] })
    const app = createApp(createDeps({ openrouter }))
    await post(app, stepBody())
    const call = (openrouter.toolCompletion as ReturnType<typeof vi.fn>).mock.calls[0]![0]
    const names = call.tools.map((t: { function: { name: string } }) => t.function.name)
    expect(names).not.toContain('web_fetch')
    expect(names).not.toContain('web_post')
  })

  it('rejects unauthenticated requests', async () => {
    const app = createApp(createDeps())
    const res = await app.request('/api/agent/step', {
      method: 'POST',
      body: JSON.stringify(stepBody()),
    })
    expect(res.status).toBe(401)
  })

  it('rejects a malformed body with 400', async () => {
    const app = createApp(createDeps())
    expect((await post(app, 'not json')).status).toBe(400)
    expect((await post(app, {})).status).toBe(400)
    expect((await post(app, stepBody({ turnId: '' }))).status).toBe(400)
    expect((await post(app, stepBody({ stepIndex: -1 }))).status).toBe(400)
    expect((await post(app, stepBody({ tree: 'nope' }))).status).toBe(400)
  })

  it('accepts a project too large to send in full, because only the tree travels', async () => {
    // The whole point of the tree+fullFiles wire shape: a 160k-char project
    // would otherwise be re-uploaded on every one of up to 12 steps.
    const tree = Array.from({ length: 400 }, (_, i) => ({ path: `src/f${i}.tsx`, bytes: 4_000 }))
    const app = createApp(createDeps())
    const res = await post(app, stepBody({ tree }))
    expect(res.status).toBe(200)
  })

  it('maps a mid-turn budget exhaustion to 402 with a reset date', async () => {
    const app = createApp(
      createDeps({ openrouter: fakeOpenRouter({ kind: 'budget_exhausted' }) }),
    )
    const res = await post(app, stepBody())
    expect(res.status).toBe(402)
    const body = (await res.json()) as { error: { code: string; resetAt: string } }
    expect(body.error.code).toBe('budget_exhausted')
    expect(body.error.resetAt).toMatch(/^\d{4}-/)
  })

  it('maps an upstream failure to 502 without leaking the provider body', async () => {
    const app = createApp(
      createDeps({
        openrouter: fakeOpenRouter({ kind: 'error', status: 500, message: 'secret upstream detail' }),
      }),
    )
    const res = await post(app, stepBody())
    expect(res.status).toBe(502)
    expect(await res.text()).not.toContain('secret upstream detail')
  })

  it('refuses a disabled account', async () => {
    const app = createApp(createDeps({ db: fakeDb([makeUserRow({ disabled: true })]) }))
    expect((await post(app, stepBody())).status).toBe(402)
  })
})

describe('step tokens on the wire', () => {
  it('requires a valid token past step 0', async () => {
    const app = createApp(createDeps())
    expect((await post(app, stepBody({ stepIndex: 1 }))).status).toBe(401)
    expect((await post(app, stepBody({ stepIndex: 1, stepToken: 'forged' }))).status).toBe(401)
  })

  it('accepts the token it issued for the next step', async () => {
    const app = createApp(createDeps())
    const first = (await (await post(app, stepBody())).json()) as { stepToken: string }
    const res = await post(app, stepBody({ stepIndex: 1, stepToken: first.stepToken }))
    expect(res.status).toBe(200)
  })

  it('refuses a token minted for a different turn', async () => {
    const tokens = createStepTokens(SECRET)
    const app = createApp(createDeps())
    const other = tokens.issue({ userId: 'user_1', turnId: 'some-other-turn', stepIndex: 1 })
    const res = await post(app, stepBody({ stepIndex: 1, stepToken: other }))
    expect(res.status).toBe(401)
  })

  it('refuses a token minted for a different user', async () => {
    const tokens = createStepTokens(SECRET)
    const app = createApp(createDeps())
    const other = tokens.issue({ userId: 'someone_else', turnId: 'turn-1', stepIndex: 1 })
    expect((await post(app, stepBody({ stepIndex: 1, stepToken: other }))).status).toBe(401)
  })

  it('refuses a step past the tier budget', async () => {
    const tokens = createStepTokens(SECRET)
    const app = createApp(createDeps())
    const token = tokens.issue({
      userId: 'user_1',
      turnId: 'turn-1',
      stepIndex: MAX_TOOL_STEPS_FREE,
    })
    const res = await post(app, stepBody({ stepIndex: MAX_TOOL_STEPS_FREE, stepToken: token }))
    expect(res.status).toBe(400)
    expect((await res.json() as { error: { code: string } }).error.code).toBe('step_budget_exceeded')
  })
})

describe('step budget nudge', () => {
  it('withholds tools and nudges on the final step, so the nudge is binding', async () => {
    // Ending a long turn with a usable answer beats an error that discards
    // everything the agent already did.
    const tokens = createStepTokens(SECRET)
    const openrouter = fakeOpenRouter({ kind: 'ok', content: 'Here is what I did.', toolCalls: [] })
    const app = createApp(createDeps({ openrouter }))
    const lastIndex = MAX_TOOL_STEPS_FREE - 1
    const token = tokens.issue({ userId: 'user_1', turnId: 'turn-1', stepIndex: lastIndex })
    await post(app, stepBody({ stepIndex: lastIndex, stepToken: token }))

    const call = (openrouter.toolCompletion as ReturnType<typeof vi.fn>).mock.calls[0]![0]
    expect(call.tools).toEqual([])
    const systemContents = call.messages
      .filter((m: { role: string }) => m.role === 'system')
      .map((m: { content: string }) => m.content)
    expect(systemContents.some((c: string) => c === STEP_BUDGET_NUDGE)).toBe(true)
  })

  it('does not nudge on an ordinary early step', async () => {
    const openrouter = fakeOpenRouter({ kind: 'ok', content: 'ok', toolCalls: [] })
    const app = createApp(createDeps({ openrouter }))
    await post(app, stepBody())
    const call = (openrouter.toolCompletion as ReturnType<typeof vi.fn>).mock.calls[0]![0]
    expect(call.tools.length).toBeGreaterThan(0)
    const systemContents = call.messages
      .filter((m: { role: string }) => m.role === 'system')
      .map((m: { content: string }) => m.content)
    expect(systemContents).not.toContain(STEP_BUDGET_NUDGE)
  })
})

describe('legacy patch adapter', () => {
  it('decodes a {reply, patches} answer into one synthetic fs_batch_write', async () => {
    const legacy = JSON.stringify({
      reply: 'Renamed the button.',
      patches: [{ path: 'src/App.tsx', content: 'export default App' }],
    })
    const app = createApp(
      createDeps({ openrouter: fakeOpenRouter({ kind: 'ok', content: legacy, toolCalls: [] }) }),
    )
    const body = (await (await post(app, stepBody())).json()) as {
      toolCalls: { function: { name: string; arguments: string } }[]
      assistantContent: string
      done: boolean
      usedLegacyAdapter: boolean
    }
    expect(body.usedLegacyAdapter).toBe(true)
    expect(body.done).toBe(false)
    expect(body.toolCalls).toHaveLength(1)
    expect(body.toolCalls[0]!.function.name).toBe('fs_batch_write')
    expect(JSON.parse(body.toolCalls[0]!.function.arguments)).toEqual({
      files: [{ path: 'src/App.tsx', content: 'export default App' }],
    })
    expect(body.assistantContent).toBe('Renamed the button.')
  })

  it('leaves ordinary prose alone', async () => {
    const app = createApp(createDeps())
    const body = (await (await post(app, stepBody())).json()) as {
      usedLegacyAdapter: boolean
      done: boolean
    }
    expect(body.usedLegacyAdapter).toBe(false)
    expect(body.done).toBe(true)
  })
})

describe('adaptLegacyPatches (unit)', () => {
  it('parses a fenced JSON envelope', () => {
    const adapted = adaptLegacyPatches(
      '```json\n{"reply":"hi","patches":[{"path":"a.ts","content":"x"}]}\n```',
    )
    expect(adapted?.toolCalls).toHaveLength(1)
    expect(adapted?.reply).toBe('hi')
  })

  it('returns null for text that is not the legacy shape', () => {
    expect(adaptLegacyPatches('Just a sentence.')).toBeNull()
    expect(adaptLegacyPatches('{"reply":"hi"}')).toBeNull()
    expect(adaptLegacyPatches('{"patches":[]}')).toBeNull()
  })

  it('treats an empty patch list as a plain reply, not a write', () => {
    const adapted = adaptLegacyPatches('{"reply":"I need more info.","patches":[]}')
    expect(adapted?.toolCalls).toEqual([])
    expect(adapted?.reply).toBe('I need more info.')
  })

  it('drops malformed patch entries rather than writing garbage', () => {
    const adapted = adaptLegacyPatches(
      '{"reply":"x","patches":[{"path":"a.ts","content":"ok"},{"path":42},{"content":"no path"}]}',
    )
    const args = JSON.parse(adapted!.toolCalls[0]!.function.arguments)
    expect(args.files).toEqual([{ path: 'a.ts', content: 'ok' }])
  })
})

describe('buildToolModeMessages', () => {
  it('ships a file tree, not file contents', () => {
    const messages = buildToolModeMessages({
      turnId: 't',
      stepIndex: 0,
      tree: [
        { path: 'src/App.tsx', bytes: 5000 },
        { path: 'src/db.ts', bytes: 800 },
      ],
      fullFiles: [],
      messages: [],
      toolResults: [],
      userPrompt: 'hi',
    })
    const joined = messages.map(m => m.content).join('\n')
    expect(joined).toContain('src/App.tsx (5000 bytes)')
    expect(joined).toContain('fs_read')
  })

  it('drops the JSON envelope from the header so the model does not default to it', () => {
    // The header is the strongest signal in the prompt; leaving the old shape
    // there would invite answers the legacy adapter silently accepts.
    const [system] = buildToolModeMessages({
      turnId: 't',
      stepIndex: 0,
      tree: [],
      fullFiles: [],
      messages: [],
      toolResults: [],
    })
    expect(system!.content).not.toContain('"patches"')
    expect(system!.content).not.toContain('Return ONLY valid JSON')
  })

  it('instructs the model to verify before finishing', () => {
    const [system] = buildToolModeMessages({
      turnId: 't',
      stepIndex: 0,
      tree: [],
      fullFiles: [],
      messages: [],
      toolResults: [],
    })
    expect(system!.content).toContain('tsc --noEmit')
    expect(system!.content).toMatch(/Check your work|verified/)
  })

  it('omits web-tool rules unless web tools are actually offered', () => {
    const without = buildToolModeMessages(
      { turnId: 't', stepIndex: 0, tree: [], fullFiles: [], messages: [], toolResults: [] },
      { webTools: false },
    )[0]!.content
    const with_ = buildToolModeMessages(
      { turnId: 't', stepIndex: 0, tree: [], fullFiles: [], messages: [], toolResults: [] },
      { webTools: true },
    )[0]!.content
    expect(without).not.toContain('web_search')
    expect(with_).toContain('web_search')
    expect(with_).toContain('untrusted DATA')
  })

  it('emits tool results paired with the calls they answer', () => {
    // Providers reject a tool message with no matching tool_calls.
    const messages = buildToolModeMessages({
      turnId: 't',
      stepIndex: 1,
      tree: [],
      fullFiles: [],
      messages: [],
      toolCalls: [toolCall('c1')],
      toolResults: [{ toolCallId: 'c1', name: 'fs_read', content: 'file body' }],
    })
    const assistant = messages.find(m => m.role === 'assistant')
    const tool = messages.find(m => m.role === 'tool')
    expect(assistant?.tool_calls?.[0]?.id).toBe('c1')
    expect(tool?.tool_call_id).toBe('c1')
    expect(messages.indexOf(assistant!)).toBeLessThan(messages.indexOf(tool!))
  })
})

describe('buildFileTree', () => {
  it('sorts by path and includes sizes', () => {
    expect(
      buildFileTree([
        { path: 'src/b.ts', bytes: 2 },
        { path: 'src/a.ts', bytes: 1 },
      ]),
    ).toBe('src/a.ts (1 bytes)\nsrc/b.ts (2 bytes)')
  })
})
