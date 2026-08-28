import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseUsageScreen } from './antigravity-cli.js'

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
      'Gemini · weekly',
      'Gemini · 5-hour',
      'Claude and GPT · weekly',
      'Claude and GPT · 5-hour'
    ])
  })

  it('⛔ inverts remaining into used, which is what QuotaWindow.percent means', () => {
    // The panel said "94.52%" under "Weekly Limit Remaining". Storing that as `percent` would report
    // an almost-untouched window as almost-exhausted and vice versa — and in the dangerous
    // direction: QUOTA_HIGH_WATER (92% used) would never trip on an account that was genuinely full.
    const windows = parseUsageScreen(screen, NOW) ?? []
    const geminiWeekly = windows.find((w) => w.label === 'Gemini · weekly')
    expect(geminiWeekly?.percent).toBeCloseTo(5.48, 2)

    const claudeFiveHour = windows.find((w) => w.label === 'Claude and GPT · 5-hour')
    // "Quota available" / 100.00% remaining — nothing used.
    expect(claudeFiveHour?.percent).toBe(0)
  })

  it('takes the bar’s own figure, not the rounded sentence under it', () => {
    // The panel prints "[…] 94.52%" and then "95% remaining". The sentence rounds the *remaining*
    // figure up, which rounds the utilisation down — the optimistic direction.
    const windows = parseUsageScreen(screen, NOW) ?? []
    expect(windows.find((w) => w.label === 'Gemini · weekly')?.percent).not.toBe(5)
  })

  it('turns "Refreshes in 1h 51m" into an instant, and "Quota available" into no instant', () => {
    const windows = parseUsageScreen(screen, NOW) ?? []
    const geminiFiveHour = windows.find((w) => w.label === 'Gemini · 5-hour')
    expect(geminiFiveHour?.resetsAt).toBe(NOW + (1 * 60 + 51) * 60_000)

    const geminiWeekly = windows.find((w) => w.label === 'Gemini · weekly')
    expect(geminiWeekly?.resetsAt).toBe(NOW + 138 * 60 * 60_000)

    // ⚠️ A window with quota to spare states no reset, and null is the honest answer. Zero would be
    // read downstream as "resets at the epoch", i.e. already reset.
    expect(windows.find((w) => w.label === 'Claude and GPT · 5-hour')?.resetsAt).toBeNull()
  })

  it('⛔ gives the id the quota gate looks for to the BUSIEST five-hour window', () => {
    // There are two five-hour windows because Gemini and Claude/GPT are metered separately, and a
    // quota snapshot cannot know which group the next run will use. `scheduler.ts` and `reserve.ts`
    // both look for `session` or `5h`. Promoting the busiest is the conservative direction:
    // over-stating pressure delays a dispatch, under-stating it strands a run at a window boundary.
    const windows = parseUsageScreen(screen, NOW) ?? []
    const gate = windows.find((w) => w.id === '5h')
    expect(gate?.label).toBe('Gemini · 5-hour') // 32.8% used, against 0% on Claude/GPT
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

  it('parses "Quota available" or "Quota ava…" on the bar line as 0% used', () => {
    const screenWithQuotaAvailableOnBar = screen.replace(
      'Five Hour Limit Remaining\n    [██████████████████████████████████████████████████] 100.00%',
      'Five Hour Limit Remaining\n    [██████████████████████████████████████████████████] Quota ava…'
    )
    const windows = parseUsageScreen(screenWithQuotaAvailableOnBar, NOW)
    expect(windows).not.toBeNull()
    expect(windows).toHaveLength(4)
    const claudeFiveHour = windows?.find((w) => w.label === 'Claude and GPT · 5-hour')
    expect(claudeFiveHour?.percent).toBe(0)
    expect(claudeFiveHour?.resetsAt).toBeNull()
  })
})
