import type { Settings } from '@shared/protocol.js'
import { DEFAULT_FLEET_COMPLETION, DEFAULT_FLEET_FINISH, DEFAULT_FLEET_SHARING } from '@shared/tasks.js'
import { db, row } from './db.js'
import { log } from './log.js'
import { DEFAULT_OBJECTIVE, parseObjective } from './objective.js'

/**
 * Fleet settings: the handful of switches that are the operator's to throw, not the scheduler's to
 * infer.
 *
 * ⛔ Deliberately tiny, and it should stay that way. Almost everything this app does is decided from
 * measured evidence and an objective vector - a setting is an admission that no evidence can settle
 * the question, because the answer is a preference. There are currently three, and every one of them
 * gates an intervention the scheduler makes on a live session without being asked.
 *
 * ⚠️ Stored as JSON values under string keys so that a boolean today can become a shape tomorrow
 * without a migration, and read through `settings()` so a key that has never been written returns
 * the default rather than `undefined` at the point of use.
 */

export const DEFAULT_SETTINGS: Settings = {
  /**
   * Whether the cache clock may compact a session on its own.
   *
   * ⚠️ Default on, because compaction is what stops a long session being stranded at a window
   * boundary, and that loss is unrecoverable where an over-eager compaction merely costs tokens.
   * Off is nonetheless a legitimate answer: on a provider where `/compact` is not honoured - which
   * on the `stream` transport is still **unverified**, HANDOFF R6 - every attempt is pure spend,
   * and an operator watching that happen should not have to edit code to stop it.
   */
  autoCompact: true,

  /**
   * Whether the scheduler may wrap a run up before its quota window closes.
   *
   * ⚠️ Default on, because this is the one intervention the tool was built to make. A run caught by a
   * window close with this off is not paused - it is simply cut off mid-thought, with no commit and
   * no handoff, and the next session pays to rediscover the branch. That loss is unrecoverable where
   * an unnecessary wrap-up merely ends a run early.
   */
  autoPreempt: true,

  /**
   * Whether the scheduler may wrap up a run when 5-hour quota is near exhaustion (>=95%)
   * or an in-stream rate-limit warning arrives.
   *
   * ⚠️ Default on: catching rapid depletion mid-run and wrapping up cleanly (committing and pausing)
   * prevents unrecoverable 429 API failures and context loss.
   */
  autoOverrunPreempt: true,

  /**
   * Whether the scheduler may stop a run for going far past its estimate.
   *
   * ⛔ Default **off**, and the asymmetry with `autoPreempt` is the point. A window boundary is a
   * measured fact with a reset time attached; a runaway is a *judgement* made from a median over
   * completed runs, in raw tokens that are ~98% cache reads. Measured on t5, 2026-08-28: a run at
   * 6,271,722 tokens against an estimate of 1,557,974 was called a runaway at 4.0×, of which
   * 6,155,066 were cache reads and 27,338 were output. That trigger fires on a session being long,
   * not on it being wasteful. Until the factor is measured in cost rather than tokens, stopping work
   * on it is a guess, and a guess that ends somebody's run should be opted into.
   */
  autoRunawayStop: false,

  /**
   * Whether the controller may be asked to write a one-line label for a long task title.
   *
   * ⛔ Default **off**, on the same principle as `autoRunawayStop` and for a sharper reason: it is
   * the only consult that spends a turn and changes nothing about what the fleet does. `title` *is*
   * the prompt, so a summary is a display convenience, and a display convenience should not quietly
   * put a controller turn on every task an operator files.
   *
   * ⚠️ On or off, the four questions the scheduler already asks carry a `summary` field and store one
   * when the answer has it. This gates only the dedicated question. Turning it on trades one short
   * turn per long task for a board that can be read at a glance.
   */
  summariseTitles: false,

  /**
   * What finishing a task means when nothing more specific says otherwise.
   *
   * ⚠️ `agent-lands` matches what the project default has always effectively been, so this is not a
   * loosening — `safeToLand` now requires the project's checks to exist and to pass, which the old
   * path did not, so the same value lands strictly less than before. A project with no checks
   * configured rests at `awaiting_human` and says so.
   */
  finishPolicy: DEFAULT_FLEET_FINISH,

  /**
   * May a task be given a conversation another task has already been having?
   *
   * ⛔ **Off**, and the asymmetry with `finishPolicy` above is the point. Finishing has to do
   * *something* when a task ends, so its default is the useful one. Sharing changes who can see whose
   * work, so switching it on for every project in an install by upgrading it would be a change nobody
   * asked for, made everywhere at once. Turn it on per project, and per task from the detail pane.
   */
  sessionSharing: DEFAULT_FLEET_SHARING,

  /**
   * How far a dispatched agent is expected to get before it stops.
   *
   * ⛔ `autonomous`, because the premise of the tool is unattended progress across quota
   * windows hours long; a fleet defaulting to `checkpointed` would need a person present for every
   * task. ⚠️ It is not a care setting - an autonomous agent still stops to ask when a decision
   * changes what it builds. Choose `checkpointed` per task, for work worth steering.
   */
  completionMode: DEFAULT_FLEET_COMPLETION,

  /**
   * What the scheduler optimises for, fleet-wide, when a project or task has not specified otherwise.
   *
   * ⛔ A weight vector, not a mode name. Presets (economy, balanced, velocity, quality) are just
   * named vectors; the operator can choose a preset or supply custom weights.
   */
  objective: DEFAULT_OBJECTIVE,

  /**
   * How often (in minutes) orchestratord sweeps workers for quota **while a run is in flight**.
   *
   * ⚠️ Default 5 minutes, and since 2026-08-31 the number is honoured rather than approximated. A
   * sweep reads the local usage cache (free); on a worker that is *actually running something* it
   * now also **refreshes** that cache on this cadence, because the whole reason to watch a busy
   * account closely is that its window is the only one moving. On every other worker the refresh
   * stays behind `REFRESH_AFTER_MS`.
   *
   * ⛔ The measured failure this fixes: the cadence was described as five minutes and the *number*
   * only ever moved when the vendor happened to rewrite its own cache, so a card could sit at 63%
   * while the run beside it was preempted on a live signal that said 93%. Two numbers, one account,
   * no way for the operator to reconcile them.
   */
  probeIntervalMinutes: 5,

  /**
   * How often (in minutes) orchestratord sweeps workers when **nothing is running**.
   *
   * ⛔ Default 20, deliberately slower than the active cadence rather than equal to it. An idle
   * account's window does not move on its own, so the only thing frequent polling buys on a quiet
   * fleet is background processes — 150 probe sessions against 14 that did work, measured over four
   * days, which is what made `REFRESH_AFTER_MS` two hours in the first place.
   *
   * ⚠️ Idle is not the same as *nothing to wait for*: a task parked on a quota window is probed at
   * its release time regardless of this number. See `QuotaPoller.nextDelayMs`.
   */
  idleProbeIntervalMinutes: 20
}

type SettingChangeListener = <K extends keyof Settings>(key: K, value: Settings[K]) => void
const changeListeners: SettingChangeListener[] = []

export function onSettingChange(listener: SettingChangeListener): () => void {
  changeListeners.push(listener)
  return () => {
    const idx = changeListeners.indexOf(listener)
    if (idx >= 0) changeListeners.splice(idx, 1)
  }
}

export function settings(): Settings {
  return { ...DEFAULT_SETTINGS, ...read() }
}

export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): Settings {
  const sanitized = (key === 'objective' ? (parseObjective(value) ?? DEFAULT_OBJECTIVE) : value) as Settings[K]
  db()
    .prepare(
      `insert into settings (key, value, updated_at) values (?,?,?)
         on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`
    )
    .run(key, JSON.stringify(sanitized), Date.now())
  log.info(`setting ${key} = ${JSON.stringify(sanitized)}`)
  for (const listener of changeListeners) {
    try {
      listener(key, sanitized)
    } catch (err) {
      log.warn(`error in setting change listener for ${key}:`, err)
    }
  }
  return settings()
}

function read(): Partial<Settings> {
  const out: Partial<Settings> = {}
  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>) {
    const r = row<{ value: string }>(
      db().prepare('select value from settings where key = ?').get(key)
    )
    if (!r) continue
    try {
      // ⚠️ A row that will not parse is a row written by something that is not this build. Falling
      // back to the default is right - refusing to start because one switch is corrupt would take
      // the whole fleet down for a preference.
      // ⚠️ The cast widened when `finishPolicy` joined three booleans: the value type is no longer
      // uniform across keys, and indexing a heterogeneous record by a loop variable defeats the
      // narrowing. The parse is unvalidated either way - a corrupt row falls back below.
      const parsed: unknown = JSON.parse(r.value)
      if (key === 'objective') {
        const obj = parseObjective(parsed)
        if (obj) {
          out.objective = obj
        } else {
          log.warn('setting objective is not valid - using the default')
        }
      } else {
        ;(out as Record<string, unknown>)[key] = parsed
      }
    } catch {
      log.warn(`setting ${key} is not valid JSON - using the default`)
    }
  }
  return out
}
