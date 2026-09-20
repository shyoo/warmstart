/**
 * The two things that keep L1 from filling the disk, asserted from inside L1.
 *
 * ⛔ **Without this, both mechanisms are a config line nobody would miss.** `vitest.config.ts`'s
 * `globalSetup` and `PATH` shim are what stopped L1 orphaning 24,322 fixture directories and ~161 GB
 * of `%TEMP%` (measured 2026-09-19; `docs/testing.md` §3 has the full account). Neither has a visible
 * effect on a passing run, so deleting either would go unnoticed until a disk filled up weeks later —
 * which is exactly how the first one got noticed the first time.
 *
 * ⚠️ Deliberately about the *sandbox*, not about any suite's behaviour, which is why it is two
 * assertions and no fixtures.
 */

import { basename, dirname, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { which } from './which.js'

/** Every command an adapter declares as its CLI. Must match `VENDOR_CLIS` in `test/l1-temproot.ts`. */
const VENDOR_CLIS = ['claude', 'codex', 'agy', 'muse', 'local-llm-bridge']

describe('the L1 sandbox', () => {
  /**
   * ⭐ This is the assertion that makes a leak impossible rather than unlikely: if `tmpdir()` is the
   * run's own root, then every `mkdtempSync(join(tmpdir(), …))` in the tier lands inside one directory
   * that is removed when the run ends — including the `${root}_workspaces` siblings and the per-`it`
   * directories no `afterAll` ever tracked.
   */
  it('⛔ points os.tmpdir() at this run’s own root, so nothing can be left outside it', () => {
    expect(basename(tmpdir())).toMatch(/^agentyard-l1-/)
  })

  /**
   * ⛔ **No L1 test may reach a real vendor CLI.** Non-vacuous on every host, and the same invariant
   * either way: on CI nothing resolves at all, and on a machine with the CLIs installed each resolves
   * to the empty stub inside the run root. ⚠️ A resolution pointing *outside* the root is the real
   * binary, and means the shim is gone — which is how `codex doctor --json` came to clone a plugins
   * marketplace over the network 16 times per run.
   */
  it('⛔ resolves no vendor CLI to anything outside this run’s root', () => {
    const root = tmpdir()
    const escaped = VENDOR_CLIS.map((c) => [c, which(c)] as const)
      .filter((pair): pair is readonly [string, string] => pair[1] !== null)
      .filter(([, path]) => !`${dirname(path)}${sep}`.startsWith(`${root}${sep}`))
    expect(escaped).toEqual([])
  })
})
