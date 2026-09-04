import { resolve, sep } from 'node:path'

/**
 * One spelling for one directory.
 *
 * ⛔ **Windows filesystems are case-insensitive and Windows *paths* are not.** `c:\Dev\x` and
 * `C:\Dev\x` are the same directory and two different strings, so anything that compares paths with
 * `===` will one day decide a directory is not itself. Measured against this install 2026-08-28: the
 * `sessions` table held the same pooled worktree under both spellings — 8 Claude rows as `c:\` and 2
 * as `C:\` — because `policyFor` derives an unconfigured workspace root by concatenating onto
 * `project.root`, which `addProject` stores in whatever case its caller supplied.
 *
 * ⚠️ The cost of getting this wrong is silent and one-directional: `resumableSession` requires the
 * cwd to match, because Claude Code files its transcripts under an encoding of the cwd and `--resume`
 * from elsewhere finds nothing and starts cold *while reporting success*. A case mismatch there does
 * not resume the wrong conversation — it resumes none, pays the full cold start (41,542
 * cache-creation tokens, measured), and records `warm=false` as though that were the answer.
 *
 * ⛔ **win32 only.** On Linux and macOS `/Dev` and `/dev` are genuinely different directories, and
 * folding case there would make two distinct worktrees look like one — the same bug pointing the
 * other way, with a worse outcome.
 */
export function canonicalPath(path: string): string {
  const absolute = resolve(path)
  if (process.platform !== 'win32') return absolute
  // Only the drive letter. The rest of a Windows path is case-insensitive too, but folding all of it
  // would change what gets *shown* to an operator, and these strings are displayed as well as
  // compared — a worktree rendered `c:\dev\multi_agent_controller_workspaces\ws1` is harder to
  // recognise than the one the operator actually typed.
  return absolute.replace(/^([a-z]):/, (_, drive: string) => `${drive.toUpperCase()}:`)
}

/** Do these two paths name the same directory? Compares canonically; see `canonicalPath`. */
export function samePath(a: string, b: string): boolean {
  if (process.platform !== 'win32') return canonicalPath(a) === canonicalPath(b)
  // ⚠️ Whole-path case folding for the *comparison* only, never for what is stored or drawn. The
  // drive letter is the case this install actually produced, but nothing guarantees it is the only
  // one — a path that arrived from a shell, a config file and a directory picker has three chances
  // to differ, and a comparison that caught two of the three would be worse than one that is honest
  // about the platform it runs on.
  return canonicalPath(a).toLowerCase() === canonicalPath(b).toLowerCase()
}

/**
 * Is `child` the same directory as `parent`, or somewhere beneath it?
 *
 * ⛔ **Not `child.startsWith(parent)`.** That answers yes for `…/ws10` under `…/ws1` — two different
 * pool members — and no for `C:\Dev\x` under `c:\Dev`, which is one directory spelled twice. The
 * separator has to be part of the test and the comparison has to be `samePath`'s, for exactly the
 * reasons `canonicalPath` gives.
 *
 * ⚠️ Pure string arithmetic on already-resolved paths: it does not touch the filesystem and does not
 * follow links, so a caller asking *"did this link escape the workspace?"* has to resolve both sides
 * with `realpathSync` first. `linkedWritableRoots` is the caller that does.
 */
export function withinPath(parent: string, child: string): boolean {
  if (samePath(parent, child)) return true
  const from = canonicalPath(parent)
  const to = canonicalPath(child)
  const prefix = from.endsWith(sep) ? from : from + sep
  if (process.platform !== 'win32') return to.startsWith(prefix)
  return to.toLowerCase().startsWith(prefix.toLowerCase())
}
