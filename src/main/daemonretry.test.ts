import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * What happens after orchestratord fails to answer in time.
 *
 * ⛔ **A startup timeout used to be a dead end.** `ensure` set `state: 'error'` and nothing could
 * call it again — `scheduleReconnect` hangs off the WebSocket `close` event, and on that path no
 * socket was ever opened. The renderer then compounded it: `refreshProjects` returns early on
 * `if (!connected)` and only re-runs when `connected` changes, so the fleet stayed empty until the
 * operator quit and relaunched. Measured on this install 2026-09-10: the packaged app came up with
 * both projects on one launch and empty on the next, with an intact 37MB database and a daemon log
 * showing a clean `ready` every time.
 *
 * ⚠️ Fake timers, because the real path is a 20s poll followed by a 2s backoff and a test that
 * actually waited 22 seconds would be a test nobody runs.
 */
vi.mock('../daemon/lock.js', () => ({
  // Never publishes: this is the "daemon did not answer" case, held open for as long as the test wants.
  readEndpoint: (): null => null
}))

const spawned: string[][] = []
vi.mock('node:child_process', () => ({
  spawn: (cmd: string, args: string[]) => {
    spawned.push([cmd, ...args])
    return { unref: (): void => {} }
  }
}))

const { DaemonClient } = await import('./daemon.js')

describe('orchestratord did not answer in time', () => {
  // A path that really exists, so the `existsSync(daemonScript)` guard passes without mocking fs.
  const script = fileURLToPath(import.meta.url)

  beforeEach(() => {
    spawned.length = 0
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports the failure but does not stop there', async () => {
    const client = new DaemonClient()
    const settled = client.ensure(script)
    // Past the 20s startup poll.
    await vi.advanceTimersByTimeAsync(21_000)
    const status = await settled

    expect(status.state).toBe('error')
    // ⚠️ The message has to say a retry is coming, or the operator reads a dead end and relaunches
    // — the exact behaviour this change exists to remove.
    expect(status.state === 'error' && status.message).toContain('retrying')
    expect(spawned).toHaveLength(1)

    // The backoff fires and the whole attempt is made again, spawn included.
    await vi.advanceTimersByTimeAsync(2_500)
    expect(spawned).toHaveLength(2)

    // ⚠️ A retry is a whole `ensure`, so the next one is 20s of polling away and *then* the second
    // backoff — not 5s away. Asserting the shorter gap failed here first, which is the cadence
    // worth writing down: each attempt costs the full startup timeout before the next is queued.
    await vi.advanceTimersByTimeAsync(21_000 + 5_500)
    expect(spawned).toHaveLength(3)

    client.dispose()
  })

  it('stops retrying once disposed', async () => {
    const client = new DaemonClient()
    const settled = client.ensure(script)
    await vi.advanceTimersByTimeAsync(21_000)
    await settled
    expect(spawned).toHaveLength(1)

    client.dispose()
    await vi.advanceTimersByTimeAsync(60_000)
    // ⛔ A quit must not leave a timer spawning daemons behind the closed window.
    expect(spawned).toHaveLength(1)
  })
})
