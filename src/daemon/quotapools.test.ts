import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { QuotaWindow } from '@shared/protocol.js'

/**
 * One account, two quota pools.
 *
 * ⭐ Antigravity meters **Gemini apart from Claude/GPT** — two five-hour windows and two weeklies on
 * a single account, measured 2026-08-27 by reading the `/usage` panel, which renders both groups.
 * The parser has produced four windows since that day. What consumed them was one line asking for a
 * window whose id is `session` or `5h`, which on this provider matches neither.
 *
 * ⛔ The adapter papered over that by renaming the **busiest** five-hour window to the bare `5h`.
 * That is the right answer for a caller with no model in hand — the reset countdown, the reserve's
 * sample query — and the wrong one for the dispatch gate, which since 2026-08-29 resolves the task's
 * model *before* it spawns. Holding a Gemini task out because the Claude/GPT pool is nearly spent is
 * a refusal with no cause: the pools do not share.
 */

let dir: string
let db: typeof import('./db.js')
let quota: typeof import('./quota.js')
let costmodel: typeof import('./costmodel.js')

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-pools-'))
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
  db = await import('./db.js')
  quota = await import('./quota.js')
  costmodel = await import('./costmodel.js')
  db.openDb(join(dir, 'pools.db'))
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    // A held handle on Windows is not a test failure.
  }
})

/** The shape `parseUsageScreen` emits, after the adapter aliases the busiest five-hour to `5h`. */
const antigravityWindows = (geminiPct: number, claudePct: number): QuotaWindow[] => {
  const gemini: QuotaWindow = {
    id: '5h:gemini',
    label: 'Gemini 5h',
    percent: geminiPct,
    resetsAt: null,
    group: 'gemini'
  }
  const claude: QuotaWindow = {
    id: '5h:claude-gpt',
    label: 'Claude/GPT 5h',
    percent: claudePct,
    resetsAt: null,
    group: 'claude-gpt'
  }
  // The adapter's aliasing, reproduced: the busiest loses its id and keeps its group.
  const busiest = geminiPct >= claudePct ? gemini : claude
  busiest.id = '5h'
  return [gemini, claude]
}

describe('picking the window that governs a run', () => {
  it('reads the pool the model actually draws on, not the emptier one', () => {
    // ⭐ The case the old line got wrong. Claude/GPT is nearly spent and therefore holds the bare
    //    `5h` alias; a Gemini task must still see its own untouched 4%.
    const windows = antigravityWindows(4, 96)
    expect(quota.sessionWindowFor(windows, 'gemini')?.percent).toBe(4)
    expect(quota.sessionWindowFor(windows, 'claude')?.percent).toBe(96)
  })

  it('finds a pool whose window is the one carrying the alias', () => {
    // ⛔ The busiest window's id was overwritten, so it can only be found by `group`. Matching on the
    //    id alone would lose whichever pool happened to be fullest.
    const windows = antigravityWindows(96, 4)
    expect(quota.sessionWindowFor(windows, 'gemini')?.percent).toBe(96)
    expect(quota.sessionWindowFor(windows, 'claude')?.percent).toBe(4)
  })

  it('falls back to the busiest when no model is known, which is what the alias is for', () => {
    // ⚠️ The reset countdown and the reserve have no model in hand. Pessimistic is correct there.
    expect(quota.sessionWindowFor(antigravityWindows(4, 96), null)?.percent).toBe(96)
    expect(quota.sessionWindowFor(antigravityWindows(96, 4), null)?.percent).toBe(96)
  })

  it('falls back rather than refusing when the pool matches nothing', () => {
    // ⛔ An unrecognised pool is ignorance, not permission. Returning no window would read as "no
    //    limit found" and dispatch onto a spent account.
    expect(quota.sessionWindowFor(antigravityWindows(4, 96), 'mistral')?.percent).toBe(96)
  })

  it('leaves a single-pool provider exactly as it was', () => {
    // ⛔ The guard. Anthropic has one pool and its window carries no group; asking for a pool there
    //    must not start returning undefined and disable the gate for the whole provider.
    const anthropic: QuotaWindow[] = [
      { id: '5h', label: 'session', percent: 42, resetsAt: null },
      { id: '7d', label: 'weekly_all', percent: 11, resetsAt: null }
    ]
    expect(quota.sessionWindowFor(anthropic, null)?.percent).toBe(42)
    expect(quota.sessionWindowFor(anthropic, 'claude')?.percent).toBe(42)
  })

  it('matches a group by containment, because the panel writes the heading three ways', () => {
    // ⚠️ `CLAUDE & GPT`, `CLAUDE AND GPT` and `CLAUDE/GPT` slugify to three different strings. The
    //    pool token has to be a substring of all three, and of none of Gemini's.
    for (const group of ['claude-gpt', 'claude-and-gpt']) {
      const windows: QuotaWindow[] = [
        { id: '5h:gemini', label: 'Gemini 5h', percent: 3, resetsAt: null, group: 'gemini' },
        { id: '5h', label: 'Claude/GPT 5h', percent: 88, resetsAt: null, group }
      ]
      expect(quota.sessionWindowFor(windows, 'claude')?.percent, group).toBe(88)
      expect(quota.sessionWindowFor(windows, 'gpt')?.percent, group).toBe(88)
      expect(quota.sessionWindowFor(windows, 'gemini')?.percent, group).toBe(3)
    }
  })

  it('returns all applicable windows (both 5h and 7d) for a pool with windowsForPool', () => {
    const windows: QuotaWindow[] = [
      { id: '5h:gemini', label: 'Gemini 5h', percent: 0, resetsAt: null, group: 'gemini' },
      { id: 'weekly:gemini', label: 'Gemini 7d', percent: 93, resetsAt: null, group: 'gemini' },
      { id: '5h:claude-and-gpt', label: 'Claude/GPT 5h', percent: 0, resetsAt: null, group: 'claude-and-gpt' },
      { id: 'weekly:claude-and-gpt', label: 'Claude/GPT 7d', percent: 88, resetsAt: null, group: 'claude-and-gpt' }
    ]
    const geminiWins = quota.windowsForPool(windows, 'gemini')
    expect(geminiWins).toHaveLength(2)
    expect(geminiWins.map((w) => w.id)).toEqual(['5h:gemini', 'weekly:gemini'])

    const claudeWins = quota.windowsForPool(windows, 'claude')
    expect(claudeWins).toHaveLength(2)
    expect(claudeWins.map((w) => w.id)).toEqual(['5h:claude-and-gpt', 'weekly:claude-and-gpt'])
  })
})

describe('which pool each model belongs to', () => {
  it('is read from the cost model, model by model', () => {
    const cm = costmodel.costModel('google.antigravity.2026-08')
    expect(cm.modelSpec('gemini-3.1-pro-high')?.pool).toBe('gemini')
    expect(cm.modelSpec('claude-sonnet-4-6')?.pool).toBe('claude')
    expect(cm.modelSpec('gpt-oss-120b-medium')?.pool).toBe('gpt')
  })

  it('covers every model the file offers, so none falls through to the pessimistic window', () => {
    // ⛔ A model with no pool silently gets the busiest window — the exact behaviour this replaces.
    //    Adding a model to this file without a pool would reintroduce it for that model only.
    const cm = costmodel.costModel('google.antigravity.2026-08')
    for (const id of cm.modelIds()) {
      expect(cm.modelSpec(id)?.pool, id).toBeTruthy()
    }
  })

  it('leaves single-pool providers without one, which is not the same as unknown', () => {
    // ⚠️ Undefined here means "this account has one pool and every window covers it".
    const cm = costmodel.costModel('anthropic.subscription.2026-08')
    for (const id of cm.modelIds()) {
      expect(cm.modelSpec(id)?.pool, id).toBeUndefined()
    }
  })

  it('declares, on the file itself, the probe it actually has', () => {
    // ⛔ This block said kind 'unknown', probe 'none', windows [] while a working parser had been
    //    reading four windows for two days and the adapter declared `quotaProbe: 'cli'`. A cost model
    //    that contradicts the code is worse than one that says nothing.
    //
    // ⚠️ Asserted against the shipped JSON rather than through `CostModel`, because **nothing reads
    //    this block** — `data` is private and the live windows come from `parseUsageScreen`. It is
    //    documentation, and this test is what stops it drifting back into a lie. The `pool` field
    //    beside it is the part that is load-bearing, and the tests above cover that.
    const file = JSON.parse(
      readFileSync(join(process.cwd(), 'costmodels', 'google.antigravity.2026-08.json'), 'utf8')
    ) as { quota?: { kind?: string; probe?: string; windows?: unknown[] } }
    expect(file.quota?.kind).toBe('rolling_windows')
    expect(file.quota?.probe).toBe('cli')
    expect(file.quota?.windows).toHaveLength(4)
  })
})
