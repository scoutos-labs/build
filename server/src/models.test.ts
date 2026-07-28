import { describe, expect, it } from 'vitest'
import {
  CURATED_CHAINS,
  JOB_IDS,
  createModelCatalog,
  normalizeModels,
  type CatalogModel,
} from './models.js'

/** Minimal shape of an OpenRouter catalog row. */
function row(
  id: string,
  opts: { tools?: boolean; name?: string; ctx?: number; prompt?: string; completion?: string } = {},
) {
  return {
    id,
    name: opts.name ?? id,
    context_length: opts.ctx ?? 128_000,
    pricing: { prompt: opts.prompt ?? '0.000001', completion: opts.completion ?? '0.000002' },
    supported_parameters: opts.tools === false ? ['temperature'] : ['temperature', 'tools'],
  }
}

/** Every id the curated chains can resolve to, all tool-capable. */
const ALL_CURATED = [...new Set(JOB_IDS.flatMap(job => CURATED_CHAINS[job].chain))]

function catalogBody(rows: unknown[]) {
  return { data: rows }
}

function fakeFetch(rows: unknown[], counter?: { calls: number }) {
  return (async () => {
    if (counter) counter.calls++
    return {
      ok: true,
      status: 200,
      json: async () => catalogBody(rows),
    } as unknown as Response
  }) as unknown as typeof fetch
}

describe('normalizeModels', () => {
  it('reads tool capability from supported_parameters', () => {
    const models = normalizeModels([row('a/one'), row('b/two', { tools: false })])
    expect(models.find(m => m.id === 'a/one')?.tools).toBe(true)
    expect(models.find(m => m.id === 'b/two')?.tools).toBe(false)
  })

  it('strips the provider prefix from the label and derives provider from the id', () => {
    const [model] = normalizeModels([row('anthropic/claude-x', { name: 'Anthropic: Claude X' })])
    expect(model.label).toBe('Claude X')
    expect(model.provider).toBe('anthropic')
  })

  it('drops malformed rows instead of throwing, so one bad row cannot blank the picker', () => {
    const models = normalizeModels([null, {}, { id: '' }, 'nope', row('good/one')])
    expect(models.map(m => m.id)).toEqual(['good/one'])
  })

  it('drops openrouter/* meta-router pseudo-models', () => {
    // Their advertised capabilities are the union of a routing pool, which is
    // exactly the wrong input to a tool-capability gate.
    const models = normalizeModels([row('openrouter/auto'), row('real/model')])
    expect(models.map(m => m.id)).toEqual(['real/model'])
  })

  it('deduplicates repeated ids', () => {
    expect(normalizeModels([row('a/one'), row('a/one')]).map(m => m.id)).toEqual(['a/one'])
  })

  it('coerces unparseable numbers to 0 rather than NaN', () => {
    const [model] = normalizeModels([
      { id: 'x/y', pricing: { prompt: 'free', completion: null }, context_length: 'lots' },
    ])
    expect(model.promptPrice).toBe(0)
    expect(model.completionPrice).toBe(0)
    expect(model.contextLength).toBe(0)
  })

  it('returns [] for a non-array payload', () => {
    expect(normalizeModels(undefined)).toEqual([])
    expect(normalizeModels({ data: [] })).toEqual([])
  })
})

describe('createModelCatalog — tool filtering', () => {
  it('exposes only tool-capable rows in the advanced catalog', async () => {
    const catalog = createModelCatalog({
      fetchImpl: fakeFetch([row('a/tools'), row('b/no-tools', { tools: false })]),
    })
    const capable = await catalog.toolCapable()
    expect(capable.map((m: CatalogModel) => m.id)).toEqual(['a/tools'])
  })

  it('isToolCapable is false for a model the feed says lacks tools', async () => {
    const catalog = createModelCatalog({
      fetchImpl: fakeFetch([row('b/no-tools', { tools: false })]),
    })
    expect(await catalog.isToolCapable('b/no-tools')).toBe(false)
    expect(await catalog.isToolCapable('never/heard-of-it')).toBe(false)
  })
})

describe('createModelCatalog — curated jobs', () => {
  it('resolves all three jobs to their first choice when everything is available', async () => {
    const catalog = createModelCatalog({ fetchImpl: fakeFetch(ALL_CURATED.map(id => row(id))) })
    const curated = await catalog.curated()
    expect(curated.map(job => job.id)).toEqual(JOB_IDS)
    for (const job of curated) {
      expect(job.model).toBe(CURATED_CHAINS[job.id].chain[0])
      expect(job.fellBack).toBe(false)
    }
  })

  it('labels the job, never the internal tier id or a model id', async () => {
    // "fast/balanced/deep" are our engineering words; the picker must describe
    // the work instead. (A blurb may still use "fastest" as ordinary English —
    // what matters is that the *label* is not the tier id and no model id leaks.)
    const catalog = createModelCatalog({ fetchImpl: fakeFetch(ALL_CURATED.map(id => row(id))) })
    for (const job of await catalog.curated()) {
      expect(JOB_IDS).not.toContain(job.label.toLowerCase())
      expect(job.label).not.toContain('/')
      expect(job.blurb).not.toContain('/')
      expect(job.label.length).toBeGreaterThan(0)
      expect(job.blurb.length).toBeGreaterThan(0)
      // The resolved id is data for the client, never shown as the label.
      expect(job.label).not.toBe(job.model)
    }
  })

  it('falls back down the chain and flags it when the first choice is missing', async () => {
    const chain = CURATED_CHAINS.balanced.chain
    // Everything available except balanced's first choice.
    const rows = ALL_CURATED.filter(id => id !== chain[0]).map(id => row(id))
    const logs: string[] = []
    const catalog = createModelCatalog({ fetchImpl: fakeFetch(rows), log: m => logs.push(m) })
    const balanced = (await catalog.curated()).find(job => job.id === 'balanced')!
    expect(balanced.model).toBe(chain[1])
    expect(balanced.fellBack).toBe(true)
    expect(logs.some(line => line.includes('balanced') && line.includes(chain[1]))).toBe(true)
  })

  it('skips a first choice that is present but not tool-capable', async () => {
    const chain = CURATED_CHAINS.deep.chain
    const rows = ALL_CURATED.map(id => row(id, { tools: id !== chain[0] }))
    const catalog = createModelCatalog({ fetchImpl: fakeFetch(rows) })
    const deep = (await catalog.curated()).find(job => job.id === 'deep')!
    expect(deep.model).toBe(chain[1])
    expect(deep.fellBack).toBe(true)
  })
})

describe('createModelCatalog — caching and degradation', () => {
  it('serves two calls inside the TTL from one upstream fetch', async () => {
    const counter = { calls: 0 }
    const catalog = createModelCatalog({
      fetchImpl: fakeFetch([row('a/one')], counter),
      ttlMs: 60_000,
      now: () => 1_000,
    })
    await catalog.toolCapable()
    await catalog.toolCapable()
    expect(counter.calls).toBe(1)
  })

  it('refetches once the TTL has elapsed', async () => {
    const counter = { calls: 0 }
    let clock = 1_000
    const catalog = createModelCatalog({
      fetchImpl: fakeFetch([row('a/one')], counter),
      ttlMs: 5_000,
      now: () => clock,
    })
    await catalog.toolCapable()
    clock += 6_000
    await catalog.toolCapable()
    expect(counter.calls).toBe(2)
  })

  it('coalesces concurrent misses into one upstream fetch', async () => {
    const counter = { calls: 0 }
    const catalog = createModelCatalog({ fetchImpl: fakeFetch([row('a/one')], counter) })
    await Promise.all([catalog.toolCapable(), catalog.toolCapable(), catalog.toolCapable()])
    expect(counter.calls).toBe(1)
  })

  it('serves stale rows when a later fetch fails, rather than emptying the picker', async () => {
    let fail = false
    let clock = 1_000
    const fetchImpl = (async () => {
      if (fail) throw new Error('network down')
      return { ok: true, status: 200, json: async () => catalogBody([row('a/one')]) } as unknown as Response
    }) as unknown as typeof fetch
    const catalog = createModelCatalog({ fetchImpl, ttlMs: 1_000, now: () => clock })
    expect((await catalog.toolCapable()).map(m => m.id)).toEqual(['a/one'])
    fail = true
    clock += 5_000
    expect((await catalog.toolCapable()).map(m => m.id)).toEqual(['a/one'])
  })

  it('falls back to the curated allowlist for isToolCapable when the feed is unreachable', async () => {
    // A transient outage must not lock a user out of a model we already trust.
    const fetchImpl = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    const catalog = createModelCatalog({ fetchImpl })
    expect(await catalog.isToolCapable(CURATED_CHAINS.balanced.chain[0])).toBe(true)
    expect(await catalog.isToolCapable('some/unknown-model')).toBe(false)
  })

  it('keeps the first choice (not a fabricated fallback) when the feed is down', async () => {
    const fetchImpl = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    const catalog = createModelCatalog({ fetchImpl })
    for (const job of await catalog.curated()) {
      expect(job.model).toBe(CURATED_CHAINS[job.id].chain[0])
      expect(job.fellBack).toBe(false)
    }
  })

  it('treats an empty catalog response as a failure and serves stale', async () => {
    let empty = false
    let clock = 0
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      json: async () => catalogBody(empty ? [] : [row('a/one')]),
    })) as unknown as typeof fetch
    const catalog = createModelCatalog({ fetchImpl, ttlMs: 100, now: () => clock })
    await catalog.toolCapable()
    empty = true
    clock += 500
    expect((await catalog.toolCapable()).map(m => m.id)).toEqual(['a/one'])
  })
})
