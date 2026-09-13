import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { log } from './log.js'
import { run } from './spawn.js'

/**
 * NTFS hygiene for a workspace a sandboxed agent has written in.
 *
 * ⛔ **Why a file a sandboxed Codex run cannot write is one it wrote itself.** Measured on t408
 * (2026-09-13, codex-cli under `--sandbox workspace-write`) and reproduced by hand in ws1 the same
 * day. Codex grants its per-run identity on the workspace root with an inheritable ACE and takes it
 * back when the run ends, so at rest the root carries nothing explicit. Inheritance is *propagated*
 * by the process that sets the grant — the operator's own unelevated token — and propagation needs
 * WRITE_DAC on every descendant. A file the sandbox created or rewrote is owned by
 * `CodexSandboxOffline`; the operator holds Modify on it and nothing more, so the grant silently
 * skips it (`icacls` answers *Successfully processed 1 files; Failed processing 0 files* while the
 * file stays untouched). It keeps the DACL an *earlier* run gave it, which names an identity that no
 * longer exists, and the next sandboxed run gets *Failed to write file* on exactly that file and
 * nothing else. 124 such files sat in ws1; `Workers.tsx` was t408's, `prefs.ts` was t353's.
 *
 * ⭐ **The operator cannot rewrite the DACL, but can replace the file.** Modify includes DELETE, so
 * a copy made beside the file and renamed over it is a new file owned by the operator with clean
 * inherited permissions — measured on `CLA.md`: owner changed, hash unchanged, and the next
 * inheritable grant on the root reached it. That is what `reown` does, and it is why the paths
 * `icacls /reset` refuses are the list worth having: they are precisely the files the sandbox's
 * next grant will not reach either.
 *
 * ⚠️ The full `/reset /t` of a 19,706-file workspace takes **7.2 s** (measured 2026-09-11 and again
 * 2026-09-13; `/q` does not shorten it). It used to be a synchronous call killed at 5 s, so the
 * daemon froze for five seconds on every dispatch and never saw the files after the cut-off. It is
 * asynchronous now with a 60 s bound: a dispatch waits that long, and nothing else does.
 */

export interface AclSweep {
  /** Paths `icacls` refused to reset — owned by somebody the operator cannot override. */
  denied: string[]
  /** Of those, the ones replaced with an operator-owned copy. */
  reowned: number
  /** Denied paths that could not be replaced either, with the first reason. */
  stuck: string[]
  /** `icacls` did not finish inside the bound, so `denied` is partial. */
  timedOut: boolean
}

const RESET_TIMEOUT_MS = 60_000

/**
 * `icacls <path> /reset [/t] /c /q`, returning the paths it could not reset.
 *
 * `/c` carries on past per-file failures and `/q` leaves only those failures and the summary in the
 * output, so every line of the form `<path>: <reason>` is a refusal. ⚠️ The reason text is
 * localised; the path before the first `: ` after the drive is not, and existence is the check.
 * ⛔ The refusals arrive on **stderr** and the summary on stdout (measured 2026-09-13) — the old
 * `stdio: ['ignore', 'pipe', 'ignore']` threw away the only lines that mattered, and exit stays 0.
 */
async function resetAcls(path: string, recursive: boolean): Promise<{ denied: string[]; timedOut: boolean }> {
  const args = [path, '/reset', ...(recursive ? ['/t'] : []), '/c', '/q']
  let out: string
  let timedOut = false
  try {
    const result = await run('icacls', args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: RESET_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024
    })
    out = `${result.stdout}\n${result.stderr}`
  } catch (err) {
    const e = err as { killed?: boolean; stdout?: string; stderr?: string; code?: unknown }
    out = `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim()
    if (e.killed) {
      timedOut = true
      log.warn(`ACL reset of ${path} did not finish in ${RESET_TIMEOUT_MS / 1000} s; whatever sorted after the cut-off was not reset`)
    } else if (!out) {
      log.warn(`ACL reset of ${path} failed:`, err)
      return { denied: [], timedOut: false }
    }
  }
  return { denied: deniedPaths(out), timedOut }
}

/**
 * The paths an `icacls … /c /q` run refused, read off its output.
 *
 * ⭐ Measured shape (2026-09-13): `C:\Dev\…\CLA.md: Access is denied.` per refusal, then
 * `Successfully processed 19706 files; Failed processing 146 files`. A directory whose name `icacls`
 * cannot spell in the console comes out as `C:\…\???\…` — it does not exist under that name, so
 * `exists` is the filter rather than any reading of the reason text, which is localised anyway.
 */
export function deniedPaths(out: string, exists: (path: string) => boolean = existsSync): string[] {
  const denied: string[] = []
  for (const line of out.split(/\r?\n/)) {
    // ⚠️ The root is echoed as it was given, so a forward-slash root prints as `C:/…\file`.
    const match = /^([A-Za-z]:[\\/][^:]*?|\\\\[^:]*?): /.exec(line)
    if (match?.[1] && exists(match[1])) denied.push(match[1])
  }
  return denied
}

/** Replace a file with an operator-owned copy of itself, atomically, keeping every byte. */
function reownFile(path: string): void {
  const tmp = join(dirname(path), `.${process.pid}.reown.${Date.now()}`)
  copyFileSync(path, tmp)
  try {
    renameSync(tmp, path)
  } catch (err) {
    try {
      renameSync(tmp, `${tmp}.failed`)
    } catch {
      // The copy stays beside the file; better a stray than a lost byte.
    }
    throw err
  }
}

/**
 * Replace a directory with an operator-owned one holding the same children.
 *
 * Renaming a child out of a directory needs DELETE on the child, which Modify grants; the directory
 * itself has to be empty to be removed, which is why the children move first. Files under it were
 * already re-owned by the time this runs — see the ordering in `sweepAcls`.
 */
function reownDir(path: string): void {
  const tmp = join(dirname(path), `.${process.pid}.reown.${Date.now()}`)
  mkdirSync(tmp)
  for (const child of readdirSync(path)) renameSync(join(path, child), join(tmp, child))
  rmdirSync(path)
  renameSync(tmp, path)
}

/** Replace `path` with an operator-owned copy of itself: a file by copy-and-rename, a directory by moving its children. */
export function reown(path: string): void {
  if (statSync(path).isDirectory()) reownDir(path)
  else reownFile(path)
}

/**
 * Reset the DACLs under each root and re-own whatever the reset could not touch.
 *
 * ⛔ Windows only, and a no-op elsewhere: this is about NTFS ownership, not about any adapter. A
 * root that does not exist is skipped, so callers pass what they know about without checking.
 * `recursive` roots get `/t`; the rest are reset one level deep — a `<dir>\*` spelling, which
 * `icacls` expands itself, so a git directory's top-level files are covered without walking its
 * object store.
 */
export async function sweepAcls(roots: { path: string; recursive: boolean }[]): Promise<AclSweep> {
  const sweep: AclSweep = { denied: [], reowned: 0, stuck: [], timedOut: false }
  if (process.platform !== 'win32') return sweep
  const seen = new Set<string>()
  for (const root of roots) {
    if (!existsSync(root.path)) continue
    const target = root.recursive ? root.path : join(root.path, '*')
    const { denied, timedOut } = await resetAcls(target, root.recursive)
    sweep.timedOut ||= timedOut
    for (const path of denied) {
      const key = path.toLowerCase()
      if (!seen.has(key)) {
        seen.add(key)
        sweep.denied.push(path)
      }
    }
  }
  if (sweep.denied.length === 0) return sweep

  // Files first, then directories deepest-first: a directory is re-owned by moving its children,
  // and a child still owned by the sandbox would carry that ownership straight into the new one.
  const files = sweep.denied.filter((p) => !safeIsDir(p))
  const dirs = sweep.denied
    .filter((p) => safeIsDir(p))
    .sort((a, b) => b.split(/[\\/]/).length - a.split(/[\\/]/).length)
  for (const path of [...files, ...dirs]) {
    try {
      reown(path)
      sweep.reowned += 1
    } catch (err) {
      sweep.stuck.push(path)
      if (sweep.stuck.length === 1) log.warn(`could not re-own ${path}:`, err)
    }
  }
  const where = roots[0]?.path ?? '?'
  if (sweep.reowned > 0) {
    log.info(`re-owned ${sweep.reowned} path(s) under ${where} that a sandboxed run had left unwritable to its next run`)
  }
  if (sweep.stuck.length > 0) {
    log.warn(`could not reset ACLs on ${sweep.stuck.length} path(s) under ${where} — a sandboxed run owns them and they could not be replaced`)
  }
  return sweep
}

function safeIsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
