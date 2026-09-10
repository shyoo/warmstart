/**
 * Shared L1 fixture builders: the one place a suite seeds rows.
 *
 * ⛔ **This file is the union of ~25 near-duplicate builders, not a 26th variant.** Every
 * signature below was fixed only after reading every copy it replaces (`seedWorker` ×8,
 * `seedSession` ×6, `makeTask` ×5, `makeProject` ×5, `git` ×5, `pinnedTask` ×3,
 * `seedRun`/`seedQuota`/`seedReading`/`makeRepo` ×2 each — measured 2026-09-07), and each takes
 * the union of the options its copies take, so no suite needs a private variant. If a new suite
 * needs an option that is not here, add it here rather than forking a local copy.
 *
 * ⚠️ **Deliberately not migrated in one sweep.** Suites adopt these when they are already being
 * edited; a 41-file mechanical rewrite is the change whose review nobody finishes, and it would
 * collide with every refactor in flight. The first three are the `pinnedTask` copies, which were
 * byte-identical apart from a default title.
 *
 * ⛔ **Not bundled and must never be.** `electron.vite.config.ts` names its entry points
 * explicitly (`index`, `orchestratord`, `agentyard-mcp`, `local-llm-bridge`) and nothing that
 * ships imports this file. It is `import`ed by `*.test.ts` only — `docs.test.ts` fails on a
 * `src/…` path a doc cites that no longer exists, so keep it that way.
 *
 * Variants that stay local, and why:
 * - In-memory `Task` objects (`exploration`, `scheduling` `makeTask`): no rows, no schema
 *   coupling — the thing this file exists to remove. They are not fixtures.
 * - `taskcommits`' raw-SQL `projects` insert: writes a controlled `id`, which `addProject`
 *   does not offer. Different contract, not a missing option.
 * - `conflict`'s async `git` and `capacityreduction`'s void one: different signatures on
 *   purpose. This file's `git` is the dominant sync `(cwd, ...args)` shape.
 * - Adapter-JSON scaffolding in `beforeAll`: the declared CLI differs per suite, so the file it
 *   is written from stays where the suite can see it.
 */

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Session, Worker } from '@shared/protocol.js'
import type { Project, ProjectConfig, Task } from '@shared/tasks.js'
import { db, openDb, row } from './db.js'
import { addProject } from './projects.js'
import { createTask, requireTask, type CreateTaskInput } from './tasks.js'
import { createWorker } from './workers.js'

/**
 * A scratch database for one suite: temp dir, `WARMSTART_DATA_DIR` pointed at it,
 * database opened. Returns the dir; suites keep writing their own adapter JSON into it before
 * `loadAdapters()`, because the declared CLI differs per suite.
 */
export function openTestDb(prefix: string, file = 'test.db'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  process.env.WARMSTART_DATA_DIR = dir
  openDb(join(dir, file))
  return dir
}

/**
 * Force `isInstalled()` true for the named adapters, and hand back the undo.
 *
 * ⛔ **A suite that asserts *routing* must not also assert that a CLI is on this machine.**
 * `eligibility.ts` rejects a worker whose adapter is not installed **before** any other gate, and it
 * does so with a standing reason — so on a machine without the vendor CLI (every CI runner, by
 * design: no job there may spend a token) a router test gets an empty candidate list and fails
 * reporting *"Claude Code is not installed"* in place of whatever it meant to measure. Measured
 * 2026-09-09: this is the whole of why `reviewer` (7), `scheduling` (2), `reviewqueue` (1) and
 * `headlesspermission` (1) were red on Linux while green on the author's Windows box.
 *
 * ⚠️ **The fix is to stub, not to skip.** `describe.runIf` would satisfy `ci.yml`'s "skipped
 * visibly" rule and lose the point: these suites test selection logic, which has nothing to do with
 * the CLI and should run everywhere. Skipping leaves the router covered only on machines that happen
 * to have the vendors installed.
 *
 * Third copy of an idiom already hand-rolled in `dispatching`, `awaithuman` and `conversationkind`;
 * per this file's own rule, it lives here now rather than being forked a fourth time. ⛔ Adapter
 * objects are module singletons, so **always call the returned undo in `afterAll`** — a suite that
 * leaks this makes every later suite in the same worker believe the CLI is present.
 */
export async function forceInstalled(...adapterIds: string[]): Promise<() => void> {
  const { adapter } = await import('./adapters/index.js')
  const undo: Array<() => void> = []
  for (const id of adapterIds) {
    const ad = adapter(id)
    // ⚠️ Bound on capture: an adapter's `isInstalled` may read its own cached state (`local-llm`
    // and `muse-code` both do), so restoring a bare method reference would put back a function that
    // has lost its receiver. `no-unbound-method` is right to object.
    const original = ad.isInstalled.bind(ad)
    ad.isInstalled = () => true
    undo.push(() => {
      ad.isInstalled = original
    })
  }
  return () => {
    for (const restore of undo) restore()
  }
}

/** One worker row. `enabled` defaults true; suites that must never dispatch pass false. */
export function seedWorker(opts: {
  adapterId: string
  label: string
  enabled?: boolean
}): Worker {
  return createWorker({ adapterId: opts.adapterId, label: opts.label, enabled: opts.enabled ?? true })
}

/**
 * One session row, re-read and returned whole — callers wanting only the id read `.id`.
 * `cwd` is required: every copy pins it to its suite's dir, and a default would be a lie about
 * where the session ran.
 */
export function seedSession(opts: {
  id?: string
  workerId: string
  adapterId: string
  transport?: string
  cwd: string
  state?: string
  purpose?: string
  model?: string | null
  effort?: string | null
  startedAt?: number
  lastRequestStartedAt?: number | null
  tokensSinceCompact?: number
  contextTokens?: number | null
  pid?: number | null
}): Session {
  const id = opts.id ?? randomUUID()
  const startedAt = opts.startedAt ?? Date.now()
  db()
    .prepare(
      `insert into sessions (id, worker_id, adapter_id, transport, cwd, model, effort, state,
                             purpose, started_at, last_request_started_at, tokens_since_compact,
                             context_tokens, pid)
       values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      id,
      opts.workerId,
      opts.adapterId,
      opts.transport ?? 'stream',
      opts.cwd,
      opts.model ?? null,
      opts.effort ?? null,
      opts.state ?? 'live',
      opts.purpose ?? 'work',
      startedAt,
      opts.lastRequestStartedAt ?? null,
      opts.tokensSinceCompact ?? 0,
      opts.contextTokens ?? null,
      opts.pid ?? null
    )
  const session = row<Session>(db().prepare('select * from sessions where id = ?').get(id))
  if (!session) throw new Error('session vanished after insert')
  return session
}

/**
 * One run row, plus its task row (`insert or ignore` — `runs.task_id` is a real foreign key).
 * Covers the quota-window runs (`before`/`after` snapshots), the priced runs (`costModel`,
 * `model`, `listUsd`, `onOverage`) and the bare lifecycle rows (id + outcome).
 */
export function seedRun(opts: {
  id: string
  workerId: string
  taskId?: string
  taskSeq?: number
  sessionId?: string | null
  startedAt?: number
  endedAt?: number | null
  outcome?: string | null
  costModel?: string | null
  model?: string | null
  before?: string | null
  after?: string | null
  listUsd?: number | null
  onOverage?: boolean | null
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}): void {
  const taskId = opts.taskId ?? `task-${opts.id}`
  const at = opts.startedAt ?? Date.now()
  db()
    .prepare(
      `insert or ignore into tasks (id, seq, title, status, created_by_json, mandate_json,
                                    budget_json, created_at, updated_at)
       values (?,?,?, 'completed','{}','{}','{}',?,?)`
    )
    .run(taskId, opts.taskSeq ?? 1, taskId, at, at)
  db()
    .prepare(
      `insert into runs (id, task_id, worker_id, session_id, started_at, ended_at, outcome,
                         quota_unverified, input_tokens, output_tokens, cache_read_tokens,
                         cache_write_tokens, cost_model_id, model, quota_before_json,
                         quota_after_json, list_usd, on_overage)
       values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      opts.id,
      taskId,
      opts.workerId,
      opts.sessionId ?? null,
      at,
      opts.endedAt ?? null,
      opts.outcome ?? null,
      0,
      opts.inputTokens ?? 0,
      opts.outputTokens ?? 0,
      opts.cacheReadTokens ?? 0,
      opts.cacheWriteTokens ?? 0,
      opts.costModel ?? null,
      opts.model ?? null,
      opts.before ?? null,
      opts.after ?? null,
      opts.listUsd ?? null,
      opts.onOverage === null || opts.onOverage === undefined ? null : opts.onOverage ? 1 : 0
    )
}

/** One quota sample. Defaults are the 5h-window shape most copies seed. */
export function seedQuota(opts: {
  workerId: string
  percent: number
  windowId?: string
  label?: string
  resetsAt?: number | null
  source?: string
  sampledAt?: number
  group?: string | null
}): void {
  db()
    .prepare(
      `insert into quota_samples (worker_id, window_id, label, percent, resets_at, source,
                                  sampled_at, window_group)
       values (?,?,?,?,?,?,?,?)`
    )
    .run(
      opts.workerId,
      opts.windowId ?? 'session',
      opts.label ?? 'Claude 5h',
      opts.percent,
      opts.resetsAt ?? null,
      opts.source ?? 'config-cache',
      opts.sampledAt ?? Date.now(),
      opts.group ?? null
    )
}

/** One reading however many windows, taken `ageMs` ago. Returns what it wrote as resets. */
export function seedReading(opts: {
  workerId: string
  windows: Array<{
    id: string
    label: string
    percent: number
    /** Absolute reset; `resetsIn` is relative to now. Both absent writes null (unknown). */
    resetsAt?: number | null
    resetsIn?: number | null
    group?: string
  }>
  ageMs?: number
  sampledAt?: number
  source?: string
}): number[] {
  const sampledAt = opts.sampledAt ?? Date.now() - (opts.ageMs ?? 0)
  const resets: number[] = []
  for (const w of opts.windows) {
    const resetsAt =
      w.resetsAt ?? (w.resetsIn === null || w.resetsIn === undefined ? null : Date.now() + w.resetsIn)
    resets.push(resetsAt ?? 0)
    seedQuota({
      workerId: opts.workerId,
      percent: w.percent,
      windowId: w.id,
      label: w.label,
      resetsAt,
      source: opts.source,
      sampledAt,
      group: w.group
    })
  }
  return resets
}

/**
 * One real task row. The `CreateTaskInput` fields pass straight through; `overrides` are merged
 * onto the re-read row **without being written back** (the `landingtarget` pattern — a way to
 * hold a shape the store would not accept, not a second writer); `finishAsked` stamps
 * `finish_asked_at` the way the finish suite's copy does.
 */
export function makeTask(
  opts: {
    title?: string
    projectId?: string | null
    parentTaskId?: string | null
    kind?: Task['kind']
    constraints?: CreateTaskInput['constraints']
    createdBy?: CreateTaskInput['createdBy']
    finishPolicy?: CreateTaskInput['finishPolicy']
    mandate?: CreateTaskInput['mandate']
    landingTarget?: string | null
    finishAsked?: boolean
    overrides?: Partial<Task>
  } = {}
): Task {
  const input: CreateTaskInput = {
    title: opts.title ?? 'Test task',
    createdBy: opts.createdBy ?? { kind: 'human' }
  }
  if (opts.projectId !== undefined && opts.projectId !== null) input.projectId = opts.projectId
  if (opts.parentTaskId) input.parentTaskId = opts.parentTaskId
  if (opts.kind) input.kind = opts.kind
  if (opts.constraints) input.constraints = opts.constraints
  if (opts.finishPolicy) input.finishPolicy = opts.finishPolicy
  if (opts.mandate) input.mandate = opts.mandate
  if (opts.landingTarget !== undefined && opts.landingTarget !== null) input.landingTarget = opts.landingTarget
  const task = createTask(input)
  if (opts.finishAsked) {
    db().prepare('update tasks set finish_asked_at = ? where id = ?').run(Date.now(), task.id)
  }
  return { ...requireTask(task.id), ...opts.overrides }
}

/** A task pinned to one account — the shape that cannot route around a full window. */
export function pinnedTask(workerId: string, adapterId: string, title = 'a pinned task'): Task {
  return createTask({
    title,
    createdBy: { kind: 'human' },
    constraints: { workerId, adapterId }
  })
}

/**
 * A git repo with an initial commit, registered as a project. `config` is merged over a
 * minimal `project.json`; `files` are written before the commit (`kept.txt` by default, the
 * file the worktree suites assert survives); `docs` are plain files for the orientation suite.
 */
export function makeProject(opts: {
  dir: string
  name: string
  config?: Partial<ProjectConfig>
  files?: Record<string, string>
  docs?: string[]
}): Project {
  const root = makeRepo({
    dir: opts.dir,
    name: opts.name,
    projectJson: { vcs: 'git', check: [], ...(opts.config ?? {}) },
    files: opts.files,
    docs: opts.docs
  })
  return addProject({ root })
}

/**
 * A git repo with an initial commit and a `project.json`, **not** registered — the caller
 * decides whether `addProject` (a `Project`) or a raw row (a controlled id) follows.
 */
export function makeRepo(opts: {
  dir: string
  name: string
  projectJson?: Record<string, unknown>
  files?: Record<string, string>
  docs?: string[]
}): string {
  const root = join(opts.dir, opts.name)
  mkdirSync(root, { recursive: true })
  git(root, 'init', '--initial-branch=main')
  git(root, 'config', 'user.name', 'agentyard test')
  git(root, 'config', 'user.email', 'test@example.invalid')
  mkdirSync(join(root, '.warmstart'), { recursive: true })
  writeFileSync(
    join(root, '.warmstart', 'project.json'),
    JSON.stringify({ schema_version: 1, name: opts.name, ...(opts.projectJson ?? {}) }, null, 2)
  )
  const files = opts.files ?? { 'kept.txt': 'as committed\n' }
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content)
  for (const name of opts.docs ?? []) writeFileSync(join(root, name), `# ${name}\n`)
  git(root, 'add', '-A')
  git(root, 'commit', '-m', 'initial')
  return root
}

/**
 * The dominant sync `(cwd, ...args)` git shape, trimmed stdout. Fixture-only: production code
 * shells out through `git.ts`; the async and void copies stay local to their suites.
 */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}
