/**
 * URL policy for model-chosen destinations, split by method class.
 *
 * Two different risks used to live in one blocklist, and separating them is the
 * whole design:
 *
 * - **Network-boundary names** (`localhost`, `.local`, `.internal`, cloud
 *   metadata) are a real SSRF surface. Blocked for *every* method, alongside the
 *   connect-time private-IP check in `safe-http.ts`.
 * - **Our own trust surfaces** (scoutos.live, hyper.io, openrouter.ai, Clerk,
 *   Build's own host) are blocked so the model cannot drive state-changing
 *   requests at our infrastructure. That risk is **write-shaped**: an
 *   uncredentialed, redirect-free GET to these public hosts sees exactly what
 *   any anonymous client sees. So reads stay open to any public-unicast host and
 *   writes keep the block — no per-site exception list to maintain in either
 *   direction.
 *
 * Ported from the reference implementation's `convex/url_guard.mjs`, with the
 * write-blocked list rewritten for Build's surfaces. Kept dependency-free so the
 * tests exercise it directly.
 */

export const NETWORK_BLOCKED_SUFFIXES = ['localhost', '.local', '.internal', '.localdomain']
export const NETWORK_BLOCKED_EXACT = ['localhost', 'metadata.google.internal']

/**
 * Build's own trust surfaces. A model-driven POST at any of these could publish,
 * spend, or mutate an account — the exact class of thing the user must remain
 * the only one able to do.
 */
export const WRITE_BLOCKED_SUFFIXES = [
  'scoutos.live',
  'scoutos.com',
  'hyper.io',
  'openrouter.ai',
  'clerk.com',
  'clerk.dev',
  'clerk.accounts.dev',
  'onrender.com',
]

function suffixHit(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(suffix.startsWith('.') ? suffix : `.${suffix}`)
}

export function hostBlocked(host: string, forWrite = false): boolean {
  const normalized = host.toLowerCase().replace(/\.$/, '')
  if (NETWORK_BLOCKED_EXACT.includes(normalized)) return true
  if (NETWORK_BLOCKED_SUFFIXES.some(suffix => suffixHit(normalized, suffix))) return true
  if (forWrite && WRITE_BLOCKED_SUFFIXES.some(suffix => suffixHit(normalized, suffix))) return true
  return false
}

export type UrlVerdict = { ok: true; parsed: URL } | { ok: false; reason: string }

/**
 * Everything checkable without a network call.
 *
 * The connect-time private-IP check — the anti-DNS-rebinding half — lives in
 * `safe-http.ts`, because a hostname that resolves to 127.0.0.1 passes every
 * test here and can only be caught at socket time.
 */
export function validateUrl(url: string, opts: { forWrite?: boolean } = {}): UrlVerdict {
  const forWrite = opts.forWrite ?? false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, reason: 'That is not a valid URL.' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'Only http and https URLs are allowed.' }
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'URLs with embedded credentials are not allowed.' }
  }
  const host = parsed.hostname
  // Only hostnames are accepted, because only hostnames get DNS-checked at
  // connect time. An IP literal would skip that check entirely.
  if (/^[\d.]+$/.test(host)) {
    return { ok: false, reason: 'IP-address URLs are not allowed.' }
  }
  if (host.includes(':') || host.startsWith('[')) {
    return { ok: false, reason: 'IPv6-literal URLs are not allowed.' }
  }
  if (parsed.port && parsed.port !== '80' && parsed.port !== '443') {
    return { ok: false, reason: 'Only ports 80 and 443 are allowed.' }
  }
  if (hostBlocked(host, forWrite)) {
    return { ok: false, reason: 'That destination is blocked.' }
  }
  return { ok: true, parsed }
}
