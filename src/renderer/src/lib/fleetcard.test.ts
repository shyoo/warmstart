import { describe, expect, it } from 'vitest'
import type { Session } from '@shared/protocol'
import { cardStatus, gaugedSessions } from './fleetcard'
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

const quota = (over: Partial<NonNullable<FleetEntry['quota']>> = {}): FleetEntry['quota'] =>
  ({
    windows: [{ id: '5h', label: 'Claude 5h', percent: 40, resetsAt: null }],
    stale: false,
    ageMs: 0,
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
    expect(cardStatus(entry({ quota: quota() }))).toBeNull()
  })

  it('shows the age of a stale reading rather than a row under the bars', () => {
    const status = cardStatus(entry({ quota: quota({ stale: true, ageMs: 29 * 60_000 }) }))
    expect(status).toMatchObject({ kind: 'age', label: '29m ago', failing: false })
  })

  it('marks a stale reading whose every retry has failed as failing', () => {
    const status = cardStatus(
      entry({ quota: quota({ stale: true, ageMs: 60_000, error: 'exit 1' }) })
    )
    expect(status).toMatchObject({ kind: 'age', failing: true })
    expect(status?.title).toContain('exit 1')
  })

  it('says nothing about staleness when there are no windows to be stale about', () => {
    expect(cardStatus(entry({ quota: quota({ stale: true, windows: [] }) }))).toBeNull()
  })

  it('shows a probe in flight', () => {
    const status = cardStatus(
      entry({ quota: quota(), sessions: [session({ purpose: 'probe' })] })
    )
    expect(status).toMatchObject({ kind: 'pending', label: 'probing' })
  })

  it('shows a session that is starting', () => {
    const status = cardStatus(entry({ quota: quota(), sessions: [session()] }))
    expect(status).toMatchObject({ kind: 'pending', label: 'starting' })
  })

  it('prefers the probe in flight over the age it is about to replace', () => {
    const status = cardStatus(
      entry({
        quota: quota({ stale: true, ageMs: 40 * 60_000 }),
        sessions: [session({ purpose: 'probe' })]
      })
    )
    expect(status).toMatchObject({ kind: 'pending', label: 'probing' })
  })

  it('ignores a closed or idle session with no reading, which is not in flight', () => {
    const gone = [session({ state: 'closed' }), session({ state: 'idle' })]
    expect(cardStatus(entry({ quota: quota(), sessions: gone }))).toBeNull()
  })

  it('still shows the age while a measured session is running', () => {
    const status = cardStatus(
      entry({
        quota: quota({ stale: true, ageMs: 3 * 60 * 60_000 }),
        sessions: [session({ contextTokens: 5000 })]
      })
    )
    expect(status).toMatchObject({ kind: 'age', label: '3h ago' })
  })
})
