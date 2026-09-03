import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  parseContextScreen,
  parseTokenCount,
  parseUsageScreen,
  parseUsageScreenIdentity,
  readAntigravityIdentity
} from './antigravity-cli.js'

/**
 * Reading Antigravity's `/usage` panel.
 *
 * ⛔ The fixture is a **real capture**, not a hand-written approximation: `agy` driven in a real PTY
 * on 2026-08-27 (v1.1.22, Google AI Pro), ANSI stripped, saved verbatim. A hand-written sample of a
 * screen format proves only that the parser matches the sample.
 *
 * ⚠️ This parser is the one place in the codebase that turns rendered terminal text into state, so
 * it carries the tests that go with that: the numbers are inverted (the panel reports *remaining*,
 * the model stores *used*), a partial screen must fail rather than half-parse, and the id the quota
 * gate looks for has to land on the right window.
 */

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '__fixtures__',
  'agy-usage-screen.txt'
)
const screen = readFileSync(FIXTURE, 'utf8')
const NOW = 1_787_815_290_000

describe('the /usage panel', () => {
  it('finds every window in both model groups', () => {
    const windows = parseUsageScreen(screen, NOW)
    expect(windows).not.toBeNull()
    // Gemini weekly + Gemini 5h + Claude/GPT weekly + Claude/GPT 5h.
    expect(windows).toHaveLength(4)
    expect(windows?.map((w) => w.label)).toEqual([
      'Gemini 5h',
      'Gemini 7d',
      'Claude/GPT 5h',
      'Claude/GPT 7d'
    ])
  })

  it('⛔ inverts remaining into used, which is what QuotaWindow.percent means', () => {
    // The panel said "94.52%" under "Weekly Limit Remaining". Storing that as `percent` would report
    // an almost-untouched window as almost-exhausted and vice versa — and in the dangerous
    // direction: QUOTA_HIGH_WATER (92% used) would never trip on an account that was genuinely full.
    const windows = parseUsageScreen(screen, NOW) ?? []
    const geminiWeekly = windows.find((w) => w.label === 'Gemini 7d')
    expect(geminiWeekly?.percent).toBeCloseTo(5.48, 2)

    const claudeFiveHour = windows.find((w) => w.label === 'Claude/GPT 5h')
    // "Quota available" / 100.00% remaining — nothing used.
    expect(claudeFiveHour?.percent).toBe(0)
  })

  it('takes the bar’s own figure, not the rounded sentence under it', () => {
    // The panel prints "[…] 94.52%" and then "95% remaining". The sentence rounds the *remaining*
    // figure up, which rounds the utilisation down — the optimistic direction.
    const windows = parseUsageScreen(screen, NOW) ?? []
    expect(windows.find((w) => w.label === 'Gemini 7d')?.percent).not.toBe(5)
  })

  it('turns "Refreshes in 1h 51m" into an instant, and "Quota available" into no instant', () => {
    const windows = parseUsageScreen(screen, NOW) ?? []
    const geminiFiveHour = windows.find((w) => w.label === 'Gemini 5h')
    expect(geminiFiveHour?.resetsAt).toBe(NOW + (1 * 60 + 51) * 60_000)

    const geminiWeekly = windows.find((w) => w.label === 'Gemini 7d')
    expect(geminiWeekly?.resetsAt).toBe(NOW + 138 * 60 * 60_000)

    // ⚠️ A window with quota to spare states no reset, and null is the honest answer. Zero would be
    // read downstream as "resets at the epoch", i.e. already reset.
    expect(windows.find((w) => w.label === 'Claude/GPT 5h')?.resetsAt).toBeNull()
  })

  it('⛔ gives the id the quota gate looks for to the BUSIEST five-hour window', () => {
    // There are two five-hour windows because Gemini and Claude/GPT are metered separately, and a
    // quota snapshot cannot know which group the next run will use. `scheduler.ts` and `reserve.ts`
    // both look for `session` or `5h`. Promoting the busiest is the conservative direction:
    // over-stating pressure delays a dispatch, under-stating it strands a run at a window boundary.
    const windows = parseUsageScreen(screen, NOW) ?? []
    const gate = windows.find((w) => w.id === '5h')
    expect(gate?.label).toBe('Gemini 5h') // 32.8% used, against 0% on Claude/GPT
    expect(gate?.percent).toBeCloseTo(32.8, 2)
    // ⚠️ Exactly one, or the fleet strip shows the same window twice and the gate picks arbitrarily.
    expect(windows.filter((w) => w.id === '5h')).toHaveLength(1)
  })

  it('every window carries a distinct id', () => {
    const windows = parseUsageScreen(screen, NOW) ?? []
    expect(new Set(windows.map((w) => w.id)).size).toBe(windows.length)
  })

  it('⛔ returns null for a screen that is not the panel, rather than an empty reading', () => {
    // An empty `windows` array is stored as a reading and rendered as "unknown"; null lets the
    // caller say what actually happened. The commonest non-panel screen is the folder-trust dialog,
    // which eats the keystrokes — measured while building this probe.
    expect(parseUsageScreen('', NOW)).toBeNull()
    expect(parseUsageScreen('Do you trust the contents of this project?', NOW)).toBeNull()
    expect(parseUsageScreen('? for shortcuts', NOW)).toBeNull()
  })

  it('⛔ refuses a panel that was cut off mid-group rather than under-reporting', () => {
    // ⚠️ This is not hypothetical - it is what the probe did on its first live run. At the default
    // 30 rows the panel scrolled, Claude-and-GPT's five-hour window fell below the fold, and three
    // windows came back looking complete. The dropped window is a candidate for the `5h` promotion,
    // so the gate would have been handed one group's pressure while the run used the other's.
    // A group that shows one of its two windows means the read was short. Fail, do not guess.
    const cut = screen.slice(0, screen.indexOf('Five Hour Limit Remaining', screen.indexOf('CLAUDE AND GPT MODELS')))
    expect(parseUsageScreen(cut, NOW)).toBeNull()
  })

  it('a whole group missing is fine - that is a shorter panel, not a truncated one', () => {
    // ⚠️ The complement, so the guard above cannot be satisfied by simply refusing everything: an
    // account with one model group is a legitimate two-window panel.
    const oneGroup = screen.slice(0, screen.indexOf('CLAUDE AND GPT MODELS'))
    const windows = parseUsageScreen(oneGroup, NOW)
    expect(windows).toHaveLength(2)
    expect(windows?.some((w) => w.id === '5h')).toBe(true)
  })

  it('ignores a percentage that is not attached to a bar', () => {
    const prose = 'Models & Quota\nGEMINI MODELS\n  Quota is consumed proportionally, up to 100%.\n'
    expect(parseUsageScreen(prose, NOW)).toBeNull()
  })

  it('deduplicates windows when backscroll contains multiple repaints', () => {
    const tripleScreen = `${screen}\n${screen}\n${screen}`
    const windows = parseUsageScreen(tripleScreen, NOW)
    expect(windows).not.toBeNull()
    expect(windows).toHaveLength(4)
    expect(new Set(windows?.map((w) => w.id)).size).toBe(4)
  })

  it('parses a complete "Quota available" on the bar line as 0% used', () => {
    const screenWithQuotaAvailableOnBar = screen.replace(
      'Five Hour Limit Remaining\n    [██████████████████████████████████████████████████] 100.00%',
      'Five Hour Limit Remaining\n    [██████████████████████████████████████████████████] Quota available'
    )
    const windows = parseUsageScreen(screenWithQuotaAvailableOnBar, NOW)
    expect(windows).not.toBeNull()
    expect(windows).toHaveLength(4)
    const claudeFiveHour = windows?.find((w) => w.label === 'Claude/GPT 5h')
    expect(claudeFiveHour?.percent).toBe(0)
    expect(claudeFiveHour?.resetsAt).toBeNull()
  })

  it('⛔ records no reading when a clipped "Quota ava…" would make a used window look unused', () => {
    // The exact t163 failure: both Gemini labels were visibly clipped. Treating the ellipsis as
    // "available" created two false 0% rows and a later real reading was charged as a huge delta.
    const clipped = screen
      .replace('] 94.52%', '] Quota ava…')
      .replace('] 67.20%', '] Quota ava…')
    expect(parseUsageScreen(clipped, NOW)).toBeNull()
  })

  it('treats a five-hour window disabled by an exhausted weekly pool as gated until weekly reset', () => {
    // ⭐ Verbatim leading text from a live agy 1.1.25 panel on 2026-09-03. The remainder of this
    // vendor sentence was clipped at column 120, so only the stable complete sentence is matched.
    const disabled = screen
      .replace(
        '[█████████████████████████████░░░░░░░░░░░░░░░░░░░░░] 57.20%',
        '[░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░] 0.00%'
      )
      .replace(
        '[██████████████████████████████████████████████████] 100.00%\n    Quota available',
        'Disabled: You have hit your weekly limit, the 5-hour limit does not currently apply. Your weekly limit will fully re'
      )
    const windows = parseUsageScreen(disabled, NOW)

    expect(windows).not.toBeNull()
    expect(windows).toHaveLength(4)
    const weekly = windows?.find((w) => w.label === 'Claude/GPT 7d')
    const disabledFiveHour = windows?.find((w) => w.label === 'Claude/GPT 5h')
    expect(weekly?.percent).toBe(100)
    expect(disabledFiveHour?.percent).toBe(100)
    expect(disabledFiveHour?.resetsAt).toBe(weekly?.resetsAt)
    // It is the pessimistic bare gate too; a consumer without a model must not dispatch here.
    expect(disabledFiveHour?.id).toBe('5h')
  })
})

describe('parseTokenCount', () => {
  it('parses abbreviations and commas into exact numbers', () => {
    expect(parseTokenCount('28.9k')).toBe(28900)
    expect(parseTokenCount('1.0M')).toBe(1000000)
    expect(parseTokenCount('1,048,576')).toBe(1048576)
    expect(parseTokenCount('145')).toBe(145)
    expect(parseTokenCount('0')).toBe(0)
  })
})

describe('parseContextScreen', () => {
  const CONTEXT_SCREEN = `
└ Context Usage
◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □     Gemini 3.7 Flash (High) · 28.9k/1.0M tokens
□ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □      (2.8%)
□ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □     Token usage by category
□ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □     ◉ User messages: 1 tokens (0.0%)
□ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □     ◉ Agent responses: 145 tokens (0.0%)
□ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □     ◉ Tool calls: 0 tokens (0.0%)
□ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □     ⛁ System prompt: 12.7k tokens (1.2%)
□ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □     ⛁ System tools: 14.7k tokens (1.4%)
□ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □     ⛁ Skills: 699 tokens (0.1%)
□ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □     ⛁ Subagents: 653 tokens (0.1%)
□ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □     □ Free space: 1.0M (97.2%)
`

  it('extracts tokens, capacity, percentage, and breakdown', () => {
    const snap = parseContextScreen(CONTEXT_SCREEN)
    expect(snap).not.toBeNull()
    expect(snap?.model).toBe('Gemini 3.7 Flash (High)')
    expect(snap?.usedTokens).toBe(28900)
    expect(snap?.windowTokens).toBe(1000000)
    expect(snap?.percent).toBe(2.8)
    expect(snap?.breakdown?.systemPrompt).toBe(12700)
    expect(snap?.breakdown?.systemTools).toBe(14700)
    expect(snap?.breakdown?.skills).toBe(699)
    expect(snap?.breakdown?.subagents).toBe(653)
    expect(snap?.breakdown?.userMessages).toBe(1)
    expect(snap?.breakdown?.agentResponses).toBe(145)
  })

  it('parses a fresh session with 0 tokens', () => {
    const freshScreen = `
└ Context Breakdown
  Context Window Usage (Session Tokens)
    [░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░] 0.00%
    0 / 1,048,576 tokens used
  Tokens by Category
    System instructions                                0  (0%)
    Conversation history                               0  (0%)
`
    const snap = parseContextScreen(freshScreen)
    expect(snap).not.toBeNull()
    expect(snap?.usedTokens).toBe(0)
    expect(snap?.windowTokens).toBe(1048576)
    expect(snap?.percent).toBe(0)
  })

  it('parseUsageScreen returns a QuotaWindow for context when /context is present', () => {
    const windows = parseUsageScreen(CONTEXT_SCREEN)
    expect(windows).not.toBeNull()
    expect(windows).toHaveLength(1)
    expect(windows?.[0]).toEqual({
      id: 'context',
      label: 'Context · 1M',
      percent: 2.8,
      resetsAt: null
    })
  })
})

describe('parseUsageScreenIdentity', () => {
  it('extracts account and inferred tier from the fixture /usage screen', () => {
    const ident = parseUsageScreenIdentity(screen)
    expect(ident).not.toBeNull()
    expect(ident?.account).toBe('someone@example.com')
    expect(ident?.subscriptionType).toBe('Google AI Pro')
  })

  it('extracts explicit tier in parentheses from header line', () => {
    const customScreen = screen.replace(
      'Account: someone@example.com',
      'Account: user@domain.com (Google AI Ultra)'
    )
    const ident = parseUsageScreenIdentity(customScreen)
    expect(ident?.account).toBe('user@domain.com')
    expect(ident?.subscriptionType).toBe('Google AI Ultra')
  })

  it('extracts explicit tier after middle dot from header line', () => {
    const customScreen = screen.replace(
      'Account: someone@example.com',
      'Account: user@domain.com · Google One AI Premium'
    )
    const ident = parseUsageScreenIdentity(customScreen)
    expect(ident?.account).toBe('user@domain.com')
    expect(ident?.subscriptionType).toBe('Google One AI Premium')
  })

  it('returns null for non-usage screens', () => {
    expect(parseUsageScreenIdentity('')).toBeNull()
    expect(parseUsageScreenIdentity('Do you trust the contents of this project?')).toBeNull()
  })
})

describe('readAntigravityIdentity', () => {
  it('reads active email from google_accounts.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-ident-'))
    try {
      writeFileSync(
        join(dir, 'google_accounts.json'),
        JSON.stringify({ active: 'test@example.com', old: [] })
      )
      const res = readAntigravityIdentity(dir)
      expect(res.loggedIn).toBe(true)
      expect(res.account).toBe('test@example.com')
      expect(res.subscriptionType).toBe('Google AI Pro')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('falls back to oauth_creds.json id_token when google_accounts.json is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-ident-'))
    try {
      const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64')
      const payload = Buffer.from(JSON.stringify({ email: 'oauth@example.com' })).toString('base64')
      const token = `${header}.${payload}.signature`
      writeFileSync(
        join(dir, 'oauth_creds.json'),
        JSON.stringify({ id_token: token })
      )
      const res = readAntigravityIdentity(dir)
      expect(res.loggedIn).toBe(true)
      expect(res.account).toBe('oauth@example.com')
      expect(res.subscriptionType).toBe('Google AI Pro')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns loggedIn: false when settings.json exists but no account credentials exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-ident-'))
    try {
      writeFileSync(join(dir, 'settings.json'), JSON.stringify({ enableTelemetry: false }))
      const res = readAntigravityIdentity(dir)
      expect(res.loggedIn).toBe(false)
      expect(res.account).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns loggedIn: null when directory is empty / nonexistent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-ident-'))
    try {
      const res = readAntigravityIdentity(join(dir, 'nonexistent'))
      expect(res.loggedIn).toBeNull()
      expect(res.account).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
