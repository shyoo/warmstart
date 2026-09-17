import { existsSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { tryGit } from './git.js'
import { samePath, withinPath } from './fspath.js'

/**
 * Commits a run made in a repository its task's landing never looks at.
 *
 * ⛔ **The finish only measures the checkout it owns.** t491 (2026-09-16) was filed on
 * `sunghwanyoo-site` about a commit that lives in `warmstart-site`. Its agent — Antigravity, running
 * with the operator's full OS authority — ran `git -C C:\Dev\warmstart-site …`, edited the post there
 * and committed `e59ca4e` there. The trunk finish surveyed `sunghwanyoo-site`, found no commits on
 * its `main`, and wrote *"Finished — no commits reached `main` during this run"*: true of the
 * project, and a completed task whose actual work sat unpushed in another repository. It reached
 * origin five minutes later, by hand.
 *
 * ⭐ **Candidates from what the agent did, facts from git.** The run's recorded tool lines only
 * suggest *where to look* — any absolute path they name. Whether anything happened there is read
 * from that repository's own `HEAD` reflog: a `commit` entry timestamped inside the run. Nothing an
 * agent *said* is believed, and a path it merely read produces nothing unless a commit landed there.
 *
 * ⚠️ **Best effort in both directions, and the direction matters.**
 *  - It can miss: the activity tail is bounded (see `activity.ts`), and a path an agent reached
 *    through a relative `cd` is never named in full.
 *  - It can over-report: a commit somebody else made in the same repository during the run reads
 *    as this run's. The caller holds for a person rather than acting, so a false positive costs a
 *    click, and a false negative is the silent completion this exists to prevent.
 *
 * ⛔ **Excluded, because their commits are somebody's to land already:** the project's own checkout
 * and every worktree that shares its git directory (a pool member another task is committing in is
 * not this run's stray), and every directory granted to the task.
 */

export interface StrayRepo {
  /** The repository's top level, as git spells it. */
  root: string
  commits: Array<{ sha: string; subject: string; pushed: boolean }>
}

/** How many distinct directories one finish will ask git about. A bound, not a tuning knob. */
const MAX_CANDIDATES = 24

/**
 * Every absolute path an activity line names, in order of first appearance.
 *
 * ⚠️ Deliberately loose: a false candidate costs one `git rev-parse` that says no. A Windows path
 * is a drive letter and a separator; a POSIX one must not be the tail of a URL (`https://host/x`)
 * or a relative path's middle (`src/daemon`).
 */
export function candidatePaths(lines: string[]): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  const windows = /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'`<>|*?\][(){},;]*/g
  const posix = /(?<![\w.:/\\-])\/[A-Za-z0-9._-][^\s"'`<>|*?\][(){},;]*/g
  for (const line of lines) {
    for (const match of [...line.matchAll(windows), ...line.matchAll(posix)]) {
      const path = match[0].replace(/[.:…]+$/, '')
      if (path.length < 3 || seen.has(path)) continue
      seen.add(path)
      found.push(path)
    }
  }
  return found
}

/** The nearest directory on disk at or above `path`, or null if none is. */
function existingDir(path: string): string | null {
  let current = path
  for (let i = 0; i < 64; i++) {
    if (existsSync(current)) {
      try {
        return statSync(current).isDirectory() ? current : dirname(current)
      } catch {
        return null
      }
    }
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
  return null
}

/**
 * Repositories named in `lines` that took a commit during the run and are none of `exclude`'s.
 *
 * @param lines the run's activity, oldest first
 * @param since the run's start, in ms since the epoch
 * @param projectRoot the task's project checkout — it and every worktree sharing its git directory
 *   are excluded
 * @param exclude further directories whose commits are accounted for (the workspace, granted dirs)
 */
export async function strayCommits(opts: {
  lines: string[]
  since: number
  projectRoot: string
  exclude: string[]
}): Promise<StrayRepo[]> {
  const projectCommon = await tryGit(opts.projectRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  const roots: string[] = []
  const dirs = new Set<string>()
  for (const path of candidatePaths(opts.lines)) {
    if (dirs.size >= MAX_CANDIDATES) break
    const dir = existingDir(path)
    if (!dir || dirs.has(dir)) continue
    dirs.add(dir)
    if (withinPath(opts.projectRoot, dir) || opts.exclude.some((e) => withinPath(e, dir))) continue
    const root = await tryGit(dir, ['rev-parse', '--show-toplevel'])
    if (!root || roots.some((r) => samePath(r, root))) continue
    if (samePath(root, opts.projectRoot) || opts.exclude.some((e) => withinPath(e, root) || withinPath(root, e))) continue
    const common = await tryGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
    if (projectCommon && common && samePath(projectCommon, common)) continue
    roots.push(root)
  }

  const since = Math.floor(opts.since / 1000)
  const strays: StrayRepo[] = []
  for (const root of roots) {
    // `HEAD@{<unix seconds>}` under --date=unix: the time this checkout's HEAD moved, which a fetch
    // does not do. `commit`, `commit (amend)`, `commit (merge)` — not checkout, reset or pull.
    const reflog = await tryGit(root, ['reflog', 'show', '--date=unix', '--format=%H%x09%gd%x09%gs', 'HEAD'])
    if (!reflog) continue
    const commits: StrayRepo['commits'] = []
    for (const entry of reflog.split('\n')) {
      const [sha, selector, subject] = entry.split('\t')
      const at = Number(/@\{(\d+)\}/.exec(selector ?? '')?.[1])
      if (!sha || !Number.isFinite(at) || at < since) continue
      if (!/^commit\b/.test(subject ?? '')) continue
      if (commits.some((c) => c.sha === sha)) continue
      const remote = await tryGit(root, ['branch', '-r', '--contains', sha])
      commits.push({ sha, subject: (subject ?? '').replace(/^commit[^:]*:\s*/, ''), pushed: !!remote })
    }
    if (commits.length > 0) strays.push({ root, commits: commits.reverse() })
  }
  return strays
}

/**
 * The hold reason for strays that are not all on a remote, or null when there is nothing to hold for.
 *
 * ⚠️ A stray the agent also pushed is not held: nothing is waiting on a person to move it, and the
 * finish's own message still names it (see `strayNote`).
 */
export function strayHoldReason(strays: StrayRepo[]): string | null {
  const unpushed = strays.filter((s) => s.commits.some((c) => !c.pushed))
  if (unpushed.length === 0) return null
  const where = unpushed
    .map((s) => {
      const shas = s.commits.filter((c) => !c.pushed).map((c) => c.sha.slice(0, 7))
      return `${shas.join(', ')} in ${s.root}`
    })
    .join('; ')
  return (
    `this run committed outside its project, and the landing does not push another repository: ${where}. ` +
    'Review and push it there yourself, or move the work to that project.'
  )
}

/** One line naming every stray, pushed or not, for the thread. */
export function strayNote(strays: StrayRepo[]): string {
  return strays
    .map((s) => {
      const list = s.commits.map((c) => `${c.sha.slice(0, 7)} ${c.subject}${c.pushed ? ' (pushed)' : ' (not pushed)'}`)
      return `${s.root}: ${list.join('; ')}`
    })
    .join('\n')
}
