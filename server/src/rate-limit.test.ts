import { describe, expect, it } from 'vitest'
import { createRateLimiter } from './rate-limit.js'

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
