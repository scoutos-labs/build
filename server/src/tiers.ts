export type Tier = 'free' | 'pro'

export type TierConfig = {
  /** Monthly USD budget set as the OpenRouter per-key `limit`. */
  limitUsd: number
  /** Server-assigned model for this tier. Users never pick a model. */
  model: string
}

export const TIERS: Record<Tier, TierConfig> = {
  // qwen/qwen3.6-35b-a3b is a strong open-source model that reliably produces
  // well-formed JSON, making it a solid default for the free tier.
  free: { limitUsd: 5, model: 'qwen/qwen3.6-35b-a3b' },
  pro: { limitUsd: 10, model: 'anthropic/claude-sonnet-4.6' },
}

export function tierConfig(tier: string): TierConfig {
  return TIERS[tier as Tier] ?? TIERS.free
}

export function normalizeTier(tier: string | undefined): Tier {
  return tier === 'pro' ? 'pro' : 'free'
}
