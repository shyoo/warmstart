import type { Settings } from '@shared/protocol.js'
import { db, row } from './db.js'
import { log } from './log.js'

/**
 * Fleet settings: the handful of switches that are the operator's to throw, not the scheduler's to
 * infer.
 *
 * ⛔ Deliberately tiny, and it should stay that way. Almost everything this app does is decided from
 * measured evidence and an objective vector - a setting is an admission that no evidence can settle
 * the question, because the answer is a preference. There is currently one.
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
  autoCompact: true
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
      out[key] = JSON.parse(r.value) as Settings[typeof key]
    } catch {
      log.warn(`setting ${key} is not valid JSON - using the default`)
    }
  }
  return out
}
