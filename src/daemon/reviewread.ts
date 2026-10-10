import type { ReviewCounts, ReviewFilter, ReviewQueuePage } from '@shared/quality.js'
import type { Project } from '@shared/tasks.js'
import { db, rows } from './db.js'
import { adapterLabels } from './adapters/index.js'
import { landingTargetFor, projectLandingTarget } from './projects.js'
import { pendingReviews, resolveRange } from './review.js'
import { reviewerAvailability } from './reviewer.js'
import { listWorkers } from './workers.js'

// Display evidence only. Commissioning a review always resolves the range afresh.
export const RANGE_FRESH_MS = 60_000
const RETRY_MS = 30_000
const FINISHED = `t.status = 'completed' and t.deleted_at is null
  and coalesce(t.stats_excluded, 0) = 0
  and exists(select 1 from runs r where r.task_id = t.id and r.kind = 'work')`

interface Candidate {
  id: string; seq: number; title: string; project_id: string | null; updated_at: number
  quality_review_count: number; quality_review_score: number | null; non_gradable: number
  branch: string | null; landed_base_sha: string | null; landed_head_sha: string | null
  landing_target: string | null; commits: string | null
  fingerprint: string | null; ok: number | null; reason: string | null; checked_at: number | null
}
interface Verdict { ok: boolean; reason: string; pending: boolean; checkedAt: number | null }
type RangeProject = Pick<Project, 'root' | 'config'>
interface Job { row: Candidate; project: RangeProject; fingerprint: string; target: string; projectTarget: string }
const jobs = new Map<string, Job>()
const active = new Set<string>()
const retries = new Map<string, number>()
let owner: ReturnType<typeof db> | null = null
let timer: ReturnType<typeof setTimeout> | null = null
const controllers = new Set<AbortController>()

/** Cancel display checks when their database owner changes; never leaves a Git child behind. */
export function stopReviewChecks(): void {
  if (timer) clearTimeout(timer)
  timer = null
  for (const controller of controllers) controller.abort()
  controllers.clear(); jobs.clear(); active.clear(); retries.clear()
  owner = null
}

function connection(): ReturnType<typeof db> {
  const current = db()
  if (owner !== current) {
    stopReviewChecks()
    owner = current
  }
  return current
}

function schedule(job: Job): void {
  if (!active.has(job.row.id)) jobs.set(job.row.id, job)
  if (!timer && jobs.size) {
    timer = setTimeout(drain, 10)
    timer.unref()
  }
}

function drain(): void {
  timer = null
  const conn = owner
  if (!conn) return
  // Two processes at most, rather than thousands of Git chains from Promise.all.
  while (active.size < 2 && jobs.size) {
    const [id, job] = jobs.entries().next().value!
    jobs.delete(id)
    active.add(id)
    void validate(job).then((result) => {
      if (db() !== conn || owner !== conn) return
      // A deleted task cannot receive evidence. Changed evidence is rejected on the next read.
      if (!conn.prepare('select 1 from tasks where id = ?').get(id)) return
      conn.prepare(`insert into review_range_cache values (?, ?, ?, ?, ?)
        on conflict(task_id) do update set fingerprint=excluded.fingerprint,
        ok=excluded.ok, reason=excluded.reason, checked_at=excluded.checked_at`)
        .run(id, job.fingerprint, result.ok ? 1 : 0, result.reason, Date.now())
      retries.delete(id)
    }).catch(() => {
      // Abort, timeout, missing executable or inaccessible repository: still unknown.
      if (owner === conn) retries.set(id, Date.now() + RETRY_MS)
    }).finally(() => {
      if (owner !== conn) return
      active.delete(id)
      if (jobs.size && !timer) {
        timer = setTimeout(drain, 10)
        timer.unref()
      }
    })
  }
}

async function validate(job: Job): Promise<{ ok: boolean; reason: string }> {
  const { row, project, target, projectTarget } = job
  const controller = new AbortController()
  controllers.add(controller)
  const timeout = setTimeout(() => controller.abort(), 4000)
  const signal = controller.signal
  // Distinguish an unavailable repository from a known missing commit/ref.
  const { git } = await import('./git.js')
  try {
    await git(project.root, ['rev-parse', '--git-dir'], { signal })
    const range = await resolveRange({ id: row.id, branch: row.branch,
      landedBaseSha: row.landed_base_sha, landedHeadSha: row.landed_head_sha },
    project, target, projectTarget, { signal })
    if (signal.aborted) throw new Error('range check interrupted')
    return range.ok ? { ok: true, reason: '' } : range
  } finally {
    clearTimeout(timeout)
    controllers.delete(controller)
  }
}

function snapshot(): { candidates: Candidate[]; verdicts: Map<string, Verdict>;
  authors: Map<string, { adapterId: string; model: string | null }[]>;
  graded: Map<string, { adapterId: string; model: string | null }[]> } {
  const conn = connection()
  const candidates = rows<Candidate>(conn.prepare(`select t.id, t.seq, substr(t.title,1,400) as title,
    t.project_id, t.updated_at, t.quality_review_count, t.quality_review_score, t.non_gradable,
    t.branch, t.landed_base_sha, t.landed_head_sha, t.landing_target,
    (select group_concat(sha) from (select sha from task_commits where task_id=t.id order by sha)) as commits,
    c.fingerprint, c.ok, c.reason, c.checked_at
    from tasks t left join review_range_cache c on c.task_id=t.id where ${FINISHED}
    order by t.updated_at desc, t.seq desc`).all())
  const authors = new Map<string, { adapterId: string; model: string | null }[]>()
  for (const r of rows<{ task_id: string; adapter_id: string; model: string | null }>(conn.prepare(
    `select r.task_id, r.adapter_id, r.model, max(r.started_at) as last_at
     from runs r join tasks t on t.id=r.task_id where ${FINISHED}
     and r.kind='work' and coalesce(r.outcome,'') <> 'failed' and r.adapter_id is not null
     group by r.task_id, r.adapter_id order by last_at`).all())) {
    authors.set(r.task_id, [...(authors.get(r.task_id) ?? []), { adapterId: r.adapter_id, model: r.model }])
  }
  const graded = new Map<string, { adapterId: string; model: string | null }[]>()
  for (const r of rows<{ task_id: string; reviewer_adapter: string; reviewer_model: string | null }>(conn.prepare(
    `select distinct q.task_id, q.reviewer_adapter, q.reviewer_model from quality_reviews q
     join tasks t on t.id=q.task_id where ${FINISHED} and q.status='complete' and q.composite is not null
     order by q.reviewer_adapter, q.reviewer_model`).all())) {
    graded.set(r.task_id, [...(graded.get(r.task_id) ?? []), { adapterId: r.reviewer_adapter, model: r.reviewer_model }])
  }
  const workers = listWorkers()
  const projects = new Map(rows<{ id: string; root: string; config_json: string }>(
    conn.prepare('select id, root, config_json from projects').all()
  ).map((p) => [p.id, { root: p.root, config: JSON.parse(p.config_json) as Project['config'] }]))
  const verdicts = new Map<string, Verdict>()
  for (const r of candidates) {
    const peers = reviewerAvailability({ id: r.id }, false, {
      authors: new Set(authors.get(r.id)?.map((a) => a.adapterId)),
      graded: new Set(graded.get(r.id)?.map((a) => a.adapterId)), workers
    })
    let verdict: Verdict = { ok: false, reason: '', pending: false, checkedAt: null }
    if (r.non_gradable) verdict.reason = 'marked non-gradable by operator'
    else if (!peers.eligible) verdict.reason = peers.reason
    else if (!r.project_id) verdict.ok = true
    else {
      const project = projects.get(r.project_id)
      if (!project) verdict.reason = 'this task has no project to read'
      else {
        const target = landingTargetFor({ landingTarget: r.landing_target }, project)
        const projectTarget = projectLandingTarget(project)
        const fingerprint = JSON.stringify([project.root, target, projectTarget,
          r.branch, r.landed_base_sha, r.landed_head_sha, r.commits])
        if (r.fingerprint === fingerprint && r.checked_at !== null && Date.now() - r.checked_at < RANGE_FRESH_MS) {
          verdict = { ok: r.ok === 1, reason: r.reason ?? '', pending: false, checkedAt: r.checked_at }
        } else {
          verdict.pending = true
          if ((retries.get(r.id) ?? 0) <= Date.now()) schedule({ row: r, project, target, projectTarget, fingerprint })
        }
      }
    }
    verdicts.set(r.id, verdict)
  }
  return { candidates, verdicts, authors, graded }
}

export function candidatePage(filter: ReviewFilter, limit: number, offset: number, gradableOnly: boolean): ReviewQueuePage {
  const { candidates, verdicts, authors, graded } = snapshot()
  const matching = candidates.filter((r) =>
    (filter === 'all' || (filter === 'none' ? r.quality_review_count === 0 :
      filter === 'one' ? r.quality_review_count === 1 : r.quality_review_count >= 2)) &&
    (!gradableOnly || verdicts.get(r.id)!.ok || verdicts.get(r.id)!.pending))
  const grading = new Set(pendingReviews().map((r) => r.taskId))
  const found = matching.slice(offset, offset + limit)
  // Move requested-page work ahead of the history scan, including on older pages.
  const priority = found.map((r) => [r.id, jobs.get(r.id)] as const).filter((entry) => entry[1])
  const rest = [...jobs].filter(([id]) => !found.some((r) => r.id === id))
  jobs.clear()
  for (const [id, job] of [...priority, ...rest]) if (job) jobs.set(id, job)
  return { total: matching.length, pending: matching.filter((r) => verdicts.get(r.id)!.pending).length,
    adapterLabels: adapterLabels(), rows: found.map((r) => {
      const v = verdicts.get(r.id)!
      const author = authors.get(r.id)?.at(-1)
      return { taskId: r.id, seq: r.seq, title: r.title, projectId: r.project_id, finishedAt: r.updated_at,
        adapterId: author?.adapterId ?? null, model: author?.model ?? null,
        reviewCount: r.quality_review_count, score: r.quality_review_score,
        gradedBy: graded.get(r.id) ?? [], eligible: v.ok, eligibilityPending: v.pending,
        eligibilityCheckedAt: v.checkedAt, ineligibleReason: v.reason, grading: grading.has(r.id) }
    }) }
}

export function candidateCoverage(): ReviewCounts {
  const { candidates, verdicts } = snapshot()
  const counts: ReviewCounts = { none: 0, one: 0, many: 0, total: 0, ungradable: 0 }
  let pending = 0
  for (const r of candidates) {
    const v = verdicts.get(r.id)!
    if (v.pending) pending++
    else if (!v.ok) counts.ungradable!++
    else {
      counts.total++
      if (r.quality_review_count === 0) counts.none++
      else if (r.quality_review_count === 1) counts.one++
      else counts.many++
    }
  }
  if (pending) counts.pending = pending
  return counts
}
