/**
 * Model catalog for the agent harness.
 *
 * Two jobs:
 *
 * 1. **Tool capability.** The harness is a tool-calling loop, so a model that
 *    cannot call tools does not degrade gracefully — it silently breaks the
 *    whole thing. Every id we hand to the loop must be tool-capable.
 * 2. **Curated jobs.** Users pick a *job* ("quick changes", "most work",
 *    "hard problems"), never a model id. Each job resolves through an ordered
 *    fallback chain so a model disappearing from OpenRouter's feed degrades to
 *    the next choice instead of erroring.
 *
 * Capability is decided two different ways on purpose. The curated chains are a
 * hand-maintained allowlist, because a wildcard rule would silently admit a
 * future non-tool variant of a name we trust. The *advanced* catalog is filtered
 * by the live feed's `supported_parameters`, because hand-maintaining 274 rows is
 * not possible. Verified against https://openrouter.ai/api/v1/models on
 * 2026-07-27: all 342 rows carry `supported_parameters`, 274 include `tools`,
 * and every id in CURATED_CHAINS below is present and tool-capable.
 */

/** A normalized catalog row. Prices are USD per token, as OpenRouter reports them. */
export type CatalogModel = {
  id: string
  label: string
  provider: string
  contextLength: number
  promptPrice: number
  completionPrice: number
  tools: boolean
}

/** Internal tier ids. These are *our* engineering words — the UI shows the job
 * label instead, so "fast/balanced/deep" must never reach a user-facing string. */
export type JobId = 'fast' | 'balanced' | 'deep'

export type CuratedJob = {
  id: JobId
  /** User-facing name. Describes the work, not the model. */
  label: string
  /** One line of consequence, in the founder's terms. The tradeoff a user
   * actually feels is budget, not speed — so say that. */
  blurb: string
  /** The id this job resolved to against the live catalog. */
  model: string
  /** True when the first choice in the chain was unavailable. Surfaced so the
   * UI can attribute what actually ran — silent substitution destroys trust. */
  fellBack: boolean
}

/**
 * Ordered preference chains. First available tool-capable id wins.
 *
 * Grounded in live pricing (per 1M tokens, in/out) on 2026-07-27:
 *   qwen/qwen3.6-35b-a3b        $0.14 / $1.00   262k ctx
 *   meta-llama/llama-4-maverick $0.20 / $0.80   1.05M ctx
 *   google/gemini-3.5-flash     $1.50 / $9.00   1.05M ctx
 *   anthropic/claude-sonnet-4.6 $3.00 / $15.00  1M ctx
 *   openai/gpt-5.5              $5.00 / $30.00  1.05M ctx
 */
export const CURATED_CHAINS: Record<JobId, { label: string; blurb: string; chain: string[] }> = {
  fast: {
    label: 'Quick changes',
    blurb: 'Fastest, and easiest on your monthly budget. Good for small edits.',
    chain: ['qwen/qwen3.6-35b-a3b', 'meta-llama/llama-4-maverick', 'google/gemini-3.5-flash'],
  },
  balanced: {
    label: 'Most work',
    blurb: 'The default. Strong at writing and fixing app code.',
    chain: ['anthropic/claude-sonnet-4.6', 'google/gemini-3.5-flash', 'openai/gpt-5.5'],
  },
  deep: {
    label: 'Hard problems',
    blurb: 'Slower, and uses more of your monthly budget. For tricky bugs and big rewrites.',
    chain: ['openai/gpt-5.5', 'anthropic/claude-sonnet-4.6', 'google/gemini-3.5-flash'],
  },
}

export const DEFAULT_JOB: JobId = 'balanced'
export const JOB_IDS: JobId[] = ['fast', 'balanced', 'deep']

/** Last-resort model when the live feed is unreachable entirely. Matches the
 * free tier's existing default (`server/src/tiers.ts`), which the 2026-07-27
 * spike confirmed is tool-capable — so the harness still works offline-ish. */
export const FALLBACK_MODEL = 'qwen/qwen3.6-35b-a3b'

const CATALOG_URL = 'https://openrouter.ai/api/v1/models'
const DEFAULT_TTL_MS = 5 * 60_000

function num(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/**
 * Normalize OpenRouter's `/api/v1/models` payload. Skips malformed rows rather
 * than throwing — one bad row must not blank the picker. Derives the provider
 * from the id prefix and strips OpenRouter's "Anthropic: " name prefix.
 *
 * `openrouter/*` meta-router pseudo-models are dropped: their advertised
 * capabilities are the union of a routing pool rather than a fact about the
 * model that will actually run, which is exactly the wrong input to a
 * tool-capability gate.
 */
export function normalizeModels(data: unknown): CatalogModel[] {
  if (!Array.isArray(data)) return []
  const out: CatalogModel[] = []
  const seen = new Set<string>()
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as Record<string, any>
    if (typeof row.id !== 'string' || !row.id) continue
    const provider = row.id.split('/')[0] ?? ''
    if (provider === 'openrouter') continue
    if (seen.has(row.id)) continue
    seen.add(row.id)
    const rawName = typeof row.name === 'string' && row.name ? row.name : row.id
    const params = Array.isArray(row.supported_parameters) ? row.supported_parameters : []
    out.push({
      id: row.id,
      label: rawName.replace(/^[^:]+:\s*/, ''),
      provider,
      contextLength: num(row.context_length),
      promptPrice: num(row.pricing?.prompt),
      completionPrice: num(row.pricing?.completion),
      tools: params.includes('tools'),
    })
  }
  return out
}

export type ModelCatalog = {
  /** Tool-capable rows only, for the advanced picker. Empty when the feed is down. */
  toolCapable(): Promise<CatalogModel[]>
  /** Resolve all three jobs against the live catalog. */
  curated(): Promise<CuratedJob[]>
  /** Is this id safe to hand to the loop? */
  isToolCapable(id: string): Promise<boolean>
}

export function createModelCatalog(opts: {
  fetchImpl?: typeof fetch
  ttlMs?: number
  now?: () => number
  log?: (message: string) => void
} = {}): ModelCatalog {
  const fetchImpl = opts.fetchImpl ?? fetch
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
  const now = opts.now ?? (() => Date.now())

  let cache: CatalogModel[] | null = null
  let cachedAt = 0
  let inFlight: Promise<CatalogModel[]> | null = null

  async function load(): Promise<CatalogModel[]> {
    if (cache && now() - cachedAt < ttlMs) return cache
    // Coalesce concurrent misses so a burst of requests is one upstream fetch.
    if (inFlight) return inFlight
    inFlight = (async () => {
      try {
        const response = await fetchImpl(CATALOG_URL)
        if (!response.ok) throw new Error(`catalog fetch failed (${response.status})`)
        const body = (await response.json()) as { data?: unknown }
        const models = normalizeModels(body.data)
        if (models.length === 0) throw new Error('catalog returned no usable rows')
        cache = models
        cachedAt = now()
        return models
      } catch (error) {
        opts.log?.(`model catalog unavailable: ${String(error)}`)
        // Serve stale rather than nothing — a picker that empties on a blip is
        // worse than one showing last-known-good models.
        return cache ?? []
      } finally {
        inFlight = null
      }
    })()
    return inFlight
  }

  return {
    async toolCapable() {
      return (await load()).filter(model => model.tools)
    },

    async curated() {
      const models = await load()
      const capable = new Map(models.filter(m => m.tools).map(m => [m.id, m]))
      return JOB_IDS.map(id => {
        const spec = CURATED_CHAINS[id]
        const index = spec.chain.findIndex(candidate => capable.has(candidate))
        // Feed down (capable empty) → keep the first choice rather than
        // reporting a fallback we never verified. FALLBACK_MODEL covers the
        // impossible case of an empty chain so this can never yield undefined.
        const resolved = (index === -1 ? spec.chain[0] : spec.chain[index]) ?? FALLBACK_MODEL
        const fellBack = index > 0
        if (fellBack) {
          opts.log?.(`curated job ${id}: ${spec.chain[0]} unavailable, using ${resolved}`)
        }
        return { id, label: spec.label, blurb: spec.blurb, model: resolved, fellBack }
      })
    },

    async isToolCapable(id) {
      const models = await load()
      // Feed down: fall back to the curated allowlist so a transient outage
      // cannot lock a user out of a model we already trust.
      if (models.length === 0) {
        return JOB_IDS.some(job => CURATED_CHAINS[job].chain.includes(id))
      }
      return models.some(model => model.id === id && model.tools)
    },
  }
}
