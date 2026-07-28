import { dispatchAccountLoaded } from './runtime_bridge.mjs'

// globalThis.__buildManagedAuth is registered by src/managed-auth.ts after the
// sign-in gate, before the Gleam app boots.
export function isManagedAuth() {
  return globalThis.__buildManagedAuth != null
}

export function purgeLegacySettings() {
  for (const key of ['openrouter-key', 'ollama-url', 'agent-provider', 'agent-model']) {
    globalThis.localStorage?.removeItem(key)
  }
}

export function managedSignOut() {
  void globalThis.__buildManagedAuth?.signOut?.()
}

export async function fetchAccountInfo() {
  try {
    const auth = globalThis.__buildManagedAuth
    const token = await auth?.getToken?.()
    const response = await fetch('/api/me', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const me = await response.json()
    const usd = value => (typeof value === 'number' ? `$${value.toFixed(2)}` : null)
    const remaining = usd(me.limitRemaining)
    const limit = usd(me.limit)
    const budget = remaining && limit
      ? `${remaining} of ${limit} remaining this month`
      : 'Budget unavailable'
    dispatchAccountLoaded(me.plan ?? 'free', budget)
  } catch {
    dispatchAccountLoaded('', 'Could not load account info')
  }
}

/**
 * Record the chosen job.
 *
 * Always stored locally so the picker survives a reload. In managed mode the
 * server is told too — it re-validates the id against the live tool-capable
 * catalog and refuses anything that cannot call tools, which is the guard that
 * stops a silently broken harness three turns later.
 */
export async function persistJob(job, model) {
  try { globalThis.localStorage?.setItem('build.job', job) } catch { /* private mode */ }
  const managed = globalThis.__buildManagedAuth
  if (!managed) return
  try {
    const token = await managed.getToken()
    await fetch('/api/me/model', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ model }),
    })
  } catch { /* the local choice still stands; the next turn uses the stored model */ }
}

/** The job chosen last session, if any. */
export function loadJob() {
  try { return globalThis.localStorage?.getItem('build.job') ?? '' } catch { return '' }
}
