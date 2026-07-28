import { describe, expect, it } from 'vitest'
import {
  MAX_TOOL_STEPS,
  MAX_TOOL_STEPS_FREE,
  TOKEN_TTL_MS,
  createStepTokens,
  maxStepsForTier,
} from './step-token.js'

const SECRET = 'test-root-secret-not-a-real-one'

describe('createStepTokens', () => {
  it('round-trips claims', () => {
    const tokens = createStepTokens(SECRET)
    const token = tokens.issue({ userId: 'u1', turnId: 't1', stepIndex: 3 }, 1_000)
    const verdict = tokens.verify(token, { now: 1_000 })
    expect(verdict.ok).toBe(true)
    if (!verdict.ok) return
    expect(verdict.claims).toEqual({ userId: 'u1', turnId: 't1', stepIndex: 3, iat: 1_000 })
  })

  it('rejects a tampered payload', () => {
    const tokens = createStepTokens(SECRET)
    const token = tokens.issue({ userId: 'u1', turnId: 't1', stepIndex: 0 }, 1_000)
    const [payload, signature] = token.split('.')
    // Re-encode the claims with a higher stepIndex, keeping the old signature.
    const forged = Buffer.from(
      JSON.stringify({ userId: 'u1', turnId: 't1', stepIndex: 99, iat: 1_000 }),
      'utf8',
    ).toString('base64url')
    const verdict = tokens.verify(`${forged}.${signature}`, { now: 1_000 })
    expect(verdict).toEqual({ ok: false, reason: 'bad_signature' })
    expect(payload).not.toBe(forged)
  })

  it('rejects a token signed with a different secret', () => {
    const mine = createStepTokens(SECRET)
    const theirs = createStepTokens('a-different-root-secret')
    const token = theirs.issue({ userId: 'u1', turnId: 't1', stepIndex: 0 }, 1_000)
    expect(mine.verify(token, { now: 1_000 })).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('rejects garbage and structurally invalid tokens as malformed', () => {
    const tokens = createStepTokens(SECRET)
    for (const bad of ['', 'nodot', '.', 'a.', '.b']) {
      const verdict = tokens.verify(bad, { now: 1_000 })
      expect(verdict.ok).toBe(false)
      if (!verdict.ok) expect(['malformed', 'bad_signature']).toContain(verdict.reason)
    }
  })

  it('rejects a validly-signed token whose claims are the wrong shape', () => {
    const tokens = createStepTokens(SECRET)
    // Sign a well-formed-but-wrong payload by issuing then swapping claims and
    // re-signing through the same instance is not possible from outside, so
    // assert via a non-integer stepIndex round-trip instead.
    const token = tokens.issue({ userId: 'u1', turnId: 't1', stepIndex: 1.5 }, 1_000)
    expect(tokens.verify(token, { now: 1_000 })).toEqual({ ok: false, reason: 'malformed' })
  })

  it('expires a token older than the TTL', () => {
    const tokens = createStepTokens(SECRET)
    const token = tokens.issue({ userId: 'u1', turnId: 't1', stepIndex: 0 }, 1_000)
    expect(tokens.verify(token, { now: 1_000 + TOKEN_TTL_MS - 1 }).ok).toBe(true)
    expect(tokens.verify(token, { now: 1_000 + TOKEN_TTL_MS + 1 })).toEqual({
      ok: false,
      reason: 'expired',
    })
  })

  it('refuses a stepIndex at or past the budget', () => {
    const tokens = createStepTokens(SECRET)
    const under = tokens.issue({ userId: 'u1', turnId: 't1', stepIndex: MAX_TOOL_STEPS - 1 }, 0)
    const at = tokens.issue({ userId: 'u1', turnId: 't1', stepIndex: MAX_TOOL_STEPS }, 0)
    expect(tokens.verify(under, { now: 0 }).ok).toBe(true)
    expect(tokens.verify(at, { now: 0 })).toEqual({ ok: false, reason: 'budget_exceeded' })
  })

  it('honors a per-request maxSteps override, so free tier gets a shorter leash', () => {
    const tokens = createStepTokens(SECRET)
    const token = tokens.issue({ userId: 'u1', turnId: 't1', stepIndex: MAX_TOOL_STEPS_FREE }, 0)
    // Allowed under the pro ceiling, refused under the free one.
    expect(tokens.verify(token, { now: 0, maxSteps: MAX_TOOL_STEPS }).ok).toBe(true)
    expect(tokens.verify(token, { now: 0, maxSteps: MAX_TOOL_STEPS_FREE })).toEqual({
      ok: false,
      reason: 'budget_exceeded',
    })
  })

  it('refuses to construct without a secret', () => {
    expect(() => createStepTokens('')).toThrow(/secret is required/)
  })

  it('does not embed the root secret in the token', () => {
    const tokens = createStepTokens(SECRET)
    const token = tokens.issue({ userId: 'u1', turnId: 't1', stepIndex: 0 }, 0)
    expect(token).not.toContain(SECRET)
    // HKDF domain separation: the raw secret must never be the signing key.
    expect(Buffer.from(token, 'utf8').includes(Buffer.from(SECRET, 'utf8'))).toBe(false)
  })
})

describe('maxStepsForTier', () => {
  it('gives pro the full budget and everyone else the free one', () => {
    expect(maxStepsForTier('pro')).toBe(MAX_TOOL_STEPS)
    expect(maxStepsForTier('free')).toBe(MAX_TOOL_STEPS_FREE)
    expect(maxStepsForTier('anything-else')).toBe(MAX_TOOL_STEPS_FREE)
  })
})
