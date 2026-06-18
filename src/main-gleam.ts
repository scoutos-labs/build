import { registerBuildEditor } from './gleam-externals/editor.mjs'
import { dispatchBuildFromPlan, dispatchPreviewElementSelected, dispatchWebContainerLog } from '../build/dev/javascript/build/gleam-externals/runtime_bridge.mjs'
import { registerBuildTerminal } from './gleam-externals/terminal.mjs'
import { main } from '../build/dev/javascript/build/build_app.mjs'
import { ensureSignedIn, isManagedAuthEnabled, registerManagedAgentAuth } from './managed-auth'
import { isTrustedPreviewMessage } from './preview-message-guard'

registerBuildEditor()
registerBuildTerminal()
window.addEventListener('message', event => {
  if (isTrustedPreviewMessage(event)) {
    if (event.data?.type === 'BUILD_ELEMENT_SELECTED') dispatchPreviewElementSelected(event.data.element)
    if (event.data?.type === 'BUILD_APP_FROM_PLAN') dispatchBuildFromPlan(event.data.planSummary ?? '')
    if (event.data?.type === 'BUILD_PREVIEW_ERROR') dispatchWebContainerLog(`[preview error] ${event.data.message ?? ''}`)
  }
  if (typeof event.data?.type === 'string' && event.data.type.startsWith('BUILD_INSPECTOR_')) {
    ;(window as typeof window & { __buildInspectorEvents?: string[] }).__buildInspectorEvents = [
      ...((window as typeof window & { __buildInspectorEvents?: string[] }).__buildInspectorEvents ?? []),
      event.data.type,
    ]
  }
})

// Boot gate: with managed auth on, nothing app-side (Gleam runtime,
// WebContainer boot, IndexedDB) starts until the user is signed in.
async function boot() {
  if (isManagedAuthEnabled()) {
    await ensureSignedIn()
    registerManagedAgentAuth()
  }
  main()
}
void boot()
