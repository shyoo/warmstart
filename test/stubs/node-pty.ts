/**
 * The `@lydell/node-pty` L1 sees. ⛔ **No L1 test may spawn a vendor CLI.**
 *
 * `vitest.config.ts` aliases the real module to this one for the L1 tier. An alias rather than
 * `vi.mock` in a setup file on purpose: `vi.mock` is hoisted into the module that *calls* it, so a
 * factory registered from `setupFiles` did not reach `quota.ts`'s `await import('./sessions.js')` —
 * measured 2026-09-19, the spawn still happened and the clone still ran. An alias is resolution, not
 * mocking, so there is no ordering to get wrong and a dynamic import cannot slip past it.
 *
 * This enforces at `sessions.ts`'s single `pty.spawn` call what `docs/testing.md` §3 already asks of
 * `plan()`: *a test may not assert a host capability*.
 *
 * ⚠️ **It is not what fixed the 161 GB leak, and the comment it replaced claimed it was.** Measured
 * 2026-09-19: with this alias in place the orphaned clones continued, because the spawn was an
 * `execFile` of `codex doctor --json` from `probeIdentity`, not a PTY. `test/l1-temproot.ts` carries
 * that finding and the `PATH` shim that closes it. This stays because the PTY route is real and a
 * named error beats whatever an empty `PATH` stub does when executed.
 *
 * ⚠️ Throwing is deliberate. It reaches the `catch` the callers already have, which logs and carries
 * on — the same path CI has always taken and proven green. A stub that returned a dead terminal would
 * let a caller believe it had one and assert against silence instead.
 */

export function spawn(command: string): never {
  throw new Error(
    `L1 may not spawn a vendor CLI (tried to spawn ${command}). ` +
      'See test/stubs/node-pty.ts: a check that needs a real process belongs at L2 or above.'
  )
}
