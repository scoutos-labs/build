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
