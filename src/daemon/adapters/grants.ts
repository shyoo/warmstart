import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { samePath, withinPath } from '../fspath.js'
import { log } from '../log.js'

/**
 * The directories outside a pooled worktree that an agent working in it still has to reach.
 *
 * ⛔ **A workspace is not a self-contained directory, and every CLI that sandboxes assumes it is.**
 * Two things reach out of it, both by construction and both invisible in a `dir` listing: git keeps
 * a worktree's metadata in the trunk (`gitWritableRoots`), and anything shared between pool members
 * to avoid paying for it three times is a link to the trunk (`linkedWritableRoots`). A sandbox drawn
 * around `cwd` covers neither, and the failure in both cases is the same shape — the agent can read
 * and edit everything it was asked to, and cannot complete the one command that proves the work.
 *
 * ⚠️ These are *grants*, not a boundary: they widen what a sandboxed CLI may write, and they are the
 * whole of the fix. ⛔ Turning the sandbox off would also make the symptom go away and is never the
 * answer — see `docs/adapters.md`.
 */

/**
 * The directories a `git commit` in `cwd` has to write to, other than `cwd` itself.
 *
 * ⛔ **A worktree keeps none of its git metadata inside itself.** `<worktree>/.git` is a *file*
 * holding `gitdir: <trunk>/.git/worktrees/<slot>`, and a commit writes the index there, the new
 * objects into the common `.git/objects`, and the branch ref into the common `.git/refs/heads`.
 * Every one of those is outside the sandbox `--sandbox workspace-write` draws around `cwd`.
 *
 * ⭐ Measured on t56, 2026-08-30, across three runs and ~1.8M tokens that could never have landed:
 * *"Could not commit: sandbox denies writes to `.git/worktrees/ws1/index.lock`, so sync/rebase and
 * staging both failed."* The agent edited the files it was asked to and could not commit them — not
 * a t56 fault and not a codex fault, but every pooled worktree on this adapter, for every task.
 *
 * ⚠️ This returns the **common** `.git`, which is wider than the one slot: it holds every branch's
 * refs and every task's objects, so a worker given it could rewrite refs belonging to another task.
 * That is not an oversight and there is no narrower grant — a worktree commit genuinely needs all
 * three paths, and two of them are shared by construction. The narrow fix is a different
 * architecture (a real clone per worker, `.git` inside the workspace), not a smaller flag.
 *
 * ⚠️ Returns empty for an ordinary clone, where `.git` is a directory already inside `cwd` and
 * nothing needs widening, and for a directory that is not a repository at all — a project declared
 * `vcs: none` runs here too, under `--skip-git-repo-check`.
 */
export function gitWritableRoots(cwd: string): string[] {
  try {
    const dotGit = join(cwd, '.git')
    if (!existsSync(dotGit)) return []
    // A directory means an ordinary clone: the metadata is already inside the workspace.
    if (statSync(dotGit).isDirectory()) return []

    const pointer = readFileSync(dotGit, 'utf8').trim()
    const match = /^gitdir:\s*(.+)$/m.exec(pointer)
    if (!match?.[1]) return []
    const gitDir = resolve(cwd, match[1].trim())
    if (!existsSync(gitDir)) return []

    const roots = [gitDir]
    // ⚠️ `commondir` is written relative to `gitDir` (`../..` for a standard worktree). Resolved,
    // it is the trunk's `.git` — where objects and refs live. Absent on some layouts, in which
    // case the slot directory is all there is to grant.
    const commonFile = join(gitDir, 'commondir')
    if (existsSync(commonFile)) {
      const common = resolve(gitDir, readFileSync(commonFile, 'utf8').trim())
      if (existsSync(common)) roots.push(common)
    }
    // Deduplicated, and the common dir usually contains the slot dir — but only usually, so both
    // are passed rather than assuming the containment.
    return [...new Set(roots)]
  } catch (err) {
    // ⚠️ Never fatal. Failing to widen produces the old behaviour — an agent that cannot commit —
    // which is bad; refusing to spawn produces no agent at all, which is worse.
    log.warn(`could not work out git metadata roots for ${cwd}:`, err)
    return []
  }
}

/**
 * The real directories that links *inside* `cwd` point at, when they leave `cwd`.
 *
 * ⛔ **A sandbox resolves links before it checks them; an agent reading a path does not.** A junction
 * at `<workspace>/node_modules` pointing at `<trunk>/node_modules` looks like an ordinary
 * subdirectory in every listing, in every import specifier and in every error message — and a write
 * through it lands outside the writable set and is refused.
 *
 * ⭐ Measured on t171, 2026-09-03. `ws2/node_modules` on this install is a directory junction to the
 * trunk's; the sandbox's writable roots were the workspace and the two git directories, and nothing
 * else. `npm test` there died before a single test ran, twice in one run:
 *
 * ```
 * failed to load config from …\ws2\vitest.config.ts
 * Error: EPERM: operation not permitted, open
 *   '…\ws2\node_modules\.vite-temp\vitest.config.ts.timestamp-1788470916132-….mjs'
 * ```
 *
 * ⚠️ **And it presented as flakiness, which is the expensive part.** The same task, same branch and
 * same commands ran the full suite in `ws1` and `ws3` — 1,576, 1,642 and 1,644 tests — because only
 * `ws2` carried the junction. The agent could not tell "my workspace is shaped differently" from "my
 * change broke the build", so it committed with the suite unverified and said so in its handoff.
 *
 * ⚠️ **Not a lock and not a race**, which is what `EPERM` on a uniquely-named temp file looks like.
 * The run's own sandbox banner named its three writable roots — the workspace and the two git
 * directories — and enforcement is against that list *after* the path is resolved. The junction's
 * target was never on it. ⛔ Do not read anything into the ACLs on that directory: it carries a
 * `CodexSandboxUsers` ACE and was refused anyway, so the ACE is not what decides.
 *
 * ⚠️ **Depth one, deliberately.** This runs on every spawn, and a link scan of a whole workspace is a
 * walk of `node_modules` — the very directory being linked. The links that exist in practice are
 * top-level shares (`node_modules`, `.venv`, `vendor`), and one `readdir` finds all of them.
 *
 * ⚠️ Containment is judged against the **resolved** `cwd`, never the spelling that was passed. On
 * macOS a temporary directory is reached through `/var` → `/private/var`, so every child of it
 * resolves to a different string than it was joined from and a naive comparison would report the
 * whole workspace as escaping.
 */
export function linkedWritableRoots(cwd: string): string[] {
  const roots: string[] = []
  // ⚠️ Quiet about a directory that is not there. `plan()` is called with a placeholder cwd by tests
  // and by flows that never open a workspace, and a warning per spawn about a path nobody meant to
  // exist is how a log stops being read.
  if (!existsSync(cwd)) return []
  try {
    const inside = realpathSync.native(cwd)
    for (const entry of readdirSync(cwd, { withFileTypes: true })) {
      // ⛔ Both questions. A Windows junction is what this exists for and it reports as a symlink,
      // not as a directory; a POSIX symlink to a directory does the same.
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const path = join(cwd, entry.name)
      try {
        const target = realpathSync.native(path)
        // Resolves to where it sits, or to somewhere still inside the workspace: nothing to widen.
        if (withinPath(inside, target)) continue
        // `--add-dir` names directories. A link to a single file is a grant no CLI here would take.
        if (!statSync(target).isDirectory()) continue
        roots.push(target)
      } catch {
        // A broken link, or one this process may not resolve. Neither is a reason to fail a spawn,
        // and neither is a directory an agent could have used.
      }
    }
  } catch (err) {
    // ⚠️ Never fatal, for `gitWritableRoots`' reason: failing to widen is the old behaviour, and
    // refusing to spawn is worse than it.
    log.warn(`could not work out the link targets under ${cwd}:`, err)
    return []
  }
  return unique(roots)
}

/**
 * Everything outside `cwd` that a session working in `cwd` should be allowed to write.
 *
 * ⛔ `cwd` itself is never in it. Every adapter here already grants its own working directory —
 * codex through `--sandbox workspace-write`, Claude Code through the directory it is started in —
 * and repeating it would say this function had found something when it had not.
 */
export function workspaceGrants(cwd: string): string[] {
  return unique([...gitWritableRoots(cwd), ...linkedWritableRoots(cwd)])
}

/** ⛔ `samePath`, not a `Set`: one directory has more than one spelling. See `fspath.ts`. */
function unique(paths: string[]): string[] {
  const out: string[] = []
  for (const path of paths) if (!out.some((seen) => samePath(seen, path))) out.push(path)
  return out
}
