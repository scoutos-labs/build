// @ts-ignore — @clerk type declarations may or may not be available
/* eslint-disable-next-line @typescript-eslint/no-unused-vars */
type Clerk = any

/**
 * Managed auth (Clerk + server-proxied OpenRouter) is gated behind
 * VITE_MANAGED_AUTH until the Phase 2 COEP spike passes and Phase 5 flips
 * production. With the flag off, the app behaves exactly as before.
 *
 * Clerk is bundled from npm (no CDN-loaded script) because the site ships
 * Cross-Origin-Embedder-Policy: require-corp for WebContainers, which blocks
 * cross-origin scripts without CORP headers.
 */
export function isManagedAuthEnabled(): boolean {
  const env = import.meta.env
  return env?.VITE_MANAGED_AUTH === 'true' && !!env?.VITE_CLERK_PUBLISHABLE_KEY
}

let clerkInstance: Clerk | null = null
let clerkLoading: Promise<Clerk> | null = null

async function loadClerk(): Promise<Clerk> {
  if (clerkInstance) return clerkInstance
  clerkLoading ??= (async () => {
    // no-rhc variants: clerk-js loads its UI components (and other chunks)
    // from Clerk's CDN at runtime by default, which COEP require-corp blocks.
    // Bundling @clerk/ui and passing it via load() keeps everything local.
    const [{ Clerk }, { ui }] = await Promise.all([
      // @ts-ignore — @clerk/* type declarations may not be available
      import('@clerk/clerk-js/no-rhc'),
      // @ts-ignore — @clerk/* type declarations may not be available
      import('@clerk/ui/no-rhc'),
    ])
    const clerk = new Clerk(import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string)
    await clerk.load({ ui })
    clerkInstance = clerk
    // Debug visibility while managed auth is in development: lets DevTools
    // inspect auth state (window.Clerk.user / .session) like the CDN build.
    ;(globalThis as Record<string, unknown>).Clerk = clerk
    console.debug('[managed-auth] clerk loaded', {
      user: clerk.user?.id ?? null,
      session: clerk.session?.id ?? null,
      status: clerk.status,
    })
    return clerk
  })()
  return clerkLoading
}

/**
 * Clerk session tokens are short-lived (~60s); always fetch a fresh one per
 * request instead of caching.
 */
export async function getSessionToken(): Promise<string | null> {
  if (!isManagedAuthEnabled()) return null
  const clerk = await loadClerk()
  return clerk.session ? clerk.session.getToken() : null
}

/**
 * True while a deliberate sign-out is in flight, so the gate's listener below
 * does not reload the page out from under it. Clerk clears `user` locally the
 * moment signOut() is called, long before the revoke request reaches Clerk —
 * reloading on that event aborts the request in flight, and the session comes
 * back alive from the still-valid cookie.
 */
let signingOut = false

export async function signOut(): Promise<void> {
  if (!clerkInstance) return
  signingOut = true
  try {
    // Must be awaited: this is the call that actually revokes the session
    // server-side. Reloading before it settles leaves the session active.
    await clerkInstance.signOut()
  } finally {
    signingOut = false
  }
  // Re-run the boot gate now that the session is genuinely gone.
  window.location.reload()
}

/**
 * The Gleam build mirrors src/ into build/dev/javascript/build/, so this
 * module can be bundled twice (once for main-gleam.ts, once for the
 * gleam-externals copy). Sharing the token getter via globalThis keeps a
 * single Clerk instance regardless of which copy a caller imports.
 */
export function registerManagedAgentAuth(): void {
  ;(globalThis as Record<string, unknown>).__buildManagedAuth = {
    getToken: getSessionToken,
    signOut,
  }
}

/**
 * Boot gate: resolves once a user is signed in. Until then the Gleam app,
 * WebContainer boot, and IndexedDB access must not start. After sign-in, a
 * later sign-out reloads the page so the gate runs again.
 */
export async function ensureSignedIn(): Promise<void> {
  // Branded shell first: it covers the app instantly, so signed-in reloads
  // see a quiet base-color surface (never the landing) and signed-out
  // visitors never see an unstyled flash while Clerk loads.
  const { createLandingShell } = await import('./landing')
  const shell = createLandingShell()
  const clerk = await loadClerk()

  if (!clerk.user) {
    const { signInSlot: mount } = shell.expandToLanding()
    // COOP: same-origin (required for WebContainers) severs window.opener, so
    // popup OAuth can never report back — force the full-page redirect flow.
    // withSignUp keeps sign-up inside this embedded component instead of
    // bouncing to the Account Portal (a separate origin outside our COEP
    // setup and a detour out of the app).
    clerk.mountSignIn(mount, { oauthFlow: 'redirect', withSignUp: true })

    await new Promise<void>(resolve => {
      // @ts-ignore — listener callback type may vary by Clerk version
    const unsubscribe = clerk.addListener(({ user, session }) => {
        console.debug('[managed-auth] gate event', { user: user?.id ?? null, session: session?.id ?? null })
        if (user) {
          unsubscribe()
          resolve()
        }
      })
    })

    clerk.unmountSignIn(mount)
  }
  shell.remove()

  // A session that ends elsewhere (expiry, revoked in another tab) returns the
  // visitor to the gate. A deliberate sign-out is excluded: signOut() owns the
  // reload, and only after the revoke request has actually settled.
  // @ts-ignore — listener callback type may vary by Clerk version
  clerk.addListener(({ user }) => {
    if (!user && !signingOut) window.location.reload()
  })
}
