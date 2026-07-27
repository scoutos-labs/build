import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import type { Db, UserRow } from './db.js'
import type { KeyCrypto } from './key-crypto.js'
import type { OpenRouterClient } from './openrouter.js'
import {
  adaptLegacyPatches,
  buildModelMessages,
  buildToolModeMessages,
  extractJson,
  type AgentRequestBody,
  type ProjectFile,
  type StepRequestBody,
} from './prompt.js'
import {
  CLIENT_TOOL_SPECS,
  GATED_TOOLS,
  MAX_CALLS_PER_STEP,
  MSG_TAINTED_TURN,
  SERVER_INLINE_TOOLS,
  STEP_BUDGET_NUDGE,
  WEB_TOOL_SPECS,
} from './agent-tools.js'
import { guardWebContent, injectionLabel } from './injection-guard.js'
import { safeHttp, type SafeHttpResult } from './safe-http.js'
import { webFetch, webSearch } from './web-search.js'
import type { ProviderToolCall } from './openrouter.js'

/**
 * Run a server-owned read tool and turn it into a tool message.
 *
 * Every web read goes through `guardWebContent`, which is the single choke point
 * where hostile page text is sanitized, scanned, and wrapped as untrusted data.
 * The trail summary carries only a fixed content-free label — never page text,
 * or an injection attempt would be re-displayed to the user verbatim.
 */
async function executeServerTool(
  call: ProviderToolCall,
  deps: AppDeps,
): Promise<{ content: string; step: { name: string; summary: string; warn?: string } }> {
  let args: Record<string, unknown> = {}
  try {
    args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>
  } catch {
    return {
      content: 'Those arguments were not valid JSON. Send a JSON object.',
      step: { name: call.function.name, summary: 'Sent a malformed request' },
    }
  }

  if (call.function.name === 'web_search') {
    const query = typeof args.query === 'string' ? args.query : ''
    const result = await (deps.webSearchImpl ?? webSearch)(query, args.count)
    if (!result.ok) {
      return { content: result.content, step: { name: 'web_search', summary: 'Could not search the web' } }
    }
    // Titles and snippets are attacker-authored too — a result set gets the same
    // sanitize/scan/wrap treatment as a page body.
    const guarded = guardWebContent(result.content, `search: ${query.slice(0, 60)}`)
    const warn = injectionLabel(guarded.findings)
    return {
      content: guarded.content,
      step: {
        name: 'web_search',
        summary: `Searched the web for “${query.slice(0, 60)}”`,
        ...(warn ? { warn } : {}),
      },
    }
  }

  const url = typeof args.url === 'string' ? args.url : ''
  const fetched = await (deps.webFetchImpl ?? webFetch)(url)
  if (!fetched.ok) {
    return {
      content: fetched.content,
      step: { name: 'web_fetch', summary: `Could not read ${hostOf(url)}` },
    }
  }
  const guarded = guardWebContent(fetched.content, url)
  const warn = injectionLabel(guarded.findings)
  return {
    content: guarded.content,
    step: { name: 'web_fetch', summary: `Read ${hostOf(url)}`, ...(warn ? { warn } : {}) },
  }
}

/** Host only, for trail copy — a full URL reads as noise in chat. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return 'that page'
  }
}

/**
 * What the user is shown before anything is sent.
 *
 * The whole request — method, URL, and the exact body — because an approval card
 * that summarizes is an approval card that hides something.
 */
function describeApproval(call: ProviderToolCall, webRead: boolean) {
  let args: Record<string, unknown> = {}
  try {
    args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>
  } catch {
    /* shown as an empty request below */
  }
  const url = typeof args.url === 'string' ? args.url : ''
  const body = typeof args.body === 'string' ? args.body : ''
  const method = typeof args.method === 'string' ? args.method.toUpperCase() : 'POST'
  const contentType = typeof args.content_type === 'string' ? args.content_type : 'application/json'
  return {
    toolCallId: call.id,
    tool: 'web_post',
    url,
    method,
    body,
    contentType,
    title: `Send data to ${hostOf(url)}?`,
    // Refused up front rather than at send time, so the user is never shown a
    // card for something that cannot go through.
    blocked: webRead ? MSG_TAINTED_TURN : '',
  }
}
import { checkSubdomain, packageProject } from './publish.js'
import type { AgentRateLimiters, RateLimiter } from './rate-limit.js'
import type { ScoutLiveClient } from './scoutlive.js'
import { normalizeTier, tierConfig } from './tiers.js'
import { DEFAULT_JOB, type ModelCatalog } from './models.js'
import { maxStepsForTier, type StepTokens } from './step-token.js'

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
  scoutlive: ScoutLiveClient
  keyCrypto: KeyCrypto
  rateLimiter: RateLimiter
  /**
   * Harness dependencies. Optional so the single-shot `/api/agent` surface (and
   * its existing tests) keep working untouched: when absent, the model and
   * step-token routes report themselves unconfigured rather than 500ing.
   */
  models?: ModelCatalog
  stepTokens?: StepTokens
  /** Separate ceilings for turn-starts vs. continuation steps. Falls back to
   * `rateLimiter` for both when absent. */
  agentLimiters?: AgentRateLimiters
  /** Set false to withhold the web tools entirely (they need the SSRF guard and
   * an authenticated caller, so they are managed-mode only). */
  webTools?: boolean
  /** Test seams for the server-owned tools. */
  webSearchImpl?: (query: unknown, count: unknown) => Promise<{ ok: boolean; content: string }>
  webFetchImpl?: (url: unknown) => Promise<{ ok: boolean; content: string }>
  safeHttpImpl?: (
    url: string,
    method: string,
    options?: { body?: string; contentType?: string },
  ) => Promise<SafeHttpResult>
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

function isFileList(value: unknown): value is ProjectFile[] {
  return (
    Array.isArray(value) &&
    value.every(f => typeof f?.path === 'string' && typeof f?.content === 'string')
  )
}

function isValidStepBody(body: unknown): body is StepRequestBody {
  if (!body || typeof body !== 'object') return false
  const c = body as Partial<StepRequestBody>
  return (
    typeof c.turnId === 'string' &&
    c.turnId.length > 0 &&
    typeof c.stepIndex === 'number' &&
    Number.isInteger(c.stepIndex) &&
    c.stepIndex >= 0 &&
    Array.isArray(c.tree) &&
    c.tree.every(entry => typeof entry?.path === 'string' && typeof entry?.bytes === 'number') &&
    isFileList(c.fullFiles) &&
    Array.isArray(c.messages) &&
    c.messages.every(
      m => (m?.role === 'user' || m?.role === 'assistant') && typeof m?.content === 'string',
    ) &&
    Array.isArray(c.toolResults) &&
    c.toolResults.every(
      r => typeof r?.toolCallId === 'string' && typeof r?.content === 'string',
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

  /**
   * One step of the agent harness.
   *
   * Stateless by design. The browser drives the loop (it owns the WebContainer,
   * so `fs_*` and `exec` execute there) and carries the transcript in the request
   * body. That keeps Build's "anonymous, local-first" promise intact: the server
   * sees project bytes transiently, exactly as it already does for `/api/agent`,
   * and persists nothing new. A server-side transcript store would mean Build's
   * server holds users' source code.
   *
   * The bound on a client-driven loop is the step token (HMAC over stepIndex)
   * plus the split rate limiter — and, honestly, the per-user OpenRouter key's
   * monthly limit, which is the only hard ceiling on spend.
   */
  app.post('/api/agent/step', async c => {
    const auth = await authenticate(c)
    if (!auth) return c.json(errorBody('unauthorized', 'Missing or invalid session token'), 401)
    if (!deps.stepTokens) return c.json(errorBody('not_configured', 'Agent harness unavailable'), 503)

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
    if (!isValidStepBody(parsed)) {
      return c.json(errorBody('bad_request', 'Body must include turnId, stepIndex, tree, fullFiles, messages'), 400)
    }
    const body = parsed

    // Turn-starts and continuation steps have separate ceilings: one turn is up
    // to MAX_TOOL_STEPS requests, so a single limiter would 429 the user's
    // second turn within a minute.
    const limiters = deps.agentLimiters
    const limiter = limiters
      ? body.stepIndex === 0
        ? limiters.turns
        : limiters.steps
      : deps.rateLimiter
    if (!limiter.check(auth.userId)) {
      return c.json(errorBody('rate_limited', 'Too many requests; try again in a minute'), 429)
    }

    const maxSteps = maxStepsForTier(auth.tier)
    if (body.stepIndex > 0) {
      const verdict = deps.stepTokens.verify(body.stepToken ?? '', { maxSteps })
      if (!verdict.ok) {
        if (verdict.reason === 'budget_exceeded') {
          return c.json(errorBody('step_budget_exceeded', 'This turn used its step budget'), 400)
        }
        return c.json(errorBody('unauthorized', 'Invalid or expired step token'), 401)
      }
      // A token minted for one user must not drive another user's turn.
      if (verdict.claims.userId !== auth.userId || verdict.claims.turnId !== body.turnId) {
        return c.json(errorBody('unauthorized', 'Step token does not match this turn'), 401)
      }
    }
    if (body.stepIndex >= maxSteps) {
      return c.json(errorBody('step_budget_exceeded', 'This turn used its step budget'), 400)
    }

    let user: UserRow
    try {
      user = await loadOrProvisionUser(deps, auth)
    } catch (error) {
      deps.log?.(`provisioning failed for ${auth.userId}: ${String(error)}`)
      return c.json(errorBody('provisioning_failed', 'Could not provision account'), 503)
    }
    if (user.disabled) return c.json(errorBody('payment_failed', 'Account is disabled'), 402)

    // Web tools exist only here: they need the SSRF guard, a server-held search
    // key, and an authenticated caller. BYOK gets the fs/exec loop and is never
    // told these exist.
    const webTools = deps.webTools !== false
    const modelMessages = buildToolModeMessages(body, { webTools })
    const promptChars = modelMessages.reduce((total, m) => total + m.content.length, 0)
    // Over budget mid-turn, forcing a final answer beats 413-ing: the work
    // already done is not thrown away, and the user gets a usable reply.
    const overBudget = promptChars > MAX_PROMPT_CHARS
    if (overBudget) {
      modelMessages.push({ role: 'system', content: STEP_BUDGET_NUDGE })
    }
    const lastStep = body.stepIndex + 1 >= maxSteps
    if (lastStep && !overBudget) {
      modelMessages.push({ role: 'system', content: STEP_BUDGET_NUDGE })
    }

    const apiKey = deps.keyCrypto.decrypt(user.or_key_enc)

    // Once anything has been read from the web this turn, web_post is gone.
    // Carried by the client across steps because the server holds no turn state.
    let webRead = body.webRead === true

    const offeredTools = () => {
      // Offering no tools on the final step is what makes the nudge binding
      // rather than advisory.
      if (lastStep || overBudget) return []
      const web = webTools ? WEB_TOOL_SPECS.filter(spec => !(webRead && spec.function.name === 'web_post')) : []
      return [...CLIENT_TOOL_SPECS, ...web]
    }

    /**
     * Server-owned read tools run inline and loop again in the same request, so
     * a search-then-read never costs the browser a round trip. Capped, because
     * one HTTP request must not become an unbounded chain of model calls.
     */
    const INNER_CAP = 4
    let result = await deps.openrouter.toolCompletion({
      apiKey,
      model: user.model,
      messages: modelMessages,
      tools: offeredTools(),
      maxCalls: MAX_CALLS_PER_STEP,
    })
    const serverSteps: { name: string; summary: string; warn?: string }[] = []
    /**
     * The inline calls and their results, echoed back so the NEXT step still has
     * them. Without this a page the agent just read vanishes when the step ends:
     * `buildToolModeMessages` rebuilds from the request body, which knows nothing
     * about the server's local message list — so the model would re-fetch what it
     * already has, on a turn whose taint flag has already cost it web_post.
     */
    const inlineCalls: ProviderToolCall[] = []
    const inlineResults: { toolCallId: string; name: string; content: string }[] = []

    for (let inner = 0; inner < INNER_CAP; inner++) {
      if (result.kind !== 'ok') break
      const runnableHere = result.toolCalls.filter(call => SERVER_INLINE_TOOLS.has(call.function.name))
      if (runnableHere.length === 0) break

      modelMessages.push({ role: 'assistant', content: result.content, tool_calls: result.toolCalls })
      for (const call of result.toolCalls) {
        if (!SERVER_INLINE_TOOLS.has(call.function.name)) {
          // Every emitted call needs an answering tool message or the provider
          // rejects the next request; client tools are resolved by the browser,
          // so tell the model that is what is happening.
          modelMessages.push({
            role: 'tool',
            content: 'Deferred: this runs in the browser and its result arrives next step.',
            tool_call_id: call.id,
          })
          continue
        }
        const executed = await executeServerTool(call, deps)
        webRead = true
        serverSteps.push(executed.step)
        modelMessages.push({ role: 'tool', content: executed.content, tool_call_id: call.id })
        inlineCalls.push(call)
        inlineResults.push({
          toolCallId: call.id,
          name: call.function.name,
          content: executed.content,
        })
      }
      result = await deps.openrouter.toolCompletion({
        apiKey,
        model: user.model,
        messages: modelMessages,
        tools: offeredTools(),
        maxCalls: MAX_CALLS_PER_STEP,
      })
    }

    if (result.kind === 'budget_exhausted') return c.json(budgetExhaustedBody(), 402)
    if (result.kind === 'error') {
      deps.log?.(`openrouter step error for ${auth.userId}: ${result.status} ${result.message}`)
      return c.json(errorBody('upstream_error', 'Model call failed'), 502)
    }

    // A model answering in the old JSON envelope is decoded into one synthetic
    // fs_batch_write rather than failing the turn — one write path, no second
    // protocol. See adaptLegacyPatches.
    let toolCalls = result.toolCalls
    let assistantContent = result.content
    let usedLegacyAdapter = false
    if (toolCalls.length === 0 && assistantContent) {
      const adapted = adaptLegacyPatches(assistantContent, `${body.turnId}-${body.stepIndex}-legacy`)
      if (adapted && adapted.toolCalls.length > 0) {
        toolCalls = adapted.toolCalls
        assistantContent = adapted.reply
        usedLegacyAdapter = true
        deps.log?.(`legacy patch envelope adapted for ${auth.userId} at step ${body.stepIndex}`)
      }
    }

    // web_post never reaches the client as a runnable call: the browser cannot
    // execute it. It comes back as an approval request the chat renders.
    const approval = toolCalls.find(call => GATED_TOOLS.has(call.function.name))
    const clientCalls = toolCalls.filter(call => !GATED_TOOLS.has(call.function.name))

    return c.json({
      toolCalls: clientCalls,
      // Everything the model emitted, including the gated call. The client
      // echoes THIS back as the assistant `tool_calls` on the next step:
      // answering a call the provider never saw requested is a 400, and it
      // would land after the POST had already gone out.
      transcriptCalls: [...inlineCalls, ...toolCalls],
      // Answers for the inline calls above, so the client can echo the pair and
      // the model keeps what it read.
      serverToolResults: inlineResults,
      approval: approval ? describeApproval(approval, webRead) : null,
      serverSteps,
      assistantContent,
      done: clientCalls.length === 0 && !approval,
      usedLegacyAdapter,
      webRead,
      stepToken: deps.stepTokens.issue({
        userId: auth.userId,
        turnId: body.turnId,
        stepIndex: body.stepIndex + 1,
      }),
      maxToolSteps: maxSteps,
    })
  })

  /**
   * Execute an approved `web_post`.
   *
   * Separate from the step endpoint because approval is a *user* action with its
   * own round trip: the chat shows the exact URL and body, the user clicks, and
   * only then does anything leave the server. The taint rule is re-checked here
   * rather than trusted from the client — a client that "forgot" it had read the
   * web must not be able to unlock the write.
   */
  app.post('/api/agent/tool/web_post', async c => {
    const auth = await authenticate(c)
    if (!auth) return c.json(errorBody('unauthorized', 'Missing or invalid session token'), 401)
    if (deps.webTools === false) {
      return c.json(errorBody('not_configured', 'Web tools are unavailable'), 503)
    }
    if (!deps.rateLimiter.check(auth.userId)) {
      return c.json(errorBody('rate_limited', 'Too many requests; try again in a minute'), 429)
    }

    let body: { url?: unknown; method?: unknown; body?: unknown; contentType?: unknown; webRead?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json(errorBody('bad_request', 'Body must be JSON'), 400)
    }
    if (body.webRead === true) {
      return c.json(errorBody('tainted_turn', MSG_TAINTED_TURN), 400)
    }
    const url = typeof body.url === 'string' ? body.url : ''
    const payload = typeof body.body === 'string' ? body.body : ''
    if (!url || !payload) {
      return c.json(errorBody('bad_request', 'web_post needs a url and a body'), 400)
    }
    const method = typeof body.method === 'string' ? body.method.toUpperCase() : 'POST'
    if (!['POST', 'PUT', 'PATCH'].includes(method)) {
      return c.json(errorBody('bad_request', 'Method must be POST, PUT, or PATCH'), 400)
    }

    const sent = await (deps.safeHttpImpl ?? safeHttp)(url, method, {
      body: payload,
      contentType: typeof body.contentType === 'string' ? body.contentType : 'application/json',
    })
    // The POST target's response is model-bound content from a host the model
    // chose, so it is guarded exactly like a page read.
    const guarded = guardWebContent(sent.content, url)
    return c.json({
      ok: sent.ok,
      content: guarded.content,
      warn: injectionLabel(guarded.findings),
    })
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

  type PublishBody = { projectId: string; subdomain: string; files: ProjectFile[] }
  function isValidPublishBody(body: unknown): body is PublishBody {
    if (!body || typeof body !== 'object') return false
    const candidate = body as Partial<PublishBody>
    return (
      typeof candidate.projectId === 'string' &&
      candidate.projectId.length > 0 &&
      typeof candidate.subdomain === 'string' &&
      Array.isArray(candidate.files) &&
      candidate.files.length > 0 &&
      candidate.files.every(f => typeof f?.path === 'string' && typeof f?.content === 'string')
    )
  }

  app.post('/api/publish', async c => {
    const auth = await authenticate(c)
    if (!auth) return c.json(errorBody('unauthorized', 'Missing or invalid session token'), 401)

    if (!deps.rateLimiter.check(auth.userId)) {
      return c.json(errorBody('rate_limited', 'Too many requests; try again in a minute'), 429)
    }

    const declaredLength = Number(c.req.header('content-length') ?? '0')
    if (declaredLength > MAX_BODY_BYTES) {
      return c.json(errorBody('payload_too_large', 'Project exceeds the 2MB publish limit — remove large assets'), 413)
    }
    const rawBody = await c.req.text()
    if (rawBody.length > MAX_BODY_BYTES) {
      return c.json(errorBody('payload_too_large', 'Project exceeds the 2MB publish limit — remove large assets'), 413)
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(rawBody)
    } catch {
      return c.json(errorBody('bad_request', 'Body must be JSON'), 400)
    }
    if (!isValidPublishBody(parsed)) {
      return c.json(errorBody('bad_request', 'Body must include projectId, subdomain, files'), 400)
    }

    // Republish targets the recorded subdomain so the URL stays stable; the
    // body subdomain only names a first deploy.
    const existing = await deps.db.getDeployment(auth.userId, parsed.projectId)
    const check = checkSubdomain(existing?.subdomain ?? parsed.subdomain)
    if (!check.ok) {
      return c.json(
        check.reason === 'reserved'
          ? errorBody('reserved_subdomain', 'That subdomain is reserved by the platform')
          : errorBody('invalid_subdomain', 'Subdomain must be 1-63 chars, lowercase letters, digits, and inner hyphens'),
        400,
      )
    }

    const keyEnc = await deps.db.getCredential(auth.userId, 'scoutos')
    if (!keyEnc) {
      return c.json(errorBody('no_scoutos_key', 'Add your ScoutOS API key in settings before publishing'), 400)
    }

    let tarGz: Buffer
    try {
      tarGz = packageProject(parsed.files)
    } catch (error) {
      deps.log?.(`packaging failed for ${auth.userId}/${parsed.projectId}: ${String(error)}`)
      return c.json(errorBody('bad_request', 'Project could not be packaged'), 400)
    }

    const result = await deps.scoutlive.deploy({
      apiKey: deps.keyCrypto.decrypt(keyEnc),
      subdomain: check.subdomain,
      tarGz,
      code: existing?.publish_code_enc ? deps.keyCrypto.decrypt(existing.publish_code_enc) : undefined,
    })

    switch (result.kind) {
      case 'accepted':
        await deps.db.upsertDeployment({
          clerkUserId: auth.userId,
          projectId: parsed.projectId,
          subdomain: check.subdomain,
          lastBuildId: result.buildId,
        })
        return c.json({ buildId: result.buildId, subdomain: check.subdomain })
      case 'subdomain_taken':
        return c.json(errorBody('subdomain_taken', 'That subdomain is taken — pick another name'), 409)
      case 'invalid_code':
        deps.log?.(`publish code rejected for ${auth.userId}/${parsed.projectId} (${check.subdomain})`)
        return c.json(errorBody('publish_code_rejected', 'The platform rejected the stored publish code for this app'), 409)
      case 'rate_limited': {
        if (result.retryAfterSeconds !== null) {
          c.header('Retry-After', String(result.retryAfterSeconds))
        }
        return c.json(errorBody('scoutlive_rate_limited', 'Scout Live deploy limit reached; try again later'), 429)
      }
      case 'error':
        deps.log?.(`scoutlive deploy failed for ${auth.userId}/${parsed.projectId}: ${result.status} ${result.message}`)
        return c.json(errorBody('upstream_error', 'Deploy request to Scout Live failed'), 502)
    }
  })

  // Lets the client skip the subdomain prompt when a project was already
  // published (the publish handler reuses the record regardless).
  app.get('/api/deployments/:projectId', async c => {
    const auth = await authenticate(c)
    if (!auth) return c.json(errorBody('unauthorized', 'Missing or invalid session token'), 401)

    const deployment = await deps.db.getDeployment(auth.userId, c.req.param('projectId'))
    if (!deployment) return c.json(errorBody('not_found', 'Project has not been published'), 404)
    return c.json({ subdomain: deployment.subdomain, url: deployment.last_url ?? null })
  })

  app.get('/api/publish/:buildId', async c => {
    const auth = await authenticate(c)
    if (!auth) return c.json(errorBody('unauthorized', 'Missing or invalid session token'), 401)

    const buildId = c.req.param('buildId')
    // Scoped to the caller's own deployments — unknown build ids 404 rather
    // than proxying arbitrary lookups to the platform.
    const deployment = await deps.db.getDeploymentByBuild(auth.userId, buildId)
    if (!deployment) return c.json(errorBody('not_found', 'No such build'), 404)

    const keyEnc = await deps.db.getCredential(auth.userId, 'scoutos')
    if (!keyEnc) {
      return c.json(errorBody('no_scoutos_key', 'Add your ScoutOS API key in settings before publishing'), 400)
    }

    const result = await deps.scoutlive.getBuildStatus({
      apiKey: deps.keyCrypto.decrypt(keyEnc),
      buildId,
    })
    if (result.kind === 'not_found') return c.json(errorBody('not_found', 'No such build'), 404)
    if (result.kind === 'error') {
      deps.log?.(`scoutlive status failed for ${auth.userId}/${buildId}: ${result.status} ${result.message}`)
      return c.json(errorBody('upstream_error', 'Status request to Scout Live failed'), 502)
    }

    const { build } = result
    if (build.status === 'deployed') {
      // The platform shows publishCode once (first deploy only); persisting
      // it is what makes zero-downtime republish possible.
      await deps.db.recordDeployOutcome({
        clerkUserId: auth.userId,
        projectId: deployment.project_id,
        publishCodeEnc: build.publishCode ? deps.keyCrypto.encrypt(build.publishCode) : undefined,
        lastUrl: build.url,
      })
    }

    // publishCode never leaves the server.
    return c.json({
      buildId,
      status: build.status,
      url: build.url ?? null,
      error: build.error ?? null,
      logs: build.logs ?? null,
    })
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
    // Tool capability is a property of the *harness*, not of billing — surface
    // it so the client can refuse to run the loop rather than degrade silently.
    const toolCapable = deps.models ? await deps.models.isToolCapable(user.model) : false
    return c.json({
      plan: user.tier,
      model: user.model,
      disabled: user.disabled,
      limit: keyInfo.limit,
      usage: keyInfo.usage,
      limitRemaining: keyInfo.limitRemaining,
      toolCapable,
      maxToolSteps: maxStepsForTier(user.tier),
    })
  })

  /**
   * The picker's data. `curated` is what the UI shows by default (three jobs, no
   * model ids); `catalog` backs the advanced disclosure and is already filtered
   * to tool-capable rows, because offering a non-tool model would silently break
   * the harness rather than merely perform worse.
   */
  app.get('/api/models', async c => {
    const auth = await authenticate(c)
    if (!auth) return c.json(errorBody('unauthorized', 'Missing or invalid session token'), 401)
    if (!deps.models) return c.json(errorBody('not_configured', 'Model catalog unavailable'), 503)

    const [curated, catalog] = await Promise.all([
      deps.models.curated(),
      deps.models.toolCapable(),
    ])
    return c.json({ curated, catalog, defaultJob: DEFAULT_JOB })
  })

  app.put('/api/me/model', async c => {
    const auth = await authenticate(c)
    if (!auth) return c.json(errorBody('unauthorized', 'Missing or invalid session token'), 401)
    if (!deps.models) return c.json(errorBody('not_configured', 'Model catalog unavailable'), 503)

    let body: { model?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json(errorBody('bad_request', 'Body must be JSON'), 400)
    }
    const model = typeof body.model === 'string' ? body.model.trim() : ''
    if (!model) return c.json(errorBody('bad_request', 'Body must include a model id'), 400)

    if (!(await deps.models.isToolCapable(model))) {
      return c.json(
        errorBody(
          'model_not_tool_capable',
          "That model can't use tools, so build couldn't read files, run commands, or check its own work.",
        ),
        400,
      )
    }

    // Provision first: a model choice made before the first turn must not be
    // written to a row that does not exist yet.
    try {
      await loadOrProvisionUser(deps, auth)
    } catch (error) {
      deps.log?.(`provisioning failed for ${auth.userId}: ${String(error)}`)
      return c.json(errorBody('provisioning_failed', 'Could not provision account'), 503)
    }
    await deps.db.updateModel(auth.userId, model)
    return c.json({ model })
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
