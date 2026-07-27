import { runNpmInstall } from './webcontainer.mjs'
import { dispatchAgentBudgetExhausted, dispatchAgentFailed, dispatchAgentApprovalRequested, dispatchAgentServerStepRecorded, dispatchAgentStepReturned, dispatchAgentTick, dispatchAgentTimeoutReached, dispatchAgentToolFinished, dispatchAgentToolStarted, dispatchProjectFileApplied, dispatchProjectFileRemoved, dispatchProjectFilesUpdated, dispatchWebContainerLog, dispatchWebContainerRemountRequested } from './runtime_bridge.mjs'

let elapsedTimer = null
let activeController = null
let activeRequestId = null
let activeTimeout = null

/** One turn's worth of context and in-flight transcript, keyed by request id.
 * Deleted on every terminal transition — see finishTurn / abortAgent. */
const turns = new Map()

/** Per-TURN deadline. Before the harness a turn was one request, so this and the
 * old per-request timeout were the same number; under a loop they are not. */
const TURN_DEADLINE_MS = 300_000

/** Tool calls honored from one step. Mirrors the Gleam actor and the server. */
const MAX_CALLS_PER_STEP = 3


async function agentModule() {
  try { return await import('../agent') }
  catch { return { runAgent: async () => ({ reply: 'Agent unavailable outside browser bundle.', patches: [] }) } }
}
function message(error) { return error instanceof Error ? error.message : String(error) }
function gleamListToArray(list) { return Array.isArray(list) ? list : typeof list?.toArray === 'function' ? list.toArray() : [] }
function normalizeFiles(files) { return gleamListToArray(files).map(file => ({ path: file.path, content: file.content })) }
function normalizeMessages(messages) { return gleamListToArray(messages).map(message => ({ role: message.role.constructor.name === 'User' ? 'user' : 'assistant', content: message.content })) }
function normalizeSelectedElement(option) {
  if (!option || option.constructor?.name === 'None') return undefined
  const element = option[0] ?? option.value ?? option.element ?? option
  const tagName = element?.tagName ?? element?.tag_name
  if (!element || !tagName) return undefined
  return {
    tagName,
    id: element.id ?? '',
    classes: gleamListToArray(element.classes),
    textContent: element.textContent ?? element.text_content ?? '',
    outerHTML: element.outerHTML ?? element.outer_html ?? '',
    boundingRect: element.boundingRect ?? element.bounding_rect ?? { x: 0, y: 0, width: 0, height: 0 },
    computedStyles: element.computedStyles ?? Object.fromEntries(gleamListToArray(element.computed_styles)),
  }
}

// Set by registerManagedAgentAuth() in src/managed-auth.ts after the sign-in
// gate. When present, agent calls go to /api/agent with a fresh Clerk token
// per request instead of calling providers directly from the browser.
function managedAuth() {
  return globalThis.__buildManagedAuth ?? null
}

/**
 * Start a turn.
 *
 * The effect that used to make one single-shot call now opens the loop: it
 * records the turn's context (the parts that do not change between steps) and
 * takes step 0. Continuation is `callAgentStep`, driven by the actor once every
 * tool call for a step has reported back.
 *
 * The deadline is per TURN, not per request. Before the harness one turn was one
 * request, so a 300s request timeout and a 300s turn timeout were the same
 * thing; under a 12-step loop a per-request timeout would let a turn run for an
 * hour.
 */
export async function callAgent(requestId, provider, model, userPrompt, apiKey = '', ollamaUrl = '', files, messages, selectedElement, elementComment = '') {
  const controller = new AbortController()
  activeController = controller
  activeRequestId = requestId
  activeTimeout = setTimeout(() => {
    // A turn that outruns the deadline is stopped, not merely aborted: the
    // actor needs the message to render a bubble and reset the lifecycle.
    controller.abort()
    dispatchAgentTimeoutReached(requestId)
  }, TURN_DEADLINE_MS)

  turns.set(requestId, {
    provider,
    model,
    apiKey,
    ollamaUrl,
    userPrompt,
    files: normalizeFiles(files),
    messages: normalizeMessages(messages),
    selectedElement: normalizeSelectedElement(selectedElement),
    elementComment,
    controller,
    toolCalls: [],
    toolResults: [],
    stepToken: undefined,
    // Read the web or write the web, never both in one turn. Carried here
    // because the server keeps no turn state; it re-checks before sending.
    webRead: false,
  })

  await runStep(requestId, 0)
}

/**
 * One step of the turn.
 *
 * Serialized per turn. A step can be triggered from two places at once — the
 * last client tool of a step finishing, and the user resolving a web_post
 * approval from that same step — and two in-flight requests sharing one turn
 * would race `drainToolResults` and clobber each other's `stepToken` and
 * `toolCalls`. The later trigger is queued rather than dropped, so its results
 * still reach the model on the next step.
 */
async function runStep(requestId, stepIndex) {
  const turn = turns.get(requestId)
  if (!turn) return // canceled between steps
  if (turn.inFlight) {
    turn.queuedStep = Math.max(turn.queuedStep ?? 0, stepIndex)
    return
  }
  turn.inFlight = true
  // Results recorded since the last step (tool executions, an approved post).
  if (stepIndex > 0) turn.toolResults = [...turn.toolResults, ...drainToolResults(requestId)]

  try {
    const managed = managedAuth()
    if (!managed) {
      await runByokStep(requestId, stepIndex, turn)
      return
    }

    const { callAgentStep: postStep } = await import('../managed-agent-client')
    const response = await postStep(
      {
        turnId: requestId,
        stepIndex,
        stepToken: turn.stepToken,
        tree: fileTree(),
        fullFiles: alwaysFullFiles(),
        messages: turn.messages,
        toolCalls: turn.toolCalls,
        toolResults: turn.toolResults,
        userPrompt: stepIndex === 0 ? turn.userPrompt : undefined,
        selectedElement: turn.selectedElement,
        elementComment: turn.elementComment,
        webRead: turn.webRead,
      },
      { getToken: managed.getToken, signal: turn.controller.signal },
    )

    turn.stepToken = response.stepToken
    turn.stepIndex = stepIndex
    // Once tainted, a turn stays tainted.
    turn.webRead = turn.webRead || response.webRead === true

    // Server-run reads already happened; show them in the trail so the user
    // sees what the agent looked at, with the injection label when flagged.
    for (const step of response.serverSteps ?? []) {
      // The warning is a fixed content-free label, never page text.
      const summary = step.warn ? `${step.summary} — ${step.warn}` : step.summary
      dispatchAgentServerStepRecorded(requestId, step.name, summary)
    }
    // ACCUMULATE, never replace. A one-step-wide transcript window leaves the
    // model with no memory of what it already did, so it re-decides from the
    // file tree every step and burns the whole budget rediscovering the same
    // thing — measured at 12 steps for work that takes 2.
    //
    // toolCalls carries the FULL emitted set (including a gated web_post),
    // because every tool result sent must have a matching call in this array.
    // toolResults picks up anything the SERVER ran inline, or the model loses
    // the page it just read.
    turn.toolCalls = [...turn.toolCalls, ...(response.transcriptCalls ?? response.toolCalls ?? [])]
    turn.toolResults = [...turn.toolResults, ...(response.serverToolResults ?? [])]

    // A web_post never arrives as a runnable call — the browser cannot send it.
    // It pauses the turn for the user, who sees the exact request.
    if (response.approval) {
      turn.approval = response.approval
      dispatchAgentApprovalRequested(requestId, response.approval)
    }

    dispatchAgentStepReturned(
      requestId,
      (response.toolCalls ?? []).map(call => ({
        id: call.id,
        name: call.function?.name ?? '',
        argsJson: call.function?.arguments ?? '{}',
      })),
      response.assistantContent ?? '',
    )
    if (response.done) finishTurn(requestId)
  } catch (error) {
    if (error?.code === 'budget_exhausted') {
      dispatchAgentBudgetExhausted(requestId, error.resetAt ?? '')
    } else if (error instanceof DOMException && error.name === 'AbortError') {
      // Cancel and timeout already dispatched their own message; a second
      // failure bubble would double-report the same event.
    } else {
      const raw = message(error)
      dispatchAgentFailed(requestId, raw)
      dispatchWebContainerLog(raw)
    }
    finishTurn(requestId)
  } finally {
    turn.inFlight = false
    const queued = turn.queuedStep
    if (queued !== undefined) {
      turn.queuedStep = undefined
      // No-op if the turn ended while this step was running.
      void runStep(requestId, queued)
    }
  }
}

/**
 * One BYOK step.
 *
 * OpenRouter gets the same tool loop as managed mode, driven entirely from the
 * browser — there is no server to hold the key, so the client calls the provider
 * and assembles the transcript itself. The step budget is enforced by the actor
 * (there is no step token to enforce it with), and no web tools are offered:
 * they need the SSRF guard and a server-held search key.
 *
 * Ollama stays on the single-shot JSON protocol — it forces `format: 'json'`,
 * returns tool-call arguments as an object rather than a JSON string, and
 * exposes no capability metadata, so tool mode there would fail silently.
 */
async function runByokStep(requestId, stepIndex, turn) {
  const agentModuleExports = await agentModule()
  if (turn.provider !== 'openrouter') {
    await runJsonModeTurn(requestId, turn, agentModuleExports)
    return
  }

  const [{ FetchLLMClient }, tools, prompt] = await Promise.all([
    import('../llm-client'),
    import('../agent-tools'),
    import('../agent'),
  ])
  const client = new FetchLLMClient()
  const result = await client.step({
    provider: 'openrouter',
    model: turn.model,
    apiKey: turn.apiKey,
    messages: prompt.buildToolModeMessages({
      files: globalThis.__buildProjectFiles ?? turn.files,
      messages: turn.messages,
      userPrompt: stepIndex === 0 ? turn.userPrompt : undefined,
      selectedElement: turn.selectedElement,
      elementComment: turn.elementComment,
      toolCalls: turn.toolCalls,
      toolResults: turn.toolResults,
    }),
    tools: tools.CLIENT_TOOL_SPECS,
    maxCalls: MAX_CALLS_PER_STEP,
    signal: turn.controller.signal,
  })

  let toolCalls = result.toolCalls
  let content = result.content
  // Same adapter as managed mode: a model answering in the old JSON envelope is
  // decoded into one synthetic fs_batch_write rather than failing the turn.
  if (toolCalls.length === 0 && content) {
    const adapted = adaptLegacyPatches(content, `${requestId}-${stepIndex}-legacy`)
    if (adapted) {
      toolCalls = adapted.toolCalls
      content = adapted.reply
    }
  }

  turn.toolCalls = [...turn.toolCalls, ...toolCalls]
  turn.stepIndex = stepIndex
  dispatchAgentStepReturned(
    requestId,
    toolCalls.map(call => ({
      id: call.id,
      name: call.function?.name ?? '',
      argsJson: call.function?.arguments ?? '{}',
    })),
    content ?? '',
  )
  if (toolCalls.length === 0) finishTurn(requestId)
}

/**
 * Decode a legacy `{reply, patches[]}` answer into one synthetic
 * `fs_batch_write`. Mirrors `adaptLegacyPatches` in server/src/prompt.ts so BYOK
 * keeps exactly one write path too.
 */
function adaptLegacyPatches(content, callId) {
  let parsed
  try {
    const trimmed = String(content).trim()
    const unfenced = trimmed.startsWith('```')
      ? trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim()
      : trimmed
    parsed = JSON.parse(unfenced)
  } catch {
    return null
  }
  if (!Array.isArray(parsed?.patches) || typeof parsed?.reply !== 'string') return null
  const files = parsed.patches.filter(
    patch => patch && typeof patch.path === 'string' && typeof patch.content === 'string',
  )
  if (files.length === 0) return { toolCalls: [], reply: parsed.reply }
  return {
    reply: parsed.reply,
    toolCalls: [
      { id: callId, type: 'function', function: { name: 'fs_batch_write', arguments: JSON.stringify({ files }) } },
    ],
  }
}

/**
 * Ollama's single-shot turn.
 *
 * Its one response is adapted into the SAME synthetic fs_batch_write the tool
 * loop uses, so it goes through identical machinery — touched_paths, pkg_dirty,
 * chips and the build log all populate. Applying patches directly instead left
 * this path with no chips, no story paths, and no install trigger at all.
 */
async function runJsonModeTurn(requestId, turn, agentModuleExports) {
  const result = await agentModuleExports.runAgent({
    provider: turn.provider,
    apiKey: turn.apiKey,
    ollamaUrl: turn.ollamaUrl,
    model: turn.model,
    userPrompt: turn.userPrompt,
    files: turn.files,
    messages: turn.messages,
    selectedElement: turn.selectedElement,
    elementComment: turn.elementComment,
    signal: turn.controller.signal,
  })
  const patches = (result.patches ?? []).filter(
    patch => typeof patch?.path === 'string' && typeof patch?.content === 'string',
  )
  if (patches.length > 0) {
    const callId = `${requestId}-json`
    // Drop the turn FIRST: AgentToolFinished emits CallAgentStep synchronously,
    // and JSON mode has no next step.
    turns.delete(requestId)
    dispatchAgentStepReturned(
      requestId,
      [{ id: callId, name: 'fs_batch_write', argsJson: JSON.stringify({ files: patches }) }],
      result.reply ?? '',
    )
    for (const patch of patches) dispatchProjectFileApplied(patch.path, patch.content)
    const paths = patches.map(patch => patch.path)
    dispatchAgentToolFinished(
      requestId,
      callId,
      true,
      paths.length === 1 ? `Wrote ${paths[0].split('/').pop()}` : `Wrote ${paths.length} files`,
      paths,
      false,
    )
  }
  dispatchAgentStepReturned(requestId, [], result.reply ?? '')
  finishTurn(requestId)
}

/** Everything a finished turn was holding. */
function finishTurn(requestId) {
  clearTurnState(requestId)
  turns.delete(requestId)
  if (activeRequestId === requestId) {
    if (activeTimeout) clearTimeout(activeTimeout)
    activeTimeout = null
    activeController = null
    activeRequestId = null
  }
}

/** Paths + sizes only. Contents reach the model through fs_read, which is what
 * makes a multi-step turn affordable. */
function fileTree() {
  return (globalThis.__buildProjectFiles ?? []).map(file => ({
    path: file.path,
    bytes: file.content.length,
  }))
}

/** The few files worth shipping unasked every step. */
const ALWAYS_FULL = new Set(['package.json', 'BRAIN.md', 'src/db.ts'])

function alwaysFullFiles() {
  return (globalThis.__buildProjectFiles ?? []).filter(file => ALWAYS_FULL.has(file.path))
}

// ── Harness effects ──────────────────────────────────────────────────────────
// The step transport is wired in U4 and the loop in U7a. Tool execution below is
// live: it runs the real executors against the real WebContainer.

// Tool results for the current turn, keyed by request id. This is the only place
// raw tool output lives — Gleam holds summaries and paths, never bodies. Cleared
// on every terminal transition (see clearTurnState).
const toolResults = new Map()

/** The seam between the tool executors and the browser. */
async function toolContext() {
  const wc = await import('./webcontainer.mjs')
  const tools = await import('../agent-tools')
  return {
    tools,
    ctx: {
      // project.files is the source of truth. Snapshotted into globalThis by the
      // runtime bridge so the executors can read it without a Gleam round trip.
      files: () => globalThis.__buildProjectFiles ?? [],
      // The ONLY legal write path — see dispatchProjectFileApplied.
      applyFile: (path, content) => dispatchProjectFileApplied(path, content),
      removeFile: path => dispatchProjectFileRemoved(path),
      readContainerFile: async path => {
        const m = await import('../webcontainer')
        return m.readProjectFile ? m.readProjectFile(path) : undefined
      },
      flushWrites: () => wc.flushContainerWrites(),
      spawn: (command, args) => wc.spawnAgentCommand(command, args),
      log: line => wc.appendRuntimeLog(line),
    },
  }
}

/** Continue a turn. Dispatched by the actor once every tool call for the current
 * step has reported back. */
export function callAgentStep(requestId, step) {
  globalThis.__buildAgentStepCalls = [
    ...(globalThis.__buildAgentStepCalls ?? []),
    { requestId, step },
  ]
  const turn = turns.get(requestId)
  if (!turn) return // canceled, timed out, or already finished
  void runStep(requestId, step)
}

export async function executeTool(requestId, callId, name, argsJson) {
  let result
  try {
    const { tools, ctx } = await toolContext()
    dispatchAgentToolStarted(requestId, callId, `Working on it`)
    result = await tools.runTool(ctx, name, argsJson)
  } catch (error) {
    // A thrown executor must still finish the call, or the step never completes
    // and the turn hangs until the deadline.
    result = { ok: false, content: `Tool failed: ${message(error)}`, summary: 'A step failed' }
  }
  const bucket = toolResults.get(requestId) ?? []
  bucket.push({ toolCallId: callId, name, content: result.content })
  toolResults.set(requestId, bucket)
  dispatchAgentToolFinished(
    requestId,
    callId,
    result.ok,
    result.summary,
    result.paths ?? [],
    result.installed ?? false,
  )
}

/**
 * Send an approved web_post, then continue the turn with its result.
 *
 * The taint flag rides along and is re-checked server-side: a client that
 * "forgot" it had read the web must not be able to unlock the write.
 */
export async function sendApprovedPost(requestId, callId) {
  const turn = turns.get(requestId)
  if (!turn) return
  const approval = turn.approval
  turn.approval = null
  let content = 'Could not send that request.'
  try {
    const managed = managedAuth()
    const token = managed ? await managed.getToken() : null
    const response = await fetch('/api/agent/tool/web_post', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({
        url: approval?.url,
        method: approval?.method,
        body: approval?.body,
        contentType: approval?.contentType,
        webRead: turn.webRead,
      }),
      signal: turn.controller.signal,
    })
    const result = await response.json().catch(() => ({}))
    content = response.ok
      ? String(result.content ?? 'Sent.')
      : String(result?.error?.message ?? 'That request was refused.')
  } catch (error) {
    content = `Could not send that request: ${message(error)}`
  }
  recordToolResult(requestId, callId, 'web_post', content)
  dispatchAgentServerStepRecorded(requestId, 'web_post', 'Sent the request')
  void runStep(requestId, (turn.stepIndex ?? 0) + 1)
}

/** The user said no. The model is still owed a result, or the turn stalls. */
export function declineApprovedPost(requestId, callId) {
  const turn = turns.get(requestId)
  if (!turn) return
  turn.approval = null
  recordToolResult(
    requestId,
    callId,
    'web_post',
    'The user declined to send this request. Do not try again unless they ask; carry on with the rest of the work.',
  )
  dispatchAgentServerStepRecorded(requestId, 'web_post', 'Did not send the request')
  void runStep(requestId, (turn.stepIndex ?? 0) + 1)
}

function recordToolResult(requestId, callId, name, content) {
  const bucket = toolResults.get(requestId) ?? []
  bucket.push({ toolCallId: callId, name, content })
  toolResults.set(requestId, bucket)
}

/**
 * Put the project back to a snapshot.
 *
 * Restores through `dispatchProjectFilesUpdated` (which updates the model and
 * reseeds the agent's file snapshot) and then `dispatchWebContainerRemountRequested`,
 * which is the ONLY remount path that actually carries files —
 * `project.RemountProject` discards its argument at the interpreter and remounts
 * a JS-side cache that may be several turns stale.
 */
export function restoreSnapshot(files) {
  const restored = gleamListToArray(files).map(file => ({
    path: file.path,
    content: file.content,
  }))
  dispatchProjectFilesUpdated(restored, 'Undid the last build')
  dispatchWebContainerRemountRequested(restored)
}

export function killExec() {
  globalThis.__buildAgentKillExecCalls = (globalThis.__buildAgentKillExecCalls ?? 0) + 1
  void import('../agent-tools').then(tools => tools.killExec()).catch(() => {})
}

export function installDependencies() {
  globalThis.__buildAgentInstallCalls = (globalThis.__buildAgentInstallCalls ?? 0) + 1
  void runNpmInstall()
}

/** Take and clear the tool results accumulated for a turn's current step. */
function drainToolResults(requestId) {
  const bucket = toolResults.get(requestId) ?? []
  toolResults.set(requestId, [])
  return bucket
}

/** Drop everything a finished turn was holding. Called on every terminal
 * transition — success, failure, cancel, timeout, project new/open/reset — so a
 * transcript never outlives its turn. */
export function clearTurnState(requestId) {
  if (requestId) {
    toolResults.delete(requestId)
    turns.delete(requestId)
  } else {
    toolResults.clear()
    turns.clear()
  }
}

/** Test seam: no turn state may survive a terminal transition. */
export function pendingTurnCount() {
  return Math.max(toolResults.size, turns.size)
}

export function startElapsedTimer() {
  stopElapsedTimer()
  elapsedTimer = setInterval(() => { if (activeRequestId) dispatchAgentTick(Date.now()) }, 500)
}
export function stopElapsedTimer() { if (elapsedTimer) clearInterval(elapsedTimer); elapsedTimer = null }
/**
 * Stop the turn and drop everything it held.
 *
 * Clearing the maps is not housekeeping — it is what makes a late step response
 * inert. Without it a reply arriving after a cancel would find its turn context
 * and keep looping into a project the user has since reset.
 */
export function abortAgent() {
  activeController?.abort()
  if (activeTimeout) clearTimeout(activeTimeout)
  activeTimeout = null
  activeController = null
  activeRequestId = null
  clearTurnState()
}
