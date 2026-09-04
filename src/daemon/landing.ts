import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import type {
  FinishPolicy,
  LandingResult,
  LandingStrategyId,
  Project,
  ResourceClaim,
  Task
} from '@shared/tasks.js'
import { landingBaseFor, landingStrategyIdFor } from './landingbase.js'
import { landingTargetFor, policyFor } from './projects.js'
import { claim, landResourceId, openClaims, release, upsertResource } from './resources.js'
import {
  addDependency,
  addMessage,
  getTask,
  mandateAllows,
  recordLandedRange,
  setStatus
} from './tasks.js'
import { landedRef, parkOtherHolders, parkPooledHolders, rescueAtTip } from './worktrees.js'
import { launchArgs, which } from './which.js'
import { log } from './log.js'

const run = promisify(execFile)

// ⛔ Re-exported, not redefined: every existing caller keeps one import site and one answer.
export { landingBaseFor }

/**
 * Landing: what happens to a task's branch when the work is done.
 *
 * A **strategy interface**, not a branch in the code, because different projects genuinely want
 * different flows and the tool should not have an opinion about which. v1 ships `auto-land`;
 * `leave-branch` is the fallback everything degrades to; `pull-request` slots in later without the
 * scheduler, the workspace pool or the task model changing.
 *
 * ⛔ **Landing is serialised per project.** Three workspaces finishing at once would each rebase onto
 * an `origin/main` the other two are about to move, and the second and third would race. So landing
 * takes an exclusive `land:<project>` resource - which is not a special case, it is §10 doing exactly
 * what it exists for.
 */

export interface LandingContext {
  project: Project
  task: Task
  workspacePath: string
  branch: string
  /**
   * The **resolved** finish policy, which is what chooses the strategy.
   *
   * ⛔ Not the project's `landing.strategy`. That field is the pre-2026-08-28 spelling and
   * `strategyFor` still read it, so the policy resolved task > project > fleet and the strategy that
   * actually ran were two different answers to one question - a project with `finish: 'pull-request'`
   * and no `strategy` would have had its trunk pushed. The policy decides; the legacy field is a
   * fallback for `custom` only.
   */
  policy?: FinishPolicy
}

export interface LandingStrategy {
  id: LandingStrategyId
  canLand(ctx: LandingContext): Promise<{ ok: boolean; reason?: string }>
  land(ctx: LandingContext): Promise<LandingResult>
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 })
  return stdout.trim()
}

export async function hasRemote(cwd: string): Promise<boolean> {
  try {
    await git(cwd, ['remote', 'get-url', 'origin'])
    return true
  } catch {
    return false
  }
}

async function isClean(cwd: string): Promise<boolean> {
  return (await git(cwd, ['status', '--porcelain'])).length === 0
}

/**
 * Whether the branch tip is a commit **this tool** made, not one the agent wrote.
 *
 * ⛔ `rescueDirt` commits an interrupted run's uncommitted work onto its branch so the next run
 * inherits it (t91/t92, 2026-09-01). That is a rescue, not a result: nothing in it has been compiled,
 * and a clean working tree is exactly what it leaves behind — so `isClean` alone would wave it
 * through, and `auto-land` would push somebody's half-written afternoon onto the trunk.
 *
 * ⚠️ **Only the tip.** A rescue the agent then built on is ordinary history, and the checks that run
 * after the rebase are what judge the result. A tip that is *still* the rescue means the resumed run
 * added nothing of its own, and there is nothing here worth landing yet.
 */
async function tipIsRescue(cwd: string): Promise<boolean> {
  return (await rescueAtTip(cwd)) !== null
}

/**
 * Stashes this repository is holding that were taken off **this** branch.
 *
 * ⛔ **A clean workspace is not evidence the work was done.** `rescueDirt` moves an interrupted run's
 * uncommitted work out of the way, and when HEAD is detached it can only stash it — which leaves
 * behind precisely the state the "nothing to land" verdict reads as *the task answered a question and
 * changed no file*: a clean tree and a branch with no commits. t91 and t92 (2026-09-01) were that
 * shape, and the whole afternoon's work was in `git stash list` while the pipeline called it done.
 *
 * ⚠️ Attributed by branch, not counted globally. `WorkspaceState.stashes` is a repository-wide number
 * — every pool member reports the same list — and blocking a finish on a stash some other task left
 * behind would make the count of unrelated leftovers decide whether this task can complete. Git's own
 * `On <branch>:` prefix is what ties an entry to the run that made it.
 *
 * ⚠️ Never throws: a repository that cannot answer reports nothing rather than blocking a finish.
 */
async function stashesFrom(cwd: string, branch: string): Promise<number> {
  try {
    return (await git(cwd, ['stash', 'list', '--format=%gs']))
      .split(/\r?\n/)
      .filter((line) => line.startsWith(`On ${branch}:`) || line.startsWith(`WIP on ${branch}:`))
      .length
  } catch {
    return 0
  }
}

/** Said the same way by every strategy that would put this branch somewhere it cannot be taken back. */
const RESCUE_TIP_REASON =
  'the branch tip is uncommitted work rescued from an interrupted run, and nothing has been ' +
  'finished on top of it'

// ---------------------------------------------------------------------------- will it rebase?

/**
 * Whether this branch would rebase onto its target, asked **without touching anything**.
 *
 * ⭐ **The point of asking early.** Until 2026-08-30 a conflict was discovered inside `landTask`,
 * which is after `decideFinish` has already chosen `land` — so the one path that can hand a problem
 * back to the live conversation had been passed two branches earlier, and the conflict became a
 * dead-end `awaiting_human` instead. Measured on t39 and t43: both were cut from an older trunk,
 * neither was ever rebased while it ran, and both had to be resolved by hand.
 *
 * ⛔ `git merge-tree --write-tree` merges **in memory**: it writes objects, never the index or the
 * working tree, and exits non-zero with the conflicted paths on stdout. So this is safe to ask at
 * any moment, including while an agent is still working in the same workspace. Requires git ≥ 2.38;
 * measured against 2.54.0 on 2026-08-30.
 *
 * ⚠️ Returns `null` for *no reading* — not for "it is clean". A missing target, a git too old, a
 * repository that cannot be fetched. `decideFinish` treats null the way it treats a null `trunk`:
 * unknown is not innocence, but it is not evidence either, so it declines to fire.
 */
export interface MergeReading {
  /** What it was compared against — `origin/main`, or `main` on a project with no remote. */
  base: string
  clean: boolean
  /** Paths git reported as conflicting. Empty when `clean`. */
  conflictedPaths: string[]
  /**
   * A rebase this tool started and nobody finished.
   *
   * ⛔ Read *first* by `decideFinish`, because a conflicted working tree otherwise reads as
   * ordinary uncommitted work and gets the wrong sentence entirely.
   */
  rebaseInProgress: boolean
}

/** Is the workspace sitting in the middle of a rebase right now? */
async function rebaseInProgress(cwd: string): Promise<boolean> {
  try {
    const dir = await git(cwd, ['rev-parse', '--git-path', 'rebase-merge'])
    const apply = await git(cwd, ['rev-parse', '--git-path', 'rebase-apply'])
    return existsSync(resolve(cwd, dir)) || existsSync(resolve(cwd, apply))
  } catch {
    return false
  }
}

export async function readMergeability(
  project: Project,
  workspacePath: string,
  branch: string,
  policy?: FinishPolicy,
  task?: Pick<Task, 'landingTarget'> | null
): Promise<MergeReading | null> {
  const target = landingTargetFor(task, project)
  try {
    if (await rebaseInProgress(workspacePath)) {
      return {
        base: target,
        clean: false,
        conflictedPaths: await conflictedPaths(workspacePath),
        rebaseInProgress: true
      }
    }
    const remote = await hasRemote(workspacePath)
    // ⚠️ Fetch first or this answers about a target from whenever the workspace was last updated,
    // which is the staleness that caused the conflict in the first place.
    if (remote) await git(workspacePath, ['fetch', 'origin', '--prune'])
    // ⛛ Through `landingBaseFor`, so this asks about the ref the landing will really use. Reading
    // `origin/<target>` under a policy that rebases onto the local one is how t59 was told a
    // conflicted branch was clean.
    const base = landingBaseFor(project, policy, remote, task)
    // Both sides must resolve; a target that does not exist yet is no reading rather than a conflict.
    await git(workspacePath, ['rev-parse', '--verify', `${base}^{commit}`])
    try {
      await git(workspacePath, ['merge-tree', '--write-tree', base, branch])
      return { base, clean: true, conflictedPaths: [], rebaseInProgress: false }
    } catch (err) {
      // ⚠️ Non-zero is *conflicted*, which is an answer. It is also how git reports a bad argument,
      // so the paths are parsed out rather than the exit code trusted on its own.
      // ⚠️ `execFile` hangs the child's stdout off the error; typed loosely, so it is narrowed to a
      // string here rather than stringified blind.
      const raw = err instanceof Error && 'stdout' in err ? (err as { stdout?: unknown }).stdout : ''
      const out = typeof raw === 'string' ? raw : ''
      const paths = parseMergeTreeConflicts(out)
      if (paths.length === 0) {
        log.debug(`merge-tree gave no conflicted paths for ${branch}; treating as no reading`)
        return null
      }
      return { base, clean: false, conflictedPaths: paths, rebaseInProgress: false }
    }
  } catch (err) {
    log.debug(`could not read mergeability for ${branch}:`, err)
    return null
  }
}

/**
 * The conflicted paths out of `merge-tree`'s report.
 *
 * ⭐ **Read from the unmerged-index block, not from the prose.** The output has two halves: an oid,
 * then one `<mode> <oid> <stage>\t<path>` line per conflicted stage, then a blank line, then
 * human-readable messages. The first half is machine-readable by design and names every conflicted
 * path exactly; the second is English that varies by conflict type — `Merge conflict in x`,
 * `x deleted in A and modified in B`, rename pairs — and parsing it was a guess. Captured verbatim
 * in `__fixtures__/git-merge-tree-conflict.txt` (git 2.54.0, 2026-08-30).
 *
 * ⚠️ A path appears once per stage (1 = base, 2 = ours, 3 = theirs), so three lines are one file.
 * Deduplicated and sorted, because this list is read aloud to an agent.
 */
export function parseMergeTreeConflicts(stdout: string): string[] {
  const paths = new Set<string>()
  for (const line of stdout.split('\n')) {
    const clean = line.replace(/\r$/, '')
    // ⛔ Stop at the blank line. Everything past it is prose, and a filename in a sentence is not a
    // filename we can trust.
    if (clean === '') break
    const m = clean.match(/^\d{6} [0-9a-f]{40,64} [123]\t(.+)$/)
    if (m?.[1]) paths.add(m[1])
  }
  return [...paths].sort()
}

/** Paths git has marked unmerged in the index. */
async function conflictedPaths(cwd: string): Promise<string[]> {
  try {
    const out = await git(cwd, ['diff', '--name-only', '--diff-filter=U'])
    return out ? out.split('\n').map((l) => l.trim()).filter(Boolean) : []
  } catch {
    return []
  }
}

/**
 * Start the rebase and **leave it conflicted** for the agent to finish.
 *
 * ⛔ This is the half of the fix that matters. `landTask` aborts on conflict — correctly, because
 * nobody is holding that workspace — and an agent asked to fix an aborted rebase has to reproduce it
 * before it can start. Here the session is still live and still holds the workspace, so the conflict
 * markers are left exactly where the agent will look for them and `git rebase --continue` finishes
 * the job.
 *
 * ⚠️ **Every caller must abort on every path that gives up.** A workspace left mid-rebase cannot be
 * parked — `git switch` refuses — so a slot abandoned in this state is a slot lost until somebody
 * notices. `abortRebase` below is that undo, and `parkWorkspace` calls it defensively too.
 *
 * ⭐ A rebase that unexpectedly *succeeds* is reported, not treated as an error: between the probe
 * and here another task can land and take the conflict with it.
 */
export async function beginConflictResolution(
  workspacePath: string,
  base: string
): Promise<{ resolved: boolean; paths: string[] }> {
  try {
    await git(workspacePath, ['rebase', base])
    return { resolved: true, paths: [] }
  } catch {
    return { resolved: false, paths: await conflictedPaths(workspacePath) }
  }
}

/** Undo `beginConflictResolution`, so the workspace can be parked again. Safe to call blind. */
export async function abortRebase(workspacePath: string): Promise<void> {
  await git(workspacePath, ['rebase', '--abort']).catch(() => undefined)
}

/**
 * Retire a task branch whose commits are all accounted for.
 *
 * ⛔ **Only ever called where the caller has just proved the branch carries nothing that is not
 * already in the base** — `rev-list --count base..branch === 0`, or a push that has just put every
 * one of its commits there. That proof is the whole licence to use `-D`: there is no unmerged work
 * to lose, only a name.
 *
 * ⚠️ Detaches at the current commit rather than at the base, so nothing in the working tree moves.
 * Detaching at the base would *also* free the name, and would silently change the files under an
 * agent that is still looking at them.
 *
 * ⚠️ Returns `false` instead of throwing, because every reason this fails is somebody else's
 * business: another worktree still holds the branch, or the workspace has been taken away. A branch
 * that outlives its task is untidy; a finish that reports failure because of it is wrong.
 */
/**
 * Resolve a ref to a full SHA, or `null` when it does not resolve.
 *
 * ⚠️ Null rather than a throw, and every caller treats it as *"this landing recorded no reviewable
 * range"*. Failing a landing that otherwise worked because a bookkeeping read did not is the wrong
 * trade: the work is on the trunk either way, and the review that cannot be run later refuses on
 * its own terms with a sentence saying why.
 */
async function revParse(cwd: string, ref: string): Promise<string | null> {
  try {
    return await git(cwd, ['rev-parse', `${ref}^{commit}`])
  } catch {
    return null
  }
}

/** The commit two refs diverged from. Same null-not-throw contract as `revParse`. */
async function mergeBase(cwd: string, a: string, b: string): Promise<string | null> {
  try {
    return await git(cwd, ['merge-base', a, b])
  } catch {
    return null
  }
}

async function retireBranch(cwd: string, branch: string): Promise<boolean> {
  try {
    if ((await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])) === branch) {
      await git(cwd, ['switch', '--detach', await git(cwd, ['rev-parse', 'HEAD'])])
    }
    await git(cwd, ['branch', '-D', branch])
    return true
  } catch {
    return false
  }
}

/**
 * The tail of every finish that lands nothing: retire the branch, and say what became of it.
 *
 * ⛔ **Two callers, one rule, because the rule was applied in one place and needed in both.** The
 * `landTask` early return had it; `decideFinish`'s `nothing-to-land` verdict goes straight to
 * `completed` without ever calling `landTask`, so it did not. Measured 2026-08-29: once `landedRef`
 * made an agent-pushed branch legible as finished, *that* became the path every such task takes, and
 * the stranded branch went from occasional to one per task.
 *
 * ⚠️ The caller owes the proof. Both have it — a `rev-list` count of zero against `base` — and
 * neither should be re-deriving it here, where the result would be a third opinion on a question that
 * already has an authoritative answer.
 *
 * ⚠️ `note` is empty rather than an apology when the branch could not be retired. A branch another
 * worktree still holds is untidy, not a failure, and saying so in a finish message would spend the
 * operator's attention on something that costs them nothing.
 */
export async function finishWithoutLanding(
  workspacePath: string,
  branch: string,
  base: string
): Promise<{ deleted: boolean; note: string }> {
  const deleted = await retireBranch(workspacePath, branch)
  return {
    deleted,
    note: deleted
      ? ` The branch has been deleted; continuing this task cuts a fresh \`${branch}\` from ` +
        `\`${base}\`, so it starts from the work that landed rather than from behind it.`
      : ''
  }
}

/**
 * Say where the work actually is.
 *
 * ⚠️ This used to be one sentence — "The branch `x` is intact" — and on 2026-08-26 it was true and
 * useless at the same time. The branch existed, pointed at the base commit, and contained none of
 * the change; the only copy was an uncommitted file in a **pooled** workspace that the next dispatch
 * would have switched out from under. A branch name is not a location. A person reading this needs
 * to know whether their work survived and where to go and look for it.
 */
async function whereTheWorkIs(cwd: string, branch: string): Promise<string> {
  const dirty = (await git(cwd, ['status', '--porcelain'])).split('\n').filter(Boolean)
  const carried = (await git(cwd, ['log', '--oneline', branch, '--not', '--remotes', '--']))
    .split('\n')
    .filter(Boolean)

  if (dirty.length === 0) {
    return carried.length > 0
      ? `${carried.length} commit(s) are on \`${branch}\`, which is intact.`
      : `⚠️ Nothing was committed and nothing is uncommitted — \`${branch}\` holds no work.`
  }

  const named = dirty.slice(0, 5).map((line) => line.slice(3)).join(', ')
  const more = dirty.length > 5 ? `, +${dirty.length - 5} more` : ''
  const alsoCommitted =
    carried.length > 0
      ? ` \`${branch}\` does hold ${carried.length} earlier commit(s).`
      : ` \`${branch}\` holds no commits.`

  return (
    `⚠️ ${dirty.length} file(s) are **uncommitted** in \`${cwd}\` (${named}${more}) and are NOT on ` +
    `\`${branch}\`.${alsoCommitted} That workspace is pooled and will be reused, so commit or copy ` +
    `the work out before dispatching anything else.`
  )
}

/**
 * How many commits this branch carries that the landing target does not.
 *
 * ⛔ Asked **before** anything is landed, because zero is a completely different situation from one.
 * Measured on this machine 2026-08-27: a question-only task - "how long does the quota take to show
 * up?" - was answered, changed no file, and was then reported as *"Landed as a166a6a onto main"*.
 * Every step had succeeded: the workspace was clean, the rebase was a no-op, the checks passed, the
 * push moved nothing, and `rev-parse HEAD` dutifully returned the commit that was already there. A
 * pipeline of correct steps produced a sentence that was false.
 *
 * ⚠️ Counted against the **target**, not against `--remotes`. A branch can be ahead of every remote
 * and still carry nothing new for `main`.
 */
async function commitsAhead(cwd: string, branch: string, base: string): Promise<number | null> {
  try {
    return Number.parseInt(await git(cwd, ['rev-list', '--count', `${base}..${branch}`]), 10) || 0
  } catch {
    // An unknown base is not proof of an empty branch, and guessing here would silently skip landing
    // real work. Unknown means "carry on and let the strategy decide".
    return null
  }
}

/** Run the project's own checks. A project that declares none has consented to landing unchecked. */
async function runChecks(
  project: Project,
  cwd: string
): Promise<{ ok: boolean; output: string }> {
  const commands = policyFor(project).check
  let output = ''
  for (const command of commands) {
    try {
      const result = await run(command, {
        cwd,
        shell: true,
        maxBuffer: 8 * 1024 * 1024,
        timeout: 30 * 60 * 1000
      } as never)
      output += `$ ${command}\n${result.stdout}${result.stderr}\n`
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string }
      output += `$ ${command}\n${e.stdout ?? ''}${e.stderr ?? ''}${e.message ?? ''}\n`
      return { ok: false, output: output.slice(-8000) }
    }
  }
  return { ok: true, output: output.slice(-8000) }
}

/**
 * Run the project's checks against the branch as the agent committed it, and report. Moves nothing.
 *
 * ⛔ The commit is not conditional on the result — the daemon never authors or unwinds one. What the
 * check decides is the **verdict**: a red one rests the task carrying the output, and the commit
 * stays exactly where the agent put it.
 *
 * ⚠️ A project that declares no checks gets `ok: true` with a reason that says so. An empty list must
 * never read as a clean verification; that is the first day of every project.
 */
export const verifyOnly: LandingStrategy = {
  id: 'verify-only',

  async canLand(ctx) {
    if (ctx.project.vcs !== 'git') return { ok: false, reason: 'project is not a git repository' }
    if (!(await isClean(ctx.workspacePath))) {
      return { ok: false, reason: 'the workspace has uncommitted changes' }
    }
    return { ok: true }
  },

  async land(ctx): Promise<LandingResult> {
    if (policyFor(ctx.project).check.length === 0) {
      return {
        strategy: 'verify-only',
        ok: true,
        branch: ctx.branch,
        reason:
          `committed on \`${ctx.branch}\` — **nothing was verified**: this project declares no ` +
          'check commands. Add them in Project settings.'
      }
    }
    const checks = await runChecks(ctx.project, ctx.workspacePath)
    return checks.ok
      ? {
          strategy: 'verify-only',
          ok: true,
          branch: ctx.branch,
          reason: `committed on \`${ctx.branch}\` and the project checks passed`
        }
      : {
          strategy: 'verify-only',
          ok: false,
          branch: ctx.branch,
          reason: 'the project checks failed',
          checkOutput: checks.output
        }
  }
}

/**
 * Rebase, check, fast-forward the **local** trunk, retire the branch. Never touches a remote.
 *
 * ⛔ **Only into a clean trunk, and this is the constraint the whole policy is shaped around.** Git
 * refuses outright to update a branch a worktree holds — measured 2026-08-30: *"fatal: refusing to
 * fetch into branch 'refs/heads/main' checked out at ..."* — and the operator's own checkout is
 * normally that worktree. So the merge is a `merge --ff-only` **inside the trunk**, attempted only
 * when the trunk has nothing uncommitted in it.
 *
 * ⛔ And when it does not, the branch is kept and the task says so. The tool never stashes, resets,
 * or otherwise reaches into a checkout somebody is typing in — the operator's uncommitted work is
 * not the tool's to move.
 */
export const mergeLocal: LandingStrategy = {
  id: 'merge-local',

  async canLand(ctx) {
    if (ctx.project.vcs !== 'git') return { ok: false, reason: 'project is not a git repository' }
    if (!mandateAllows(ctx.task, 'land')) {
      return { ok: false, reason: 'the task has no authority to land' }
    }
    if (ctx.task.verification === 'required') {
      return { ok: false, reason: 'task requires human verification before landing' }
    }
    if (!(await isClean(ctx.workspacePath))) {
      return { ok: false, reason: 'the workspace has uncommitted changes' }
    }
    if (await tipIsRescue(ctx.workspacePath)) return { ok: false, reason: RESCUE_TIP_REASON }
    return { ok: true }
  },

  async land(ctx): Promise<LandingResult> {
    const target = landingTargetFor(ctx.task, ctx.project)

    upsertResource({
      id: landResourceId(ctx.project.id),
      projectId: ctx.project.id,
      kind: 'exclusive',
      label: `${ctx.project.name} landing`,
      capacity: 1
    })
    const turn = await awaitLandTurn(ctx)
    if (!turn.lock) {
      const waited = Math.round(landQueue.waitMs / 1000)
      return {
        strategy: 'merge-local',
        ok: false,
        branch: ctx.branch,
        reason:
          turn.gaveUp === 'cancelled'
            ? 'this task was cancelled while it was queued to land'
            : `another task is still landing after ${waited}s of waiting for a turn`,
        ...(turn.queuedBehind ? { contendedWith: turn.queuedBehind } : {})
      }
    }

    try {
      // ⚠️ The local target, never `origin/<target>`. Rebasing onto the remote would quietly make
      // this policy depend on a fetch, which is the thing it exists to avoid.
      //
      // ⛔ Through the same helper `readMergeability` asks, and that is the whole point: the two had
      // separate copies of this rule, disagreed on the default policy, and t59 was told its branch
      // was clean against `origin/main` and then failed rebasing onto `main`.
      const base = landingBaseFor(ctx.project, ctx.policy, false, ctx.task)
      try {
        await git(ctx.workspacePath, ['rebase', base])
      } catch (err) {
        await git(ctx.workspacePath, ['rebase', '--abort']).catch(() => undefined)
        return {
          strategy: 'merge-local',
          ok: false,
          branch: ctx.branch,
          reason: `rebase onto ${base} conflicted: ${err instanceof Error ? err.message : String(err)}`
        }
      }

      const checks = await runChecks(ctx.project, ctx.workspacePath)
      if (!checks.ok) {
        return {
          strategy: 'merge-local',
          ok: false,
          branch: ctx.branch,
          reason: 'the project checks failed after rebase',
          checkOutput: checks.output
        }
      }

      const commit = await git(ctx.workspacePath, ['rev-parse', 'HEAD'])
      // ⛔ Resolved *after* the rebase, which is the only moment it is the parent of what lands.
      // `runs.trunk_sha_before` is the same idea read at dispatch and is a different commit; the
      // whole point of recording this pair is that `retireBranch` below makes the branch unavailable
      // and nothing else identifies the task's commits afterwards. See `Task.landedBaseSha`.
      const baseSha = await revParse(ctx.workspacePath, base)

      if (target === policyFor(ctx.project).landingTarget) {
        // ⛔ The trunk has to be clean and on the target. Anything else and the work stays on its
        // branch with a sentence naming what is in the way, because the alternative is editing a
        // working tree somebody is using.
        const blocked = await trunkNotReady(ctx.project.root, target)
        if (blocked) {
          return {
            strategy: 'merge-local',
            ok: false,
            branch: ctx.branch,
            commit,
            reason:
              `committed and verified on \`${ctx.branch}\`, but not merged: ${blocked}. ` +
              'The branch is intact — merge it when the trunk is free.'
          }
        }

        try {
          await git(ctx.project.root, ['merge', '--ff-only', ctx.branch])
        } catch (err) {
          return {
            strategy: 'merge-local',
            ok: false,
            branch: ctx.branch,
            commit,
            reason:
              `committed and verified on \`${ctx.branch}\`, but the trunk would not fast-forward: ` +
              (err instanceof Error ? err.message : String(err))
          }
        }
      } else {
        // Landing into a non-trunk branch (such as the planner's branch)
        try {
          await parkOtherHolders(ctx.project, target, ctx.workspacePath)
          await git(ctx.project.root, ['branch', '-f', target, commit])
        } catch (err) {
          return {
            strategy: 'merge-local',
            ok: false,
            branch: ctx.branch,
            commit,
            reason:
              `committed and verified on \`${ctx.branch}\`, but could not update \`${target}\`: ` +
              (err instanceof Error ? err.message : String(err))
          }
        }
      }

      // The fast-forward above is the proof `retireBranch` requires: every commit on the branch is
      // now on the target.
      await retireBranch(ctx.workspacePath, ctx.branch)
      log.info(`merged t${ctx.task.seq} (${commit.slice(0, 8)}) into ${target}, not pushed`)
      return {
        strategy: 'merge-local',
        ok: true,
        commit,
        ...(baseSha ? { base: baseSha } : {}),
        branch: ctx.branch,
        reason:
          target === policyFor(ctx.project).landingTarget
            ? `merged into local \`${target}\` as ${commit.slice(0, 8)}. Not pushed.`
            : `merged into planner branch \`${target}\` as ${commit.slice(0, 8)}.`
      }
    } finally {
      release(turn.lock.id)
    }
  }
}

/**
 * Rebase, check, and fast-forward a target **ref** that is checked out nowhere.
 *
 * ⛔ **This exists because `merge-local` structurally cannot do it.** `merge-local` runs
 * `git merge --ff-only` *inside the operator's own trunk checkout* and is gated on that checkout
 * having the target branch checked out and clean — which is correct, because git refuses to update a
 * branch a worktree holds. Under Plan & Split a child lands onto its **planner's** branch, so under
 * `merge-local` every child would need the operator's own checkout parked on the plan branch. That
 * is never acceptable: the trunk is the operator's, and agents work in a pooled worktree.
 *
 * So the fast-forward is done with `update-ref`, from inside the child's own worktree, against a
 * branch nothing has checked out. ⛔ **The precondition is verified, not assumed.** It happens to be
 * true while children run — the planner is `blocked` and its workspace was parked on a detached HEAD
 * when phase 1 ended — but "true today" and "checked" are different things, and this is the one
 * place in the feature where being wrong corrupts a branch rather than failing a task.
 *
 * ⛔ **`update-ref` is given the old value.** The three-argument form fails if the ref has moved
 * since it was read, which makes the whole thing a compare-and-swap rather than a blind write: a
 * sibling that lands in the window between the ancestry proof and the write loses the race and
 * retries, instead of having its commits silently discarded.
 */
export const mergeBranch: LandingStrategy = {
  id: 'merge-branch',

  async canLand(ctx) {
    if (ctx.project.vcs !== 'git') return { ok: false, reason: 'project is not a git repository' }
    if (!mandateAllows(ctx.task, 'land')) {
      return { ok: false, reason: 'the task has no authority to land' }
    }
    if (ctx.task.verification === 'required') {
      return { ok: false, reason: 'task requires human verification before landing' }
    }
    if (!(await isClean(ctx.workspacePath))) {
      return { ok: false, reason: 'the workspace has uncommitted changes' }
    }
    if (await tipIsRescue(ctx.workspacePath)) return { ok: false, reason: RESCUE_TIP_REASON }
    return { ok: true }
  },

  async land(ctx): Promise<LandingResult> {
    const target = landingTargetFor(ctx.task, ctx.project)

    // ⛔ Keyed on the **branch**, not the project. Two siblings finishing together contend for the
    // plan branch, and nothing else in the fleet does — while an ordinary task landing onto `main`
    // in the same project must not be made to wait behind them. Same queue mechanism, different key.
    const resourceId = `land-branch:${ctx.project.id}:${target}`
    upsertResource({
      id: resourceId,
      projectId: ctx.project.id,
      kind: 'exclusive',
      label: `${ctx.project.name} ${target}`,
      capacity: 1
    })
    const turn = await awaitLandTurn(ctx, resourceId)
    if (!turn.lock) {
      const waited = Math.round(landQueue.waitMs / 1000)
      return {
        strategy: 'merge-branch',
        ok: false,
        branch: ctx.branch,
        reason:
          turn.gaveUp === 'cancelled'
            ? 'this task was cancelled while it was queued to land'
            : `another task is still landing onto \`${target}\` after ${waited}s of waiting`,
        ...(turn.queuedBehind ? { contendedWith: turn.queuedBehind } : {})
      }
    }

    try {
      // ⛔ **Park a pooled slot still sitting on the target — first, before the rebase.**
      //    This is the deadlock t197 hit, and it is structural rather than unlucky: the planner's own
      //    workspace holds the plan branch, and if parking it at the end of phase 1 did not take —
      //    a slot busy, a switch refused, a daemon restart — then every child of that plan is refused
      //    its landing for ever. The children rest at `awaiting_human`, which is not a settled status,
      //    so the planner stays `blocked` on them and nothing in the fleet can move any of it again.
      //    ⚠️ Only this tool's own pool members are freed. The operator's trunk, and any worktree
      //    they made themselves, are left where they are — so the refusal below still stands for the
      //    one kind of holder that actually means somebody is working.
      //    ⛔ **Before the rebase, not before the write.** Freeing a slot commits whatever an
      //    interrupted run left in it *onto the target*, so a park done later would move the target
      //    after this branch had already been rebased onto it — and the ancestry proof below would
      //    then refuse the landing it had just made possible.
      await parkPooledHolders(ctx.project, target, ctx.workspacePath)

      // ⚠️ The local ref always. A plan branch is never pushed — see `docs/landing.md` — so there is
      // no `origin/<target>` to prefer and asking for one would resolve to nothing.
      try {
        await git(ctx.workspacePath, ['rebase', target])
      } catch (err) {
        await git(ctx.workspacePath, ['rebase', '--abort']).catch(() => undefined)
        return {
          strategy: 'merge-branch',
          ok: false,
          branch: ctx.branch,
          reason: `rebase onto ${target} conflicted: ${err instanceof Error ? err.message : String(err)}`
        }
      }

      const checks = await runChecks(ctx.project, ctx.workspacePath)
      if (!checks.ok) {
        return {
          strategy: 'merge-branch',
          ok: false,
          branch: ctx.branch,
          reason: 'the project checks failed after rebase',
          checkOutput: checks.output
        }
      }

      const commit = await git(ctx.workspacePath, ['rev-parse', 'HEAD'])
      const baseSha = await revParse(ctx.workspacePath, target)

      // ⛔ The precondition, checked rather than trusted. A branch checked out in *any* worktree of
      // this repository — the operator's trunk or another pooled slot — must not be moved under it.
      const heldBy = await branchCheckedOutIn(ctx.workspacePath, target)
      if (heldBy) {
        return {
          strategy: 'merge-branch',
          ok: false,
          branch: ctx.branch,
          commit,
          reason:
            `committed and verified on \`${ctx.branch}\`, but not merged: \`${target}\` is ` +
            `checked out at ${heldBy}, and moving a branch a worktree holds is what git refuses ` +
            'outright. The branch is intact.'
        }
      }

      // ⛔ The ancestry proof. `update-ref` will happily move a branch backwards or sideways; only a
      // fast-forward is a merge. The rebase above should guarantee it, and this asks anyway, because
      // a merge strategy that silently does the wrong thing looks exactly like one that worked.
      if (baseSha && !(await isAncestorOf(ctx.workspacePath, baseSha, commit))) {
        return {
          strategy: 'merge-branch',
          ok: false,
          branch: ctx.branch,
          commit,
          reason:
            `committed and verified on \`${ctx.branch}\`, but \`${target}\` moved to a commit ` +
            'this branch does not contain, so the merge would not be a fast-forward. The branch is intact.'
        }
      }

      try {
        // ⛔ Compare-and-swap: the third argument is the value read above, so a sibling that landed
        // in between makes this fail rather than lose its commits.
        await git(ctx.workspacePath, [
          'update-ref',
          `refs/heads/${target}`,
          commit,
          ...(baseSha ? [baseSha] : [])
        ])
      } catch (err) {
        return {
          strategy: 'merge-branch',
          ok: false,
          branch: ctx.branch,
          commit,
          reason:
            `committed and verified on \`${ctx.branch}\`, but \`${target}\` would not ` +
            `fast-forward: ${err instanceof Error ? err.message : String(err)}`
        }
      }

      await retireBranch(ctx.workspacePath, ctx.branch)
      log.info(`merged t${ctx.task.seq} (${commit.slice(0, 8)}) into ${target} by ref, not pushed`)
      return {
        strategy: 'merge-branch',
        ok: true,
        commit,
        ...(baseSha ? { base: baseSha } : {}),
        branch: ctx.branch,
        reason: `merged into \`${target}\` as ${commit.slice(0, 8)}. Not pushed.`
      }
    } finally {
      release(turn.lock.id)
    }
  }
}

/**
 * Which worktree has this branch checked out, or null if none does.
 *
 * ⚠️ Reads `git worktree list --porcelain`, which enumerates the trunk *and* every pooled slot from
 * any one of them — so asking from inside a child's workspace still sees the operator's checkout.
 * ⛔ A failure to answer reads as *held*, not as free: this gate exists to protect a branch, and the
 * safe direction when git cannot be asked is to decline the merge.
 */
async function branchCheckedOutIn(cwd: string, branch: string): Promise<string | null> {
  let out: string
  try {
    out = await git(cwd, ['worktree', 'list', '--porcelain'])
  } catch {
    return 'an unreadable worktree list'
  }
  let path: string | null = null
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length).trim()
    else if (line.trim() === `branch refs/heads/${branch}`) return path ?? 'another worktree'
  }
  return null
}

async function isAncestorOf(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await git(cwd, ['merge-base', '--is-ancestor', ancestor, descendant])
    return true
  } catch {
    return false
  }
}

/**
 * Why the trunk cannot take a fast-forward right now, or null.
 *
 * ⚠️ Read-only. Three questions, and each one is a state the operator created deliberately: a dirty
 * tree, a detached HEAD, or a different branch checked out. None of them is an error, and none of
 * them is the tool's to fix.
 */
async function trunkNotReady(root: string, target: string): Promise<string | null> {
  try {
    const head = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
    if (head !== target) {
      return head === 'HEAD'
        ? `the trunk is on a detached HEAD rather than \`${target}\``
        : `the trunk has \`${head}\` checked out rather than \`${target}\``
    }
    const dirty = await git(root, ['status', '--porcelain'])
    if (dirty.trim()) {
      const count = dirty.trim().split(/\r?\n/).length
      return `the trunk has ${count} uncommitted file(s) in it`
    }
    return null
  } catch (err) {
    return `the trunk could not be read: ${err instanceof Error ? err.message : String(err)}`
  }
}

export const leaveBranch: LandingStrategy = {
  id: 'leave-branch',
  async canLand() {
    return { ok: true }
  },
  async land(ctx) {
    return { strategy: 'leave-branch', ok: true, branch: ctx.branch }
  }
}

/**
 * How long a task waits its turn to land, and how often it asks.
 *
 * ⚠️ **Mutable so the tests can shorten it, and written by nothing else.** Fifteen minutes is sized
 * against the thing actually being waited for: one landing is a fetch, a rebase, the project's own
 * checks — which `runChecks` allows thirty minutes *per command* — and a push. A wait shorter than a
 * plausible check run would turn every slow landing into the hand-off this exists to remove.
 */
export const landQueue = { waitMs: 15 * 60 * 1000, pollMs: 500 }

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Whoever is holding this project's landing lock, if it is not us. */
function landingHolder(resourceId: string, self: string): string | null {
  return openClaims(resourceId).find((c) => c.holder !== self)?.holder ?? null
}

/**
 * Record that this task landed after that one.
 *
 * ⚠️ Returns false rather than throwing on every refusal, because each one is a reason the *edge*
 * cannot exist and none of them is a reason not to land: the holder may be a task this fleet no
 * longer has, and the edge may already run the other way — t26 waiting on t27 while t27 already
 * declares it waits on t26 is a cycle `addDependency` is right to reject and wrong to fail a landing
 * over. The wait below is what serialises the two; the edge only records that it happened.
 */
function noteLandingOrder(taskId: string, holderId: string): boolean {
  if (holderId === taskId || !getTask(holderId)) return false
  try {
    addDependency(taskId, holderId)
    return true
  } catch (err) {
    log.debug(`no landing-order edge from ${taskId.slice(0, 8)} to ${holderId.slice(0, 8)}:`, err)
    return false
  }
}

/**
 * Queue behind whoever is landing, rather than losing to them.
 *
 * ⛔ **Measured 2026-08-29.** t26 and t27 finished within the same second; one landed and the other
 * was told *"Landing failed: another task is landing right now"* and handed to a person, with a real
 * commit sitting on an intact branch. Nothing was wrong with that branch — it had simply arrived
 * second at a door that admits one at a time. The lock was doing its job; the *caller* was treating a
 * queue as a failure.
 *
 * ⭐ **The wait happens inside the run that is already waiting.** The losing task holds its workspace
 * and its session for the duration either way, so polling costs nothing it was not already spending,
 * and — unlike releasing and re-dispatching — it cannot start a second agent over work that is
 * already finished.
 *
 * ⛔ **Which is also why the task is not moved to `blocked`.** The dependency edge is recorded so the
 * ordering is visible and durable, but `blocked` is the status of work waiting to be *dispatched*,
 * and `admitDependents` would walk this task to `ready` the moment the holder completed. A finished
 * task made ready is a task the scheduler will hand to an agent again. The edge is a fact; the status
 * would be an instruction, and the wrong one.
 *
 * ⚠️ Bounded, and it gives up on a cancel. An unbounded wait inside a completion is a deadlock with a
 * patient face, and a task the operator has cancelled must not go on holding a workspace to land work
 * they just said they did not want.
 */
async function awaitLandTurn(
  ctx: LandingContext,
  resourceId: string = landResourceId(ctx.project.id)
): Promise<{
  lock: ResourceClaim | null
  queuedBehind: string | null
  gaveUp?: 'timeout' | 'cancelled'
}> {
  const first = claim(resourceId, ctx.task.id)
  // ⭐ The overwhelmingly common path: nobody else is landing, and this costs one synchronous query.
  if (first) return { lock: first, queuedBehind: null }

  const holder = landingHolder(resourceId, ctx.task.id)
  const linked = holder ? noteLandingOrder(ctx.task.id, holder) : false
  const other = holder ? getTask(holder) : null
  addMessage(
    ctx.task.id,
    'system',
    `Waiting to land: ${other ? `t${other.seq} (${other.title})` : 'another task'} is landing right ` +
      'now, and landing is serialised per project so that two rebases cannot race for the trunk. ' +
      `This one is queued behind it${linked ? ' and now depends on it' : ''}, and will land by itself.`
  )
  log.info(`t${ctx.task.seq} is queued behind ${other ? `t${other.seq}` : 'another task'} to land`)

  const deadline = Date.now() + landQueue.waitMs
  while (Date.now() < deadline) {
    await sleep(landQueue.pollMs)
    const status = getTask(ctx.task.id)?.status
    if (status === 'cancelling' || status === 'cancelled') {
      return { lock: null, queuedBehind: holder, gaveUp: 'cancelled' }
    }
    const got = claim(resourceId, ctx.task.id)
    if (got) return { lock: got, queuedBehind: holder }
  }
  return { lock: null, queuedBehind: holder, gaveUp: 'timeout' }
}

export const autoLand: LandingStrategy = {
  id: 'auto-land',

  async canLand(ctx) {
    if (ctx.project.vcs !== 'git') return { ok: false, reason: 'project is not a git repository' }
    if (!mandateAllows(ctx.task, 'land')) {
      return { ok: false, reason: 'the task has no authority to land' }
    }
    if (ctx.task.verification === 'required') {
      return { ok: false, reason: 'task requires human verification before landing' }
    }
    if (!(await isClean(ctx.workspacePath))) {
      return { ok: false, reason: 'the workspace has uncommitted changes' }
    }
    if (await tipIsRescue(ctx.workspacePath)) return { ok: false, reason: RESCUE_TIP_REASON }
    return { ok: true }
  },

  async land(ctx): Promise<LandingResult> {
    const target = landingTargetFor(ctx.task, ctx.project)

    // ⛔ Exclusive for the whole of rebase-check-push. Released in `finally` without exception.
    upsertResource({
      id: landResourceId(ctx.project.id),
      projectId: ctx.project.id,
      kind: 'exclusive',
      label: `${ctx.project.name} landing`,
      capacity: 1
    })
    // ⭐ Waits its turn rather than losing the race. See `awaitLandTurn`.
    const turn = await awaitLandTurn(ctx)
    if (!turn.lock) {
      const waited = Math.round(landQueue.waitMs / 1000)
      return {
        strategy: 'auto-land',
        ok: false,
        branch: ctx.branch,
        reason:
          turn.gaveUp === 'cancelled'
            ? 'this task was cancelled while it was queued to land'
            : `another task is still landing after ${waited}s of waiting for a turn`,
        ...(turn.queuedBehind ? { contendedWith: turn.queuedBehind } : {})
      }
    }
    const lock = turn.lock

    try {
      const remote = await hasRemote(ctx.workspacePath)
      if (remote) await git(ctx.workspacePath, ['fetch', 'origin', '--prune'])
      // ⛔ The same helper `readMergeability` asks, so the check and the act cannot disagree.
      // ⚠️ With the task, so a branch whose target is not the project's trunk is rebased onto the
      // target it will actually be merged into.
      const base = landingBaseFor(ctx.project, ctx.policy, remote, ctx.task)

      try {
        await git(ctx.workspacePath, ['rebase', base])
      } catch (err) {
        // Leave nothing half-rebased for a person to discover later.
        await git(ctx.workspacePath, ['rebase', '--abort']).catch(() => undefined)
        return {
          strategy: 'auto-land',
          ok: false,
          branch: ctx.branch,
          reason: `rebase onto ${base} conflicted: ${err instanceof Error ? err.message : String(err)}`
        }
      }

      const checks = await runChecks(ctx.project, ctx.workspacePath)
      if (!checks.ok) {
        return {
          strategy: 'auto-land',
          ok: false,
          branch: ctx.branch,
          reason: 'the project checks failed after rebase',
          checkOutput: checks.output
        }
      }

      const commit = await git(ctx.workspacePath, ['rev-parse', 'HEAD'])
      // ⛔ After the rebase, for the reason `mergeLocal` states: `retireBranch` below is about to
      // make this range unrecoverable any other way.
      const baseSha = await revParse(ctx.workspacePath, base)

      if (remote) {
        await git(ctx.workspacePath, ['push', 'origin', `HEAD:${target}`])
      } else {
        // No remote: fast-forward the local target in the trunk instead. Same outcome, no invention.
        await git(ctx.project.root, ['fetch', ctx.workspacePath, `${ctx.branch}:${target}`])
      }

      // The push above is the proof `retireBranch` requires: every commit on the branch is now on
      // the target. ⚠️ HEAD is the landed commit here, so this detaches exactly where the two
      // hand-written lines it replaced did.
      await retireBranch(ctx.workspacePath, ctx.branch)

      log.info(`landed t${ctx.task.seq} (${commit.slice(0, 8)}) onto ${target}`)
      return {
        strategy: 'auto-land',
        ok: true,
        commit,
        ...(baseSha ? { base: baseSha } : {}),
        checkOutput: checks.output,
        // ⚠️ Carried on the *success* too, because "it landed, after waiting for t26" is the sentence
        // the operator who started both tasks needs, and it is the only evidence that the queue ran.
        ...(turn.queuedBehind ? { contendedWith: turn.queuedBehind } : {})
      }
    } catch (err) {
      return {
        strategy: 'auto-land',
        ok: false,
        branch: ctx.branch,
        reason: err instanceof Error ? err.message : String(err)
      }
    } finally {
      release(lock.id)
    }
  }
}

/**
 * Open a pull request instead of landing.
 *
 * ⛔ **`gh` is wrapped, never vendored** (D7). GitHub's API is a moving target with auth agentyard
 * has no business holding; `gh` already solves both and the operator already has it configured. If it
 * is absent, this refuses *before* doing anything rather than pushing a branch and then discovering
 * it cannot open the PR.
 *
 * ⚠️ The important difference from `auto-land`: this **does not rebase and does not run the project
 * checks**. A pull request exists so that CI and a person do that. Rebasing here would rewrite a
 * branch somebody is about to review, and running checks locally would duplicate what the PR is for.
 */
export const pullRequest: LandingStrategy = {
  id: 'pull-request',

  async canLand(ctx) {
    if (ctx.project.vcs !== 'git') return { ok: false, reason: 'project is not a git repository' }
    if (!mandateAllows(ctx.task, 'push')) {
      // ⛔ `push`, not `land`. Opening a PR does not put anything on the trunk, so it needs the
      // narrower authority - and a task that may only push should be able to use this strategy.
      return { ok: false, reason: 'the task has no authority to push' }
    }
    if (!(await isClean(ctx.workspacePath))) {
      return { ok: false, reason: 'the workspace has uncommitted changes' }
    }
    if (await tipIsRescue(ctx.workspacePath)) return { ok: false, reason: RESCUE_TIP_REASON }
    if (!(await hasRemote(ctx.workspacePath))) {
      return { ok: false, reason: 'no origin remote, so there is nowhere to open a pull request' }
    }
    if (!which('gh')) {
      return {
        ok: false,
        reason:
          'the GitHub CLI (`gh`) is not on PATH. Multi Agent Controller wraps it rather than talking to the ' +
          'GitHub API itself, so that it never holds a token of yours. Install it, or set the ' +
          "project's landing strategy to `leave-branch`."
      }
    }
    return { ok: true }
  },

  async land(ctx): Promise<LandingResult> {
    const policy = policyFor(ctx.project)
    try {
      // ⛔ Push first and separately. If the PR call fails, the work is already safe on the remote
      // and the operator can open one by hand - which is a much better failure than a branch that
      // exists only on this machine.
      await git(ctx.workspacePath, ['push', '--set-upstream', 'origin', ctx.branch])

      const commit = await git(ctx.workspacePath, ['rev-parse', 'HEAD'])
      // ⚠️ A merge base rather than the target's tip: this strategy does not rebase, so the target
      // may carry commits this branch does not. The merge base is the commit the branch actually
      // diverged from, which is the range a reviewer wants either way.
      const baseSha = await mergeBase(ctx.workspacePath, landingTargetFor(ctx.task, ctx.project), 'HEAD')
      const title = `t${ctx.task.seq}: ${ctx.task.title}`.slice(0, 120)
      const body = [
        ctx.task.handoffNote ? `${ctx.task.handoffNote}\n` : '',
        `Opened by Multi Agent Controller for task t${ctx.task.seq}.`,
        '',
        `- branch: \`${ctx.branch}\``,
        `- base: \`${policy.landingTarget}\``,
        '',
        '⚠️ Written by an agent. The project checks were **not** run locally — that is what this ' +
          'pull request is for.'
      ].join('\n')

      const resolved = which('gh')
      if (!resolved) throw new Error('gh vanished between the check and the call')
      const call = launchArgs(resolved, [
        'pr',
        'create',
        '--base',
        landingTargetFor(ctx.task, ctx.project),
        '--head',
        ctx.branch,
        '--title',
        title,
        '--body',
        body
      ])
      const { stdout } = await run(call.command, call.args, {
        cwd: ctx.workspacePath,
        maxBuffer: 4 * 1024 * 1024,
        timeout: 120_000
      })

      // `gh pr create` prints the URL and nothing else worth having.
      const prUrl = stdout.trim().split(/\s+/).find((line) => line.startsWith('http')) ?? undefined
      log.info(`opened a pull request for t${ctx.task.seq}: ${prUrl ?? 'url not reported'}`)
      return {
        strategy: 'pull-request',
        ok: true,
        commit,
        ...(baseSha ? { base: baseSha } : {}),
        branch: ctx.branch,
        ...(prUrl ? { prUrl } : {})
      }
    } catch (err) {
      // ⚠️ The branch is pushed by now in most failure paths, which is deliberate. Say so, rather
      // than leaving somebody to guess whether their work escaped the machine.
      return {
        strategy: 'pull-request',
        ok: false,
        branch: ctx.branch,
        reason:
          `${err instanceof Error ? err.message : String(err)} ` +
          `(the branch \`${ctx.branch}\` may already be pushed - check the remote before redoing work)`
      }
    }
  }
}

const STRATEGIES: Record<LandingStrategyId, LandingStrategy> = {
  'auto-land': autoLand,
  'leave-branch': leaveBranch,
  'pull-request': pullRequest,
  'verify-only': verifyOnly,
  'merge-local': mergeLocal,
  'merge-branch': mergeBranch
}

/**
 * ⛔ Through `landingStrategyIdFor`, which `worktrees.ts` reads too. The mapping used to live here,
 * where the file that cuts the branches could not see it — see `landingbase.ts` for what that cost.
 */
export function strategyFor(
  project: Project,
  policy?: FinishPolicy,
  task?: Pick<Task, 'landingTarget'> | null
): LandingStrategy {
  return STRATEGIES[landingStrategyIdFor(project, policy, task)] ?? leaveBranch
}

/**
 * Land, or fall back honestly.
 *
 * ⛔ Nothing is ever forced. A task that cannot land keeps its branch, gets an `awaiting_human` entry
 * that says exactly why, and leaves the repository in a state a person can act on.
 */
export async function landTask(ctx: LandingContext): Promise<LandingResult> {
  const strategy = strategyFor(ctx.project, ctx.policy, ctx.task)

  // ⛔ Before the strategy, and only when the workspace is clean. A task that produced **no commits**
  // has nothing to land, and saying "landed as <the commit that was already there>" is not a
  // harmless overstatement - it tells somebody their change reached the trunk. Uncommitted work is a
  // different case entirely and is left to `canLand`, which refuses it and says where the work is.
  // ⚠️ Not for a task that asked to be checked. "Nothing landed" is still an outcome its author
  // wanted to see before it was called done, and skipping the review because the diff turned out
  // empty decides that for them.
  if (
    ctx.project.vcs === 'git' &&
    ctx.task.verification !== 'required' &&
    (await isClean(ctx.workspacePath))
  ) {
    const target = landingTargetFor(ctx.task, ctx.project)
    const base = await landedRef(ctx.workspacePath, target)
    if ((await commitsAhead(ctx.workspacePath, ctx.branch, base)) === 0) {
      // ⛔ **Asked before the verdict, because the verdict is otherwise unfalsifiable.** Everything
      // this branch reads — a clean tree, a branch level with the trunk — is equally true of a task
      // that answered a question and of a task whose entire output was stashed out from under it.
      // The stash list is the one place those two differ, and nothing used to look at it.
      const stashed = await stashesFrom(ctx.workspacePath, ctx.branch)
      if (stashed > 0) {
        const reason =
          `\`${ctx.branch}\` has no commits and the workspace is clean, but this repository is ` +
          `holding ${stashed} stash(es) taken off that branch — the work an interrupted run left ` +
          'behind. That is not nothing to land.'
        addMessage(
          ctx.task.id,
          'system',
          `Not landed automatically: ${reason} ⚠️ Recover it with \`git stash list\` and ` +
            `\`git stash apply\` in ${ctx.workspacePath}. ⛔ The branch has been kept.`
        )
        setStatus(ctx.task.id, 'awaiting_human', {
          assignee: 'human',
          holdReason: `the work is in a stash, not on \`${ctx.branch}\``
        })
        return { strategy: strategy.id, ok: false, branch: ctx.branch, reason }
      }
      // ⛔ **Names the ref it compared.** This said `main` while comparing `origin/main`, which is
      // not a wording quibble: on 2026-08-29 t22's agent pushed its own commit to `origin/main`, and
      // the operator was told the branch carried nothing `main` did not have while their `main` was
      // two commits short of it. A message that names the wrong ref is worse than no message,
      // because it is checkable and it checks out false.
      const behind = (await commitsAhead(ctx.workspacePath, base, target)) ?? 0
      if (behind > 0) {
        const retired = await finishWithoutLanding(ctx.workspacePath, ctx.branch, base)
        addMessage(
          ctx.task.id,
          'system',
          `Nothing to land: \`${ctx.branch}\` carries no commits that \`${base}\` does not already ` +
            'have, and the workspace is clean.' +
            ` The work reached \`${base}\` without passing through here — your \`${target}\` is ` +
            `${behind} commit(s) behind it, so run \`git pull\` in the trunk to see it.` +
            retired.note
        )
        return {
          strategy: strategy.id,
          ok: true,
          branch: ctx.branch,
          nothingToLand: true,
          branchDeleted: retired.deleted
        }
      }
      // ⭐ Empty commit guard: if no commits were produced and no work landed, ask a person.
      const reason =
        `\`${ctx.branch}\` carries no commits that \`${base}\` does not already have and no work landed. ` +
        'Check if the agent answered as a question instead of making changes.'
      addMessage(
        ctx.task.id,
        'system',
        `Not landed: ${reason} ⛔ The branch has been kept.`
      )
      setStatus(ctx.task.id, 'awaiting_human', {
        assignee: 'human',
        holdReason: 'no commits were produced on this branch'
      })
      return {
        strategy: strategy.id,
        ok: false,
        branch: ctx.branch,
        reason
      }
    }
  }

  const allowed = await strategy.canLand(ctx)

  if (!allowed.ok) {
    const fallback = await leaveBranch.land(ctx)
    addMessage(
      ctx.task.id,
      'system',
      `Not landed automatically: ${allowed.reason}. ` +
        (await whereTheWorkIs(ctx.workspacePath, ctx.branch))
    )
    setStatus(ctx.task.id, 'awaiting_human', {
      assignee: 'human',
      holdReason: `the work is done but did not land: ${allowed.reason}`
    })
    return { ...fallback, ok: false, reason: allowed.reason }
  }

  const result = await strategy.land(ctx)
  // ⚠️ Named by seq, not by id. `contendedWith` is a task id because that is what the resource broker
  // records; an operator reading a message wants `t26`.
  const behind = result.contendedWith ? getTask(result.contendedWith) : null
  if (!result.ok) {
    addMessage(
      ctx.task.id,
      'system',
      `Landing failed: ${result.reason}. ` +
        (await whereTheWorkIs(ctx.workspacePath, ctx.branch)) +
        // ⭐ A task that failed *only* because it was queued has nothing wrong with it, and the action
        // is a retry rather than an investigation. That is the difference between an operator opening
        // a branch to find out what broke and an operator pressing one button.
        (result.contendedWith
          ? ' Nothing is wrong with the branch — it waited its turn behind ' +
            `${behind ? `t${behind.seq}` : 'another task'} and the wait ran out. Landing it again is ` +
            'all this needs.'
          : '') +
        (result.checkOutput ? `\n\n${result.checkOutput.slice(-2000)}` : '')
    )
    setStatus(ctx.task.id, 'awaiting_human', {
      assignee: 'human',
      holdReason: `landing failed: ${result.reason}`
    })
  } else {
    // ⛔ **Written here, on the one path every strategy's success goes through.** The branch this
    // range names has usually just been deleted by `retireBranch`, and after that nothing else in
    // the system can say which commits on the trunk were this task's. A task that lands without
    // this recorded is permanently unreviewable — there is no backfill, only a refusal later.
    recordLandedRange(ctx.task.id, result.base ?? null, result.commit ?? null)
    addMessage(
      ctx.task.id,
      'system',
      `Landed as ${result.commit?.slice(0, 8)} onto ${landingTargetFor(ctx.task, ctx.project)}.` +
        (behind ? ` It queued behind t${behind.seq} and landed once that finished.` : '')
    )
  }
  return result
}
