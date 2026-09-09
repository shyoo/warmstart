import { describe, expect, it } from 'vitest'
import { transportFailure } from './daemon.js'

/**
 * What the operator is told when an RPC never got an answer.
 *
 * ⛔ **`TypeError: fetch failed` is three words that fit four different problems**, and the renderer
 * showed exactly those three: *"Error invoking remote method 'daemon:rpc': TypeError: fetch
 * failed"*. Reproduced on this install 2026-09-09 by stacking 40 `quality.queue` calls — `/health`
 * answered in 78s and one poll came back `ECONNRESET` — and the badge said nothing about which call
 * broke, how long it had waited, or whether `orchestratord` was down, slow or had dropped a socket.
 * Those have three different answers, and the cause was one property away the whole time.
 */
describe('a daemon call that never reached an answer', () => {
  /** How undici reports a socket the server destroyed under a live request. */
  const reset = (): unknown =>
    Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
    })

  it('names the method, the cause and how long it waited', () => {
    const said = transportFailure('quality.queue', reset(), 78_412)
    expect(said).toContain('quality.queue')
    expect(said).toContain('ECONNRESET')
    expect(said).toContain('78s')
    // ⛔ The words that carried no information are the ones that must be gone.
    expect(said).not.toContain('fetch failed')
  })

  it('unwraps the AggregateError a refused connect arrives in', () => {
    // ⚠️ A daemon that is not running is the one case with a button next to it, and it is also the
    // one undici buries one level deeper than every other.
    const refused = Object.assign(new TypeError('fetch failed'), {
      cause: new AggregateError([Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })])
    })
    expect(transportFailure('task.list', refused, 12)).toContain('ECONNREFUSED')
  })

  it('reports a timeout by its own code rather than as a lost connection', () => {
    const timedOut = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' })
    })
    const said = transportFailure('quality.queue', timedOut, 300_000)
    expect(said).toContain('UND_ERR_HEADERS_TIMEOUT')
    expect(said).toContain('300s')
  })

  it('falls back to the cause’s own words, and never invents a diagnosis', () => {
    const odd = Object.assign(new TypeError('fetch failed'), { cause: new Error('socket hang up') })
    expect(transportFailure('task.list', odd, 900)).toContain('socket hang up')
    // Nothing to unwrap at all: report the throw itself rather than guessing at a code.
    expect(transportFailure('task.list', new TypeError('fetch failed'), 900)).toContain('fetch failed')
  })
})
