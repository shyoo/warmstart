import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  formatPlan,
  lastRateLimits,
  parseJwtPayload,
  readCodexAuthIdentity,
  rolloutQuota,
  windowsFromRateLimits
} from './openai-compatible.js'

/**
 * Codex's quota reading comes out of a rollout file, and the fixture is a real one.
 *
 * ⛔ For three months this adapter answered `windows: []` with the note "Codex has no
 * non-interactive usage command". The command half was true; the conclusion was not. Measured
 * 2026-08-29 on codex-cli 0.151.0, every turn writes `rate_limits` into its rollout JSONL, so the
 * reading was on disk the whole time and the fleet strip said `quota unknown` over it.
 *
 * ⚠️ The account that produced the fixture is on the **free** plan, and that is the interesting
 * part: free reports **one 30-day window** and a null `secondary`, where a paid plan reports a
 * five-hour one. So "quota is unavailable to free users" is false, and an adapter that read
 * `primary` as *the 5h window* would be wrong here in a way that reaches `reserve.ts`.
 */

const FIXTURE = join(import.meta.dirname, '__fixtures__', 'codex-rollout-tail.jsonl')

let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'agentyard-codexquota-'))
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** A rollout at `<root>/sessions/<y>/<m>/<d>/rollout-<stamp>-<id>.jsonl`, as codex lays them out. */
function plantRollout(dir: string, day: [string, string, string], name: string, body: string): void {
  const d = join(dir, 'sessions', ...day)
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, name), body)
}

describe('codex rate_limits, read from a rollout', () => {
  const jsonl = () => readFileSync(FIXTURE, 'utf8')

  it('finds the last token_count record and dates it by the vendor timestamp', () => {
    const found = lastRateLimits(jsonl())
    expect(found).not.toBeNull()
    expect(found!.limits.plan_type).toBe('free')
    // ⛔ The record's own timestamp, never Date.now(). quota.ts's staleness ladder reads this.
    expect(found!.at).toBe(Date.parse('2026-08-30T01:23:30.316Z'))
  })

  it('names the window by its length, not by the slot it arrived in', () => {
    const windows = windowsFromRateLimits(lastRateLimits(jsonl())!.limits)
    expect(windows).toEqual([
      { id: '30d', label: '30d', percent: 0, resetsAt: 1790645009 * 1000 }
    ])
  })

  it('calls a five-hour window `5h`, which is the id the gates recognise', () => {
    // ⛔ reserve.ts and controller.ts key on `5h`/`session`. A paid plan puts that window in
    // `primary` and a longer one in `secondary`; free puts a 30-day one in `primary`. Only the
    // duration tells them apart.
    const windows = windowsFromRateLimits({
      primary: { used_percent: 41.5, window_minutes: 300, resets_at: 1790645009 },
      secondary: { used_percent: 12, window_minutes: 10080, resets_at: null }
    })
    expect(windows.map((w) => w.id)).toEqual(['5h', '7d'])
    expect(windows[0]!.percent).toBe(41.5)
    expect(windows[1]!.resetsAt).toBeNull()
  })

  it('drops a null secondary rather than inventing a window for it', () => {
    expect(windowsFromRateLimits({ primary: null, secondary: null })).toEqual([])
  })

  it('walks back past a half-written last line', () => {
    // A live session is still appending; the tail is routinely truncated mid-object.
    const found = lastRateLimits(jsonl() + '{"type":"event_msg","payload":{"rate_limits":')
    expect(found?.limits.plan_type).toBe('free')
  })
})

describe('the rollout rung', () => {
  // ⚠️ `rolloutQuota`, not `probeQuota`. The probe asks the app-server first, and spawning that
  // here would make the suite depend on whether the machine running it is signed in to codex.
  it('reads the newest rollout under the isolation root', () => {
    const dir = join(root, 'happy')
    plantRollout(dir, ['2026', '08', '29'], 'rollout-2026-08-29T18-23-28-a.jsonl', readFileSync(FIXTURE, 'utf8'))
    const q = rolloutQuota(dir)
    expect(q.source).toBe('config-cache')
    expect(q.error).toBeUndefined()
    expect(q.windows).toEqual([{ id: '30d', label: '30d', percent: 0, resetsAt: 1790645009 * 1000 }])
    expect(q.sampledAt).toBe(Date.parse('2026-08-30T01:23:30.316Z'))
  })

  it('prefers a later day directory over an earlier one', () => {
    const dir = join(root, 'twodays')
    const old = readFileSync(FIXTURE, 'utf8').replace('"used_percent":0.0', '"used_percent":88.0')
    plantRollout(dir, ['2026', '07', '01'], 'rollout-2026-07-01T00-00-00-a.jsonl', old)
    plantRollout(dir, ['2026', '08', '29'], 'rollout-2026-08-29T18-23-28-b.jsonl', readFileSync(FIXTURE, 'utf8'))
    const q = rolloutQuota(dir)
    expect(q.windows[0]!.percent).toBe(0)
  })

  it('says so when the root holds no rollouts at all', () => {
    const q = rolloutQuota(join(root, 'empty'))
    expect(q.windows).toEqual([])
    expect(q.source).toBe('unknown')
    expect(q.error).toMatch(/no rollout files/)
  })

  it('reports a rollout with no rate_limits as a failed reading, not a zero one', () => {
    const dir = join(root, 'norates')
    plantRollout(
      dir,
      ['2026', '08', '29'],
      'rollout-2026-08-29T18-23-28-c.jsonl',
      '{"timestamp":"2026-08-30T01:23:28.282Z","type":"event_msg","payload":{"type":"task_started"}}\n'
    )
    const q = rolloutQuota(dir)
    expect(q.windows).toEqual([])
    expect(q.error).toMatch(/no rate_limits record/)
  })

  it('names an unmetered account instead of returning an empty snapshot', () => {
    const dir = join(root, 'credits')
    const body = readFileSync(FIXTURE, 'utf8')
      .replace('"primary":{"used_percent":0.0,"window_minutes":43200,"resets_at":1790645009}', '"primary":null')
      .replace('"unlimited":false', '"unlimited":true')
    plantRollout(dir, ['2026', '08', '29'], 'rollout-2026-08-29T18-23-28-d.jsonl', body)
    const q = rolloutQuota(dir)
    expect(q.windows).toEqual([])
    expect(q.error).toMatch(/unlimited credits/)
    // ⚠️ Still the vendor's timestamp: we know *when* we learned there is nothing to meter.
    expect(q.sampledAt).toBe(Date.parse('2026-08-30T01:23:30.316Z'))
  })
})

describe('the two rungs, and why they are not interchangeable', () => {
  // ⭐ Measured 2026-08-29, codex-cli 0.151.0: `codex app-server` answers `account/rateLimits/read`
  // in ~700ms with no params, no turn and no token — the same reading the TUI's `/status` shows. It
  // is a live server call, not a cache: two readings minutes apart returned `resetsAt` 1311s apart.
  //
  // ⛔ That is why the rollout is the *fallback*. A rollout is only ever as fresh as the worker's
  // last turn, so an idle worker's reading ages without limit; the app-server's is current whenever
  // it is asked. The fallback still earns its keep — the live call needs the network and a working
  // sign-in — which is what the differing `source` values are for.
  it('reads a live app-server response, which is camelCase where the rollout is snake_case', () => {
    const windows = windowsFromRateLimits({
      planType: 'free',
      primary: { usedPercent: 0, windowDurationMins: 43200, resetsAt: 1790646320 },
      secondary: null,
      credits: { hasCredits: false, unlimited: false, balance: null }
    })
    expect(windows).toEqual([
      { id: '30d', label: '30d', percent: 0, resetsAt: 1790646320 * 1000 }
    ])
  })

  it('reads both spellings through one normaliser, so neither caller has to know its source', () => {
    const camel = windowsFromRateLimits({
      primary: { usedPercent: 41, windowDurationMins: 300, resetsAt: 1790646320 }
    })
    const snake = windowsFromRateLimits({
      primary: { used_percent: 41, window_minutes: 300, resets_at: 1790646320 }
    })
    expect(camel).toEqual(snake)
  })

  it('ignores a window the app-server sent without a duration', () => {
    // `windowDurationMins` is nullable in the protocol schema, and an id cannot be derived without
    // it. A window with no id would be a window no gate can find.
    expect(windowsFromRateLimits({ primary: { usedPercent: 12, windowDurationMins: null } })).toEqual([])
  })

  it('reads a paid Pro/Plus app-server response with 5h primary and 7d secondary windows', () => {
    const windows = windowsFromRateLimits({
      planType: 'plus',
      primary: { usedPercent: 15, windowDurationMins: 300, resetsAt: 1788338185 },
      secondary: { usedPercent: 42, windowDurationMins: 10080, resetsAt: 1788924985 },
      credits: { hasCredits: false, unlimited: false, balance: '0' }
    })
    expect(windows).toEqual([
      { id: '5h', label: '5h', percent: 15, resetsAt: 1788338185 * 1000 },
      { id: '7d', label: '7d', percent: 42, resetsAt: 1788924985 * 1000 }
    ])
  })
})

describe('codex identity and JWT payload parsing', () => {
  it('formats plan names nicely', () => {
    expect(formatPlan('plus')).toBe('Plus')
    expect(formatPlan('pro')).toBe('Pro')
    expect(formatPlan('free')).toBe('Free')
    expect(formatPlan('team')).toBe('Team')
    expect(formatPlan('enterprise')).toBe('Enterprise')
    expect(formatPlan(null)).toBeNull()
  })

  it('decodes base64url JWT payload claims', () => {
    const payload = { email: 'user@example.com', sub: '123' }
    const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const jwt = `header.${b64}.signature`
    expect(parseJwtPayload(jwt)).toEqual(payload)
    expect(parseJwtPayload('invalid')).toBeNull()
  })

  it('extracts account email and subscriptionType from auth.json tokens', () => {
    const idClaims = {
      email: 'shyoo@sunghwanyoo.com',
      'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' }
    }
    const accessClaims = {
      'https://api.openai.com/profile': { email: 'shyoo@sunghwanyoo.com' },
      'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' }
    }
    const idToken = `h.${Buffer.from(JSON.stringify(idClaims)).toString('base64url')}.s`
    const accessToken = `h.${Buffer.from(JSON.stringify(accessClaims)).toString('base64url')}.s`

    const dir = join(root, 'authident')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'auth.json'),
      JSON.stringify({
        tokens: {
          id_token: idToken,
          access_token: accessToken,
          refresh_token: 'rt_dummy'
        }
      })
    )

    const ident = readCodexAuthIdentity(dir)
    expect(ident).toEqual({
      loggedIn: true,
      account: 'shyoo@sunghwanyoo.com',
      subscriptionType: 'Plus'
    })
  })

  it('handles API key auth mode in auth.json', () => {
    const dir = join(root, 'apikeyident')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-test' }))

    const ident = readCodexAuthIdentity(dir)
    expect(ident).toEqual({
      loggedIn: true,
      subscriptionType: 'API Key'
    })
  })
})

