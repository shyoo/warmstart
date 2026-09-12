import { randomUUID } from 'node:crypto'
import { db, row, rows } from './db.js'
import { getProject, landingTargetFor } from './projects.js'
import { addMessage, getTask } from './tasks.js'
import { git, tryGit } from './git.js'
import { launchArgs, which } from './which.js'
import * as spawn from './spawn.js'
import { errorMessage } from '@shared/errors.js'
import { log } from './log.js'
import { recordTaskCommits } from './taskcommits.js'
import { taskBranches } from './worktrees.js'

export type DeliveryState = 'open' | 'merged' | 'closed_unmerged'

export interface PullRequestDelivery {
  id: string
  taskId: string
  projectId: string
  url: string
  target: string
  branch: string
  headSha: string
  state: DeliveryState
  mergeSha: string | null
  observedAt: number | null
  observationError: string | null
  reconciledAt: number | null
}

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
    reconciledAt: r.reconciled_at
  }
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
  const now = Date.now()
  db().prepare(
    `insert into task_deliveries
       (id, task_id, project_id, provider, url, target, branch, head_sha, state,
        created_at, updated_at)
     values (?, ?, ?, 'github', ?, ?, ?, ?, 'open', ?, ?)
     on conflict(url) do update set
       task_id = excluded.task_id, project_id = excluded.project_id,
       target = excluded.target, branch = excluded.branch, head_sha = excluded.head_sha,
       state = 'open', observation_error = null, reconciled_at = null, updated_at = excluded.updated_at`
  ).run(
    randomUUID(), input.taskId, input.projectId, input.url, input.target, input.branch,
    input.headSha.toLowerCase(), now, now
  )
  const stored = row<DeliveryRow>(db().prepare('select * from task_deliveries where url = ?').get(input.url))
  if (!stored) throw new Error(`could not persist pull request delivery ${input.url}`)
  return toDelivery(stored)
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

async function retireMergedBranch(delivery: PullRequestDelivery): Promise<boolean> {
  const project = getProject(delivery.projectId)
  if (!project || project.vcs !== 'git') return false
  const branch = (await taskBranches(project, delivery.target)).find((b) => b.branch === delivery.branch)
  if (!branch) return true
  const localHead = (await tryGit(project.root, ['rev-parse', `refs/heads/${delivery.branch}`]))?.trim().toLowerCase()
  // ⛔ This is the chosen squash/rebase exception to ancestry retirement: the exact persisted PR
  // says it merged, and the local name still points at precisely the head GitHub accepted.
  if (!mergedHeadMayRetire(localHead, delivery.headSha, branch.heldBy)) return false
  await git(project.root, ['branch', '-D', delivery.branch])
  log.info(`retired ${delivery.branch}: exact pull request ${delivery.url} merged at ${delivery.headSha}`)
  return true
}

async function reconcileMerged(delivery: PullRequestDelivery): Promise<boolean> {
  const project = getProject(delivery.projectId)
  if (!project || !delivery.mergeSha) return false
  await git(project.root, ['fetch', 'origin', delivery.target])
  const base = (await tryGit(project.root, ['merge-base', delivery.mergeSha, `origin/${delivery.target}`]))
    ?.trim().toLowerCase()
  if (base !== delivery.mergeSha) return false
  recordTaskCommits(
    delivery.taskId,
    [{ sha: delivery.mergeSha, subject: `Pull request merge: ${delivery.url}` }],
    delivery.target,
    'pull-request'
  )
  return retireMergedBranch(delivery)
}

async function observe(delivery: PullRequestDelivery): Promise<void> {
  const resolved = which('gh')
  if (!resolved) return
  const call = launchArgs(resolved, [
    'pr', 'view', delivery.url, '--json',
    'state,baseRefName,headRefName,headRefOid,mergeCommit,mergedAt'
  ])
  const now = Date.now()
  try {
    const { stdout } = await spawn.run(call.command, call.args, { maxBuffer: 1024 * 1024, timeout: 30_000 })
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
    const current = { ...delivery, ...fact, observedAt: now, observationError: null }
    if (fact.state === 'merged' && !delivery.reconciledAt && await reconcileMerged(current)) {
      db().prepare('update task_deliveries set reconciled_at = ?, updated_at = ? where id = ?')
        .run(now, now, delivery.id)
      addMessage(
        delivery.taskId,
        'system',
        `Pull request merged as \`${fact.mergeSha!.slice(0, 8)}\` into \`${delivery.target}\``,
        null,
        [],
        { detail: `GitHub reports ${delivery.url} merged. The unchanged local branch was retired.` }
      )
    } else if (fact.state === 'closed_unmerged' && delivery.state !== 'closed_unmerged') {
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
  }
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
    const url = /https:\/\/github\.com\/[^\s)]+\/pull\/\d+/i.exec(message.text)?.[0]
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

/** Zero-token, restart-safe observation of PRs that outlive their coding runs. */
export async function reconcilePullRequestDeliveries(): Promise<void> {
  if (reconciling) return
  reconciling = true
  try {
    await salvageAnnouncedDeliveries()
    const pending = rows<DeliveryRow>(
      db().prepare(
        `select * from task_deliveries
         where state = 'open' or (state = 'merged' and reconciled_at is null)
         order by coalesce(observed_at, 0) limit 20`
      ).all()
    ).map(toDelivery)
    for (const delivery of pending) await observe(delivery)
  } finally {
    reconciling = false
  }
}
