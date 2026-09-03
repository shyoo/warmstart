import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * Tests run against the source, so they need the same `@shared` alias the three bundles get from
 * `electron.vite.config.ts`. Without it, only modules that import from `@shared` as *types* resolve -
 * which passes for a while and then fails the moment a test touches a real exported value.
 */
export default defineConfig({
  resolve: {
    alias: { '@shared': resolve('src/shared') }
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15_000
  }
})
