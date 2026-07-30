/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Regression cover for the sign-out race found by the 2026-07-30 local smoke
 * test: the account panel fired signOut() without awaiting it, and the boot
 * gate's listener reloaded the page the instant Clerk cleared `user` locally.
 * The navigation aborted the revoke request in flight, so Clerk never ended
 * the session — it came back alive from the still-valid cookie, and the
 * session stayed `active` server-side for days.
 */

const reload = vi.fn()

type Listener = (state: { user: unknown; session: unknown }) => void

let listeners: Listener[] = []
let signOutResolve: () => void
let signOutCalls = 0
let clerkUser: unknown = { id: 'user_1' }

const clerkStub = {
  get user() {
    return clerkUser
  },
  session: { id: 'sess_1', getToken: async () => 'jwt' },
  status: 'ready',
  load: vi.fn(async () => {}),
  mountSignIn: vi.fn(),
  unmountSignIn: vi.fn(),
  addListener: (fn: Listener) => {
    listeners.push(fn)
    return () => {
      listeners = listeners.filter(l => l !== fn)
    }
  },
  signOut: vi.fn(() => {
    signOutCalls += 1
    // Clerk clears local state immediately; the network revoke settles later.
    clerkUser = null
    listeners.forEach(l => l({ user: null, session: null }))
    return new Promise<void>(res => {
      signOutResolve = res
    })
  }),
}

// Must be constructible — managed-auth.ts calls `new Clerk(publishableKey)`.
vi.mock('@clerk/clerk-js/no-rhc', () => ({
  Clerk: function Clerk(this: unknown) {
    return clerkStub
  },
}))
vi.mock('@clerk/ui/no-rhc', () => ({ ui: {} }))
vi.mock('./landing', () => ({
  createLandingShell: () => ({
    expandToLanding: () => ({ signInSlot: document.createElement('div') }),
    remove: vi.fn(),
  }),
}))

async function loadModule() {
  vi.resetModules()
  vi.stubEnv('VITE_MANAGED_AUTH', 'true')
  vi.stubEnv('VITE_CLERK_PUBLISHABLE_KEY', 'pk_test_x')
  return import('./managed-auth')
}

beforeEach(() => {
  listeners = []
  signOutCalls = 0
  clerkUser = { id: 'user_1' }
  reload.mockClear()
  vi.stubGlobal('location', { reload, href: 'http://localhost:5173/' })
})

describe('signOut', () => {
  it('does not reload until the revoke request has actually settled', async () => {
    const mod = await loadModule()
    await mod.ensureSignedIn()

    const pending = mod.signOut()
    // Clerk has already cleared `user` and fired the listener by now. If the
    // gate reloads here, the revoke request dies with the page.
    await Promise.resolve()
    expect(signOutCalls).toBe(1)
    expect(reload).not.toHaveBeenCalled()

    signOutResolve()
    await pending
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('still returns a session that ended elsewhere to the gate', async () => {
    const mod = await loadModule()
    await mod.ensureSignedIn()

    // Not a deliberate sign-out — an expiry or a revoke from another tab.
    listeners.forEach(l => l({ user: null, session: null }))
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('is a no-op before Clerk has loaded', async () => {
    const mod = await loadModule()
    await mod.signOut()
    expect(signOutCalls).toBe(0)
    expect(reload).not.toHaveBeenCalled()
  })
})
