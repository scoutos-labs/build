import { runNpmInstall } from './webcontainer.mjs'
import { dispatchAgentBudgetExhausted, dispatchAgentFailed, dispatchAgentSucceeded, dispatchAgentTick, dispatchAgentToolFinished, dispatchAgentToolStarted, dispatchProjectFileApplied, dispatchWebContainerLog } from './runtime_bridge.mjs'

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
  })

  await runStep(requestId, 0)
}

/** Ollama has no tool mode (see LLMStepParams.provider) — it stays on the
 * single-shot JSON protocol, and the loop's first step is also its last. */
function usesToolMode(turn) {
  return managedAuth() !== null || turn.provider !== 'ollama'
}

async function runStep(requestId, stepIndex) {
  const turn = turns.get(requestId)
  if (!turn) return // canceled between steps

  try {
    const managed = managedAuth()
    if (!managed) {
      // BYOK. Ollama falls back to the single-shot protocol; BYOK-OpenRouter
      // will get the client-side loop with the step transport from U3.
      const result = await (await agentModule()).runAgent({
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
      // Apply through the one legal write path, then close the turn.
      for (const patch of result.patches ?? []) {
        dispatchProjectFileApplied(patch.path, patch.content)
      }
      dispatchAgentStepReturned(requestId, [], result.reply)
      finishTurn(requestId)
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
      },
      { getToken: managed.getToken, signal: turn.controller.signal },
    )

    turn.stepToken = response.stepToken
    // Results are consumed by the step that carried them; the next step reports
    // only its own.
    turn.toolResults = []
    turn.toolCalls = response.toolCalls ?? []

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
  }
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
  turn.toolResults = drainToolResults(requestId)
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
