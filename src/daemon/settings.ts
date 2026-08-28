import type { Settings } from '@shared/protocol.js'
import { DEFAULT_FLEET_FINISH, DEFAULT_FLEET_SHARING } from '@shared/tasks.js'
import { db, row } from './db.js'
import { log } from './log.js'

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
   * How often (in minutes) orchestratord sweeps workers in the background for quota updates.
   *
   * ⚠️ Default 5 minutes. A sweep reads the local usage cache (free) and, at most once per sweep
   * when a worker's cache is genuinely stale (>30m), refreshes usage via an interactive background
   * session (also free of tokens, but spends a subprocess).
   */
  probeIntervalMinutes: 5
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
  db()
    .prepare(
      `insert into settings (key, value, updated_at) values (?,?,?)
         on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`
    )
    .run(key, JSON.stringify(value), Date.now())
  log.info(`setting ${key} = ${JSON.stringify(value)}`)
  for (const listener of changeListeners) {
    try {
      listener(key, value)
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
      ;(out as Record<string, unknown>)[key] = JSON.parse(r.value)
    } catch {
      log.warn(`setting ${key} is not valid JSON - using the default`)
    }
  }
  return out
}
