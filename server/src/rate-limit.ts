export type RateLimiter = {
  /** Returns true if the request is allowed, false if the user is over the limit. */
  check(userId: string, now?: number): boolean
}

/**
 * In-memory sliding window. Single-instance only — fine while the API runs as
 * one Render service; swap for a shared store if it ever scales out.
 */
export function createRateLimiter(limit = 10, windowMs = 60_000): RateLimiter {
  const hits = new Map<string, number[]>()
  return {
    check(userId, now = Date.now()) {
      const cutoff = now - windowMs
      const recent = (hits.get(userId) ?? []).filter(t => t > cutoff)
      if (recent.length >= limit) {
        hits.set(userId, recent)
        return false
      }
      recent.push(now)
      hits.set(userId, recent)
      return true
    },
  }
}
