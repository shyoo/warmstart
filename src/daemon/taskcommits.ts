import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Project, TaskCommit } from '@shared/tasks.js'
import { db, rows } from './db.js'
import { listProjects, policyFor } from './projects.js'
import { log } from './log.js'

/**
 * Which commits a task put on its landing target — recorded when it lands, salvaged when it did not.
 *
 * ⛔ **A task is not always a range.** `landedBaseSha`/`landedHeadSha` describe `base..head`, which
 * is exact for the ordinary task (one landing, one commit) and wrong for a task that landed twice:
 * measured on this fleet 2026-09-05, **7** tasks landed more than once and t124's two landings have
 * five other tasks' commits between them. A range across that pair grades work nobody on this task
 * wrote. The rows here name the commits themselves, so nothing is interpolated from adjacency.
 *
 * ⛔ **Migration 39 declared this unrecoverable for everything that had already landed, and it was
 * looking in the wrong place.** It reasoned from `runs.trunk_sha_before`, which is read at dispatch
 * — before the rebase — and is therefore not a parent of what landed. But every successful landing
 * also writes *"Landed as `<sha>` onto `<target>`"* onto the task's own thread, and a thread message
 * outlives the branch, the workspace and the columns. `salvageLandedCommits` reads it back. Run
 * against a copy of this fleet's database on 2026-09-05 it recovered **207 commits across 200
 * tasks** and filled in **148** commit ranges, taking the gradable count from **51 of 233 tasks to
 * 199**. Eight announced shas no longer resolve, and those stay ungradable rather than guessed at.
 *
 * ⚠️ **Salvage attributes the commit that was named and nothing beside it.** A landing that put two
 * commits on the target names only its tip in that message, so the earlier one stays unattributed.
 * The alternative — walking back from the tip until something else claims a commit — would be a
 * guess: **141** of the 347 commits on this repository's `main` were landed by no task at all
 * (hand commits, merges, work from before the tool existed), and each of them sits directly behind
 * some task's tip. Under-attributing costs a partial diff. Over-attributing produces a grade of
 * somebody else's work that is indistinguishable from a real one.
 */

const run = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 })
  return stdout.replace(/\s+$/, '')
}

async function tryGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    return await git(cwd, args)
  } catch {
    return null
  }
}

interface CommitRow {
  task_id: string
  sha: string
  subject: string | null
  authored_at: number | null
  target: string | null
  recorded_at: number
  source: string
}

function toCommit(r: CommitRow): TaskCommit {
  return {
    sha: r.sha,
    subject: r.subject ?? null,
    authoredAt: r.authored_at ?? null,
    target: r.target ?? null,
    recordedAt: r.recorded_at,
    source: r.source === 'salvage' ? 'salvage' : 'landing'
  }
}

/**
 * Oldest first, which is the order they were written and the order a reviewer reads them in.
 *
 * ⚠️ Ordered by author date with `recorded_at` as the tie-break, never by SHA: a rebase rewrites
 * every SHA and preserves every author date, and these rows are read *after* the rebase.
 */
export function taskCommits(taskId: string): TaskCommit[] {
  return rows<CommitRow>(
    db()
      .prepare(
        `select * from task_commits where task_id = ?
          order by coalesce(authored_at, recorded_at), recorded_at, sha`
      )
      .all(taskId)
  ).map(toCommit)
}

export function taskCommitShas(taskId: string): string[] {
  return taskCommits(taskId).map((c) => c.sha)
}

/** The same read for many tasks at once — one statement, for a pane that lists a fleet. */
export function commitsForTasks(taskIds: string[]): Map<string, TaskCommit[]> {
  const out = new Map<string, TaskCommit[]>()
  if (taskIds.length === 0) return out
  const marks = taskIds.map(() => '?').join(', ')
  for (const r of rows<CommitRow>(
    db()
      .prepare(
        `select * from task_commits where task_id in (${marks})
          order by task_id, coalesce(authored_at, recorded_at), recorded_at, sha`
      )
      .all(...taskIds)
  )) {
    out.set(r.task_id, [...(out.get(r.task_id) ?? []), toCommit(r)])
  }
  return out
}

export interface RecordedCommit {
  sha: string
  subject?: string | null
  authoredAt?: number | null
}

/**
 * Remember commits this task landed.
 *
 * ⚠️ `insert or ignore`, so a task that lands a second time adds to its list rather than replacing
 * it, and re-running the salvage over a fleet that has already been salvaged writes nothing. The
 * primary key is `(task_id, sha)`: the same commit recorded twice is one row, and the *first*
 * recording — the one made by the landing, with `source = 'landing'` — is the one that survives.
 */
export function recordTaskCommits(
  taskId: string,
  commits: RecordedCommit[],
  target: string | null,
  source: 'landing' | 'salvage' = 'landing'
): number {
  const full = commits.filter((c) => /^[0-9a-f]{40}$/i.test(c.sha))
  if (full.length === 0) return 0
  const stmt = db().prepare(
    `insert or ignore into task_commits
       (task_id, sha, subject, authored_at, target, recorded_at, source)
     values (?, ?, ?, ?, ?, ?, ?)`
  )
  const now = Date.now()
  let written = 0
  for (const c of full) {
    const res = stmt.run(
      taskId,
      c.sha.toLowerCase(),
      c.subject ?? null,
      c.authoredAt ?? null,
      target,
      now,
      source
    )
    written += Number(res.changes ?? 0)
  }
  return written
}

// ⚠️ Nothing deletes these rows by hand: `task_commits.task_id` is `on delete cascade` and
// `pragma foreign_keys` is on, so the one hard delete in `cancel.ts` takes them with it.

// ---------------------------------------------------------------------------- reading git

/**
 * ⛔ **A unit separator, spelled `%x1f` so the byte is produced by git rather than passed to it.**
 * A NUL would be the obvious choice - no commit subject can contain one - but Windows builds a
 * child's command line as a NUL-terminated string, so `execFile` rejects any argument holding one
 * outright and every `git log` here failed with *"cannot read main"*. `%x1f` is plain ASCII on
 * the way in and a byte no commit subject contains on the way out.
 */
const SEP = '\u001f'
const FORMAT = '%H%x1f%at%x1f%s'

function parseLog(text: string): RecordedCommit[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.includes(SEP))
    .map((line) => {
      const [sha, at, ...rest] = line.split(SEP)
      const seconds = Number.parseInt(at ?? '', 10)
      return {
        sha: sha ?? '',
        authoredAt: Number.isFinite(seconds) ? seconds * 1000 : null,
        subject: rest.join(SEP) || null
      }
    })
    .filter((c) => /^[0-9a-f]{40}$/i.test(c.sha))
}

/**
 * The commits a landing actually put on the target, oldest first.
 *
 * ⚠️ `base..head` when the landing knew its base and `head` alone when it did not. A landing
 * strategy that cannot name a merge base (a pull-request flow that has not merged yet) still knows
 * the commit it made, and one commit recorded is worth more than a range refused.
 */
export async function landedCommits(
  cwd: string,
  base: string | null,
  head: string
): Promise<RecordedCommit[]> {
  const args = base
    ? ['log', '--reverse', `--format=${FORMAT}`, `${base}..${head}`]
    : ['log', '-1', `--format=${FORMAT}`, head]
  const text = await tryGit(cwd, args)
  return text ? parseLog(text) : []
}

// ---------------------------------------------------------------------------- salvage

/**
 * The headline of every successful landing, written by the one path they all go through:
 * *Landed as `98f200ab` onto `main`.*
 *
 * ⚠️ **Both spellings, because the message gained backticks after these rows were written.** The
 * sha and the target are now rendered as code in the thread, and a parser that demanded the old
 * bare form would silently stop salvaging every task landed since — silently being the whole
 * problem, since salvage reports what it found and cannot report what it did not recognise.
 */
const LANDED_AS = /Landed as `?([0-9a-f]{7,40})`? onto `?([^\s.`]+)`?/i

export interface SalvageReport {
  /** Tasks that gained at least one commit row. */
  tasks: number
  /** Commit rows written, which is larger than `tasks` for anything that landed twice. */
  commits: number
  /** Named in a thread message but no longer resolving in the project's history. */
  unresolved: number
  /** Tasks whose `landed_base_sha`/`landed_head_sha` this filled in as well. */
  ranges: number
}

interface LandingMessage {
  task_id: string
  project_id: string | null
  text: string
  ts: number
}

/**
 * Read every task's landed commits back out of its own thread, for the tasks that landed before
 * anything recorded them.
 *
 * ⛔ **Idempotent and additive — it never overwrites a recorded fact.** Commit rows are
 * `insert or ignore`, and the range columns are only written where they are currently null. Running
 * it on a fleet that has already been salvaged writes nothing and costs one `git log` per project.
 *
 * ⚠️ Resolves abbreviations against the target's own history in memory rather than by spawning
 * `git rev-parse` per message: 148 salvageable tasks on this fleet would otherwise be 148 process
 * spawns. An abbreviation that matches two commits is left unresolved rather than picked between.
 */
export async function salvageLandedCommits(): Promise<SalvageReport> {
  const report: SalvageReport = { tasks: 0, commits: 0, unresolved: 0, ranges: 0 }
  const projects: Project[] = listProjects()
  if (projects.length === 0) return report

  const messages = rows<LandingMessage>(
    db()
      .prepare(
        `select m.task_id, t.project_id, m.text, m.ts
           from task_messages m join tasks t on t.id = m.task_id
          where m.role = 'system' and m.text like 'Landed as %'
          order by m.ts, m.id`
      )
      .all()
  )
  if (messages.length === 0) return report

  const byProject = new Map<string, LandingMessage[]>()
  for (const m of messages) {
    if (!m.project_id) continue
    byProject.set(m.project_id, [...(byProject.get(m.project_id) ?? []), m])
  }

  for (const project of projects) {
    const pending = byProject.get(project.id)
    if (!pending || pending.length === 0) continue
    const target = policyFor(project).landingTarget
    // ⛔ Every commit reachable from the trunk, not `--first-parent`. A split child lands onto a
    // plan branch that is retired once the planner lands; its commits reach the trunk through the
    // planner's landing, and a first-parent walk would not necessarily see them.
    const history = await tryGit(project.root, ['log', `--format=${FORMAT}`, target])
    if (history === null) {
      log.warn(
        `salvage: cannot read ${target} in ${project.root}; skipped ${pending.length} landings`
      )
      continue
    }
    const index = indexHistory(parseLog(history))

    const found = new Map<string, Array<RecordedCommit & { target: string }>>()
    for (const m of pending) {
      const match = LANDED_AS.exec(m.text)
      // ⚠️ The target the message named, not the project's trunk: a split child lands onto its
      // planner's branch, and a row that claimed `main` would be describing a different landing.
      const landedOnto = match?.[2]
      if (!match?.[1] || !landedOnto) continue
      const resolved = index(match[1].toLowerCase())
      if (!resolved) {
        report.unresolved++
        continue
      }
      found.set(m.task_id, [...(found.get(m.task_id) ?? []), { ...resolved, target: landedOnto }])
    }

    for (const [taskId, list] of found) {
      let written = 0
      for (const c of list) written += recordTaskCommits(taskId, [c], c.target, 'salvage')
      report.commits += written
      if (written > 0) report.tasks++
      if (await fillRangeFromCommits(project.root, taskId)) report.ranges++
    }
  }

  if (report.tasks > 0 || report.unresolved > 0) {
    log.info(
      `salvaged landed commits: ${report.commits} commits across ${report.tasks} tasks, ` +
        `${report.ranges} commit ranges filled in, ${report.unresolved} shas no longer resolve`
    )
  }
  return report
}

/**
 * Resolve an abbreviated SHA against a history already in memory.
 *
 * ⚠️ Keyed by the first seven characters — the shortest abbreviation git prints — with every
 * candidate behind it, so a longer abbreviation narrows the list rather than missing the bucket. An
 * abbreviation that still matches two commits resolves to nothing: ambiguous is not a coin toss.
 */
function indexHistory(commits: RecordedCommit[]): (abbrev: string) => RecordedCommit | null {
  const exact = new Map<string, RecordedCommit>()
  const byPrefix = new Map<string, RecordedCommit[]>()
  for (const c of commits) {
    const sha = c.sha.toLowerCase()
    const normalised = { ...c, sha }
    exact.set(sha, normalised)
    const key = sha.slice(0, 7)
    byPrefix.set(key, [...(byPrefix.get(key) ?? []), normalised])
  }
  return (abbrev) => {
    const hit = exact.get(abbrev)
    if (hit) return hit
    const candidates = (byPrefix.get(abbrev.slice(0, 7)) ?? []).filter((c) =>
      c.sha.startsWith(abbrev)
    )
    return candidates.length === 1 ? (candidates[0] ?? null) : null
  }
}

/**
 * Fill `landed_base_sha`/`landed_head_sha` from the recorded commits, where a range can say the
 * same thing the rows do.
 *
 * ⛔ **The base is only written for a task with exactly one commit**, where `head^` is that commit's
 * own parent and the range is therefore exactly the task. A task with two landings has other tasks'
 * commits between them and no honest `base..head`; `resolveRange` reads the rows for those instead,
 * and a range invented here would be the wrong-diff failure the whole ladder exists to refuse.
 *
 * ⚠️ Never overwrites: `coalesce` in SQL keeps whatever a landing recorded at the time.
 */
async function fillRangeFromCommits(cwd: string, taskId: string): Promise<boolean> {
  const list = taskCommits(taskId)
  const head = list[list.length - 1]?.sha
  if (!head) return false
  const base = list.length === 1 ? await tryGit(cwd, ['rev-parse', `${head}^{commit}^`]) : null
  const res = db()
    .prepare(
      `update tasks
          set landed_head_sha = coalesce(landed_head_sha, ?),
              landed_base_sha = coalesce(landed_base_sha, ?)
        where id = ?
          and (landed_head_sha is null or landed_base_sha is null)`
    )
    .run(head, base, taskId)
  return Number(res.changes ?? 0) > 0
}
