export type Tier = 'free' | 'pro'

export type TierConfig = {
  /** Monthly USD budget set as the OpenRouter per-key `limit`. */
  limitUsd: number
  /** Server-assigned model for this tier. Users never pick a model. */
  model: string
}

export const TIERS: Record<Tier, TierConfig> = {
  // openrouter/auto routes per-request, so weaker models may emit loose JSON;
  // the repair retry in app.ts covers that case.
  free: { limitUsd: 5, model: 'openrouter/auto' },
  pro: { limitUsd: 10, model: 'anthropic/claude-sonnet-4.6' },
}

export function tierConfig(tier: string): TierConfig {
  return TIERS[tier as Tier] ?? TIERS.free
}

export function normalizeTier(tier: string | undefined): Tier {
  return tier === 'pro' ? 'pro' : 'free'
}
