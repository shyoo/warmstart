import { db, rows } from './db.js'
import { git } from './git.js'
import { log } from './log.js'
import { clearRangeCache, revokeReviews } from './review.js'
import { fillRangeFromCommits, taskCommits } from './taskcommits.js'
import { addMessage } from './tasks.js'

/**
 * Take off each task the commits it was recorded as landing and did not write.
 *
 * ⛔ **Why this exists** (t734, 2026-09-26). t731 answered a question and committed nothing, and its
 * thread said *"Landed as `ab96d6f5` onto `main`"* — t729's commit. The finish had counted the
 * branch against `origin/main` while inkland's local `main` was 5 commits ahead, so an empty branch
 * read as 5 commits; the rebase and fast-forward moved nothing, and `recordLandedCommits` kept the
 * tip it reported even though another task had already claimed it. `task_commits` is what the
 * quality review grades, so every such row is a grade of somebody else's work with this task's name
 * on it. Measured that day on a copy of the live database: **40** foreign commits across **19** tasks —
 * 12 carrying nothing else and 7 carrying their own work beside it — and **32** reviews revoked.
 *
 * ⭐ **Two proofs, and a row needs only one.** Each is a fact about the commit, never a guess from
 * adjacency:
 *  - *Claimed first*: another task recorded the same sha, onto the same target, earlier. Same target
 *    because a Plan & Split child lands onto its plan branch and the planner legitimately carries
 *    those commits on to the trunk. SQL only, so it runs on every boot.
 *  - *Already there*: the commit was an ancestor of the target when this task's first run started
 *    (`runs.trunk_sha_before`). Nothing a task starts can have written it. One `git` per row, so it
 *    runs once per database (`meta` key below) — the landing fixes of t734 stop new rows appearing.
 *
 * ⛔ **Then, for each task touched:** the rows are recorded in `disowned_commits` (so salvage cannot
 * write them back) and removed; the range columns are re-derived from what is left; every complete or
 * pending quality review is **revoked** — kept with its reason, out of every score; and one line on
 * the thread says what was wrong. ⚠️ Idempotent: a task with no foreign row left is not touched.
 */

const ANCESTRY_SWEPT = 'disown.ancestry.v1'

interface Foreign {
  taskId: string
  seq: number
  sha: string
  reason: string
}

export interface DisownReport {
  tasks: number
  commits: number
  reviewsRevoked: number
}

function claimedFirst(): Foreign[] {
  return rows<{ task_id: string; seq: number; sha: string; owner: number }>(
    db()
      .prepare(
        `select c.task_id, t.seq, c.sha,
                (select t2.seq from task_commits c2 join tasks t2 on t2.id = c2.task_id
                  where c2.sha = c.sha and c2.task_id <> c.task_id
                    and c2.recorded_at < c.recorded_at
                    and coalesce(c2.target, '') = coalesce(c.target, '')
                  order by c2.recorded_at limit 1) as owner
           from task_commits c join tasks t on t.id = c.task_id
          where exists (select 1 from task_commits c2
                         where c2.sha = c.sha and c2.task_id <> c.task_id
                           and c2.recorded_at < c.recorded_at
                           and coalesce(c2.target, '') = coalesce(c.target, ''))`
      )
      .all()
  ).map((r) => ({ taskId: r.task_id, seq: r.seq, sha: r.sha, reason: `landed earlier by t${r.owner}` }))
}

async function alreadyThere(): Promise<Foreign[]> {
  const candidates = rows<{ task_id: string; seq: number; sha: string; root: string; before: string | null }>(
    db()
      .prepare(
        `select c.task_id, t.seq, c.sha, p.root,
                (select r.trunk_sha_before from runs r
                  where r.task_id = t.id and r.trunk_sha_before is not null
                  order by r.started_at limit 1) as before
           from task_commits c
           join tasks t on t.id = c.task_id
           join projects p on p.id = t.project_id
          where p.vcs = 'git'`
      )
      .all()
  )
  const out: Foreign[] = []
  for (const c of candidates) {
    if (!c.before) continue
    try {
      await git(c.root, ['merge-base', '--is-ancestor', c.sha, c.before])
      out.push({
        taskId: c.task_id,
        seq: c.seq,
        sha: c.sha,
        reason: `already on the target at \`${c.before.slice(0, 8)}\`, before this task's first run started`
      })
    } catch {
      // Not an ancestor, or a repository or commit git cannot read: either way not proven foreign.
    }
  }
  return out
}

function ancestrySwept(): boolean {
  return Boolean(db().prepare('select 1 from meta where key = ?').get(ANCESTRY_SWEPT))
}

export async function disownForeignCommits(
  opts: { ancestry?: boolean } = {}
): Promise<DisownReport> {
  const report: DisownReport = { tasks: 0, commits: 0, reviewsRevoked: 0 }
  const runAncestry = opts.ancestry ?? !ancestrySwept()
  const found = [...claimedFirst(), ...(runAncestry ? await alreadyThere() : [])]

  const byTask = new Map<string, Foreign[]>()
  for (const f of found) {
    const list = byTask.get(f.taskId) ?? []
    // ⚠️ One reason per sha: a commit that is both claimed first and already there is one finding.
    if (!list.some((x) => x.sha === f.sha)) list.push(f)
    byTask.set(f.taskId, list)
  }

  for (const [taskId, foreign] of byTask) {
    const before = taskCommits(taskId).length
    const disown = db().prepare(
      'insert or ignore into disowned_commits (task_id, sha, reason, disowned_at) values (?, ?, ?, ?)'
    )
    const drop = db().prepare('delete from task_commits where task_id = ? and sha = ?')
    const now = Date.now()
    for (const f of foreign) {
      disown.run(taskId, f.sha, f.reason, now)
      drop.run(taskId, f.sha)
    }
    const left = taskCommits(taskId).length
    // ⛔ The range was written from the same false landing, and review level 2 would grade it.
    const project = db()
      .prepare('select p.root from tasks t join projects p on p.id = t.project_id where t.id = ?')
      .get(taskId) as { root: string } | undefined
    db().prepare('update tasks set landed_base_sha = null, landed_head_sha = null where id = ?').run(taskId)
    if (project && left > 0) await fillRangeFromCommits(project.root, taskId).catch(() => false)

    const seq = foreign[0]?.seq ?? 0
    const why =
      left === 0
        ? `t${seq}'s landing moved nothing of its own: every commit recorded for it was another task's`
        : `${foreign.length} of the ${before} commits recorded for t${seq} were another task's`
    const revoked = revokeReviews(taskId, `${why} (t734)`)

    const list = foreign.map((f) => `- \`${f.sha.slice(0, 8)}\` — ${f.reason}`).join('\n')
    addMessage(
      taskId,
      'system',
      left === 0
        ? 'Correction: this task landed nothing of its own'
        : `Correction: ${foreign.length} of ${before} commits recorded for this task were another task's`,
      null,
      [],
      {
        event: 'landing.corrected',
        detail:
          (left === 0
            ? "The *Landed as* line above named a commit this task did not write — the landing moved " +
              'nothing it had made. '
            : 'Some commits recorded as this task\'s landing were written by other tasks. ') +
          `Taken off this task:\n\n${list}\n\n` +
          (revoked > 0
            ? `${revoked} quality review(s) graded that work as this task's and were revoked; they no ` +
              'longer count toward any score. '
            : '') +
          (left > 0 ? `Its own ${left} commit(s) remain and can be reviewed again. ` : '') +
          'Found by the t734 sweep; nothing on the target was changed.'
      }
    )
    report.tasks++
    report.commits += foreign.length
    report.reviewsRevoked += revoked
  }

  if (runAncestry) {
    db().prepare('insert or replace into meta (key, value) values (?, ?)').run(ANCESTRY_SWEPT, String(Date.now()))
  }
  if (report.tasks > 0) {
    clearRangeCache()
    log.info(
      `disowned ${report.commits} foreign commit(s) across ${report.tasks} task(s); ` +
        `${report.reviewsRevoked} quality review(s) revoked`
    )
  }
  return report
}
