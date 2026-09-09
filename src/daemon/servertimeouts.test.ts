import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { applyLoopbackTimeouts } from './server.js'

/**
 * The loopback listener's socket reapers.
 *
 * ⛔ **Reproduced on this install 2026-09-09.** `orchestratord` is single-threaded and every RPC
 * handler is synchronous `node:sqlite` work, so a heavy read blocks the event loop — and node's
 * reapers are timers, which do not fire *during* a block, they fire in a batch the instant it
 * clears. Stacking 40 `quality.queue` calls made `/health` answer in **78s**, and one poll came back
 * `TypeError: fetch failed` / `ECONNRESET`: node's 5s `keepAliveTimeout` had elapsed on a socket
 * whose client — told `Keep-Alive: timeout=5` and subtracting its own safety margin — believed it
 * was still reusable, so the request went out onto a socket the server destroyed the moment it could
 * run a timer again. The work had succeeded; only the answer was thrown away.
 */
describe('the loopback listener’s timeouts', () => {
  it('keeps a socket alive longer than any client will hold one idle', () => {
    const server = createServer()
    try {
      // Node's default is 5s, which is *shorter* than a client's idle window rather than longer.
      expect(server.keepAliveTimeout).toBe(5_000)
      applyLoopbackTimeouts(server)
      expect(server.keepAliveTimeout).toBeGreaterThanOrEqual(60_000)
    } finally {
      server.close()
    }
  })

  it('disables the header and request reapers, which here can only fire on our own slowness', () => {
    // ⛔ They exist to stop a hostile client dribbling a request to hold a socket. This server is
    // bound to 127.0.0.1 behind a bearer token and its only client is our own main process, so the
    // sole thing they ever caught was a daemon that was busy — and what they did about it was
    // destroy the connection carrying the answer.
    const server = createServer()
    try {
      applyLoopbackTimeouts(server)
      expect(server.headersTimeout).toBe(0)
      expect(server.requestTimeout).toBe(0)
    } finally {
      server.close()
    }
  })

  it('is not offered to anything reachable from a network', async () => {
    // ⚠️ The remote listener is reachable from a tailnet and keeps node's defaults. This asserts the
    // boundary by name: a future `applyLoopbackTimeouts` call in `remote/` should fail this.
    const remote = await import('./remote/server.js')
    expect(Object.keys(remote)).not.toContain('applyLoopbackTimeouts')
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('./remote/server.ts', import.meta.url), 'utf8')
    )
    expect(source).not.toContain('applyLoopbackTimeouts')
  })
})
