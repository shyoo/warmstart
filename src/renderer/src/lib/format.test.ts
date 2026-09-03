import { describe, expect, it } from 'vitest'
import { QUOTA_STALE_AFTER_MS, quotaFreshness } from '@shared/tasks'
import { cacheRemaining, countdown, quotaGap, timeRange, when } from './format'

describe('countdown', () => {
  const NOW = Date.UTC(2026, 8, 2, 12, 0, 0)

  it('uses explicit hours and minutes for a quota window', () => {
    expect(countdown(NOW + (3 * 60 + 38) * 60_000, NOW)).toBe('3h 38m')
  })

  it('reserves colon notation for a countdown under one hour', () => {
    expect(countdown(NOW + 12 * 60_000 + 7_000, NOW)).toBe('12:07')
  })

  it('does not make an unknown reset look like a time', () => {
    expect(countdown(null, NOW)).toBe('--')
  })
})

describe('quotaGap', () => {
  it('says what would produce a reading when the account has never been used', () => {
    const gap = quotaGap({
      windows: [],
      error: 'no cachedUsageUtilization in .claude.json'
    })
    expect(gap?.label).toBe('no usage data yet')
    // ⛔ The hint has to name the action. "unknown" was already true and already useless.
    expect(gap?.hint).toMatch(/start a session/i)
    // The adapter's own words survive, so a real failure is still diagnosable from the tooltip.
    expect(gap?.hint).toContain('cachedUsageUtilization')
  })

  it('keeps an unrecognised probe failure as a failure rather than as advice', () => {
    const gap = quotaGap({ windows: [], error: 'EACCES reading .claude.json' })
    expect(gap?.label).toBe('unknown')
    expect(gap?.hint).toContain('EACCES')
  })

  it('distinguishes never-probed from probed-and-empty', () => {
    expect(quotaGap(null)?.label).toBe('never probed')
  })

  /**
   * ⛔ The label is the **age**, not the word `stale`. An idle account's window is not moving, so a
   * two-hour-old reading is very probably still true — it simply has nothing vouching for it, and
   * calling that a fault sent operators to press Probe on accounts that were fine.
   */
  it('says how old a reading is rather than calling it broken', () => {
    const gap = quotaGap({ windows: [{}], ageMs: 20 * 60 * 1000, stale: true })
    expect(gap?.label).toBe('read 20m ago')
    expect(gap?.label).not.toContain('stale')
    expect(gap?.hint).toContain('20m ago')
    // And it still says the number will not be gated on, which is the part that was true.
    expect(gap?.hint).toContain('gates on')
  })

  it('returns null when there is a real number for the caller to render', () => {
    expect(quotaGap({ windows: [{}], ageMs: 1000, stale: false })).toBeNull()
  })
})

describe('a codex worker that has never run a turn', () => {
  // ⚠️ Codex's reading lives in a rollout, and a worker that has never taken a turn has written
  // none. That is the same situation as claude-code's empty `cachedUsageUtilization` and it needs
  // the same words: an action the operator can take. `unknown` sends them back to Probe, which is
  // the one thing that cannot help, because pressing it reads the rollouts that do not exist yet.
  it('tells the operator to run something, rather than calling the reading unknown', () => {
    const gap = quotaGap(
      { windows: [], error: 'codex app-server returned no reading and there are no rollout files under C:/x yet' },
      'cli'
    )
    expect(gap?.label).toBe('no usage data yet')
    expect(gap?.hint).toMatch(/start a session/i)
  })

  it('says the same when the rollouts exist but predate rate_limits', () => {
    const gap = quotaGap({ windows: [], error: 'no rate_limits record in the 5 newest codex rollout(s)' }, 'cli')
    expect(gap?.label).toBe('no usage data yet')
  })
})

describe('a provider that has no usage probe at all', () => {
  it('says the reading is not reported, never that it is unknown', () => {
    // ⛔ A fifth state, and collapsing it into the fourth is what made a healthy Antigravity worker
    // read as broken. "unknown" is the word for a reading somebody can go and get; this provider
    // exposes usage only inside an interactive session or a running IDE, so there is nothing to
    // press, ever. Measured 2026-08-27: the operator's report was "antigravity's usage quota seems
    // always shown up as unknown" — which was true, and which the panel had no way of explaining.
    const gap = quotaGap({ windows: [], error: 'Antigravity exposes usage only…' }, 'none')
    expect(gap?.label).toBe('not reported')
    expect(gap?.hint).toMatch(/nothing to retry/i)
    // ⚠️ And it must not advise an action, because there is not one.
    expect(gap?.hint).not.toMatch(/probe again|start a session/i)
  })

  it('still uses the ordinary wording for a provider that does have a probe', () => {
    expect(quotaGap({ windows: [], error: 'EACCES' }, 'cli')?.label).toBe('unknown')
    expect(quotaGap(null, 'cli')?.label).toBe('never probed')
  })

  it('is unchanged when the caller does not know the adapter', () => {
    // The parameter is optional; every existing caller keeps its behaviour.
    expect(quotaGap({ windows: [], error: 'EACCES' })?.label).toBe('unknown')
  })
})


describe('cacheRemaining', () => {
  const HOUR = 60 * 60 * 1000
  const started = 1_700_000_000_000
  const clock = { lastRequestStartedAt: started, cacheExpiresAt: started + HOUR }

  it('is full the instant the turn started', () => {
    expect(cacheRemaining(clock, started)).toBe(1)
  })

  it('is half way through a one-hour TTL', () => {
    expect(cacheRemaining(clock, started + HOUR / 2)).toBeCloseTo(0.5, 5)
  })

  it('reads a five-minute TTL off the same two timestamps', () => {
    // ⛔ The reason this is arithmetic and not a constant: both TTLs are real, on the same fleet,
    // and a bar hard-coded to one of them is wrong by a factor of twelve on the other.
    const short = { lastRequestStartedAt: started, cacheExpiresAt: started + 5 * 60 * 1000 }
    expect(cacheRemaining(short, started + 150_000)).toBeCloseTo(0.5, 5)
  })

  it('is empty rather than negative once it has expired', () => {
    expect(cacheRemaining(clock, started + 2 * HOUR)).toBe(0)
  })

  it('does not exceed full if the clock is behind the turn', () => {
    expect(cacheRemaining(clock, started - HOUR)).toBe(1)
  })

  it('is unknown when the session never recorded a turn', () => {
    // ⚠️ Not zero. A `stream` session meters usage without ever setting `lastRequestStartedAt`, so
    // this is the ordinary state of a healthy consult - and an empty bar drawn as a *measurement*
    // would say its cache had run out.
    expect(cacheRemaining({ lastRequestStartedAt: null, cacheExpiresAt: null })).toBeNull()
    expect(cacheRemaining({ lastRequestStartedAt: started, cacheExpiresAt: null })).toBeNull()
    expect(cacheRemaining({ lastRequestStartedAt: null, cacheExpiresAt: started + HOUR })).toBeNull()
  })

  it('is unknown rather than dividing by zero on a nonsense pair', () => {
    expect(cacheRemaining({ lastRequestStartedAt: started, cacheExpiresAt: started })).toBeNull()
  })
})

/**
 * The age a card shows has to keep moving after the card stops hearing about it.
 *
 * ⛔ **The visible half of t86.** `ageMs` and `stale` are stamped onto a reading by the daemon when
 * it *sends* one, so anything that read them off the payload was frozen at the moment it arrived:
 * a card patched by a `quota.changed` event kept saying "read 2m ago" indefinitely, and a reading
 * that was fresh when it landed never went stale on screen at all. `quotaFreshness` recomputes both
 * against a clock the component already ticks.
 */
describe('quotaFreshness', () => {
  const at = (ageMs: number): { sampledAt: number; windows: unknown[] } => ({
    sampledAt: Date.now() - ageMs,
    windows: [{}]
  })

  it('ages a reading against the clock rather than trusting what it arrived with', () => {
    const now = Date.now()
    // What the daemon said when it sent this: two minutes old and perfectly usable.
    const sent = { ...at(40 * 60_000), ageMs: 2 * 60_000, stale: false }
    expect(quotaFreshness(sent, now).ageMs).toBeGreaterThan(39 * 60_000)
    expect(quotaFreshness(sent, now).stale).toBe(true)
  })

  it('leaves a genuinely fresh reading alone', () => {
    const fresh = quotaFreshness(at(60_000), Date.now())
    expect(fresh.stale).toBe(false)
    expect(fresh.ageMs).toBeLessThan(QUOTA_STALE_AFTER_MS)
  })

  /**
   * ⛔ Staleness is only ever *added*. The flag on the reading carries a second reason the clock
   * cannot rediscover — `lastQuotaReading` sets it when the newest attempt failed and these are the
   * last numbers that worked — and recomputing from age alone would quietly clear it, taking the
   * "last check failed" note off a card that has every reason to carry one.
   */
  it('keeps a stale flag that age alone would not explain', () => {
    expect(quotaFreshness({ ...at(1000), stale: true }, Date.now()).stale).toBe(true)
  })

  it('treats a reading with no windows as stale, and no reading at all as stale', () => {
    expect(quotaFreshness({ sampledAt: Date.now(), windows: [] }, Date.now()).stale).toBe(true)
    expect(quotaFreshness(null, Date.now()).stale).toBe(true)
  })
})

describe('timeRange', () => {
  const start = new Date(2026, 7, 24, 13, 43, 0).getTime()
  const end = new Date(2026, 7, 24, 13, 50, 0).getTime()

  it('formats start and end timestamps', () => {
    expect(timeRange(start, end)).toBe(`${when(start)} – ${when(end)}`)
  })

  it('formats open/ongoing time range with now', () => {
    expect(timeRange(start, null)).toBe(`${when(start)} – now`)
  })

  it('formats single start timestamp when endTs is undefined', () => {
    expect(timeRange(start, undefined)).toBe(when(start))
  })

  it('returns dash when start is null or undefined', () => {
    expect(timeRange(null, end)).toBe('—')
    expect(timeRange(undefined, undefined)).toBe('—')
  })
})
