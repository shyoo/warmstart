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
    // ⛔ `.test.tsx` as well as `.test.ts`. The pattern was `.test.ts` alone until 2026-09-07, which
    // meant a check written beside a component — the natural place to put one — would never be
    // collected and would report nothing rather than failing. A suite that silently does not run is
    // the most expensive kind of false pass this project has.
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'node',
    testTimeout: 15_000,
    /**
     * ⚠️ **Reported, not enforced.** There are no thresholds here on purpose. A coverage gate makes
     * the cheapest way to a green build *writing a test that executes a line without asserting
     * anything about it*, and this repository's own `testing.md` §3 is a list of the times a suite
     * here reported a confident false pass. The number is a map of where to look next, and the
     * judgement about what is worth covering stays with the person reading it.
     *
     * ⛔ **L1 only, and the number must be read that way.** `npm test` is the pure-logic tier; the
     * daemon's HTTP surface is L2, the renderer is L3 and neither is instrumented here. A file that
     * reads 0% may be thoroughly exercised by `test:daemon` or `test:ui` — see `docs/testing.md` §1.
     */
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'text', 'html'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.test.tsx',
        'src/**/*.d.ts',
        // ⚠️ Process entry points and the Electron shell. Every one of them is wiring whose whole
        // behaviour is starting something; counting them as uncovered logic buries the files where
        // the number means something.
        'src/daemon/index.ts',
        'src/main/**',
        'src/preload/**',
        'src/mcp/index.ts'
      ]
    }
  }
})
