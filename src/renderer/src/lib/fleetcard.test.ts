import { describe, expect, it } from 'vitest'
import type { Session } from '@shared/protocol'
import { cardStatus, gaugedSessions, shortWindowLabels } from './fleetcard'
import type { FleetEntry } from './daemon'

/**
 * The corner of a worker card, and which sessions get a gauge.
 *
 * ⛔ The property under test is not a string - it is that **a card's height does not change on its
 * own**. Everything transient (an age crossing fifteen minutes, a probe in flight) has to come out
 * of this pair, because anything the component renders outside them is a row, and a row that comes
 * and goes on a timer moves the whole strip. Tested here rather than in the UI suite for the reason
 * `fleetcounts.test.ts` gives: that suite's worker never probes and never goes stale.
 */

const session = (over: Partial<Session> = {}): Session =>
  ({ id: 's1', purpose: 'work', state: 'live', ...over }) as Session

const entry = (over: Partial<FleetEntry> = {}): FleetEntry => ({
  worker: { enabled: true } as FleetEntry['worker'],
  quota: null,
  sessions: [],
  unavailable: null,
  atCapacity: false,
  ...over
})

/** One fixed clock, so an age asserted as a string cannot drift while the test runs. */
const NOW = Date.UTC(2026, 8, 1, 12, 0, 0)

/**
 * ⚠️ `sampledAt` is what the age is now derived *from*. The corner used to read the `ageMs` the
 * daemon stamped on at send time, which froze a card at the age it arrived with (t86); it now
 * recomputes against a clock. The factory keeps taking `ageMs` because that is what each test is
 * actually saying — "a reading this old" — and back-dates `sampledAt` to match.
 */
const quota = (
  over: Partial<NonNullable<FleetEntry['quota']>> = {}
): FleetEntry['quota'] =>
  ({
    windows: [{ id: '5h', label: 'Claude 5h', percent: 40, resetsAt: null }],
    stale: false,
    ageMs: 0,
    sampledAt: NOW - (over.ageMs ?? 0),
    ...over
  }) as FleetEntry['quota']

describe('which sessions get a gauge', () => {
  it('keeps a session that has measured its context', () => {
    const s = session({ contextTokens: 1200 })
    expect(gaugedSessions([s])).toEqual([s])
  })

  it('keeps a warmed-up idle session, because its reading is real', () => {
    const s = session({ contextTokens: 1200, state: 'idle' })
    expect(gaugedSessions([s])).toEqual([s])
  })

  it('holds back a session with no turn yet, so no row appears and disappears with it', () => {
    expect(gaugedSessions([session({ contextTokens: 0 }), session({})])).toEqual([])
  })
})

describe('what the card corner says', () => {
  it('says nothing when the reading is fresh and nothing is in flight', () => {
    expect(cardStatus(entry({ quota: quota() }), NOW)).toBeNull()
  })

  it('shows the age of a stale reading rather than a row under the bars', () => {
    const status = cardStatus(entry({ quota: quota({ stale: true, ageMs: 29 * 60_000 }) }), NOW)
    expect(status).toMatchObject({ kind: 'age', label: '29m ago', failing: false })
  })

  it('does not show a short age just because the newest probe failed', () => {
    const status = cardStatus(
      entry({ quota: quota({ stale: true, ageMs: 60_000, error: 'exit 1' }) }),
      NOW
    )
    expect(status).toBeNull()
  })

  it('marks an old reading whose every retry has failed as failing', () => {
    const status = cardStatus(
      entry({ quota: quota({ stale: true, ageMs: 29 * 60_000, error: 'exit 1' }) }),
      NOW
    )
    expect(status).toMatchObject({ kind: 'age', failing: true })
    expect(status?.title).toContain('exit 1')
  })

  it('says nothing about staleness when there are no windows to be stale about', () => {
    expect(cardStatus(entry({ quota: quota({ stale: true, windows: [] }) }), NOW)).toBeNull()
  })

  it('shows a probe in flight', () => {
    const status = cardStatus(
      entry({ quota: quota(), sessions: [session({ purpose: 'probe' })] }),
      NOW
    )
    expect(status).toMatchObject({ kind: 'pending', label: 'probing' })
  })

  it('shows a session that is starting', () => {
    const status = cardStatus(entry({ quota: quota(), sessions: [session()] }), NOW)
    expect(status).toMatchObject({ kind: 'pending', label: 'starting' })
  })

  it('prefers the probe in flight over the age it is about to replace', () => {
    const status = cardStatus(
      entry({
        quota: quota({ stale: true, ageMs: 40 * 60_000 }),
        sessions: [session({ purpose: 'probe' })]
      }),
      NOW
    )
    expect(status).toMatchObject({ kind: 'pending', label: 'probing' })
  })

  it('ignores a closed or idle session with no reading, which is not in flight', () => {
    const gone = [session({ state: 'closed' }), session({ state: 'idle' })]
    expect(cardStatus(entry({ quota: quota(), sessions: gone }), NOW)).toBeNull()
  })

  it('ignores failed or abandoned sessions with no reading', () => {
    const ended = [session({ state: 'failed' }), session({ state: 'abandoned' })]
    expect(cardStatus(entry({ quota: quota(), sessions: ended }), NOW)).toBeNull()
  })

  /**
   * ⛔ **The corner ages on its own clock, not on the one the reading arrived with.** `ageMs` and
   * `stale` are stamped onto a reading when the daemon *sends* it, so a card patched by a
   * `quota.changed` event kept saying `2m ago` for as long as nothing else arrived — and a reading
   * that was fresh when it landed never turned stale on screen at all. Both halves of t86: this is
   * the visible one, and `storeAndPublish` is the reason an event arrives at all.
   */
  it('ages a reading past what it was sent as, and turns it stale on the way', () => {
    // What the daemon said when it sent this: two minutes old, and fine.
    const sent = quota({ stale: false, ageMs: 2 * 60_000 })
    const status = cardStatus(entry({ quota: sent }), NOW + 38 * 60_000)
    expect(status).toMatchObject({ kind: 'age', label: '40m ago' })
  })

  it('still shows the age while a measured session is running', () => {
    const status = cardStatus(
      entry({
        quota: quota({ stale: true, ageMs: 3 * 60 * 60_000 }),
        sessions: [session({ contextTokens: 5000 })]
      }),
      NOW
    )
    expect(status).toMatchObject({ kind: 'age', label: '3h ago' })
  })
})

/**
 * What a card's gauges are allowed to stop saying.
 *
 * The pool name in front of every window label is the card's own title repeated down the rows, and
 * it is charged to the label column - the one the bars are competing with for width. It comes off
 * exactly when what is left still names a different window on each row, which is what keeps
 * Antigravity's two pools apart.
 */
describe('shortWindowLabels', () => {
  it('drops the pool name a one-pool account repeats on every row', () => {
    expect(shortWindowLabels(['Muse 5h', 'Muse 7d'])).toEqual(['5h', '7d'])
    expect(shortWindowLabels(['GPT 5h', 'GPT 7d'])).toEqual(['5h', '7d'])
  })

  /** Claude Code meters a third window, and what tells it from the second is the part that stays. */
  it('keeps whatever follows the window length', () => {
    expect(shortWindowLabels(['Claude 5h', 'Claude 7d', 'Claude 7d Opus'])).toEqual([
      '5h',
      '7d',
      '7d Opus'
    ])
  })

  /**
   * ⛔ Antigravity's two pools are different quotas gating different tasks. Shortened, both would
   * draw a bar labelled `5h` and the card would claim to meter one window twice.
   */
  it('keeps the pool name when two pools would collide without it', () => {
    const agy = ['Claude/GPT 5h', 'Claude/GPT 7d', 'Gemini 5h', 'Gemini 7d']
    expect(shortWindowLabels(agy)).toBeNull()
  })

  /** A label that is not a named window is left alone rather than guessed at. */
  it('leaves labels it does not recognise as named windows', () => {
    expect(shortWindowLabels(['Claude 5h', 'Credits'])).toBeNull()
  })

  /** An adapter that never named a pool is already terse, and its column narrows too. */
  it('accepts labels that were only ever the window length', () => {
    expect(shortWindowLabels(['5h', '7d'])).toEqual(['5h', '7d'])
  })
})
