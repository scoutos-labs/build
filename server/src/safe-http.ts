/**
 * SSRF-hardened HTTP for model-chosen destinations.
 *
 * The model picks the URL, so treat it as hostile. Defences, in order:
 *
 * 1. **Pre-flight URL validation** (`url-guard.ts`) — scheme, credentials, IP
 *    literals, ports, blocked hosts.
 * 2. **Connect-time IP validation** — the important one. A hostname that passes
 *    every static check can still resolve to `127.0.0.1` or `169.254.169.254`,
 *    and it can resolve *differently* between a pre-flight lookup and the real
 *    connection (DNS rebinding). Validating inside the socket's own `lookup` is
 *    the only place that closes the window.
 * 3. **No redirects** — a 3xx is refused, not followed, so an allowed host
 *    cannot bounce the request to a blocked one.
 * 4. **No ambient credentials** — no cookies, no auth headers, ever.
 * 5. **Caps** — request timeout, response byte cap, request body cap.
 *
 * Ported from the reference implementation's `convex/tools.ts` `safeHttp`.
 */

import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import { validateUrl } from './url-guard.js'

export const MAX_RESPONSE_BYTES = 32 * 1024
export const MAX_BODY_BYTES = 8 * 1024
export const REQUEST_TIMEOUT_MS = 8_000

const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'PATCH']

/**
 * Anything not a normal public "unicast" address is blocked: loopback, private,
 * link-local (which covers cloud metadata at 169.254.169.254), unique-local,
 * CGNAT, TEST-NET, and the IPv4-mapped/6to4 forms of all of them.
 *
 * Implemented without a dependency, so the ranges are explicit and reviewable.
 */
export function isPrivateIp(ip: string): boolean {
  const address = ip.trim().toLowerCase()
  if (!address) return true

  // IPv4-mapped and NAT64-style IPv6 forms carry an embedded v4 address; judge
  // that address rather than the wrapper.
  const mapped = address.match(/^(?:::ffff:|64:ff9b::)([\d.]+)$/)
  if (mapped?.[1]) return isPrivateIp(mapped[1])
  // Hex forms of the same wrappers: 64:ff9b::7f00:1 is 127.0.0.1, and the
  // dotted-quad regex above would miss it.
  const hexMapped = address.match(/^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (hexMapped) {
    const high = parseInt(hexMapped[1]!, 16)
    const low = parseInt(hexMapped[2]!, 16)
    return isPrivateIp(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`)
  }

  if (address.includes(':')) return isPrivateIpV6(address)
  return isPrivateIpV4(address)
}

function isPrivateIpV4(address: string): boolean {
  const parts = address.split('.')
  if (parts.length !== 4) return true // unparseable → block
  const octets = parts.map(part => Number(part))
  if (octets.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a = 0, b = 0] = octets

  if (a === 0) return true // "this network"
  if (a === 10) return true // private
  if (a === 127) return true // loopback
  if (a === 169 && b === 254) return true // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true // private
  if (a === 192 && b === 168) return true // private
  if (a === 192 && b === 0) return true // IETF protocol assignments / TEST-NET-1
  if (a === 192 && b === 88) return true // 6to4 relay anycast
  if (a === 198 && (b === 18 || b === 19)) return true // benchmarking
  if (a === 198 && b === 51) return true // TEST-NET-2
  if (a === 203 && b === 0) return true // TEST-NET-3
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a >= 224) return true // multicast, reserved, broadcast
  return false
}

function isPrivateIpV6(address: string): boolean {
  const normalized = address.replace(/^\[|\]$/g, '')
  if (normalized === '::' || normalized === '::1') return true // unspecified, loopback
  const head = normalized.split(':')[0] ?? ''
  if (!head) return normalized.startsWith('::') // other :: forms → block
  const group = parseInt(head, 16)
  if (Number.isNaN(group)) return true
  if ((group & 0xfe00) === 0xfc00) return true // unique-local fc00::/7
  if ((group & 0xffc0) === 0xfe80) return true // link-local fe80::/10
  if ((group & 0xffc0) === 0xfec0) return true // site-local fec0::/10 (deprecated, still routed)
  if ((group & 0xff00) === 0xff00) return true // multicast ff00::/8
  // 6to4: 2002::/16 embeds an IPv4 address in the next two groups, so
  // 2002:7f00:1:: is 127.0.0.1 wearing a costume.
  if (group === 0x2002) {
    const parts = normalized.split(':')
    const high = parseInt(parts[1] ?? '0', 16)
    const low = parseInt(parts[2] ?? '0', 16)
    return isPrivateIp(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`)
  }
  return false
}

export type SafeHttpResult = { ok: boolean; content: string; status?: number }

export type SafeHttpOptions = {
  body?: string
  contentType?: string
  /** Refuse anything that is not text-ish. Used for reads, where a binary blob
   * in the model's context is pure cost. */
  restrictContentType?: boolean
  timeoutMs?: number
}

/**
 * A DNS lookup that refuses to hand the socket a private address.
 *
 * This runs at connect time, inside the request, which is what makes it an
 * anti-rebinding defence rather than a check an attacker can race.
 */
function guardedLookup(
  hostname: string,
  options: dns.LookupOneOptions | dns.LookupAllOptions | number,
  callback: (err: NodeJS.ErrnoException | null, address?: unknown, family?: number) => void,
): void {
  const opts = typeof options === 'number' ? { family: options } : (options ?? {})
  dns.lookup(hostname, { all: true, family: opts.family || 0 }, (error, addresses) => {
    if (error) return callback(error)
    if (!addresses.length) return callback(new Error('Host has no address.'))
    const blocked = addresses.find(entry => isPrivateIp(entry.address))
    if (blocked) return callback(new Error('That host resolves to a private address.'))
    if ((opts as dns.LookupAllOptions).all) return callback(null, addresses as unknown)
    const first = addresses[0]!
    callback(null, first.address, first.family)
  })
}

export async function safeHttp(
  url: string,
  method: string,
  options: SafeHttpOptions = {},
): Promise<SafeHttpResult> {
  if (!ALLOWED_METHODS.includes(method)) {
    return { ok: false, content: `Method ${method} is not allowed.` }
  }
  // Reads are open to any public host; writes additionally refuse our own trust
  // surfaces. GET is the only read method here.
  const verdict = validateUrl(url, { forWrite: method !== 'GET' })
  if (!verdict.ok) return { ok: false, content: verdict.reason }

  if (options.body !== undefined && Buffer.byteLength(options.body, 'utf8') > MAX_BODY_BYTES) {
    return { ok: false, content: `Request body is too large (max ${MAX_BODY_BYTES} bytes).` }
  }

  const parsed = verdict.parsed
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS

  return await new Promise<SafeHttpResult>(resolve => {
    let settled = false
    const done = (result: SafeHttpResult) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    // No cookies, no auth, no forwarded headers — nothing ambient.
    const headers: Record<string, string> = {
      Accept: 'text/*, application/json',
      'User-Agent': 'build-agent',
    }
    if (options.body !== undefined) {
      headers['Content-Type'] = options.contentType || 'application/json'
    }

    const lib = parsed.protocol === 'https:' ? https : http
    const request = lib.request(
      parsed,
      {
        method,
        agent: false,
        lookup: guardedLookup as never,
        timeout: timeoutMs,
        headers,
      },
      response => {
        const status = response.statusCode ?? 0
        // A redirect could bounce an allowed host to a blocked one, so it is
        // refused rather than followed.
        if (status >= 300 && status < 400) {
          response.destroy()
          return done({ ok: false, content: `Blocked a redirect (HTTP ${status}).`, status })
        }
        if (options.restrictContentType) {
          const contentType = String(response.headers['content-type'] ?? '')
          if (!/text\/|application\/(json|xml|xhtml)/i.test(contentType)) {
            response.destroy()
            return done({
              ok: false,
              content: `That page is not text (${contentType || 'unknown type'}).`,
              status,
            })
          }
        }

        const okStatus = status >= 200 && status < 400
        const chunks: Buffer[] = []
        let bytes = 0
        const body = () => Buffer.concat(chunks).toString('utf8').slice(0, MAX_RESPONSE_BYTES)

        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length
          if (bytes <= MAX_RESPONSE_BYTES) {
            chunks.push(chunk)
          } else {
            // destroy() emits 'close', not 'end' — resolve now or this hangs.
            response.destroy()
            done({ ok: okStatus, content: `HTTP ${status}\n\n${body()}\n\n[truncated]`, status })
          }
        })
        response.on('end', () => done({ ok: okStatus, content: `HTTP ${status}\n\n${body()}`, status }))
        response.on('error', () => done({ ok: false, content: 'Could not read the response.' }))
        response.on('close', () => done({ ok: false, content: 'The connection closed early.' }))
      },
    )

    request.on('timeout', () => {
      request.destroy()
      done({ ok: false, content: 'That request timed out.' })
    })
    request.on('error', error => {
      done({ ok: false, content: `Request failed: ${String(error.message).slice(0, 160)}` })
    })
    if (options.body !== undefined) request.write(options.body)
    request.end()
  })
}
