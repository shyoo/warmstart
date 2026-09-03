import type { Session } from '@shared/protocol'
import { QUOTA_STALE_AFTER_MS, quotaFreshness } from '@shared/tasks'
import type { FleetEntry } from './daemon'
import { age } from './format'

/**
 * What a worker card says in its top-right corner, and which sessions it draws as gauges.
 *
 * ⛔ Both live here rather than inside the component because they are one decision: a card's height
 * must not change on its own. Two of its rows used to come and go by themselves — the `read 29m ago`
 * note appeared under the quota bars the moment a reading crossed fifteen minutes, and a session
 * with no turn yet drew a `starting…` row for the seconds before its first usage landed. Each grew
 * the card by a line and then shrank it back, which moved every card beside it and the strip below,
 * on a timer nobody pressed.
 *
 * ⚠️ Marked, not hidden - the distinction the staleness treatment draws (see `FleetStrip`) is
 * unchanged. The age is still shown and the gauges are still dimmed; the age just moved into a
 * corner of the head row, which exists either way, so saying it costs no height.
 */

/** Whether a session has anything to draw a gauge from. */
function measured(session: Session): boolean {
  return Boolean(session.contextTokens)
}

/**
 * The sessions that get a gauge: the ones with a reading.
 *
 * ⛔ Not `state !== 'closed'`. A warmed-up idle session with a context level is worth a row - it is
 * a real measurement, and the card dims it rather than dropping it. A session with no turn yet has
 * nothing to measure, and the row it used to draw said so in words while taking the space of a
 * number.
 */
export function gaugedSessions(sessions: Session[]): Session[] {
  return sessions.filter(measured)
}

export type CardStatus =
  /** A probe or a session start is in flight: three dots, and the word in the tooltip. */
  | { kind: 'pending'; label: string; title: string }
  /** The last reading is older than the scheduler will gate on. `failing` if every retry errored. */
  | { kind: 'age'; label: string; title: string; failing: boolean }

/**
 * The one thing the corner says, or nothing.
 *
 * ⛔ Pending outranks age deliberately. Both are true at once more often than not - a stale reading
 * is exactly what sends a probe out - and when a fresh number is seconds away, *how old the old one
 * is* is not what an operator wants from a corner that fits one line.
 */
export function cardStatus(
  entry: FleetEntry,
  /**
   * ⛔ The clock, passed in, because the age here has to keep moving after the card stops hearing
   * about the reading. `ageMs` and `stale` are stamped onto a reading when the daemon *sends* it,
   * so a corner that read them off the payload froze at the age it arrived with — `29m` for an
   * hour — and a reading that was fresh when it landed never turned stale on screen at all (t86).
   * `quotaFreshness` recomputes both against this, sharing one threshold with the daemon.
   */
  now: number,
  sessions: Session[] = entry.sessions
): CardStatus | null {
  const pending = sessions.find((s) => !measured(s) && s.state !== 'closed' && s.state !== 'idle')
  if (pending) {
    return pending.purpose === 'probe'
      ? {
          kind: 'pending',
          label: 'probing',
          title:
            'Reading this account’s usage window. The bars below are the last known reading until ' +
            'it lands.'
        }
      : {
          kind: 'pending',
          label: 'starting',
          title:
            'A session is starting on this account. It gets a gauge of its own once its first ' +
            'turn reports usage.'
        }
  }

  const quota = entry.quota
  const { ageMs, stale } = quotaFreshness(quota, now)
  // A failed refresh makes the reading unfit for a scheduler gate immediately, but it must not
  // make the card start shouting an age moments after a successful reading landed. The card's
  // short-age rule is about display, not whether the daemon may rely on the number: reserve the
  // corner (and its amber failure treatment) for a reading old enough to need an age at all.
  if (!quota || !stale || quota.windows.length === 0 || ageMs <= QUOTA_STALE_AFTER_MS) return null
  return {
    kind: 'age',
    label: age(ageMs),
    failing: Boolean(quota.error),
    title: quota.error
      ? 'Every check since has failed, so this is the last reading that worked and the newest ' +
        `attempt did not: ${quota.error}`
      : 'Older than fifteen minutes, so nothing the scheduler gates on will use it — but old is ' +
        'not wrong. The CLI rewrites its usage cache when it does work, so an idle account keeps ' +
        'its last number and its window is not moving either. A fresh one is taken when a task is ' +
        'about to run here, or when you press Probe.'
  }
}
