import { runNpmInstall } from './webcontainer.mjs'
import { dispatchAgentBudgetExhausted, dispatchAgentFailed, dispatchAgentSucceeded, dispatchAgentTick, dispatchAgentToolFinished, dispatchAgentToolStarted, dispatchProjectFileApplied, dispatchWebContainerLog } from './runtime_bridge.mjs'

let elapsedTimer = null
let activeController = null
let activeRequestId = null
let activeTimeout = null

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

export async function callAgent(requestId, provider, model, userPrompt, apiKey = '', ollamaUrl = '', files, messages, selectedElement, elementComment = '') {
  const controller = new AbortController()
  activeController = controller
  activeRequestId = requestId
  activeTimeout = setTimeout(() => controller.abort(), 300_000)
  try {
    const managed = managedAuth()
    const result = managed
      ? await (await import('../managed-agent-client')).callManagedAgent(
          { userPrompt, files: normalizeFiles(files), messages: normalizeMessages(messages), selectedElement: normalizeSelectedElement(selectedElement), elementComment },
          { getToken: managed.getToken, signal: controller.signal },
        )
      : await (await agentModule()).runAgent({ provider, apiKey, ollamaUrl, model, userPrompt, files: normalizeFiles(files), messages: normalizeMessages(messages), selectedElement: normalizeSelectedElement(selectedElement), elementComment, signal: controller.signal })
    dispatchAgentSucceeded(requestId, result.reply, result.patches)
  } catch (error) {
    if (error?.code === 'budget_exhausted') {
      dispatchAgentBudgetExhausted(requestId, error.resetAt ?? '')
    } else {
      const raw = error instanceof DOMException && error.name === 'AbortError' ? 'Request canceled or timed out after 5 minutes.' : message(error)
      dispatchAgentFailed(requestId, raw)
      dispatchWebContainerLog(raw)
    }
  } finally {
    if (activeRequestId === requestId) {
      if (activeTimeout) clearTimeout(activeTimeout)
      activeTimeout = null
      activeController = null
      activeRequestId = null
    }
  }
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

export function callAgentStep(requestId, step) {
  // Wired in U4; recorded so the loop's step cadence is observable in tests.
  globalThis.__buildAgentStepCalls = [
    ...(globalThis.__buildAgentStepCalls ?? []),
    { requestId, step },
  ]
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

/** Drop everything a finished turn was holding. Called on every terminal
 * transition — success, failure, cancel, timeout, project new/open/reset — so a
 * transcript never outlives its turn. */
export function clearTurnState(requestId) {
  if (requestId) toolResults.delete(requestId)
  else toolResults.clear()
}

/** Test seam: the turn-state map must be empty after every terminal transition. */
export function pendingTurnCount() {
  return toolResults.size
}

export function startElapsedTimer() {
  stopElapsedTimer()
  elapsedTimer = setInterval(() => { if (activeRequestId) dispatchAgentTick(Date.now()) }, 500)
}
export function stopElapsedTimer() { if (elapsedTimer) clearInterval(elapsedTimer); elapsedTimer = null }
export function abortAgent() { activeController?.abort(); if (activeTimeout) clearTimeout(activeTimeout); activeTimeout = null }
export function installIfNeeded(patches) {
  const normalized = gleamListToArray(patches)
  const needsInstall = normalized.some(patch => patch.path === 'package.json' || patch[0] === 'package.json')
  globalThis.__buildInstallIfNeededCalls = [
    ...(globalThis.__buildInstallIfNeededCalls ?? []),
    { paths: normalized.map(patch => patch.path ?? patch[0] ?? ''), needsInstall },
  ]
  if (needsInstall) void runNpmInstall()
}
