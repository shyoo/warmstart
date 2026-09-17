import { randomUUID } from 'node:crypto'
import type { DeliveryState, Project, PullRequestDelivery } from '@shared/tasks.js'
import { db, row, rows } from './db.js'
import { getProject, landingTargetFor } from './projects.js'
import { addMessage, getTask } from './tasks.js'
import { git, tryGit } from './git.js'
import { launchArgs, spawnEnv, which } from './which.js'
import * as spawn from './spawn.js'
import { errorMessage } from '@shared/errors.js'
import { log } from './log.js'
import { recordTaskCommits } from './taskcommits.js'
import { idlePoolHolder, taskBranches } from './worktrees.js'
import { emit } from './events.js'

export type { DeliveryState, PullRequestDelivery }

interface DeliveryRow {
  id: string
  task_id: string
  project_id: string
  url: string
  target: string
  branch: string
  head_sha: string
  state: DeliveryState
  merge_sha: string | null
  observed_at: number | null
  observation_error: string | null
  reconciled_at: number | null
  retire_blocked: string | null
}

interface GhPullRequest {
  state?: string
  baseRefName?: string
  headRefName?: string
  headRefOid?: string
  mergedAt?: string | null
  mergeCommit?: { oid?: string } | null
}

function toDelivery(r: DeliveryRow): PullRequestDelivery {
  return {
    id: r.id,
    taskId: r.task_id,
    projectId: r.project_id,
    url: r.url,
    target: r.target,
    branch: r.branch,
    headSha: r.head_sha,
    state: r.state,
    mergeSha: r.merge_sha,
    observedAt: r.observed_at,
    observationError: r.observation_error,
    reconciledAt: r.reconciled_at,
    retireBlocked: r.retire_blocked ?? null
  }
}

/**
 * The pull request URL in some text, or `undefined`.
 *
 * ⛔ **Only `/pull/<n>`, and the last one.** t389's second landing (2026-09-12) hit gh's "already
 * exists" error, whose message quotes the whole `gh pr create --title … --body …` command line
 * before gh's own URL — and the title named `…/issues/133`. The old "first `http…`" rule took it,
 * recorded an issue as the delivery, and `gh pr view` failed on it every sweep thereafter.
 */
export function pullRequestUrlIn(text: string): string | undefined {
  const found = text.match(/https?:\/\/[^\s)"'`<>]+\/pull\/\d+/gi)
  return found?.[found.length - 1]
}

/** Persist the exact PR identity before the run that opened it is allowed to disappear. */
export function recordPullRequestDelivery(input: {
  taskId: string
  projectId: string
  url: string
  target: string
  branch: string
  headSha: string
}): PullRequestDelivery {
  if (pullRequestUrlIn(input.url) !== input.url) {
    throw new Error(`\`${input.url}\` is not a pull request URL`)
  }
  const now = Date.now()
  db().prepare(
    `insert into task_deliveries
       (id, task_id, project_id, provider, url, target, branch, head_sha, state,
        created_at, updated_at)
     values (?, ?, ?, 'github', ?, ?, ?, ?, 'open', ?, ?)
     on conflict(url) do update set
       task_id = excluded.task_id, project_id = excluded.project_id,
       target = excluded.target, branch = excluded.branch, head_sha = excluded.head_sha,
       state = 'open', observation_error = null, reconciled_at = null, retire_blocked = null,
       updated_at = excluded.updated_at`
  ).run(
    randomUUID(), input.taskId, input.projectId, input.url, input.target, input.branch,
    input.headSha.toLowerCase(), now, now
  )
  const stored = row<DeliveryRow>(db().prepare('select * from task_deliveries where url = ?').get(input.url))
  if (!stored) throw new Error(`could not persist pull request delivery ${input.url}`)
  const delivery = toDelivery(stored)
  const project = getProject(input.projectId)
  if (project) emit({ type: 'project.changed', project })
  const task = getTask(input.taskId)
  if (task) emit({ type: 'task.changed', task })
  return delivery
}

export function deliveriesForTask(taskId: string): PullRequestDelivery[] {
  return rows<DeliveryRow>(
    db().prepare('select * from task_deliveries where task_id = ? order by created_at').all(taskId)
  ).map(toDelivery)
}

export function normalizePullRequest(raw: GhPullRequest): {
  state: DeliveryState
  target: string
  branch: string
  headSha: string
  mergeSha: string | null
} {
  const target = raw.baseRefName?.trim()
  const branch = raw.headRefName?.trim()
  const headSha = raw.headRefOid?.trim().toLowerCase()
  if (!target || !branch || !headSha || !/^[0-9a-f]{40}$/.test(headSha)) {
    throw new Error('GitHub returned an incomplete pull request identity')
  }
  const merged = Boolean(raw.mergedAt) || raw.state?.toUpperCase() === 'MERGED'
  const state: DeliveryState = merged
    ? 'merged'
    : raw.state?.toUpperCase() === 'CLOSED'
      ? 'closed_unmerged'
      : 'open'
  const mergeSha = raw.mergeCommit?.oid?.trim().toLowerCase() ?? null
  if (state === 'merged' && (!mergeSha || !/^[0-9a-f]{40}$/.test(mergeSha))) {
    throw new Error('GitHub reported a merged pull request without its merge commit')
  }
  return { state, target, branch, headSha, mergeSha }
}

export function mergedHeadMayRetire(
  localHead: string | null | undefined,
  acceptedHead: string,
  heldBy: string | null
): boolean {
  return heldBy === null && localHead?.toLowerCase() === acceptedHead.toLowerCase()
}

/** What became of a merged pull request's local branch. `reason` is written for the operator. */
export type RetireOutcome = { retired: true } | { retired: false; reason: string }

/**
 * Whether a worktree standing on a merged branch may be stepped off it.
 *
 * ⛔ **Only a pool member nobody has claimed, with nothing uncommitted.** An unclaimed member on a
 * finished task's branch is exactly what `parkWorkspace` would detach anyway. Anything else is
 * somebody's: a claim is a live or resting task, and every other worktree — the operator's own trunk
 * above all, which is where t389's branch was — is a checkout this tool has no business switching.
 */
export function holderVerdict(input: {
  branch: string
  target: string
  heldBy: string
  poolMember: boolean
  claimed: boolean
  dirty: boolean
}): { detach: true } | { detach: false; reason: string } {
  if (!input.poolMember) {
    return {
      detach: false,
      reason:
        `\`${input.heldBy}\` has \`${input.branch}\` checked out. Switch it to another branch there ` +
        `(\`git switch ${input.target}\`), then clean up again`
    }
  }
  if (input.claimed) {
    return { detach: false, reason: `a task is holding \`${input.heldBy}\`, which has \`${input.branch}\` checked out` }
  }
  if (input.dirty) {
    return {
      detach: false,
      reason: `\`${input.heldBy}\` has \`${input.branch}\` checked out with uncommitted files in it`
    }
  }
  return { detach: true }
}

/**
 * Delete the local name of a branch GitHub merged, when that loses nothing.
 *
 * ⛔ This is the chosen squash/rebase exception to ancestry retirement: the exact persisted PR says
 * it merged, and the local name still points at precisely the head GitHub accepted. A branch that
 * moved past that head holds commits the PR never had, and is kept.
 */
async function retireMergedBranch(delivery: PullRequestDelivery): Promise<RetireOutcome> {
  const project = getProject(delivery.projectId)
  if (!project || project.vcs !== 'git') {
    return { retired: false, reason: 'the project is not a git project any more' }
  }
  const branch = (await taskBranches(project, delivery.target)).find((b) => b.branch === delivery.branch)
  if (!branch) return { retired: true }
  if (branch.head !== delivery.headSha.toLowerCase()) {
    return {
      retired: false,
      reason:
        `\`${delivery.branch}\` has moved on to \`${branch.head.slice(0, 8)}\` since GitHub merged ` +
        `\`${delivery.headSha.slice(0, 8)}\`, so it holds work the pull request did not`
    }
  }
  if (branch.heldBy) {
    const verdict = await holderOf(project, delivery, branch.heldBy)
    if (!verdict.detach) return { retired: false, reason: verdict.reason }
    await git(branch.heldBy, ['switch', '--detach', branch.head])
  }
  await git(project.root, ['branch', '-D', delivery.branch])
  log.info(`retired ${delivery.branch}: exact pull request ${delivery.url} merged at ${delivery.headSha}`)
  return { retired: true }
}

async function holderOf(
  project: Project,
  delivery: PullRequestDelivery,
  heldBy: string
): Promise<ReturnType<typeof holderVerdict>> {
  const { poolMember, claimed, dirty } = await idlePoolHolder(project, heldBy)
  return holderVerdict({ branch: delivery.branch, target: delivery.target, heldBy, poolMember, claimed, dirty })
}

async function reconcileMerged(delivery: PullRequestDelivery): Promise<RetireOutcome> {
  const project = getProject(delivery.projectId)
  if (!project || !delivery.mergeSha) {
    return { retired: false, reason: 'GitHub has not named the merge commit' }
  }
  await git(project.root, ['fetch', 'origin', delivery.target])
  const base = (await tryGit(project.root, ['merge-base', delivery.mergeSha, `origin/${delivery.target}`]))
    ?.trim().toLowerCase()
  if (base !== delivery.mergeSha) {
    return {
      retired: false,
      reason: `the merge commit \`${delivery.mergeSha.slice(0, 8)}\` is not on \`origin/${delivery.target}\` yet`
    }
  }
  recordTaskCommits(
    delivery.taskId,
    [{ sha: delivery.mergeSha, subject: `Pull request merge: ${delivery.url}` }],
    delivery.target,
    'pull-request'
  )
  return retireMergedBranch(delivery)
}

/**
 * Close out a merged delivery: retire its branch, or say — once per distinct reason — why not.
 *
 * ⛔ **Said on the thread, and only when the reason changes.** Before migration 69 a refusal left no
 * trace, so t389 was re-refused every five minutes in silence while Loose ends offered to land work
 * that had already landed. A sentence repeated every sweep would be the same failure made loud.
 */
async function settleMerged(delivery: PullRequestDelivery): Promise<RetireOutcome> {
  const outcome = await reconcileMerged(delivery)
  const now = Date.now()
  if (outcome.retired) {
    db().prepare(
      'update task_deliveries set reconciled_at = ?, retire_blocked = null, updated_at = ? where id = ?'
    ).run(now, now, delivery.id)
    addMessage(
      delivery.taskId,
      'system',
      `Pull request merged as \`${delivery.mergeSha!.slice(0, 8)}\` into \`${delivery.target}\``,
      null,
      [],
      { detail: `GitHub reports ${delivery.url} merged. The unchanged local branch was retired.` }
    )
  } else if (outcome.reason !== delivery.retireBlocked) {
    db().prepare('update task_deliveries set retire_blocked = ?, updated_at = ? where id = ?')
      .run(outcome.reason, now, delivery.id)
    addMessage(
      delivery.taskId,
      'system',
      'Pull request merged — local branch kept',
      null,
      [],
      {
        detail:
          `GitHub reports ${delivery.url} merged, but \`${delivery.branch}\` was not retired: ` +
          `${outcome.reason}. It is checked again every five minutes, and **Clean up** under Loose ends ` +
          'checks it now.'
      }
    )
  }
  return outcome
}

async function observe(delivery: PullRequestDelivery): Promise<PullRequestDelivery> {
  const resolved = which('gh')
  const now = Date.now()
  let current = delivery
  if (resolved) {
    const call = launchArgs(resolved, [
      'pr', 'view', delivery.url, '--json',
      'state,baseRefName,headRefName,headRefOid,mergeCommit,mergedAt'
    ])
    try {
      const { stdout } = await spawn.run(call.command, call.args, {
        env: spawnEnv(),
        maxBuffer: 1024 * 1024,
        timeout: 30_000
      })
      const fact = normalizePullRequest(JSON.parse(stdout) as GhPullRequest)
      // Exact identity is monotonic: a changed base or head branch means this is no longer the
      // delivery Warmstart opened, so retain the last good fact and surface the mismatch as an error.
      if (fact.target !== delivery.target || fact.branch !== delivery.branch) {
        throw new Error(`pull request identity changed from ${delivery.branch} -> ${delivery.target}`)
      }
      db().prepare(
        `update task_deliveries set state = ?, head_sha = ?, merge_sha = ?, observed_at = ?,
           observation_error = null, updated_at = ? where id = ?`
      ).run(fact.state, fact.headSha, fact.mergeSha, now, now, delivery.id)
      current = { ...delivery, ...fact, observedAt: now, observationError: null }
      if (fact.state === 'closed_unmerged' && delivery.state !== 'closed_unmerged') {
        addMessage(
          delivery.taskId,
          'system',
          'Pull request closed without merging',
          null,
          [],
          { detail: `${delivery.url} closed without reaching \`${delivery.target}\`; the branch was kept.` }
        )
      }
    } catch (err) {
      db().prepare(
        'update task_deliveries set observed_at = ?, observation_error = ?, updated_at = ? where id = ?'
      ).run(now, errorMessage(err), now, delivery.id)
      current = { ...delivery, observedAt: now, observationError: errorMessage(err) }
    }
  }
  // ⚠️ Outside the observation, deliberately. A merge is monotonic — a merged PR stays merged — so a
  // gh that is missing or failing today does not stop a branch GitHub already reported merged from
  // being closed out on the fact already recorded.
  if (current.state === 'merged' && !current.reconciledAt) {
    try {
      await settleMerged(current)
    } catch (err) {
      db().prepare('update task_deliveries set observation_error = ?, updated_at = ? where id = ?')
        .run(errorMessage(err), Date.now(), delivery.id)
    }
  }
  return deliveryById(delivery.id) ?? current
}

function deliveryById(id: string): PullRequestDelivery | null {
  const found = row<DeliveryRow>(db().prepare('select * from task_deliveries where id = ?').get(id))
  return found ? toDelivery(found) : null
}

/**
 * The newest merged pull request recorded for this branch, if any.
 *
 * ⚠️ The newest *merged* one: a conversation may deliver the same branch name more than once, and a
 * later open PR does not un-merge an earlier one. Whether the local name still matches that PR's head
 * is the caller's question — only then is the branch nothing but a leftover.
 */
export function mergedDeliveryFor(projectId: string, branch: string): PullRequestDelivery | null {
  const found = row<DeliveryRow>(
    db().prepare(
      `select * from task_deliveries where project_id = ? and branch = ? and state = 'merged'
       order by coalesce(observed_at, created_at) desc limit 1`
    ).get(projectId, branch)
  )
  return found ? toDelivery(found) : null
}

/** The newest open pull request recorded for this branch, if any. */
export function openDeliveryFor(projectId: string, branch: string): PullRequestDelivery | null {
  const found = row<DeliveryRow>(
    db().prepare(
      `select * from task_deliveries where project_id = ? and branch = ? and state = 'open'
       order by coalesce(observed_at, created_at) desc limit 1`
    ).get(projectId, branch)
  )
  return found ? toDelivery(found) : null
}

/** All open pull requests across all projects that have not landed yet. */
export function pendingDeliveries(): PullRequestDelivery[] {
  return rows<DeliveryRow>(
    db().prepare(
      `select * from task_deliveries
       where state = 'open'
       order by created_at desc`
    ).all()
  ).map(toDelivery)
}

let reconciling = false

async function salvageAnnouncedDeliveries(): Promise<void> {
  const announced = rows<{ task_id: string; text: string }>(
    db().prepare(
      `select task_id, text from task_messages
       where text like 'Pull request opened for %http%'
       order by ts`
    ).all()
  )
  for (const message of announced) {
    const url = pullRequestUrlIn(message.text)
    if (!url) continue
    const exists = db().prepare('select 1 from task_deliveries where url = ?').get(url)
    if (exists) continue
    const task = getTask(message.task_id)
    const project = task?.projectId ? getProject(task.projectId) : null
    if (!task?.branch || !project || project.vcs !== 'git') continue
    const headSha = (await tryGit(project.root, ['rev-parse', `refs/heads/${task.branch}`]))
      ?.trim().toLowerCase()
    if (!headSha || !/^[0-9a-f]{40}$/.test(headSha)) continue
    recordPullRequestDelivery({
      taskId: task.id,
      projectId: project.id,
      url,
      target: landingTargetFor(task, project),
      branch: task.branch,
      headSha
    })
    log.info(`recovered pull request delivery for t${task.seq}: ${url}`)
  }
}

/** What one sweep found, for the operator who asked for it by hand. */
export interface DeliverySweep {
  /** `false` when a sweep was already running and this call did nothing. */
  ran: boolean
  checked: number
  cleanedUp: number
  kept: number
  failed: number
}

/** Zero-token, restart-safe observation of PRs that outlive their coding runs. */
export async function reconcilePullRequestDeliveries(): Promise<DeliverySweep> {
  if (reconciling) return { ran: false, checked: 0, cleanedUp: 0, kept: 0, failed: 0 }
  reconciling = true
  const sweep: DeliverySweep = { ran: true, checked: 0, cleanedUp: 0, kept: 0, failed: 0 }
  const affectedProjectIds = new Set<string>()
  const affectedTaskIds = new Set<string>()
  try {
    await salvageAnnouncedDeliveries()
    const pending = rows<DeliveryRow>(
      db().prepare(
        `select * from task_deliveries
         where state = 'open' or (state = 'merged' and reconciled_at is null)
         order by coalesce(observed_at, 0) limit 20`
      ).all()
    ).map(toDelivery)
    for (const delivery of pending) {
      const after = await observe(delivery)
      sweep.checked += 1
      if (after.observationError) sweep.failed += 1
      else if (after.state === 'merged' && after.reconciledAt) sweep.cleanedUp += 1
      else if (after.state === 'merged') sweep.kept += 1

      if (
        after.state !== delivery.state ||
        after.reconciledAt !== delivery.reconciledAt ||
        after.retireBlocked !== delivery.retireBlocked ||
        after.headSha !== delivery.headSha ||
        after.mergeSha !== delivery.mergeSha
      ) {
        affectedProjectIds.add(delivery.projectId)
        affectedTaskIds.add(delivery.taskId)
      }
    }
    for (const pid of affectedProjectIds) {
      const project = getProject(pid)
      if (project) emit({ type: 'project.changed', project })
    }
    for (const tid of affectedTaskIds) {
      const task = getTask(tid)
      if (task) emit({ type: 'task.changed', task })
    }
    return sweep
  } finally {
    reconciling = false
  }
}

/**
 * The operator's **Clean up** on a merged branch under Loose ends.
 *
 * ⛔ **Re-derives the licence rather than trusting the row.** The panel may be minutes old: the PR is
 * re-read from GitHub, the local head is compared with the merged head again, and the worktree
 * holding the branch is asked about again. What this may do is exactly what the sweep may do — the
 * click only makes it happen now and hands the reason back.
 *
 * ⚠️ `refresh: false` skips gh — for tests, which must not reach GitHub. The recorded merge still counts.
 */
export async function cleanUpMergedBranch(
  projectId: string,
  branch: string,
  opts: { refresh?: boolean } = {}
): Promise<{ deleted: boolean; reason?: string }> {
  const recorded = rows<DeliveryRow>(
    db().prepare(
      `select * from task_deliveries where project_id = ? and branch = ?
       order by coalesce(observed_at, created_at) desc`
    ).all(projectId, branch)
  ).map(toDelivery)
  const delivery = recorded.find((d) => d.state === 'merged') ?? recorded[0]
  if (!delivery) return { deleted: false, reason: `no pull request is recorded for \`${branch}\`` }
  const project = getProject(projectId)
  if (!project) return { deleted: false, reason: 'that project no longer exists' }

  // ⚠️ A delivery already reconciled whose name came back (a person re-created it) is not re-settled:
  // the refresh would skip it, so it falls through to the plain "still there" answer below.
  let after: PullRequestDelivery
  if (opts.refresh === false) {
    if (delivery.state === 'merged' && !delivery.reconciledAt) {
      try {
        await settleMerged(delivery)
      } catch (err) {
        return { deleted: false, reason: errorMessage(err) }
      }
    }
    after = deliveryById(delivery.id) ?? delivery
  } else {
    after = await observe(delivery)
  }

  if (after.state !== 'merged') {
    return {
      deleted: false,
      reason: after.observationError
        ? `could not read ${after.url} from GitHub: ${after.observationError}`
        : `GitHub reports ${after.url} as ${after.state === 'open' ? 'still open' : 'closed without merging'}`
    }
  }
  const stillThere = (await taskBranches(project, after.target)).some((b) => b.branch === branch)
  const deleted = !stillThere
  if (deleted || after.reconciledAt) {
    emit({ type: 'project.changed', project })
    const task = getTask(delivery.taskId)
    if (task) emit({ type: 'task.changed', task })
  }
  if (!stillThere) return { deleted: true }
  return { deleted: false, reason: after.retireBlocked ?? after.observationError ?? `\`${branch}\` was kept` }
}
