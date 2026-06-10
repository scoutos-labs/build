export type Tier = 'free' | 'pro'

export type TierConfig = {
  /** Monthly USD budget set as the OpenRouter per-key `limit`. */
  limitUsd: number
  /** Server-assigned model for this tier. Users never pick a model. */
  model: string
}

export const TIERS: Record<Tier, TierConfig> = {
  // claude-3.5-haiku proved too weak for "full files as strict JSON" output
  // (emits unescaped newlines/backticks); haiku-4.5 is reliable at ~same cost.
  free: { limitUsd: 1, model: 'anthropic/claude-haiku-4.5' },
  pro: { limitUsd: 10, model: 'anthropic/claude-sonnet-4.6' },
}

export function tierConfig(tier: string): TierConfig {
  return TIERS[tier as Tier] ?? TIERS.free
}

export function normalizeTier(tier: string | undefined): Tier {
  return tier === 'pro' ? 'pro' : 'free'
}
