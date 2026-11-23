import { existsSync, readFileSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { errorMessage } from '@shared/errors.js'
import type { Project } from '@shared/tasks.js'
import { canonicalPath, samePath } from '../fspath.js'
import { git, tryGit } from '../git.js'
import { log } from '../log.js'
import type { DiffFileEntry } from '../review.js'
import { run } from '../spawn.js'
import { launchArgs, spawnEnv, which } from '../which.js'
import { RESCUE_TRAILER, trunkBaseRef, type Rescue, type WorkspaceState } from '../worktrees.js'
import type { VcsDriver, VcsRebaseResult, VcsWorkspaceEntry } from './driver.js'
import { gitDriver } from './git.js'

/** Minimum supported Jujutsu CLI version verified for flag compatibility (plan §9 row 5b). */
export const JJ_MIN_VERSION = '0.46.0'

/**
 * Maximum repo root path length jj 0.46 accepts reliably on Windows (plan §9 row 3b).
 * Longer roots push `.jj/repo/index/segments/<128 hex>` past 260 chars because jj is not long-path aware.
 */
export const JJ_MAX_ROOT_LENGTH = 106

const JJ_MAX_BUFFER = 64 * 1024 * 1024
const TARGET_REFRESH_MS = 5 * 60_000
const lastTargetRefresh = new Map<string, number>()
const verifiedVersions = new Map<string, string>()
const pendingConflictRebaseOps = new Map<string, string>()

function conflictRebaseKey(workspacePath: string): string {
  const canonical = canonicalPath(workspacePath)
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}

const WS_LIST_TEMPLATE =
  '"{\\"name\\":" ++ json(self.name()) ++ ",\\"root\\":" ++ ' +
  'if(self.root(), json(stringify(self.root())), "null") ++ ",\\"bookmarks\\":" ++ ' +
  'json(self.target().local_bookmarks().map(|b| b.name())) ++ "}\\n"'

const REV_META_TEMPLATE =
  '"{\\"sha\\":" ++ json(commit_id) ++ ",\\"bookmarks\\":" ++ ' +
  'json(local_bookmarks.map(|b| b.name())) ++ ",\\"desc\\":" ++ json(description) ++ ' +
  '",\\"conflict\\":" ++ if(conflict, "true", "false") ++ "}\\n"'

const WORKING_COPY_TEMPLATE =
  '"{\\"sha\\":" ++ json(commit_id) ++ ",\\"bookmarks\\":" ++ ' +
  'json(local_bookmarks.map(|b| b.name())) ++ ",\\"desc\\":" ++ json(description) ++ ' +
  '",\\"conflict\\":" ++ if(conflict, "true", "false") ++ ' +
  '",\\"empty\\":" ++ if(empty, "true", "false") ++ ' +
  '",\\"files\\":[" ++ diff.files().map(|f| "{\\"status\\":" ++ json(f.status()) ++ ' +
  '",\\"path\\":" ++ json(f.path()) ++ "}").join(",") ++ "]}\\n"'

const LOCAL_BOOKMARK_TEMPLATE = 'if(!remote, json(self) ++ "\\n", "")'

interface JjWorkspaceRow {
  name: string
  root: string | null
  bookmarks: string[]
}

interface JjRevMeta {
  sha: string
  bookmarks: string[]
  desc: string
  conflict: boolean
}

interface JjWorkingCopyFile {
  status: string
  path: string
}

interface JjWorkingCopyRow extends JjRevMeta {
  empty: boolean
  files: JjWorkingCopyFile[]
}

interface JjBookmarkRow {
  name: string
  target: string[]
}

/** Clear cached `jj --version` and refresh throttle state (tests only). */
export function _resetJjDriverCachesForTest(): void {
  verifiedVersions.clear()
  lastTargetRefresh.clear()
  pendingConflictRebaseOps.clear()
}

/** Extract `major.minor.patch` from `jj --version` output, or `null` when unrecognized. */
export function parseJjVersion(output: string): string | null {
  const match = /\b(\d+\.\d+\.\d+)\b/.exec(output)
  return match?.[1] ?? null
}

/** Compare two dotted numeric versions (`-1` if `a < b`, `0` if equal, `1` if `a > b`). */
export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0
    const db = pb[i] ?? 0
    if (da < db) return -1
    if (da > db) return 1
  }
  return 0
}

/** Validate raw `jj --version` output against `minimum`, throwing a clear error if older or unparseable. */
export function assertJjVersionSupported(versionOutput: string, minimum = JJ_MIN_VERSION): string {
  const parsed = parseJjVersion(versionOutput)
  if (!parsed) {
    throw new Error(
      `Could not determine jj version from "${versionOutput.trim()}" (minimum required: ${minimum})`
    )
  }
  if (compareSemver(parsed, minimum) < 0) {
    throw new Error(`jj ${parsed} is older than required minimum ${minimum}`)
  }
  return parsed
}

/**
 * Resolve the shared jj repository root for `path`.
 * For secondary colocated workspaces whose `.jj/repo` is a pointer file (`../../r/.jj/repo`),
 * this returns `<mainRepo>` rather than the workspace path so pool slots under `<root>_workspaces`
 * are checked against the actual shared store root.
 */
export function resolveJjRepoRoot(path: string): string {
  let cur = path
  for (;;) {
    const jjRepo = join(cur, '.jj', 'repo')
    if (existsSync(jjRepo)) {
      try {
        const st = statSync(jjRepo)
        if (st.isDirectory()) return cur
        if (st.isFile()) {
          const pointer = readFileSync(jjRepo, 'utf8').trim()
          if (pointer.length > 0) {
            return dirname(dirname(resolve(join(cur, '.jj'), pointer)))
          }
        }
      } catch {
        return cur
      }
    }
    const parent = dirname(cur)
    if (samePath(parent, cur)) break
    cur = parent
  }
  return path
}

/** Refuse repository roots longer than `maxLength` characters (jj 0.46 Windows 260-char internal path limit). */
export function assertJjRootLength(root: string, maxLength = JJ_MAX_ROOT_LENGTH): void {
  if (root.length > maxLength) {
    throw new Error(
      `jj repository root path is ${root.length} characters, exceeding the ${maxLength}-character limit (${root})`
    )
  }
}

async function ensureJjBinary(): Promise<string> {
  const binary = which('jj')
  if (!binary) {
    throw new Error('jj is not installed')
  }
  if (verifiedVersions.has(binary)) {
    return binary
  }
  const launched = launchArgs(binary, ['--version'])
  let stdout: string
  try {
    const res = await run(launched.command, launched.args, {
      env: spawnEnv(),
      windowsHide: true,
      timeout: 10_000
    })
    stdout = res.stdout
  } catch (err) {
    throw new Error(`Failed to run jj --version: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err
    })
  }
  const parsed = assertJjVersionSupported(stdout)
  verifiedVersions.set(binary, parsed)
  return binary
}

async function ensureJjReady(repoOrWorkspacePath: string): Promise<{ binary: string; repoRoot: string }> {
  const repoRoot = resolveJjRepoRoot(repoOrWorkspacePath)
  assertJjRootLength(repoRoot)
  const binary = await ensureJjBinary()
  return { binary, repoRoot }
}

async function execJj(
  cwd: string,
  args: string[],
  opts: { ignoreWorkingCopy?: boolean; rootHint?: string } = {}
): Promise<string> {
  const { binary } = await ensureJjReady(opts.rootHint ?? cwd)
  const fullArgs = [
    ...(opts.ignoreWorkingCopy ? ['--ignore-working-copy'] : []),
    '--no-pager',
    ...args
  ]
  const launched = launchArgs(binary, fullArgs)
  const { stdout } = await run(launched.command, launched.args, {
    cwd,
    env: spawnEnv(),
    maxBuffer: JJ_MAX_BUFFER,
    windowsHide: true
  })
  return stdout.replace(/\s+$/, '')
}

function parseJsonLines<T>(raw: string): T[] {
  const out: T[] = []
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    out.push(JSON.parse(trimmed) as T)
  }
  return out
}

async function resolveJjRev(cwd: string, ref: string): Promise<string> {
  const sha = await tryGit(cwd, ['rev-parse', '--verify', `${ref}^{commit}`])
  return sha && sha.length > 0 ? sha : ref
}

async function readRevMeta(cwd: string, rev: string, ignoreWorkingCopy: boolean, rootHint?: string): Promise<JjRevMeta | null> {
  try {
    const out = await execJj(
      cwd,
      ['-R', cwd, 'log', '-r', rev, '--no-graph', '-T', REV_META_TEMPLATE],
      { ignoreWorkingCopy, rootHint }
    )
    return parseJsonLines<JjRevMeta>(out)[0] ?? null
  } catch {
    return null
  }
}

async function readWorkingCopy(cwd: string, rootHint?: string): Promise<JjWorkingCopyRow | null> {
  const out = await execJj(
    cwd,
    ['-R', cwd, 'log', '-r', '@', '--no-graph', '-T', WORKING_COPY_TEMPLATE],
    { rootHint }
  )
  return parseJsonLines<JjWorkingCopyRow>(out)[0] ?? null
}

/**
 * The bookmark the workspace is on: one on the working-copy change itself, else null (detached).
 *
 * ⛔ Not `@-`. The pool puts a workspace on a branch by making the bookmarked change the working copy
 * (`switchBranch`), and detaches it with `jj new <target>` — which leaves the trunk's own bookmark on
 * `@-`, so reading `@-` reported a workspace detached at `main` as being on `main` (measured, jj 0.46).
 */
async function branchFromWorkingCopy(
  _cwd: string,
  wc: Pick<JjRevMeta, 'bookmarks'> | null,
  _rootHint?: string
): Promise<string | null> {
  return wc?.bookmarks[0] ?? null
}

async function readWorkspaceRows(project: Project): Promise<JjWorkspaceRow[]> {
  const out = await execJj(
    project.root,
    ['-R', project.root, 'workspace', 'list', '-T', WS_LIST_TEMPLATE],
    { ignoreWorkingCopy: true, rootHint: project.root }
  )
  return parseJsonLines<JjWorkspaceRow>(out)
}

async function listLocalBookmarks(cwd: string, rootHint?: string): Promise<Map<string, string>> {
  const out = await execJj(
    cwd,
    ['-R', cwd, 'bookmark', 'list', '-T', LOCAL_BOOKMARK_TEMPLATE],
    { ignoreWorkingCopy: true, rootHint }
  )
  const map = new Map<string, string>()
  for (const row of parseJsonLines<JjBookmarkRow>(out)) {
    map.set(row.name, row.target.join(','))
  }
  return map
}

async function fetchWithBookmarkGuard(
  cwd: string,
  remote: string,
  branch?: string,
  rootHint?: string
): Promise<void> {
  const before = await listLocalBookmarks(cwd, rootHint)
  const args = ['-R', cwd, 'git', 'fetch', '--remote', remote]
  if (branch) args.push('--branch', branch)
  await execJj(cwd, args, { ignoreWorkingCopy: true, rootHint })
  const after = await listLocalBookmarks(cwd, rootHint)

  for (const [name, prevTarget] of before) {
    const nextTarget = after.get(name)
    if (nextTarget === undefined) {
      log.warn(`jj git fetch dropped local bookmark "${name}" (was ${prevTarget}) in ${cwd}`)
    } else if (nextTarget !== prevTarget) {
      log.warn(
        `jj git fetch moved local bookmark "${name}" from ${prevTarget} to ${nextTarget} in ${cwd}`
      )
    }
  }
}

function buildRescueDescription(existing: string, fileCount: number): string {
  const trailerLine = `${RESCUE_TRAILER}: ${fileCount}`
  const existingRe = new RegExp(`^${RESCUE_TRAILER}: [0-9]+$`, 'm')
  if (existingRe.test(existing)) {
    return existing.replace(existingRe, trailerLine)
  }
  const trimmed = existing.trimEnd()
  if (trimmed.length > 0) {
    return `${trimmed}\n\n${trailerLine}`
  }
  return (
    `wip: ${fileCount} file(s) an interrupted run left behind\n\n` +
    'Warmstart described this working-copy change so the edits stay in jj history rather than being lost. ' +
    'Nothing here has been compiled, checked or reviewed. Amend it or build on it; it must not land as it stands.\n\n' +
    trailerLine
  )
}

function parseRescueCount(description: string): number | null {
  const match = new RegExp(`^${RESCUE_TRAILER}: ([0-9]+)$`, 'm').exec(description)
  return match ? Number(match[1]) : null
}

function isPlainBookmarkRefspec(refspec: string): boolean {
  return (
    refspec.length > 0 &&
    !refspec.includes(':') &&
    !refspec.startsWith('+') &&
    !refspec.startsWith('refs/')
  )
}

function fetchBranchFromRefspec(refspec?: string): string | undefined {
  if (!refspec) return undefined
  const clean = refspec.replace(/^\+/, '').split(':')[0] ?? ''
  if (!clean) return undefined
  if (clean.startsWith('refs/heads/')) return clean.slice('refs/heads/'.length)
  if (clean.startsWith('refs/')) return undefined
  return clean
}

function quoteJjRev(rev: string): string {
  return JSON.stringify(rev)
}

async function resolveGitSha(cwd: string, ref: string): Promise<string | null> {
  const sha = await tryGit(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  return sha && sha.length > 0 ? sha : null
}

async function describeUndescribedDirty(
  path: string,
  wc: JjWorkingCopyRow | null,
  destination: string,
  rootHint?: string
): Promise<Rescue | null> {
  if (!wc || wc.files.length === 0 || wc.desc.trim().length > 0) return null
  const files = wc.files.length
  const branch = wc.bookmarks[0] ?? null
  const message = buildRescueDescription(wc.desc, files)
  await execJj(path, ['-R', path, 'describe', '-r', '@', '-m', message], { rootHint })
  const updated = await readRevMeta(path, '@', true, rootHint)
  const sha = updated?.sha ?? wc.sha
  log.warn(`warmstart: ${files} file(s) left in ${path} before ${destination} — described as ${sha.slice(0, 8)}`)
  return { kind: 'commit', sha, files, branch }
}

/**
 * Report whether the diff between two commits in a colocated repo consists solely of CR-at-EOL
 * (`\r\n` vs `\n`) differences on tracked text files, with zero real content, mode, or binary changes.
 *
 * ⭐ Uses tree-to-tree `git diff` rather than working-tree diff so Git's index stat cache and
 * `core.autocrlf` never mask or fabricate differences (t1435, measured 2026-11-22 on Windows 11).
 */
export async function isPureLineEndingDiff(
  cwd: string,
  parentSha: string,
  wcSha: string
): Promise<boolean> {
  if (!parentSha || !wcSha || parentSha.toLowerCase() === wcSha.toLowerCase()) return false
  const [contentDiff, summary] = await Promise.all([
    tryGit(cwd, ['diff', '--ignore-cr-at-eol', '--name-only', parentSha, wcSha]),
    tryGit(cwd, ['diff', '--summary', parentSha, wcSha])
  ])
  if (contentDiff === null || summary === null) return false
  return contentDiff.trim().length === 0 && summary.trim().length === 0
}

/**
 * Report whether revision `rev` in a jj repository carries a stored conflict.
 * Landing uses this to refuse conflicted bookmarks even when files sit cleanly inside a commit.
 */
export async function jjConflicted(path: string, rev: string): Promise<boolean> {
  const out = await execJj(
    path,
    ['-R', path, 'log', '-r', rev, '--no-graph', '-T', 'if(conflict, "true", "false") ++ "\\n"'],
    { ignoreWorkingCopy: rev !== '@' }
  )
  return out.split(/\r?\n/).some((line) => line.trim() === 'true')
}

async function jjDiff(cwd: string, specs: string[]): Promise<DiffFileEntry[]>
async function jjDiff(cwd: string, specs: string[], path: string): Promise<string>
async function jjDiff(cwd: string, specs: string[], path?: string): Promise<DiffFileEntry[] | string> {
  await ensureJjReady(cwd)
  if (path !== undefined) return gitDriver.diff(cwd, specs, path)
  return gitDriver.diff(cwd, specs)
}

/**
 * Jujutsu (`jj`) implementation of `VcsDriver` for colocated repositories (`.jj` beside `.git`).
 *
 * Read-only git queries (`branchExists`, `commitsOnlyOn`, `landedRef`, `fileAt`, `diff`) delegate
 * to `gitDriver` because colocated bookmarks are immediately visible to git without export.
 */
export const jjDriver: VcsDriver = {
  capabilities: {
    sharedStore: true,
    autoSnapshot: true,
    storedConflicts: true,
    opLog: true,
    gitInterop: 'colocated',
    verification: 'jj 0.46.0 on Windows 11 (plan §9) and src/daemon/vcs/jj.test.ts'
  },

  async addWorkspace(project: Project, path: string, base: string): Promise<void> {
    await ensureJjReady(project.root)
    const rev = await resolveJjRev(project.root, base)
    await execJj(
      project.root,
      ['-R', project.root, 'workspace', 'add', '--name', basename(path), '-r', rev, path],
      { rootHint: project.root }
    )
  },

  async removeWorkspace(project: Project, path: string, _opts?: { prune?: boolean }): Promise<void> {
    await ensureJjReady(project.root)
    if (samePath(path, project.root)) {
      throw new Error(`Refusing to remove project root workspace: ${path}`)
    }
    const rows = await readWorkspaceRows(project)
    const matched = rows.find((row) => (row.root ? samePath(row.root, path) : false))
    const name = matched?.name ?? basename(path)
    if (name === 'default') {
      throw new Error(`Refusing to forget default workspace for project root: ${path}`)
    }
    await execJj(
      project.root,
      ['-R', project.root, 'workspace', 'forget', name],
      { ignoreWorkingCopy: true, rootHint: project.root }
    )
    if (existsSync(path)) {
      await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  },

  /**
   * Forget every workspace whose directory is gone (never `default`), then let git prune the
   * worktree metadata colocation created for it (§9 row 2: `workspace add` makes a git worktree).
   */
  async pruneWorkspaces(project: Project): Promise<void> {
    await ensureJjReady(project.root)
    for (const row of await readWorkspaceRows(project)) {
      if (row.name === 'default' || !row.root || existsSync(row.root)) continue
      await execJj(project.root, ['-R', project.root, 'workspace', 'forget', row.name], {
        ignoreWorkingCopy: true,
        rootHint: project.root
      })
    }
    await gitDriver.pruneWorkspaces({ ...project, vcs: 'git' })
  },

  /**
   * Put the workspace on `branch`, jj's way: the working-copy change **is** the bookmarked change, so
   * every snapshot lands on the task's bookmark and nothing has to be stashed or carried (the branch
   * is the carrier, AGENTS.md). Existing bookmark: `jj edit` it. New one: `jj new <base>` and create
   * the bookmark on that working-copy change.
   *
   * ⛔ Not `jj new <bookmark>` with the bookmark left on `@-`: a fresh task bookmark cut at the trunk
   * tip shares that commit with `main`, and `currentBranch` then read `main` back (measured, jj 0.46).
   * ⚠️ Open for wave 3: the new bookmark's working-copy change exists as a commit before anything is
   * written in it, which landing's "a branch that carries nothing" checks will have to account for.
   */
  async switchBranch(path: string, branch: string, createFromBase?: string): Promise<void> {
    await ensureJjReady(path)
    if (createFromBase === undefined) {
      await execJj(path, ['-R', path, 'edit', branch])
      return
    }
    const rev = await resolveJjRev(path, createFromBase)
    await execJj(path, ['-R', path, 'new', rev])
    await execJj(path, ['-R', path, 'bookmark', 'create', branch, '-r', '@'])
  },

  /** Leave the task's change behind (jj keeps it; nothing is stashed) and sit on `target`. */
  async detachWorkspace(path: string, target: string): Promise<void> {
    await ensureJjReady(path)
    const rev = await resolveJjRev(path, target)
    await execJj(path, ['-R', path, 'new', rev])
  },

  async listWorkspaces(project: Project): Promise<VcsWorkspaceEntry[]> {
    const entries: VcsWorkspaceEntry[] = []
    for (const row of await readWorkspaceRows(project)) {
      let wsPath = row.root
      if (!wsPath) {
        wsPath = await execJj(
          project.root,
          ['-R', project.root, 'workspace', 'root', '--name', row.name],
          { ignoreWorkingCopy: true, rootHint: project.root }
        )
      }
      entries.push({
        path: wsPath,
        branch: row.bookmarks[0] ?? null
      })
    }
    return entries
  },

  isWorkspace(path: string): boolean {
    return existsSync(join(path, '.jj')) && existsSync(join(path, '.git'))
  },

  async currentBranch(path: string): Promise<string | null> {
    await ensureJjReady(path)
    const at = await readRevMeta(path, '@', false)
    return branchFromWorkingCopy(path, at)
  },

  async trunkBranch(root: string, expectedTarget?: string): Promise<string | null> {
    await ensureJjReady(root)
    const pick = (bms: string[] | undefined): string | null => {
      if (!bms || bms.length === 0) return null
      return expectedTarget && bms.includes(expectedTarget) ? expectedTarget : (bms[0] ?? null)
    }
    const at = await readRevMeta(root, '@', false)
    if (at && at.bookmarks.length > 0) return pick(at.bookmarks)
    const parent = await readRevMeta(root, '@-', true)
    return pick(parent?.bookmarks)
  },

  async trunkNotReady(root: string, target: string): Promise<string | null> {
    try {
      await ensureJjReady(root)
      const wc = await readWorkingCopy(root)
      if (!wc) return `the trunk could not be read: missing working-copy change @ in ${root}`
      const parent = await readRevMeta(root, '@-', true)
      const targetConflicted = await jjConflicted(root, quoteJjRev(target)).catch(() => false)
      if (wc.conflict || targetConflicted) {
        return (
          `the trunk has unresolved stored conflicts on \`${target}\` or in its working copy — ` +
          `resolve them in ${root} before merging`
        )
      }
      if (wc.files.length > 0 && (wc.desc.trim().length === 0 || !wc.bookmarks.includes(target))) {
        const untracked = wc.files.filter((f) => f.status === 'added').length
        const tracked = wc.files.length - untracked
        const names = wc.files.slice(0, 5).map((f) => f.path).join(', ')
        const more = wc.files.length > 5 ? `, +${wc.files.length - 5} more` : ''
        const crlfOnly =
          untracked === 0 &&
          tracked > 0 &&
          Boolean(parent?.sha) &&
          (await isPureLineEndingDiff(root, parent!.sha, wc.sha).catch(() => false))
        const crlfHint = crlfOnly
          ? ` This is a line-ending-only diff (likely Git core.autocrlf=true vs jj raw snapshots); ` +
            `run \`jj -R "${root}" restore && git -C "${root}" config --local core.autocrlf false && git -C "${root}" read-tree HEAD\` if unintended.`
          : ''
        return (
          `the trunk has ${wc.files.length} uncommitted file(s) in it ` +
          `(${tracked} modified/tracked, ${untracked} untracked): ${names}${more}. ` +
          `Commit, describe, or clear them in the trunk checkout (${root}) so the merge can run${crlfHint}`
        )
      }
      if (wc.desc.trim().length > 0 && !wc.bookmarks.includes(target)) {
        const on = wc.bookmarks[0] ?? parent?.bookmarks[0]
        const where = on ? `\`${on}\`` : 'an unbookmarked working-copy change'
        return (
          `the trunk has ${where} checked out rather than \`${target}\` — ` +
          `run \`jj new ${target}\` in the trunk checkout to let the merge run`
        )
      }
      const onTarget =
        wc.bookmarks.includes(target) ||
        (wc.empty &&
          wc.files.length === 0 &&
          wc.desc.trim().length === 0 &&
          Boolean(parent?.bookmarks.includes(target)))
      if (!onTarget) {
        const current = wc.bookmarks[0] ?? parent?.bookmarks[0]
        const desc = current ? `\`${current}\`` : 'a detached change'
        return (
          `the trunk is on ${desc} rather than \`${target}\` — ` +
          `run \`jj new ${target}\` in the trunk checkout to let the merge run`
        )
      }
      return null
    } catch (err) {
      return `the trunk could not be read: ${errorMessage(err)}`
    }
  },

  async branchExists(project: Project, branch: string): Promise<boolean> {
    await ensureJjReady(project.root)
    // Colocated jj bookmarks mirror to git refs immediately; pass `vcs: 'git'` so the Phase 1
    // `projectUsesGitBranches` gate inside `worktrees.branchExists` does not short-circuit.
    return gitDriver.branchExists({ ...project, vcs: 'git' }, branch)
  },

  async createBranch(project: Project, branch: string, base?: string): Promise<void> {
    await ensureJjReady(project.root)
    const rawBase = base ?? (await trunkBaseRef(project))
    const rev = await resolveJjRev(project.root, rawBase)
    await execJj(
      project.root,
      ['-R', project.root, 'bookmark', 'create', branch, '-r', rev],
      { ignoreWorkingCopy: true, rootHint: project.root }
    )
  },

  async deleteBranch(project: Project, branch: string): Promise<void> {
    await execJj(
      project.root,
      ['-R', project.root, 'bookmark', 'delete', branch],
      { ignoreWorkingCopy: true, rootHint: project.root }
    )
  },

  async commitsOnlyOn(
    cwd: string,
    branch: string,
    target: string,
    also: readonly string[] = [],
    resolvedTargetRefs?: readonly string[]
  ): Promise<number> {
    await ensureJjReady(cwd)
    const branchSha = await resolveGitSha(cwd, branch)
    if (!branchSha) throw new Error(`\`${branch}\` does not resolve`)

    const excludeShas: string[] = []
    if (resolvedTargetRefs && resolvedTargetRefs.length > 0) {
      for (const ref of resolvedTargetRefs) {
        const sha = await resolveGitSha(cwd, ref)
        if (sha) excludeShas.push(sha)
      }
    } else {
      for (const ref of [target, `origin/${target}`]) {
        const sha = await resolveGitSha(cwd, ref)
        if (sha) excludeShas.push(sha)
      }
      if (excludeShas.length === 0) {
        throw new Error(`neither \`${target}\` nor \`origin/${target}\` resolves`)
      }
    }
    for (const ref of also) {
      if (ref === branch) continue
      const sha = await resolveGitSha(cwd, ref)
      if (sha) excludeShas.push(sha)
    }

    const excluded = [...new Set(excludeShas)].map((sha) => `::${sha}`).join(' | ')
    const revset = excluded
      ? `::${branchSha} ~ (${excluded}) ~ (empty() & description(exact:""))`
      : `::${branchSha} ~ (empty() & description(exact:""))`
    const out = await execJj(
      cwd,
      ['-R', cwd, 'log', '-r', revset, '--no-graph', '-T', 'commit_id ++ "\\n"'],
      { ignoreWorkingCopy: true }
    )
    return out.split(/\r?\n/).filter((line) => line.trim().length > 0).length
  },

  async landedRef(path: string, target: string): Promise<string> {
    await ensureJjReady(path)
    return gitDriver.landedRef(path, target)
  },

  async refreshTarget(project: Project, target: string): Promise<boolean> {
    await ensureJjReady(project.root)
    const now = Date.now()
    if (now - (lastTargetRefresh.get(project.id) ?? 0) < TARGET_REFRESH_MS) return false
    lastTargetRefresh.set(project.id, now)
    try {
      await fetchWithBookmarkGuard(project.root, 'origin', target, project.root)
      return true
    } catch {
      return false
    }
  },

  async park(project: Project, path: string): Promise<Rescue | null> {
    await ensureJjReady(project.root)
    if (samePath(path, project.root)) return null
    assertJjRootLength(resolveJjRepoRoot(path))
    if (!existsSync(path)) return null

    const rawBase = await trunkBaseRef(project)
    const baseRev = await resolveJjRev(project.root, rawBase)
    const wc = await readWorkingCopy(path, project.root)
    const rescued = await describeUndescribedDirty(path, wc, rawBase, project.root)
    await execJj(path, ['-R', path, 'new', baseRev], { rootHint: project.root })
    return rescued
  },

  async rescueDirty(path: string, destination: string): Promise<Rescue | null> {
    await ensureJjReady(path)
    if (!existsSync(path)) return null
    const wc = await readWorkingCopy(path)
    return describeUndescribedDirty(path, wc, destination)
  },

  async catchUpEmptyBranch(path: string, branch: string, base: string): Promise<void> {
    await ensureJjReady(path)
    try {
      if ((await jjDriver.commitsOnlyOn(path, branch, base)) !== 0) return
      const wc = await readWorkingCopy(path)
      if (!wc || wc.files.length > 0 || wc.desc.trim().length > 0) return
      const baseRev = await resolveJjRev(path, base)
      await execJj(path, ['-R', path, 'rebase', '-r', '@', '-d', baseRev])
      log.info(`rebased empty jj branch ${branch} onto ${base}`)
    } catch {
      // Best-effort, silently: branch carries work or base does not resolve.
    }
  },

  async rescue(path: string): Promise<{ sha: string; files: number } | null> {
    await ensureJjReady(path)
    if (!existsSync(path)) return null
    for (const rev of ['@', '@-'] as const) {
      const meta = await readRevMeta(path, rev, rev === '@-', undefined)
      if (!meta) continue
      const files = parseRescueCount(meta.desc)
      if (files !== null) {
        return { sha: meta.sha, files }
      }
    }
    return null
  },

  async workspaceState(path: string, target: string): Promise<WorkspaceState> {
    await ensureJjReady(path)
    const state: WorkspaceState = {
      path,
      branch: null,
      dirtyFiles: [],
      untrackedFiles: [],
      unlandedCommits: 0,
      landedRef: target,
      targetBehind: 0,
      stashes: 0,
      stashBranches: []
    }
    if (!existsSync(path)) return state

    try {
      const wc = await readWorkingCopy(path)
      if (wc) {
        state.branch = await branchFromWorkingCopy(path, wc)
        if (wc.desc.trim().length === 0) {
          for (const f of wc.files) {
            if (f.status === 'added') state.untrackedFiles.push(f.path)
            else state.dirtyFiles.push(f.path)
          }
        }
      }
    } catch {
      return state
    }

    try {
      state.landedRef = await gitDriver.landedRef(path, target)
    } catch {
      // Leave default landedRef when git cannot resolve origin/<target>.
    }

    if (state.branch) {
      try {
        state.unlandedCommits = await jjDriver.commitsOnlyOn(path, state.branch, target)
      } catch {
        // Leave 0 when target does not resolve yet.
      }
    }

    if (state.landedRef !== target) {
      try {
        const behind = await tryGit(path, ['rev-list', '--count', `${target}..${state.landedRef}`])
        state.targetBehind = Number.parseInt(behind ?? '', 10) || 0
      } catch {
        // Leave 0 when local target is absent.
      }
    }

    try {
      const stashOut = await tryGit(path, ['stash', 'list', '--format=%gs'])
      const stashes = (stashOut ?? '').split(/\r?\n/).filter(Boolean)
      state.stashes = stashes.length
      state.stashBranches = stashes.flatMap((subject) => {
        const match = /^(?:On|WIP on) (.+?):/.exec(subject)
        return match?.[1] ? [match[1]] : []
      })
    } catch {
      // No stash entries.
    }

    return state
  },

  async hasUncommittedChanges(workspacePath: string, opts?: { ignoreUntracked?: boolean }): Promise<boolean> {
    await ensureJjReady(workspacePath)
    const wc = await readWorkingCopy(workspacePath)
    if (!wc || wc.desc.trim().length > 0) return false
    if (opts?.ignoreUntracked) return wc.files.some((f) => f.status !== 'added')
    return wc.files.length > 0
  },

  async hasConflicts(cwd: string, rev: string): Promise<boolean> {
    return jjConflicted(cwd, rev)
  },

  async conflictedPaths(cwd: string, rev = '@'): Promise<string[]> {
    const out = await execJj(
      cwd,
      [
        '-R',
        cwd,
        'log',
        '-r',
        rev,
        '--no-graph',
        '-T',
        'conflicted_files.map(|f| json(f.path()) ++ "\\n").join("")'
      ],
      { ignoreWorkingCopy: rev !== '@' }
    )
    return [...new Set(parseJsonLines<string>(out))].sort()
  },

  async rebaseBranch(
    workspacePath: string,
    branch: string,
    base: string,
    opts?: { keepOnConflict?: boolean }
  ): Promise<VcsRebaseResult> {
    await ensureJjReady(workspacePath)
    const branchSha = await resolveJjRev(workspacePath, branch)
    const baseSha = await resolveJjRev(workspacePath, base)
    const opBefore = (
      await execJj(
        workspacePath,
        ['-R', workspacePath, 'op', 'log', '--limit', '1', '--no-graph', '-T', 'id'],
        { ignoreWorkingCopy: true }
      )
    ).trim()
    try {
      await execJj(workspacePath, ['-R', workspacePath, 'rebase', '-b', branchSha, '-d', baseSha])
    } catch (err) {
      return {
        ok: false,
        conflicted: false,
        reason: `rebase onto ${base} conflicted: ${errorMessage(err)}`
      }
    }

    const qBranch = quoteJjRev(branch)
    const conflictRevset = `(::${qBranch} ~ ::${baseSha}) | ${qBranch}`
    if (await jjConflicted(workspacePath, conflictRevset)) {
      const paths = await jjDriver.conflictedPaths(workspacePath, conflictRevset)
      const opAfter = (
        await execJj(
          workspacePath,
          ['-R', workspacePath, 'op', 'log', '--limit', '1', '--no-graph', '-T', 'id'],
          { ignoreWorkingCopy: true }
        )
      ).trim()
      if (opAfter && opAfter !== opBefore) {
        if (opts?.keepOnConflict) {
          pendingConflictRebaseOps.set(conflictRebaseKey(workspacePath), opAfter)
        } else {
          await execJj(workspacePath, ['-R', workspacePath, 'op', 'revert', opAfter])
        }
      }
      const suffix = paths.length > 0 ? `: ${paths.join(', ')}` : ''
      return {
        ok: false,
        conflicted: true,
        reason: `rebase onto ${base} conflicted${suffix}`,
        conflictedPaths: paths
      }
    }

    pendingConflictRebaseOps.delete(conflictRebaseKey(workspacePath))
    return { ok: true }
  },

  async abortRebase(workspacePath: string): Promise<void> {
    const key = conflictRebaseKey(workspacePath)
    const opId = pendingConflictRebaseOps.get(key)
    pendingConflictRebaseOps.delete(key)
    if (!opId) return
    await execJj(workspacePath, ['-R', workspacePath, 'op', 'revert', opId]).catch(() => undefined)
  },

  async fastForwardTrunk(project: Project, target: string, _branch: string, commit: string): Promise<void> {
    await ensureJjReady(project.root)
    await git(project.root, ['merge-base', '--is-ancestor', target, commit])
    await execJj(
      project.root,
      ['-R', project.root, 'bookmark', 'set', target, '-r', commit],
      { ignoreWorkingCopy: true, rootHint: project.root }
    )
    const wc = await readWorkingCopy(project.root)
    if (wc && wc.empty && wc.files.length === 0 && wc.desc.trim().length === 0) {
      await execJj(project.root, ['-R', project.root, 'new', quoteJjRev(target)], {
        rootHint: project.root
      })
    }
  },

  async fastForwardBranch(
    project: Project,
    workspacePath: string,
    target: string,
    commit: string,
    expectedBaseSha: string | null
  ): Promise<void> {
    await ensureJjReady(project.root)
    if (expectedBaseSha) {
      const current = await resolveGitSha(project.root, `refs/heads/${target}`)
      if (!current || current.toLowerCase() !== expectedBaseSha.toLowerCase()) {
        throw new Error(
          `\`${target}\` moved from ${expectedBaseSha.slice(0, 8)} to ${current?.slice(0, 8) ?? 'missing'}`
        )
      }
      await git(workspacePath, ['merge-base', '--is-ancestor', expectedBaseSha, commit])
    }
    await execJj(
      project.root,
      ['-R', project.root, 'bookmark', 'set', target, '-r', commit],
      { ignoreWorkingCopy: true, rootHint: project.root }
    )
  },

  async pushToTarget(cwd: string, remote: string, branch: string, target: string): Promise<void> {
    await ensureJjReady(cwd)
    const commitSha = await resolveGitSha(cwd, branch)
    if (!commitSha) throw new Error(`\`${branch}\` does not resolve to a commit`)
    await gitDriver.push(cwd, remote, `${commitSha}:refs/heads/${target}`)
    await jjDriver.fetch(cwd, remote, target)
  },

  async retireBranch(_cwd: string, project: Project, branch: string): Promise<boolean> {
    try {
      await jjDriver.deleteBranch(project, branch)
      return true
    } catch (err) {
      log.info(`kept ${branch}: ${errorMessage(err)}`)
      return false
    }
  },

  diff: jjDiff,

  async fileAt(cwd: string, rev: string, path: string): Promise<string | null> {
    await ensureJjReady(cwd)
    return gitDriver.fileAt(cwd, rev, path)
  },

  async push(cwd: string, remote: string, refspec: string, forceWithLease = false): Promise<void> {
    await ensureJjReady(cwd)
    if (isPlainBookmarkRefspec(refspec) && !forceWithLease) {
      await execJj(
        cwd,
        ['-R', cwd, 'git', 'push', '--remote', remote, '--bookmark', refspec],
        { ignoreWorkingCopy: true }
      )
      return
    }
    await gitDriver.push(cwd, remote, refspec, forceWithLease)
  },

  async fetch(cwd: string, remote: string, refspec?: string, _opts?: { prune?: boolean }): Promise<void> {
    await ensureJjReady(cwd)
    await fetchWithBookmarkGuard(cwd, remote, fetchBranchFromRefspec(refspec))
  }
}
