import { randomUUID } from 'node:crypto'
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { canWork } from '@shared/protocol.js'
import type {
  CreditStatus,
  CreditsIntent,
  Worker,
  WorkerHealth,
  WorkerIdentity,
  WorkerRole
} from '@shared/protocol.js'
import { resolveModelChoice } from '@shared/tasks.js'
import { db, row, rows } from './db.js'
import { ensureDir, paths, slugify } from './paths.js'
import { adapter, hasAdapter } from './adapters/index.js'
import { lastQuota } from './quota.js'
import { log } from './log.js'
import { emit } from './events.js'

interface WorkerRow {
  id: string
  adapter_id: string
  label: string
  isolation_root: string
  enabled: number
  human_occupied: number
  role: string
  max_concurrent: number
  default_model: string | null
  grading_model: string | null
  grading_enabled: number
  default_effort: string | null
  default_models_json: string | null
  routable_models_json: string | null
  identity_json: string | null
  credits_json: string | null
  credits_intent_json: string | null
  health_json: string | null
  sort_order: number
  created_at: number
  retired_at: number | null
}

function toWorker(r: WorkerRow): Worker {
  return {
    id: r.id,
    adapterId: r.adapter_id,
    label: r.label,
    isolationRoot: r.isolation_root,
    enabled: r.enabled === 1,
    humanOccupied: r.human_occupied === 1,
    role: (r.role as WorkerRole) ?? 'both',
    maxConcurrent: r.max_concurrent,
    defaultModel: r.default_model,
    gradingModel: r.grading_model,
    gradingEnabled: r.grading_enabled !== 0,
    defaultEffort: r.default_effort,
    defaultModels: r.default_models_json ? (JSON.parse(r.default_models_json) as Record<string, string | null>) : null,
    routableModels: r.routable_models_json ? (JSON.parse(r.routable_models_json) as string[]) : null,
    identity: (() => {
      const ident = r.identity_json ? (JSON.parse(r.identity_json) as WorkerIdentity) : null
      const hlth = r.health_json ? (JSON.parse(r.health_json) as WorkerHealth) : null
      const isExpired =
        ident?.subscriptionExpired === true ||
        hlth?.subscriptionExpired === true ||
        (hlth?.reason ? adapter(r.adapter_id).subscriptionExpired?.(hlth.reason) === true : false)
      if (ident && isExpired) {
        ident.subscriptionExpired = true
        if (ident.setupComplete === false) ident.setupComplete = null
      }
      return ident
    })(),
    credits: r.credits_json ? (JSON.parse(r.credits_json) as CreditStatus) : null,
    creditsIntent: r.credits_intent_json
      ? (JSON.parse(r.credits_intent_json) as CreditsIntent)
      : null,
    health: (() => {
      const hlth = r.health_json ? (JSON.parse(r.health_json) as WorkerHealth) : null
      if (hlth && hlth.subscriptionExpired === undefined) {
        if (adapter(r.adapter_id).subscriptionExpired?.(hlth.reason)) {
          hlth.subscriptionExpired = true
        }
      }
      return hlth
    })(),
    sortOrder: r.sort_order,
    createdAt: r.created_at,
    retiredAt: r.retired_at
  }
}

/**
 * The fleet, in the order a person put it in.
 *
 * ⛔ **One ordering, and everything that lists workers gets it.** The fleet strip, Settings > Workers
 * and the commissioning wizard all read this; a second `order by` anywhere else is how the strip and
 * the table come to disagree about which worker is first, which is the exact confusion an operator
 * cannot debug from the screen. `created_at` remains the tie-break, so two rows that were never
 * ordered against each other still come back in a stable order rather than SQLite's.
 */
export function listWorkers(includeRetired = false): Worker[] {
  const sql = includeRetired
    ? 'select * from workers order by sort_order, created_at'
    : 'select * from workers where retired_at is null order by sort_order, created_at'
  return rows<WorkerRow>(db().prepare(sql).all()).map(toWorker)
}

export function getWorker(id: string): Worker | null {
  const r = row<WorkerRow>(db().prepare('select * from workers where id = ?').get(id))
  return r ? toWorker(r) : null
}

export function requireWorker(id: string): Worker {
  const w = getWorker(id)
  if (!w) throw new Error(`no worker '${id}'`)
  return w
}

/**
 * Commission a worker.
 *
 * The isolation root is a directory the *vendor CLI* owns. agentyard creates it and points the CLI
 * at it; it never reads, copies or proxies what lands inside. An existing root can be adopted
 * instead - including a plain `~/.claude` - which is the path for someone who already has one
 * account set up and does not want to log in again.
 */
export function createWorker(input: {
  adapterId: string
  label: string
  isolationRoot?: string | undefined
  humanOccupied?: boolean | undefined
  maxConcurrent?: number | undefined
  enabled?: boolean | undefined
}): Worker {
  if (!hasAdapter(input.adapterId)) throw new Error(`unknown adapter '${input.adapterId}'`)
  const label = input.label.trim()
  if (!label) throw new Error('a worker needs a label')

  // ⛔ Refused here rather than discovered later. Some CLIs keep their credential in the OS keyring
  // with no way to point them at a different one - Antigravity is the first - so a second worker
  // would not be a second account. It would be two rows sharing one account's quota, each believing
  // it had a window of its own, and the scheduler would happily overspend it. A refusal now beats
  // that, and the message says why rather than just saying no.
  const caps = adapter(input.adapterId).info.capabilities
  const limit = caps.maxAccounts
  if (limit !== null) {
    const existing = listWorkers(true).filter((w) => w.adapterId === input.adapterId && !w.retiredAt)
    if (existing.length >= limit) {
      const info = adapter(input.adapterId).info
      throw new Error(
        `${info.label} supports only ${limit} account on this machine: it keeps credentials in the ` +
          'OS keyring and offers no way to point it at another. ' +
          `'${existing[0]?.label}' already holds it. Retire that worker to commission a different one.`
      )
    }
  }

  const id = randomUUID()
  const defaultRoot = input.adapterId === 'local-llm' ? 'http://127.0.0.1:8080' : defaultIsolationRoot(label)
  const root = input.isolationRoot?.trim() || defaultRoot
  ensureDir(root)

  const now = Date.now()
  const tail =
    (row<{ next: number }>(
      db().prepare('select coalesce(max(sort_order), -1) + 1 as next from workers').get()
    )?.next ?? 0)

  const policy = adapter(input.adapterId).info.policy
  const defaultModel = policy.defaultModel ?? null
  const defaultEffort = null
  const defaultModels = policy.defaultModels ?? null
  const defaultModelsJson = defaultModels ? JSON.stringify(defaultModels) : null
  const gradingModel = defaultGradingModel(input.adapterId)

  db()
    .prepare(
      `insert into workers (id, adapter_id, label, isolation_root, enabled, human_occupied,
                            max_concurrent, default_model, default_effort, default_models_json,
                            grading_model, grading_enabled,
                            sort_order, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    )
    .run(
      id,
      input.adapterId,
      label,
      root,
      input.enabled === false ? 0 : 1,
      input.humanOccupied ? 1 : 0,
      // Default 1: concurrent requests against one cached prefix each pay a write, so a second
      // session on the same worker is a cost decision, not a free speedup. cost-model.md §1.
      boundedConcurrency(input.maxConcurrent, 1),
      defaultModel,
      defaultEffort,
      defaultModelsJson,
      gradingModel,
      tail,
      now
    )
  log.info(`commissioned worker ${label} (${input.adapterId}) at ${root}`)
  return announce(requireWorker(id))
}

/** `<data>/workers/<slug>`, with a numeric suffix if that name is taken. Never machine-specific. */
export function defaultIsolationRoot(label: string): string {
  ensureDir(paths.workers)
  const base = slugify(label)
  let candidate = join(paths.workers, base)
  let n = 2
  while (existsSync(candidate)) candidate = join(paths.workers, `${base}-${n++}`)
  return candidate
}

/**
 * How many work sessions this account may run at once.
 *
 * ⛔ **At least one.** Zero is not "paused" — it is a worker that stays enabled, keeps its quota
 * counted and its role honoured, and silently never takes a task, with `atCapacity` true on an empty
 * account. The switch for "do not use this one" is `enabled`, which says so on the row; a max of 0
 * would be the same intent expressed where nobody would think to look.
 *
 * ⚠️ No upper bound, deliberately. The ceiling is the account's own — its rate limits, and the fact
 * that parallel requests against one cached prefix each pay a cache write (`docs/cost-model.md` §1) —
 * and inventing a number here would be a guess presented as a rule.
 */
function boundedConcurrency(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback
}

export function updateWorker(
  id: string,
  patch: Partial<
    Pick<
      Worker,
      | 'label'
      | 'enabled'
      | 'humanOccupied'
      | 'maxConcurrent'
      | 'role'
      | 'defaultModel'
      | 'gradingModel'
      | 'gradingEnabled'
      | 'defaultEffort'
      | 'defaultModels'
      | 'routableModels'
    >
  >
): Worker {
  const current = requireWorker(id)
  // ⛔ `maxConcurrent` is an admission limit, never a preemption request. A worker can briefly be
  // above its newly lowered cap while its existing work finishes; terminating those sessions would
  // turn a harmless settings edit into lost work.
  const maxConcurrent = boundedConcurrency(patch.maxConcurrent, current.maxConcurrent)
  const defaultModelsJson =
    patch.defaultModels === undefined
      ? current.defaultModels ? JSON.stringify(current.defaultModels) : null
      : patch.defaultModels ? JSON.stringify(patch.defaultModels) : null
  const routableModelsJson =
    patch.routableModels === undefined
      ? current.routableModels ? JSON.stringify(current.routableModels) : null
      : patch.routableModels && patch.routableModels.length > 0
        ? JSON.stringify(patch.routableModels)
        : null

  db()
    .prepare(
      `update workers set label = ?, enabled = ?, human_occupied = ?, max_concurrent = ?, role = ?,
                          default_model = ?, default_effort = ?, default_models_json = ?,
                          routable_models_json = ?, grading_model = ?, grading_enabled = ?
       where id = ?`
    )
    .run(
      patch.label?.trim() || current.label,
      (patch.enabled ?? current.enabled) ? 1 : 0,
      (patch.humanOccupied ?? current.humanOccupied) ? 1 : 0,
      maxConcurrent,
      patch.role ?? current.role,
      // ⛔ `undefined` means "not mentioned", `null` means "clear it". Collapsing the two with `??`
      // would make the default unclearable: every attempt to go back to the CLI's own choice would
      // silently re-save the value being cleared.
      patch.defaultModel === undefined ? current.defaultModel : patch.defaultModel,
      patch.defaultEffort === undefined ? current.defaultEffort : patch.defaultEffort,
      defaultModelsJson,
      routableModelsJson,
      patch.gradingModel === undefined ? (current.gradingModel ?? null) : patch.gradingModel,
      (patch.gradingEnabled ?? current.gradingEnabled) ? 1 : 0,
      id
    )
  // A lower limit is an admission gate, not a preemption order. Sessions already using the account
  // keep working; only the next dispatch waits until the number of live work sessions falls below it.
  if (maxConcurrent < current.maxConcurrent) {
    log.info(
      `${current.label}: concurrency reduced from ${current.maxConcurrent} to ${maxConcurrent}; ` +
        'active sessions continue and new work waits for capacity'
    )
  }
  return announce(requireWorker(id))
}

/**
 * Every model this worker may be *routed to*.
 *
 * ⛔ **Null or empty resolves to exactly the one model this worker uses today** — what
 * `resolveModelChoice` would answer with no task-level pin, wrapped in a one-element array, or
 * `[null]` ("the CLI's own choice") when that itself is null. This is what keeps model-aware
 * routing inert on every worker until an operator opts it in: an empty allowlist is read as *this
 * worker's current single model*, never as *every model the adapter can price*.
 */
export function routableModelsFor(worker: Worker): Array<string | null> {
  if (worker.routableModels && worker.routableModels.length > 0) return worker.routableModels
  return inheritedModelFor(worker)
}

/**
 * The one model this worker reaches for on its own, as a one-element candidate list.
 *
 * ⛔ **Not the allowlist, on purpose.** This is what a task filed with `modelPolicy: 'inherit'`
 * gets: the account's own default, resolved against its live quota so a multi-pool account still
 * balances between its pools, and no scoring across the models an operator widened it to.
 */
export function inheritedModelFor(worker: Worker): Array<string | null> {
  return [resolveModelChoice(null, worker, false, lastQuota(worker.id)).model]
}

/** Smallest configured review rung for a built-in adapter; external adapters use their CLI default. */
export function defaultGradingModel(adapterId: string): string | null {
  return {
    'claude-code': 'claude-haiku-4-5',
    'antigravity-cli': 'gemini-3.8-flash-low',
    'openai-compatible': 'gpt-5.4-mini',
    'local-llm': 'qwen3-coder-30b-a3b'
  }[adapterId] ?? null
}

/**
 * Put the fleet in a given order.
 *
 * ⛔ Takes the **whole order**, not a move. A `{id, direction}` call has to read the current list,
 * decide who the neighbour is, and write two rows — three steps against a list two windows are
 * looking at, where the second window's idea of "the one above" may already be wrong. A full
 * ordering is idempotent, survives being sent twice, and cannot half-apply.
 *
 * ⚠️ Ids not mentioned keep their place *after* the ones that were, in the order they already had.
 * The caller is the UI, which lists live workers only; a retired worker is not in that list and must
 * not be silently reranked to the front by its absence from it.
 */
export function reorderWorkers(ids: string[]): Worker[] {
  const all = listWorkers(true)
  const known = new Map(all.map((w) => [w.id, w]))
  const seen = new Set<string>()
  const ordered: Worker[] = []
  for (const id of ids) {
    const worker = known.get(id)
    if (!worker) throw new Error(`no worker '${id}'`)
    if (seen.has(id)) throw new Error(`worker '${worker.label}' listed twice in an ordering`)
    seen.add(id)
    ordered.push(worker)
  }
  for (const worker of all) if (!seen.has(worker.id)) ordered.push(worker)

  const write = db().prepare('update workers set sort_order = ? where id = ?')
  const changed: Worker[] = []
  ordered.forEach((worker, index) => {
    if (worker.sortOrder === index) return
    write.run(index, worker.id)
    changed.push(requireWorker(worker.id))
  })
  // ⚠️ One event per row that actually moved. Announcing all of them would make every reorder a
  // fleet-wide refetch in every open window, including the rows nobody touched.
  for (const worker of changed) announce(worker)
  return listWorkers()
}

/** Every worker mutation leaves through here, so no UI can miss one. */
function announce(worker: Worker): Worker {
  emit({ type: 'worker.changed', worker })
  return worker
}

// ------------------------------------------------------------------------------- usage credits

/**
 * Store what the vendor last said about this account spending past its plan limit.
 *
 * ⚠️ Announced only when the reading actually changed. This is written on every spend probe — every
 * five minutes on a busy worker — and emitting a `worker.changed` each time would make an unchanged
 * fact a fleet-wide refetch in every open window, which is the same cost `reorder` above avoids.
 */
export function setWorkerCredits(id: string, credits: CreditStatus | null): Worker {
  const before = requireWorker(id)
  const json = credits ? JSON.stringify(credits) : null
  if (JSON.stringify(before.credits ?? null) === JSON.stringify(credits ?? null)) return before
  db().prepare('update workers set credits_json = ? where id = ?').run(json, id)
  return announce(requireWorker(id))
}

/**
 * Record that the operator does — or does not — want this account spending credits.
 *
 * ⚠️ Grants nothing at the vendor and enables nothing by itself. Measured 2026-09-07: Claude Code
 * reports `can_toggle: false` on both live accounts and `/usage-credits` opens a login chooser
 * rather than a toggle, so the switch is thrown by a person where the vendor put it. This is how the
 * app knows what was *wanted*, which is the only way a mismatch can be noticed at all.
 */
export function setWorkerCreditsIntent(id: string, asked: boolean): Worker {
  requireWorker(id)
  const intent: CreditsIntent = { asked, at: Date.now(), reportedAt: null }
  db()
    .prepare('update workers set credits_intent_json = ? where id = ?')
    .run(JSON.stringify(intent), id)
  return announce(requireWorker(id))
}

/** Remember that the operator has been told about a mismatch, so it is raised once and not hourly. */
export function noteCreditsDiscrepancyReported(id: string): void {
  const worker = getWorker(id)
  if (!worker?.creditsIntent) return
  const intent: CreditsIntent = { ...worker.creditsIntent, reportedAt: Date.now() }
  db()
    .prepare('update workers set credits_intent_json = ? where id = ?')
    .run(JSON.stringify(intent), id)
  announce(requireWorker(id))
}

/**
 * Is this worker actually spending past its plan limit right now?
 *
 * ⛔ **All three halves, and the vendor's is not optional.** `spendCreditsPastLimit` is the operator's
 * fleet-wide permission; `worker.creditsIntent.asked` is their explicit choice for *this* account;
 * and `worker.credits.enabled` is what the vendor says about that choice. Standing the quota guards
 * down without the worker choice would keep a run billing after an operator turned that worker off.
 * Standing them down on the fleet switch alone would apply it to accounts with no credits behind them,
 * where the run does not gain a reprieve — it simply runs into a hard vendor refusal instead of
 * being wrapped up cleanly, losing the commit and the handoff the wrap-up exists to produce.
 *
 * ⚠️ A worker whose credits have never been probed reads `null` here and is therefore **not**
 * spending. Not knowing is not permission.
 *
 * ⚠️ And a purse the vendor has already emptied is not permission either — see
 * `creditsPurseEmpty`.
 */
export function spendingCreditsOn(worker: Worker | null, switchOn: boolean): boolean {
  return (
    switchOn &&
    worker?.creditsIntent?.asked === true &&
    worker.credits?.enabled === true &&
    !creditsPurseEmpty(worker.credits)
  )
}

/**
 * Has this account already spent every credit it was allowed this month?
 *
 * ⛔ **A purse with nothing in it is credits *off* for every decision that matters.** `enabled`
 * says the vendor is willing to bill past the plan limit; it does not say there is anything left to
 * bill against. Standing the quota guards down on an emptied purse is the worst of both answers —
 * the run is not wrapped up cleanly *and* the vendor refuses the turn anyway, which is exactly the
 * outcome `spendingCreditsOn` exists to avoid.
 *
 * ⚠️ Both numbers or nothing. A vendor that publishes no ceiling, or no spend against it, has
 * said nothing about the purse being empty — and an unknown is not an exhaustion.
 */
export function creditsPurseEmpty(credits: CreditStatus | null | undefined): boolean {
  if (!credits) return false
  const { monthlyLimit, used } = credits
  if (monthlyLimit === null || monthlyLimit <= 0 || used === null) return false
  return used >= monthlyLimit
}

/**
 * Has the operator asked for something the vendor is not doing? One sentence, or null.
 *
 * ⛔ Only ever the direction that **costs the operator something they did not expect**: they asked
 * for credits and the account is not spending them, so runs they expected to carry on past the limit
 * are still being wrapped up. The opposite — credits on where none were asked for — is the vendor's
 * own setting on the operator's own account and is not this app's business to challenge.
 */
export function creditsDiscrepancy(worker: Worker): string | null {
  const intent = worker.creditsIntent
  const credits = worker.credits
  if (!intent?.asked || !credits || credits.enabled) return null
  if (intent.reportedAt !== null) return null
  const why = credits.disabledReason ? ` The reason it gives is \`${credits.disabledReason}\`.` : ''
  const toggle =
    credits.canToggle === false
      ? ' It also reports that this cannot be changed from the CLI, so the switch is somewhere ' +
        'in the vendor’s own account settings rather than in the terminal.'
      : ''
  return (
    `You asked for ${worker.label} to spend usage credits past its plan limit, but the vendor ` +
    `reports credits as **off** on this account.${why}${toggle} Until they are on, runs on this ` +
    'worker are still wrapped up at the limit rather than carrying on.'
  )
}

/**
 * Signed in **and** through the CLI's first-run screens. Either one alone leaves an account that
 * cannot open a terminal, which is what `watchReadiness` below exists to wait for.
 *
 * ⛔ **Not a dispatch gate, and deliberately not exported.** It asks one narrow question - has a
 * person finished the vendor's own sign-in flow - and says nothing about whether this account may
 * be given a turn: not `enabled`, not `humanOccupied`, not `retiredAt`, not whether the CLI is
 * installed, and not whether a run has already proved that work dies here. It was called `isReady`
 * and exported, which made it exactly the thing a future caller would find by grepping for a
 * readiness check and use as one. That is how `chooseController` came to be missing the quarantine
 * gate the scheduler had: two answers to *is this worker usable*, only one of them complete.
 *
 * ⛔ The gate is `accountUnavailability` in eligibility.ts. There is one, and both schedulers use it.
 */
function isSignedInAndSetUp(worker: Worker): boolean {
  return (
    worker.identity?.loggedIn === true &&
    worker.identity?.setupComplete !== false &&
    worker.identity?.subscriptionExpired !== true
  )
}

/**
 * Re-read identity only if the stored answer has gone stale.
 *
 * ⚠️ Identity is a cached belief about the outside world and nothing expired it. ClaudeFirst on this
 * machine read `not signed in` on 2026-08-27 while its isolation root held a valid `oauthAccount`:
 * the `false` was written before somebody signed in, and only a button nobody knew to press would
 * have corrected it. A belief with a timestamp and no refresh is just a stale belief with a date on
 * it.
 */
export async function refreshIdentityIfStale(id: string, maxAgeMs: number): Promise<void> {
  const w = requireWorker(id)
  if (w.retiredAt) return
  const checkedAt = w.identity?.checkedAt ?? 0
  if (Date.now() - checkedAt < maxAgeMs) return
  await refreshIdentity(id)
}

/**
 * Watch a worker's isolation root while it is being signed in, and react when it becomes usable.
 *
 * ⛔ The operator should never have to tell this app something it can see for itself. Before this,
 * signing in left the row saying `not signed in` and finishing the first-run screens left it saying
 * `setup unfinished`, until somebody pressed a button whose name gave no hint that it was required.
 * The vendor writes to its own config the moment either finishes; that write is the signal.
 *
 * ⚠️ Watched as a **directory**, not a file: which file carries the answer is the adapter's business,
 * the credential may live somewhere else entirely, and a file that does not exist yet cannot be
 * watched at all. A slow poll runs underneath because `fs.watch` misses writes on some Windows and
 * network filesystems - the same belt-and-braces the transcript tailer uses, for the same reason.
 */
export function watchReadiness(workerId: string, onReady: () => void): () => void {
  const w = requireWorker(workerId)
  const wasSetUp = isSignedInAndSetUp(w)
  let stopped = false
  let debounce: NodeJS.Timeout | null = null
  let watcher: FSWatcher | null = null

  const check = async (): Promise<void> => {
    if (stopped) return
    try {
      const fresh = await refreshIdentity(workerId)
      // ⛔ The *transition* is the event, not the state. A worker that was already ready when the
      // pane opened must not have its terminal closed out from under whoever opened it deliberately.
      if (!wasSetUp && isSignedInAndSetUp(fresh)) {
        stop()
        onReady()
      }
    } catch (err) {
      log.warn(`readiness check failed for ${w.label}:`, err)
    }
  }

  const nudge = (): void => {
    if (debounce) clearTimeout(debounce)
    // The CLI writes its config in bursts; one probe after the burst beats one per write.
    debounce = setTimeout(() => void check(), 1_500)
  }

  try {
    watcher = watch(w.isolationRoot, { persistent: false }, nudge)
  } catch {
    // The poll below is the real guarantee; the watch is only there to make it feel immediate.
  }
  const timer = setInterval(() => void check(), 10_000)
  timer.unref?.()

  function stop(): void {
    if (stopped) return
    stopped = true
    if (debounce) clearTimeout(debounce)
    clearInterval(timer)
    watcher?.close()
  }

  return stop
}

/**
 * Retiring closes the worker to new work but **leaves the isolation root on disk**. A credential
 * store is not something a task manager deletes on a stray click; removing it is a separate,
 * explicit act by the person who owns the account.
 */
export function retireWorker(id: string): Worker {
  db().prepare('update workers set retired_at = ?, enabled = 0 where id = ?').run(Date.now(), id)
  const w = requireWorker(id)
  log.info(`retired worker ${w.label}; isolation root left at ${w.isolationRoot}`)
  return announce(w)
}

/**
 * How many dispatches may die on a worker before it stops being offered one.
 *
 * One. ⛔ Not a tolerance to be tuned: a dispatch that ends with no assistant turn at all has proved
 * the account cannot run work *right now*, and a second attempt costs another workspace claim, another
 * process, and another task sent to a person who will read it as their own task failing. The measured
 * case is an expired subscription, which does not get better by being asked twice.
 */
const STRIKES_TO_QUARANTINE = 1

/**
 * Record that a dispatch to this worker produced nothing.
 *
 * ⚠️ Only ever called for a run that ended **without a single metered turn**. A run that produced
 * turns and then failed is a task-shaped failure, and blaming the account for it would quarantine a
 * healthy fleet one bad prompt at a time.
 */
export function recordDispatchFailure(id: string, reason: string, runId: string | null): Worker {
  const w = getWorker(id)
  if (!w) return requireWorker(id)
  const strikes = (w.health?.strikes ?? 0) + 1
  const ad = adapter(w.adapterId)
  const isExpired = ad.subscriptionExpired?.(reason) ?? false
  const health: WorkerHealth = {
    state: strikes >= STRIKES_TO_QUARANTINE ? 'suspect' : 'ok',
    reason,
    strikes,
    since: Date.now(),
    runId,
    // ⛔ Asked of the adapter, whose CLI wrote the sentence. An adapter that does not classify
    // its failures says `false`, which is the safe answer: the worker is still held out, the
    // operator is still shown the reason, and nobody is sent to re-authenticate on a guess.
    needsReauth: ad.needsReauth?.(reason) ?? false,
    subscriptionExpired: isExpired
  }
  db().prepare('update workers set health_json = ? where id = ?').run(JSON.stringify(health), id)
  if (health.state === 'suspect') {
    log.warn(`${w.label} is held out of dispatch after ${strikes} dead run(s): ${reason}`)
  }
  return announce(requireWorker(id))
}

/**
 * This worker just proved it works. ⛔ Called on the first metered turn of a run, not on a clean
 * exit - a process can exit 0 having done nothing, which is the exact failure this whole mechanism
 * exists to catch.
 */
export function clearDispatchFailure(id: string): void {
  const w = getWorker(id)
  if (!w?.health) return
  db().prepare('update workers set health_json = null where id = ?').run(id)
  log.info(`${w.label} produced a turn; clearing '${w.health.reason}'`)
  announce(requireWorker(id))
}

/**
 * A probe read this account's real usage windows, so it is offered work again.
 *
 * ⛔ **The automatic exit from quarantine, and the half of t309 that closes the lock.** Before this,
 * `health.state === 'suspect'` refused the dispatch *and* `mayRefreshUsage` refused the probe, so
 * the only ways out were a metered turn — which needs a dispatch — and a person pressing Probe.
 * A quarantine whose only exits both require the thing it is blocking is a lock, however good the
 * reason for entering it.
 *
 * ⚠️ Called only where **windows were actually published** (`storeAndPublish`). That is the whole
 * strength of the evidence: an expired subscription cannot draw a `/usage` panel with percentages
 * in it, so this cannot lift the measured case the quarantine exists for. A failed or empty probe
 * changes nothing here on purpose.
 *
 * ⚠️ Unlike `refreshIdentity(lift = true)` this does **not** reset the failed run's session. A
 * person pressing Probe has usually just fixed something and wants a cold start; a probe that
 * happened to succeed is evidence about the account, not a decision about anyone's context.
 */
export function clearQuarantineByProbe(id: string): void {
  const w = getWorker(id)
  if (w?.health?.state !== 'suspect') return
  db().prepare('update workers set health_json = null where id = ?').run(id)
  log.info(`${w.label} published usage windows; clearing '${w.health.reason}'`)
  announce(requireWorker(id))
}

/**
 * Re-read who is signed in.
 *
 * `lift` says whether this re-read may also lift a dispatch quarantine, and it defaults to **no**.
 * ⛔ The two callers differ in a way that matters: a person pressing Probe has usually just fixed
 * whatever benched the account, while the five-minute sweep has fixed nothing - and an expired
 * subscription passes `auth status` unchanged, so a sweep that lifted the quarantine would re-offer
 * the same dead account every fifteen minutes, each time costing a workspace claim, a process, and a
 * task handed to a person as though their own work had failed.
 */
export async function refreshIdentity(id: string, lift = false): Promise<Worker> {
  const w = requireWorker(id)
  const probe = await adapter(w.adapterId).probeIdentity(w.isolationRoot)
  const identity = {
    // ⛔ Kept, not dropped. The adapter answered this question; throwing it away and having the
    // scheduler grep `raw` for `"loggedIn": false` is how a worker with no CLI installed used to
    // look dispatchable.
    loggedIn: probe.loggedIn,
    account: probe.account,
    organization: probe.organization,
    cliVersion: probe.cliVersion,
    // ⛔ Stored for the same reason `loggedIn` is: a belief the adapter formed and the UI needs, and
    // reconstructing it later by grepping `raw` is precisely the mistake that made a worker with no
    // CLI look dispatchable.
    setupComplete: probe.setupComplete ?? null,
    // Recorded, never gated on. See WorkerIdentity.subscriptionType.
    subscriptionType: probe.subscriptionType ?? null,
    subscriptionExpired: probe.subscriptionExpired ?? null,
    raw: probe.raw,
    checkedAt: Date.now()
  }
  db().prepare('update workers set identity_json = ? where id = ?').run(JSON.stringify(identity), id)

  if (lift && getWorker(id)?.health) {
    const health = getWorker(id)!.health
    if (probe.subscriptionExpired) {
      log.info(`${w.label} was re-probed by hand; subscription is still expired`)
    } else {
      if (health?.runId) {
        const failedRun = row<{ session_id: string; started_warm: number | null }>(
          db().prepare('select session_id, started_warm from runs where id = ?').get(health.runId)
        )
        if (failedRun?.session_id && failedRun.started_warm === 1) {
          db().prepare("update sessions set context_tokens = 0, state = 'failed' where id = ?").run(failedRun.session_id)
        }
      }
      db().prepare('update workers set health_json = null where id = ?').run(id)
      log.info(`${w.label} was re-probed by hand; it is offered work again`)
    }
  }
  return announce(requireWorker(id))
}

/**
 * Whether any commissioned worker has actually been opted into model-aware routing.
 *
 * ⛔ **Fleet-global, and the switch for the `fitness` and `price` score terms.** An empty allowlist
 * everywhere means no dispatch on this install has a model *choice* to make — `routableModelsFor`
 * hands back the one model each worker already uses — and scoring a decision nobody is making would
 * change routing on every existing fleet the day this landed. Which it did: two accounts whose
 * default models differ scored 0.55 apart on a medium-complexity task and 1.04 apart on a high one,
 * against a `ROUTE_EPSILON` of 0.10, purely from a benchmark prior nobody had validated against this
 * fleet. The allowlist is the opt-in; until one exists, both terms sit at 0 and the arithmetic is
 * the arithmetic that shipped before.
 *
 * ⚠️ **Fleet-global rather than per-worker, deliberately.** Zeroing the terms only for
 * non-opted-in workers would put an opted-in worker carrying a real `price` penalty in the same
 * field as one scored as though its model were free, and the free-looking one would win on a
 * difference that measures nothing. Either the whole field is compared on model or none of it is.
 *
 * ⚠️ An allowlist only counts on an account that could actually be handed a turn: not retired (via
 * `listWorkers()`), switched on, and taking work rather than reserved for judgment or held out of
 * both (`canWork`). Widening a decommissioned, disabled or controller-only account would otherwise
 * switch the two terms on for every *other* account while the widened one never entered a field.
 *
 * ⛔ Those three and no more — **durable configuration, never transient availability.** The rest of
 * `accountUnavailability` (human-occupied, CLI missing, signed out, quarantined by a failed run)
 * comes and goes within a tick, and gating on it would switch the terms on and off underneath the
 * fleet, making one tick's scores incomparable with the next one's for reasons no operator asked
 * for. An account that is merely busy is still an account the operator asked to route on model.
 */
export function modelRoutingActive(): boolean {
  return listWorkers().some(
    (w) => w.enabled && canWork(w.role) && w.routableModels && w.routableModels.length > 0
  )
}
