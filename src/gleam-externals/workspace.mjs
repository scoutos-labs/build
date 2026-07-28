import { dispatchPersonaLoaded, dispatchPersonaSaved } from './runtime_bridge.mjs'

/**
 * The persona editor's two effects.
 *
 * Deliberately the only writer of `.build/agents/`. The agent's own `fs_write`,
 * `fs_batch_write` and `fs_delete` all refuse that prefix, which is what lets
 * the prompt treat standing instructions as trusted guidance rather than as
 * untrusted data the way it treats skills. See src/agents.ts.
 */
async function agents() {
  return await import('../agents')
}

export async function loadPersona() {
  try {
    const m = await agents()
    dispatchPersonaLoaded(await m.readPersona())
  } catch {
    dispatchPersonaLoaded('')
  }
}

export async function persistPersona(text) {
  try {
    const m = await agents()
    const ws = await import('../workspace-store')
    const trimmed = String(text ?? '').trim()
    // Clearing the box removes the file rather than leaving an empty one, so
    // "no persona" is one state instead of two.
    if (trimmed === '') await ws.deleteWorkspaceFile(m.PERSONA_PATH)
    else await ws.writeWorkspaceFile(m.PERSONA_PATH, trimmed)
    dispatchPersonaSaved()
  } catch {
    /* a persona that will not save is not worth failing the settings save over */
  }
}
