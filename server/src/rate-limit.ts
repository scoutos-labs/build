export type RateLimiter = {
  /** Returns true if the request is allowed, false if the user is over the limit. */
  check(userId: string, now?: number): boolean
}

/**
 * Turn-starts vs. steps need different ceilings.
 *
 * One agent *turn* used to be one HTTP request, so a single 10/min limiter was
 * the whole story. Under the tool-calling harness a turn is up to 12 requests
 * (`MAX_TOOL_STEPS`), which means the old limiter would 429 a user's **second
 * turn within a minute** — it would have broken the loop on day one.
 *
 * So: `turns` keeps the original 10/min (unchanged user-visible behavior for
 * starting work), and `steps` gets a ceiling high enough that legitimate
 * multi-step turns never trip it while a runaway client still does.
 */
export type AgentRateLimiters = {
  /** Guards `stepIndex === 0` — i.e. the user starting a new turn. */
  turns: RateLimiter
  /** Guards continuation steps within a turn. */
  steps: RateLimiter
}

export const TURN_LIMIT_PER_MIN = 10
export const STEP_LIMIT_PER_MIN = 40

export function createAgentRateLimiters(windowMs = 60_000): AgentRateLimiters {
  return {
    turns: createRateLimiter(TURN_LIMIT_PER_MIN, windowMs),
    steps: createRateLimiter(STEP_LIMIT_PER_MIN, windowMs),
  }
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
