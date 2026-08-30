import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import type { LandingResult, LandingStrategyId, Project, ResourceClaim, Task } from '@shared/tasks.js'
import { policyFor } from './projects.js'
import { claim, landResourceId, openClaims, release, upsertResource } from './resources.js'
import { addDependency, addMessage, getTask, mandateAllows, setStatus } from './tasks.js'
import { landedRef } from './worktrees.js'
import { launchArgs, which } from './which.js'
import { log } from './log.js'

const run = promisify(execFile)

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

async function hasRemote(cwd: string): Promise<boolean> {
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
  branch: string
): Promise<MergeReading | null> {
  const target = policyFor(project).landingTarget
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
    const base = remote ? `origin/${target}` : target
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
function landingHolder(projectId: string, self: string): string | null {
  return openClaims(landResourceId(projectId)).find((c) => c.holder !== self)?.holder ?? null
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
async function awaitLandTurn(ctx: LandingContext): Promise<{
  lock: ResourceClaim | null
  queuedBehind: string | null
  gaveUp?: 'timeout' | 'cancelled'
}> {
  const resourceId = landResourceId(ctx.project.id)
  const first = claim(resourceId, ctx.task.id)
  // ⭐ The overwhelmingly common path: nobody else is landing, and this costs one synchronous query.
  if (first) return { lock: first, queuedBehind: null }

  const holder = landingHolder(ctx.project.id, ctx.task.id)
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
    return { ok: true }
  },

  async land(ctx): Promise<LandingResult> {
    const policy = policyFor(ctx.project)
    const target = policy.landingTarget

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
      const base = remote ? `origin/${target}` : target

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
        policy.landingTarget,
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
  'pull-request': pullRequest
}

export function strategyFor(project: Project): LandingStrategy {
  return STRATEGIES[policyFor(project).landingStrategy] ?? leaveBranch
}

/**
 * Land, or fall back honestly.
 *
 * ⛔ Nothing is ever forced. A task that cannot land keeps its branch, gets an `awaiting_human` entry
 * that says exactly why, and leaves the repository in a state a person can act on.
 */
export async function landTask(ctx: LandingContext): Promise<LandingResult> {
  const strategy = strategyFor(ctx.project)

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
    const target = policyFor(ctx.project).landingTarget
    const base = await landedRef(ctx.workspacePath, target)
    if ((await commitsAhead(ctx.workspacePath, ctx.branch, base)) === 0) {
      // ⛔ **Names the ref it compared.** This said `main` while comparing `origin/main`, which is
      // not a wording quibble: on 2026-08-29 t22's agent pushed its own commit to `origin/main`, and
      // the operator was told the branch carried nothing `main` did not have while their `main` was
      // two commits short of it. A message that names the wrong ref is worse than no message,
      // because it is checkable and it checks out false.
      // ⚠️ `?? 0` because a base git cannot resolve is not evidence the trunk is behind.
      const behind = (await commitsAhead(ctx.workspacePath, base, target)) ?? 0
      // ⭐ **And the branch goes, exactly as it does when landing succeeds.** The count above is the
      // licence: zero commits that `base` does not have means deleting the ref loses a name and
      // nothing else. Leaving it stranded was measured on 2026-08-29 — every task whose agent pushes
      // its own work left a dead branch, and this repo's own /commit skill makes that the *normal*
      // outcome, so the pool accumulated one per task until somebody swept them by hand.
      // ⚠️ Deliberately not conditional on `behind > 0`. A question-only task's branch is equally
      // contained and equally dead, and two rules here would be one more than the evidence supports.
      const retired = await finishWithoutLanding(ctx.workspacePath, ctx.branch, base)
      addMessage(
        ctx.task.id,
        'system',
        `Nothing to land: \`${ctx.branch}\` carries no commits that \`${base}\` does not already ` +
          'have, and the workspace is clean.' +
          (behind > 0
            ? ` The work reached \`${base}\` without passing through here — your \`${target}\` is ` +
              `${behind} commit(s) behind it, so run \`git pull\` in the trunk to see it.`
            : ' Work that answers a question rather than changing a file is finished here — the ' +
              'trunk was not touched.') +
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
    addMessage(
      ctx.task.id,
      'system',
      `Landed as ${result.commit?.slice(0, 8)} onto ${policyFor(ctx.project).landingTarget}.` +
        (behind ? ` It queued behind t${behind.seq} and landed once that finished.` : '')
    )
  }
  return result
}
