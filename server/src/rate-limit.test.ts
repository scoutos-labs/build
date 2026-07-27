import { describe, expect, it } from 'vitest'
import {
  STEP_LIMIT_PER_MIN,
  TURN_LIMIT_PER_MIN,
  createAgentRateLimiters,
  createRateLimiter,
} from './rate-limit.js'

describe('createRateLimiter', () => {
  it('allows up to the limit and rejects the next request', () => {
    const limiter = createRateLimiter(10, 60_000)
    const now = 1_000_000
    for (let i = 0; i < 10; i++) {
      expect(limiter.check('user-1', now + i)).toBe(true)
    }
    expect(limiter.check('user-1', now + 11)).toBe(false)
  })

  it('tracks users independently', () => {
    const limiter = createRateLimiter(1, 60_000)
    const now = 1_000_000
    expect(limiter.check('user-1', now)).toBe(true)
    expect(limiter.check('user-2', now)).toBe(true)
    expect(limiter.check('user-1', now + 1)).toBe(false)
  })

  it('frees slots once requests fall out of the window', () => {
    const limiter = createRateLimiter(2, 60_000)
    const now = 1_000_000
    expect(limiter.check('user-1', now)).toBe(true)
    expect(limiter.check('user-1', now + 1)).toBe(true)
    expect(limiter.check('user-1', now + 2)).toBe(false)
    expect(limiter.check('user-1', now + 60_001)).toBe(true)
  })
})

describe('createAgentRateLimiters', () => {
  it('keeps turn-starts at the original 10/min', () => {
    const { turns } = createAgentRateLimiters()
    const now = 1_000_000
    for (let i = 0; i < TURN_LIMIT_PER_MIN; i++) {
      expect(turns.check('user-1', now + i)).toBe(true)
    }
    expect(turns.check('user-1', now + 100)).toBe(false)
  })

  it('allows a full multi-step turn plus room to spare', () => {
    // The whole point: a 12-step turn is 12 requests, so the old single 10/min
    // limiter would have 429'd the user's second turn within a minute.
    const { steps } = createAgentRateLimiters()
    const now = 1_000_000
    for (let i = 0; i < STEP_LIMIT_PER_MIN; i++) {
      expect(steps.check('user-1', now + i)).toBe(true)
    }
    expect(steps.check('user-1', now + 100)).toBe(false)
  })

  it('counts turns and steps separately, so steps never exhaust turn budget', () => {
    const { turns, steps } = createAgentRateLimiters()
    const now = 1_000_000
    for (let i = 0; i < STEP_LIMIT_PER_MIN; i++) steps.check('user-1', now + i)
    // Steps exhausted, but the user can still start new turns.
    expect(steps.check('user-1', now + 100)).toBe(false)
    expect(turns.check('user-1', now + 100)).toBe(true)
  })

  it('gives steps a higher ceiling than turns', () => {
    expect(STEP_LIMIT_PER_MIN).toBeGreaterThan(TURN_LIMIT_PER_MIN)
  })
})
