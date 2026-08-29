import { describe, expect, it } from 'vitest'
import type { Session } from '@shared/protocol'
import { fleetCounts, type FleetEntry } from './daemon.js'

/**
 * The three numbers in the sidebar.
 *
 * ⛔ Tested here rather than in the UI suite, for the same reason `live.test.ts` is: that suite's
 * worker has no credentials and nothing it files ever dispatches, so no session ever reaches `work`
 * and a check for "a busy worker counts as running" would pass on a fleet that is never busy.
 *
 * ⚠️ What these guard is the direction of each mistake. Counting an unanswered gate as ready, or a
 * probe terminal as work, both err by telling an operator the fleet can take a task when it cannot —
 * which is the failure the old `fleet.length` badge made every time an account was signed out.
 */

const session = (purpose: Session['purpose']): Session => ({ purpose }) as Session

const entry = (over: Partial<FleetEntry> = {}): FleetEntry => ({
  worker: {} as FleetEntry['worker'],
  quota: null,
  sessions: [],
  unavailable: null,
  atCapacity: false,
  ...over
})

describe('what the sidebar says about the fleet', () => {
  it('counts an idle, eligible worker as ready and not as running', () => {
    expect(fleetCounts([entry()])).toEqual({ running: 0, ready: 1, total: 1 })
  })

  it('counts a worker with spare concurrency as both running and ready', () => {
    const busy = entry({ sessions: [session('work')], atCapacity: false })
    expect(fleetCounts([busy])).toEqual({ running: 1, ready: 1, total: 1 })
  })

  it('drops a full worker out of ready while it is still running', () => {
    const full = entry({ sessions: [session('work')], atCapacity: true })
    expect(fleetCounts([full])).toEqual({ running: 1, ready: 0, total: 1 })
  })

  // ⛔ The case the old badge got wrong: commissioned, present in the list, and unable to take work.
  it('does not count a worker the daemon is holding out', () => {
    const held = entry({ unavailable: 'ClaudeFirst is not signed in' })
    expect(fleetCounts([held])).toEqual({ running: 0, ready: 0, total: 1 })
  })

  // ⚠️ A login terminal and a 30-second quota probe are not the fleet doing work.
  it('counts only `work` sessions as running', () => {
    const probing = entry({ sessions: [session('probe'), session('login')] })
    expect(fleetCounts([probing])).toEqual({ running: 0, ready: 1, total: 1 })
  })

  it('counts one busy worker once, however many tasks it is running', () => {
    const three = entry({ sessions: [session('work'), session('work'), session('work')] })
    expect(fleetCounts([three]).running).toBe(1)
  })

  /**
   * ⚠️ An older daemon behind a newer renderer answers neither gate. `undefined` is *not answered*,
   * and reading it as ready would put a number on the sidebar that nothing measured.
   */
  it('treats a gate the daemon did not answer as not ready', () => {
    const old = { worker: {}, quota: null, sessions: [] } as unknown as FleetEntry
    expect(fleetCounts([old])).toEqual({ running: 0, ready: 0, total: 1 })
  })

  it('says nothing at all about an empty fleet', () => {
    expect(fleetCounts([])).toEqual({ running: 0, ready: 0, total: 0 })
  })
})
