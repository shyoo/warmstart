import { describe, expect, it } from 'vitest'
import type { Session } from '@shared/protocol'
import { fleetCounts, type FleetEntry } from './daemon.js'

/**
 * The three numbers in the sidebar and status bar: running / active / total workers.
 *
 * ⛔ Tested here rather than in the UI suite, for the same reason `live.test.ts` is: that suite's
 * worker has no credentials and nothing it files ever dispatches, so no session ever reaches `work`
 * and a check for "a busy worker counts as running" would pass on a fleet that is never busy.
 */

const session = (purpose: Session['purpose'], state: Session['state'] = 'live'): Session =>
  ({ purpose, state }) as Session

const entry = (over: Partial<FleetEntry> = {}): FleetEntry => ({
  worker: { enabled: true } as FleetEntry['worker'],
  quota: null,
  sessions: [],
  unavailable: null,
  atCapacity: false,
  ...over
})

describe('what the sidebar and status bar say about the fleet', () => {
  it('counts an idle, enabled worker as active and not as running', () => {
    expect(fleetCounts([entry()])).toEqual({ running: 0, active: 1, total: 1 })
  })

  it('counts a disabled worker as neither running nor active', () => {
    const disabled = entry({ worker: { enabled: false } as FleetEntry['worker'] })
    expect(fleetCounts([disabled])).toEqual({ running: 0, active: 0, total: 1 })
  })

  it('counts a busy enabled worker as both running and active', () => {
    const busy = entry({ sessions: [session('work')] })
    expect(fleetCounts([busy])).toEqual({ running: 1, active: 1, total: 1 })
  })

  it('counts a busy disabled worker as running but not active', () => {
    const busyDisabled = entry({
      worker: { enabled: false } as FleetEntry['worker'],
      sessions: [session('work')]
    })
    expect(fleetCounts([busyDisabled])).toEqual({ running: 1, active: 0, total: 1 })
  })

  it('does not count closed or failed work sessions as running', () => {
    const closed = entry({
      sessions: [session('work', 'closed'), session('work', 'failed')]
    })
    expect(fleetCounts([closed])).toEqual({ running: 0, active: 1, total: 1 })
  })

  // ⚠️ A login terminal and a 30-second quota probe are not the fleet doing work.
  it('counts only `work` sessions as running', () => {
    const probing = entry({ sessions: [session('probe'), session('login')] })
    expect(fleetCounts([probing])).toEqual({ running: 0, active: 1, total: 1 })
  })

  it('counts one busy worker once, however many tasks it is running', () => {
    const three = entry({ sessions: [session('work'), session('work'), session('work')] })
    expect(fleetCounts([three]).running).toBe(1)
  })

  it('says nothing at all about an empty fleet', () => {
    expect(fleetCounts([])).toEqual({ running: 0, active: 0, total: 0 })
  })
})
