/**
 * Step tokens — the server-side bound on a client-driven agent loop.
 *
 * The loop is orchestrated by the browser (it owns the WebContainer, so tools
 * execute there), which means the *client* decides when to ask for another step.
 * A buggy or hostile client could otherwise spin `/api/agent/step` forever on
 * the server's OpenRouter key.
 *
 * A step token is an HMAC over `{userId, turnId, stepIndex, iat}` issued with
 * each step response and echoed back on the next request. The server refuses a
 * token whose `stepIndex` has reached the budget, whose `iat` is stale, or whose
 * signature does not verify — all without storing anything.
 *
 * Honest limits, stated so nobody mistakes this for more than it is:
 * - Tokens are **not single-use** (that would need server state, which this
 *   design deliberately avoids). So a replayed token bounds a *token*, not a
 *   turn: a client could re-send step 3's token repeatedly. The real bound on
 *   total spend is the per-user provisioned OpenRouter key's monthly `limit`.
 * - The signing key is derived from `KEY_ENCRYPTION_SECRET` via HKDF with a
 *   distinct info label, never used raw — so a step-token leak cannot be
 *   replayed against the credential-encryption surface.
 */

import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto'

/** Hard ceiling on tool steps per turn. Mirrors MAX_TOOL_STEPS on the client. */
export const MAX_TOOL_STEPS = 12
/** Free tier gets a shorter leash: verifying turns cost ~2.5x a single shot,
 * and the free budget is $5/month. */
export const MAX_TOOL_STEPS_FREE = 8
/** Tokens older than this are refused, so a captured token cannot be replayed
 * days later. Generous enough to outlast a slow multi-step turn. */
export const TOKEN_TTL_MS = 10 * 60_000

const HKDF_INFO = 'build-agent-step-token/v1'
const KEY_BYTES = 32

export type StepClaims = {
  userId: string
  turnId: string
  stepIndex: number
  iat: number
}

export type StepTokenVerdict =
  | { ok: true; claims: StepClaims }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'budget_exceeded' }

export type StepTokens = {
  /** Issue a token authorizing the *next* step. */
  issue(claims: Omit<StepClaims, 'iat'>, now?: number): string
  /**
   * Verify a token and check it against the budget.
   * `maxSteps` lets the free tier carry a lower ceiling than pro.
   */
  verify(token: string, opts?: { now?: number; maxSteps?: number }): StepTokenVerdict
}

function b64url(input: Buffer): string {
  return input.toString('base64url')
}

export function createStepTokens(secret: string, opts: { maxSteps?: number } = {}): StepTokens {
  if (!secret) throw new Error('step-token secret is required')
  // Domain-separate from every other use of the same root secret.
  const key = Buffer.from(hkdfSync('sha256', secret, '', HKDF_INFO, KEY_BYTES))
  const defaultMaxSteps = opts.maxSteps ?? MAX_TOOL_STEPS

  function sign(payload: string): string {
    return b64url(createHmac('sha256', key).update(payload).digest())
  }

  return {
    issue(claims, now = Date.now()) {
      const full: StepClaims = { ...claims, iat: now }
      const payload = b64url(Buffer.from(JSON.stringify(full), 'utf8'))
      return `${payload}.${sign(payload)}`
    },

    verify(token, verifyOpts = {}) {
      const now = verifyOpts.now ?? Date.now()
      const maxSteps = verifyOpts.maxSteps ?? defaultMaxSteps
      if (typeof token !== 'string' || !token.includes('.')) return { ok: false, reason: 'malformed' }
      const separator = token.lastIndexOf('.')
      const payload = token.slice(0, separator)
      const signature = token.slice(separator + 1)
      if (!payload || !signature) return { ok: false, reason: 'malformed' }

      const expected = sign(payload)
      const given = Buffer.from(signature, 'utf8')
      const want = Buffer.from(expected, 'utf8')
      // Length check first: timingSafeEqual throws on a mismatch.
      if (given.length !== want.length || !timingSafeEqual(given, want)) {
        return { ok: false, reason: 'bad_signature' }
      }

      let claims: StepClaims
      try {
        claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as StepClaims
      } catch {
        return { ok: false, reason: 'malformed' }
      }
      if (
        typeof claims?.userId !== 'string' ||
        typeof claims?.turnId !== 'string' ||
        typeof claims?.stepIndex !== 'number' ||
        !Number.isInteger(claims.stepIndex) ||
        claims.stepIndex < 0 ||
        typeof claims?.iat !== 'number'
      ) {
        return { ok: false, reason: 'malformed' }
      }

      if (now - claims.iat > TOKEN_TTL_MS) return { ok: false, reason: 'expired' }
      if (claims.stepIndex >= maxSteps) return { ok: false, reason: 'budget_exceeded' }
      return { ok: true, claims }
    },
  }
}

/** Step ceiling for a tier. Free is shorter — see MAX_TOOL_STEPS_FREE. */
export function maxStepsForTier(tier: string): number {
  return tier === 'pro' ? MAX_TOOL_STEPS : MAX_TOOL_STEPS_FREE
}
