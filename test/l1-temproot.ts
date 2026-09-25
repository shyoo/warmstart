/**
 * One temp root per L1 run, removed when the run ends.
 *
 * ⛔ **This exists because a suite's own `afterAll` cleanup is not a mechanism.** Measured
 * 2026-09-19 on this machine: `%LOCALAPPDATA%\Temp` held **24,322** leftover `agentyard-*`
 * fixture directories totalling **~161 GB**, created between 2026-09-09 and 2026-09-19 — one set
 * per `npm test` run, none ever removed. Every one of the 122 suites that makes a temp directory
 * *does* call `rmSync` in `afterAll`; the directories survived anyway, for three reasons that no
 * amount of remembering fixes:
 *
 * 1. **The removal throws and the suite swallows it.** `runfailure.test.ts` wraps its `rmSync` in
 *    `catch {}` with the comment *"a held file handle on Windows is not a test failure"* — which is
 *    true, and which also meant 618 runs × ~250 MB (**~151 GB, 94% of the total**) went unreported.
 *    That directory held **89 real vendor-CLI config roots**: the settled-run quota probe
 *    (`captureQuotaAfter` → `refreshNow`) is dispatched as `void`, so it spawned `claude` after the
 *    suite had closed its database, and six of those processes were still cloning a plugins
 *    marketplace over the network when the run exited still holding their `.sqlite-wal` handles.
 *    `l1-nospawn.ts` is the other half of this fix and stops that spawn at the source.
 * 2. **The leaked directory is a *sibling* of the one being removed.** `isolationRoot()` puts a
 *    project's worktree pool at `${root}_workspaces` (`projects.ts`), beside the fixture root
 *    rather than inside it, so removing the root never reaches it — 376 of these survived.
 * 3. **Per-`it` directories nobody tracked.** `prompt.test.ts` mkdtemps inside a test body
 *    (`agentyard-piece-target-`, 1,268 of them) with no teardown at all.
 *
 * ⭐ **So the fix is one directory, not 122 callers.** Pointing `TMPDIR`/`TMP`/`TEMP` at a
 * per-run root means every `mkdtempSync(join(tmpdir(), …))` in the suite lands *inside* it —
 * including the siblings and the untracked per-`it` dirs — and one recursive removal gets all of
 * them however badly an individual suite behaves. A suite that keeps its own `rmSync` is unaffected
 * and still cleans up early, which keeps a long run's peak footprint down.
 *
 * ⚠️ **Env, not a vitest option, and that is what makes it total.** Worker processes are forked
 * after `setup()` and inherit `process.env`, and `os.tmpdir()` re-reads those variables on every
 * call rather than caching — verified 2026-09-19 with a throwaway config before this was written.
 * A fixture does not have to opt in, and one written next year cannot opt out by forgetting.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

const ROOT_PREFIX = 'agentyard-l1-'

/**
 * Every command an adapter declares as its CLI (`info.command`), which L1 must be able to *find* and
 * must not be able to *run*. See `shimVendorClis`.
 */
const VENDOR_CLIS = ['claude', 'codex', 'agy', 'muse', 'local-llm-bridge']

/**
 * How old a root must be before another run may remove it.
 *
 * ⛔ Not zero, because `npm test` must be able to run twice at once — `docs/testing.md` §3 counts a
 * suite that cannot as a bug in the suite. A concurrent run's root is minutes old at most, so an
 * hours-wide floor never reaches one, while anything left by a run that crashed or was killed is
 * well past it and gets collected on the next run instead of accumulating for ten days.
 */
const STALE_MS = 2 * 60 * 60 * 1000

let root: string | undefined

export function setup(): void {
  // ⛔ Read the real temp directory *before* overriding it, or a second call would nest a root
  // inside the previous run's root and the sweep below would never see either.
  const system = tmpdir()
  sweepStaleRoots(system)

  mkdirSync(system, { recursive: true })
  root = mkdtempSync(join(system, ROOT_PREFIX))
  process.env.TMPDIR = root
  process.env.TMP = root
  process.env.TEMP = root
  // ⛔ **And a data directory, for every suite that never names one** (t697, 2026-09-25). 127 of
  // the 234 L1 files do not set `WARMSTART_DATA_DIR`, so `paths` resolved the operator's real
  // one: each `npm test` appended ~32 lines to the live `orchestratord-*.log` (554 on 2026-09-24
  // alone, interleaved with the daemon's own — including the landing check being investigated),
  // and `dataDir()` ran `adoptLegacyDataDir` against the real profile. Unconditional, not `??=`: a
  // check the daemon runs inherits whatever it was started with, and L1 must not write there.
  process.env.WARMSTART_DATA_DIR = join(root, 'data')
  shimVendorClis(root)
}

/**
 * Put a findable-but-unrunnable stub for each installed vendor CLI at the front of `PATH`.
 *
 * ⛔ **This is what stops L1 starting a vendor process, and the temp root above is only the cleanup
 * for when something does.** The spawn that cost 151 GB was not a PTY: `captureQuotaAfter` settles a
 * metered run, which reaches `refreshIdentity`, which for `openai-compatible` runs
 * `codex doctor --json` with `CODEX_HOME` pointed at the fixture's worker root
 * (`openai-compatible.ts`). A fresh Codex home bootstraps itself on that command — and part of
 * bootstrapping is `git fetch --depth 1 https://github.com/openai/plugins.git`, 23 MB over the
 * network, ~16 of them at once on `runfailure.test.ts`'s sixteen `openai-compatible` workers. They
 * outlived the suite, so `afterAll`'s removal hit `EBUSY` on their own lockfiles. Observed directly
 * 2026-09-19 by polling `Win32_Process` during a run, after two wrong guesses: `pty.spawn` (aliased
 * away, clones continued) and `claude-code.probeIdentity` (instrumented, never called).
 *
 * ⭐ **`which()` is the seam, exactly as `AGENTS.md` says it is** — *everything spawnable goes
 * through `which.ts`* — and `probeIdentity` guards that spawn with `if (which(info.command))`. So a
 * `PATH` whose vendor entries resolve to an empty file satisfies the lookup and fails the execution,
 * which lands in the `catch` that is already there and already logs a debug line. It also covers the
 * one call that skips `which()` (`claude-code.probeIdentity` passes `shell: true`), because the
 * shell resolves through the same `PATH`.
 *
 * ⚠️ **Only CLIs that are genuinely installed get a stub, and that is the point, not an
 * optimisation.** Shimming unconditionally would make `isInstalled()` true on CI for CLIs CI has
 * never had, flipping every suite that asserts an account with no CLI is undispatchable. Shimming
 * what already resolves leaves every `isInstalled()` answer exactly as it is on this machine today
 * and changes nothing at all on CI, which has no vendor CLI to find. The recipe is `stubCliPath`'s,
 * which is already proven against `which()`: a regular file, the executable bit off Windows, and a
 * `PATHEXT`-matching extension on it. ⛔ Prepended, so a suite calling `stubCliPath` still wins — its
 * directory goes in front of this one.
 */
function shimVendorClis(runRoot: string): void {
  const installed = VENDOR_CLIS.filter((c) => resolvesOnPath(c))
  if (!installed.length) return
  const shims = join(runRoot, 'no-vendor-cli')
  mkdirSync(shims, { recursive: true })
  for (const command of installed) {
    for (const name of [command, `${command}.exe`]) {
      const file = join(shims, name)
      writeFileSync(file, '')
      chmodSync(file, 0o755)
    }
  }
  process.env.PATH = `${shims}${delimiter}${process.env.PATH ?? ''}`
}

/** Is this command on `PATH` as the real thing? Deliberately the same rule `which.ts` applies. */
function resolvesOnPath(command: string): boolean {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : ['']
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    for (const ext of ['', ...exts]) {
      try {
        if (existsSync(join(dir, `${command}${ext}`))) return true
      } catch {
        // An unreadable PATH entry is not a resolution.
      }
    }
  }
  return false
}

export function teardown(): void {
  if (!root) return
  // ⚠️ `maxRetries` matters here rather than being defensive noise: a vendor CLI that outlived its
  // suite releases its handles a moment later, and this is the difference between collecting it now
  // and leaving it for the next run's sweep.
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  } catch (err) {
    // ⛔ Said out loud, never swallowed. Swallowing exactly this is how 161 GB accumulated
    // unnoticed, so a root that cannot be removed reports its own path and leaves the evidence in
    // place for the next run's sweep.
    console.warn(
      `[l1-temproot] could not remove ${root} (${(err as Error).message}). ` +
        'Left in place; the next run sweeps it once it is older than 2h.'
    )
  }
  root = undefined
}

/** Roots from runs that are over. Best-effort by design: what this misses, a later run collects. */
function sweepStaleRoots(system: string): void {
  let entries: string[]
  try {
    entries = readdirSync(system)
  } catch {
    return
  }
  const cutoff = Date.now() - STALE_MS
  for (const name of entries) {
    if (!name.startsWith(ROOT_PREFIX)) continue
    const path = join(system, name)
    try {
      if (statSync(path).mtimeMs > cutoff) continue
      rmSync(path, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 })
    } catch {
      // A root still held by something is not this run's problem.
    }
  }
}
