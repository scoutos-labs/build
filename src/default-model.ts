/**
 * Default model for the build agent.
 *
 * Single source of truth for the default model string.
 * Managed mode (server/src/tiers.ts) overrides this per-tier;
 * self-hosted mode uses this as the initial default.
 */
export const DEFAULT_MODEL = 'qwen/qwen3.6-35b-a3b'
