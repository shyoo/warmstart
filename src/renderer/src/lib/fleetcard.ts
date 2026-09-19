import { sessionEnded, type Session } from '@shared/protocol'
import { parallelUse } from '@shared/capacity'
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
  const pending = sessions.find((s) => !measured(s) && !sessionEnded(s.state) && s.state !== 'idle')
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

/**
 * The window term a label ends in — `5h`, `7d`, `7d Opus` — and whatever names the pool in front
 * of it.
 *
 * Adapters name a window twice over: once by the pool it belongs to and once by its length, because
 * a reading has to be legible on its own wherever it is quoted. On a card that is one pool's worth
 * of windows, the pool half is the card's own title repeated on every row — `Claude 5h` under a
 * card headed *Claude Code* — and it is paid for in the one column the bars are competing for.
 */
const WINDOW_TERM = /(?:^|\S\s+)((?:5h|7d)\b.*)$/

/**
 * What the gauges on one card should say, given what the adapter called them.
 *
 * ⛔ Dropped only when what is left still tells the windows apart. Antigravity meters two pools on
 * one account — `Claude/GPT 5h` and `Gemini 5h` are different quotas that gate different tasks —
 * and shortening both to `5h` would draw two bars claiming to be the same window. That is the whole
 * test: not which adapter this is, but whether the terms are still unique once the pool name goes.
 *
 * ⚠️ Returns `null` for "keep what you were given", which is also what the caller widens the label
 * column on. A card either shows pool names on every row or on none — half-shortened labels read as
 * one window belonging to a pool and the other not.
 */
/**
 * Whole days until the monthly credits purse refills, for the gauge's reset column — `29d`.
 *
 * ⛔ Days, not a countdown. A monthly refill is weeks out, where `countdown`'s `29d 4h` buys
 * nothing and breaks the 58px column every other row fits in; and anything at or past the date
 * reads as blank rather than `0d`, because a refill that never lands is unknown, not imminent.
 */
export function creditResetDays(resetsAt: number | null | undefined, now: number): string {
  if (!resetsAt || resetsAt <= now) return ''
  return `${Math.ceil((resetsAt - now) / 86_400_000)}d`
}

export function shortWindowLabels(labels: string[]): string[] | null {
  const terms = labels.map((label) => WINDOW_TERM.exec(label)?.[1])
  if (terms.some((term) => term === undefined)) return null
  const short = terms as string[]
  if (new Set(short).size !== short.length) return null
  return short
}

/** How many sessions a card draws as gauges: the most recent few, and no `+N more` beneath them. */
export const SESSION_GAUGES = 3

/** What the sessions divider says about the account's parallel slots. */
export interface InstanceUse {
  /** Slots in use: the number the scheduler compares against `maxConcurrent`. */
  inUse: number
  max: number
  /** Every slot taken, so nothing new can start on this account. */
  full: boolean
  /** The divider's tooltip, which is where the words for `1 / 2` live. */
  title: string
}

/**
 * `1 / 2` on the sessions divider: slots in use against Max parallel instances.
 *
 * ⛔ **Slots, not busy processes, because that is what the limit is on.** `slotsInUse` in
 * `residency.ts` counts every open `work` session — a warm idle one included, since it still holds
 * its slot — plus slots held by a task with no live process. A card counting only sessions mid-turn
 * would read `0 / 1` beside a task held *at capacity*, which is the mismatch this indicator exists
 * to prevent. The breakdown in the tooltip is where *working* and *idle* are told apart.
 *
 * ⛔ It replaces the `+N more` line. That counted every warm conversation the worker had ever
 * measured (`+59 more` on a long-lived account), which said nothing an operator acts on; this
 * says whether the account can take another task.
 */
export function instanceUse(entry: Pick<FleetEntry, 'worker' | 'sessions' | 'reservedSlots'>): InstanceUse {
  const open = entry.sessions.filter((s) => s.purpose === 'work' && !sessionEnded(s.state))
  const idle = open.filter((s) => s.state === 'idle').length
  const working = open.length - idle
  const held = entry.reservedSlots ?? 0
  const inUse = open.length + held
  const max = entry.worker.maxConcurrent
  const lines = [
    `${parallelUse(inUse, max)} in use on this account`,
    `${working} working · ${idle} idle but warm · ${held} held by a task waiting on you or landing`,
    'Change Max parallel instances in Settings > Workers.'
  ]
  return { inUse, max, full: inUse >= max, title: lines.join('\n') }
}
