import { defineConfig } from 'vitest/config'

/**
 * Without this, vitest finds no config in `server/` and walks UP to the repo
 * root, loading the app's `vite.config.ts` — which imports from the root
 * `node_modules`. That works on a machine where the root deps happen to be
 * installed and fails everywhere else: CI installs only `server/node_modules`,
 * and so would a fresh clone running just the server suite.
 *
 * Pinning the root here keeps this package self-contained.
 */
export default defineConfig({
  root: __dirname,
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
