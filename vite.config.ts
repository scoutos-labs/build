import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  optimizeDeps: { exclude: ['@webcontainer/api'] },
  test: {
    // The Gleam compiler copies src/*.ts into build/dev/javascript/build/;
    // never run those stale duplicates. server/ has its own vitest setup.
    exclude: [...configDefaults.exclude, 'build/**', 'server/**'],
  },
  server: {
    headers: {
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
    },
    // Local equivalent of the Render rewrite rule: same-origin /api calls
    // reach the build-api dev server.
    proxy: {
      '/api': 'http://localhost:3000',
      '/webhooks': 'http://localhost:3000',
    },
  },
})
