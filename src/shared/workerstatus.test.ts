import { describe, expect, it } from 'vitest'
import type { QuotaSnapshot, Session, Worker } from './protocol.js'
import { OUTAGE_BELIEVED_MS, STATUS_GLYPH, workerStatus } from './workerstatus.js'

/**
 * The one status a worker shows, in Settings > Workers and on the fleet strip (t961).
 *
 * ⛔ **The case this exists for, measured 2026-10-07 on MuseFirst:** Meta answered every turn with
 * `402 … (billing_error)` while `auth.json` stayed valid, and the worker read as healthy. Its health
 * row says expired now, and that has to outrank everything a live-looking account also has — a
 * signed-in identity, an old reading with windows in it.
 */

const NOW = 1_791_400_000_000
const BILLING_402 =
  'API error 402 [request_id=ad5e8ebb-ef49-4a51-a5e3-7cf47cd41075]: Billing verification failed. ' +
  'Please check your payment method. (billing_error)'

const worker = (over: Partial<Worker> = {}): Worker =>
  ({
    id: 'w1',
    adapterId: 'muse-code',
    label: 'MuseFirst',
    enabled: true,
    humanOccupied: false,
    identity: { loggedIn: true, setupComplete: true, checkedAt: NOW - 60_000 },
    health: null,
    outage: null,
    ...over
  }) as Worker

const reading = (over: Partial<QuotaSnapshot> = {}): QuotaSnapshot => ({
  workerId: 'w1',
  windows: [{ id: '5h', label: 'Muse 5h', percent: 12, resetsAt: null }],
  sampledAt: NOW - 5 * 60_000,
  source: 'cli',
  ...over
})

const live = (startedAt: number): Pick<Session, 'purpose' | 'state' | 'startedAt'> => ({
  purpose: 'work',
  state: 'live',
  startedAt
})

describe('workerStatus', () => {
  it('reads an account the vendor will not bill as expired, over a valid login and an old reading', () => {
    const since = NOW - 3 * 3_600_000
    const status = workerStatus(
      worker({
        health: { state: 'suspect', reason: BILLING_402, strikes: 1, since, runId: null, subscriptionExpired: true }
      }),
      reading(),
      [],
      NOW
    )
    expect(status.kind).toBe('expired')
    expect(status.tone).toBe('bad')
    expect(status.since).toBe(since)
    expect(status.title).toContain('billing_error')
    // ⚠️ Promises the six-hourly re-ask only where the adapter has a check to re-ask with.
    expect(status.title).not.toContain('six hours')
    expect(workerStatus(worker({ health: { state: 'suspect', reason: BILLING_402, strikes: 1, since, runId: null, subscriptionExpired: true } }), null, [], NOW, { accountCheck: true }).title).toContain('six hours')
  })

  it('dates an expired hold from the last refusal once a check has re-confirmed it', () => {
    const since = NOW - 20 * 3_600_000
    const checkedAt = NOW - 2 * 3_600_000
    const status = workerStatus(
      worker({
        health: { state: 'suspect', reason: BILLING_402, strikes: 1, since, runId: null, subscriptionExpired: true, checkedAt }
      }),
      null,
      [],
      NOW
    )
    expect(status.since).toBe(checkedAt)
    expect(status.title).toContain('last refused')
  })

  it('says off before anything else, because nothing else about it is acted on', () => {
    expect(workerStatus(worker({ enabled: false }), reading(), [live(NOW)], NOW).kind).toBe('off')
  })

  it('separates a rejected credential from any other dead run', () => {
    const base = { state: 'suspect' as const, reason: 'x', strikes: 1, since: NOW - 1000, runId: null }
    expect(workerStatus(worker({ health: { ...base, needsReauth: true } }), null, [], NOW).kind).toBe('signin')
    expect(workerStatus(worker({ health: base }), null, [], NOW).kind).toBe('held')
  })

  it('reads a signed-out account as sign in, and an endpoint nobody signs in to as unavailable', () => {
    const out = worker({ identity: { loggedIn: false, checkedAt: NOW - 1000 } })
    expect(workerStatus(out, null, [], NOW).kind).toBe('signin')
    expect(workerStatus(out, null, [], NOW, { loginKind: 'external' }).kind).toBe('unavailable')
  })

  it('reports a provider outage while it is fresh, and forgets it once nothing has asked since', () => {
    const outage = { at: NOW - 60_000, reason: 'API error 529: overloaded' }
    const fresh = workerStatus(worker({ outage }), reading(), [live(NOW - 120_000)], NOW)
    expect(fresh.kind).toBe('unavailable')
    expect(fresh.since).toBe(outage.at)
    const old = { at: NOW - OUTAGE_BELIEVED_MS - 1, reason: 'overloaded' }
    expect(workerStatus(worker({ outage: old }), reading(), [], NOW).kind).toBe('ready')
  })

  it('is working while a task runs, dated from the first that started', () => {
    const status = workerStatus(worker(), reading(), [live(NOW - 50_000), live(NOW - 90_000)], NOW)
    expect(status.kind).toBe('working')
    expect(status.since).toBe(NOW - 90_000)
  })

  it('does not count a probe, a review, a turn that ended or a run that ended as working', () => {
    const sessions = [
      { purpose: 'probe' as const, state: 'live' as const, startedAt: NOW },
      { purpose: 'review' as const, state: 'live' as const, startedAt: NOW },
      { purpose: 'work' as const, state: 'idle' as const, startedAt: NOW },
      { purpose: 'work' as const, state: 'closed' as const, startedAt: NOW }
    ]
    expect(workerStatus(worker(), reading(), sessions, NOW).kind).toBe('ready')
  })

  it('is ready on published windows however old, dated by the reading', () => {
    const old = reading({ sampledAt: NOW - 5 * 3_600_000 })
    const status = workerStatus(worker(), old, [], NOW)
    expect(status.kind).toBe('ready')
    expect(status.since).toBe(old.sampledAt)
  })

  it('is unmetered where the vendor said it has published nothing yet', () => {
    const silent = reading({ windows: [], vendorSilent: true, error: 'Currently unavailable' })
    expect(workerStatus(worker(), silent, [], NOW).kind).toBe('unmetered')
  })

  it('is unknown where the newest check failed or nothing was ever read', () => {
    expect(workerStatus(worker(), reading({ error: 'the panel did not appear' }), [], NOW).kind).toBe('unknown')
    expect(workerStatus(worker(), reading({ windows: [], error: 'no file' }), [], NOW).kind).toBe('unknown')
    const never = workerStatus(worker(), null, [], NOW)
    expect(never.kind).toBe('unknown')
    expect(never.since).toBeNull()
  })

  it('is ready on a provider that publishes no quota once it has answered', () => {
    const status = workerStatus(worker(), null, [], NOW, { quotaProbe: 'none' })
    expect(status.kind).toBe('ready')
    expect(status.since).toBe(NOW - 60_000)
  })

  it('draws every status with a glyph of its own beside its colour', () => {
    expect(Object.keys(STATUS_GLYPH)).toHaveLength(10)
  })
})
