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
/** What the next spawned daemon does: nothing (the slow case), or exit with this code at once. */
let nextExit: number | null | undefined
/** What the daemon log says about it, stubbed so this test never reads the real data directory. */
let loggedReason: string | null = null
vi.mock('node:child_process', () => ({
  spawn: (cmd: string, args: string[]) => {
    spawned.push([cmd, ...args])
    const listeners: Array<(code: number | null) => void> = []
    if (nextExit !== undefined) {
      const code = nextExit
      setTimeout(() => listeners.forEach((fn) => fn(code)), 100)
    }
    return {
      unref: (): void => {},
      on: (event: string, fn: (code: number | null) => void): void => {
        if (event === 'exit') listeners.push(fn)
      }
    }
  }
}))
vi.mock('./daemonexit.js', () => ({
  readStartupFailure: (): string | null => loggedReason
}))

const { DaemonClient } = await import('./daemon.js')

describe('orchestratord did not answer in time', () => {
  // A path that really exists, so the `existsSync(daemonScript)` guard passes without mocking fs.
  const script = fileURLToPath(import.meta.url)

  beforeEach(() => {
    spawned.length = 0
    nextExit = undefined
    loggedReason = null
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

  /**
   * The case this was written for. Measured 2026-09-15 on the first packaged 0.1.0-rc.1 install:
   * the daemon logged `database schema v73 is newer than this build understands (v71)` and exited
   * in under a second, five times over two minutes, and the window said *Starting orchestratord…*
   * throughout. The reason was in the log the whole time; nothing read it.
   */
  it('says why the daemon exited, and says it as soon as it has', async () => {
    nextExit = 1
    loggedReason = 'database schema v73 is newer than this build understands (v71). Upgrade Warmstart.'
    const client = new DaemonClient()
    const settled = client.ensure(script)
    // ⚠️ Well short of the 20s poll: a finished answer must not wait out the timeout.
    await vi.advanceTimersByTimeAsync(1_000)
    const status = await settled

    expect(status.state).toBe('error')
    const message = status.state === 'error' ? status.message : ''
    expect(message).toContain('exited with code 1')
    expect(message).toContain('schema v73 is newer')
    expect(message).toContain('retrying')
    expect(message).not.toContain('did not answer')
    client.dispose()
  })

  it('reports an exit that logged nothing as an exit, not as slowness', async () => {
    nextExit = null
    const client = new DaemonClient()
    const settled = client.ensure(script)
    await vi.advanceTimersByTimeAsync(1_000)
    const status = await settled
    const message = status.state === 'error' ? status.message : ''
    expect(message).toContain('exited without saying why')
    expect(message).not.toContain('did not answer')
    client.dispose()
  })

  it('adds the logged reason to a timeout when the daemon is still running', async () => {
    loggedReason = 'the data directory is not writable'
    const client = new DaemonClient()
    const settled = client.ensure(script)
    await vi.advanceTimersByTimeAsync(21_000)
    const status = await settled
    const message = status.state === 'error' ? status.message : ''
    expect(message).toContain('did not answer within 20s: the data directory is not writable')
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
