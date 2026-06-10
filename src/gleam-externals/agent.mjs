import { runNpmInstall } from './webcontainer.mjs'
import { dispatchAgentFailed, dispatchAgentSucceeded, dispatchAgentTick, dispatchWebContainerLog } from './runtime_bridge.mjs'

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

export async function callAgent(requestId, provider, model, userPrompt, apiKey = '', ollamaUrl = '', files, messages, selectedElement, elementComment = '') {
  const { runAgent } = await agentModule()
  const controller = new AbortController()
  activeController = controller
  activeRequestId = requestId
  activeTimeout = setTimeout(() => controller.abort(), 300_000)
  try {
    const result = await runAgent({ provider, apiKey, ollamaUrl, model, userPrompt, files: normalizeFiles(files), messages: normalizeMessages(messages), selectedElement: normalizeSelectedElement(selectedElement), elementComment, signal: controller.signal })
    dispatchAgentSucceeded(requestId, result.reply, result.patches)
  } catch (error) {
    const raw = error instanceof DOMException && error.name === 'AbortError' ? 'Request canceled or timed out after 5 minutes.' : message(error)
    dispatchAgentFailed(requestId, raw)
    dispatchWebContainerLog(raw)
  } finally {
    if (activeRequestId === requestId) {
      if (activeTimeout) clearTimeout(activeTimeout)
      activeTimeout = null
      activeController = null
      activeRequestId = null
    }
  }
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
