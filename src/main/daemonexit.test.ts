import { describe, expect, it } from 'vitest'
import { startupFailureIn } from './daemonexit.js'

/** The exact shape `daemon/index.ts` wrote on 2026-09-15, stack trace included. */
const LOG = [
  '2026-09-16T04:40:36.958Z INFO  shutting down: the app asked',
  '2026-09-16T04:40:49.915Z ERROR orchestratord failed to start: Error: database schema v73 is newer than this build understands (v71). Upgrade Warmstart, or point WARMSTART_DATA_DIR somewhere else.',
  '    at migrate (file:///C:/Users/Sunghwan%20Yoo/AppData/Local/Programs/Warmstart/resources/app.asar/out/main/orchestratord.js:2466:11)',
  '    at openDb (file:///C:/Users/Sunghwan%20Yoo/AppData/Local/Programs/Warmstart/resources/app.asar/out/main/orchestratord.js:2424:3)',
  '2026-09-16T04:41:12.006Z ERROR orchestratord failed to start: Error: second attempt, same answer',
  '    at migrate (...)',
  ''
].join('\n')

describe('reading why orchestratord failed to start', () => {
  it('returns the latest reason logged since the spawn, first line only, without the Error: prefix', () => {
    const reason = startupFailureIn(LOG, Date.parse('2026-09-16T04:40:00Z'))
    expect(reason).toBe('second attempt, same answer')
  })

  it('ignores a reason older than this spawn — a stale line is somebody else’s failure', () => {
    expect(startupFailureIn(LOG, Date.parse('2026-09-16T04:41:00Z'))).toBe('second attempt, same answer')
    expect(startupFailureIn(LOG, Date.parse('2026-09-16T04:42:00Z'))).toBeNull()
  })

  it('reads a full schema refusal back intact', () => {
    const firstAttemptOnly = LOG.split('\n').slice(0, 4).join('\n')
    expect(startupFailureIn(firstAttemptOnly, 0)).toBe(
      'database schema v73 is newer than this build understands (v71). Upgrade Warmstart, or point WARMSTART_DATA_DIR somewhere else.'
    )
  })

  it('finds nothing in a log with ordinary lines and CRLF endings', () => {
    expect(startupFailureIn('2026-09-16T04:39:02.806Z INFO  orchestratord listening on 127.0.0.1:6177\r\n', 0)).toBeNull()
    expect(startupFailureIn('', 0)).toBeNull()
  })
})
