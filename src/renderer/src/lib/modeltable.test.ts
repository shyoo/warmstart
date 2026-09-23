import { describe, expect, it } from 'vitest'
import type { ModelOptions, Worker } from '@shared/protocol'
import type { ModelRoute } from '@shared/modelroutes'
import {
  effectiveEffort,
  isDefaultRow,
  isGradingRow,
  isJudgmentRow,
  isSummaryRow,
  modelTableRows,
  routesToStore,
  seedEffort
} from './modeltable'

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']
const claude: ModelOptions = {
  adapterId: 'claude-code',
  costModelId: 'anthropic',
  selectableEffort: true,
  models: [
    { id: 'claude-opus-5-5', contextWindow: 1_000_000, effortLevels: LEVELS },
    { id: 'claude-opus-5', contextWindow: 1_000_000, effortLevels: LEVELS },
    { id: 'claude-sonnet-5', contextWindow: 1_000_000, effortLevels: LEVELS },
    { id: 'claude-haiku-4-5', contextWindow: 200_000, effortLevels: [] }
  ]
}

type TableWorker = Parameters<typeof modelTableRows>[0]
const worker = (over: Partial<Worker> = {}): TableWorker => ({
  modelRoutes: null,
  defaultModel: null,
  defaultEffort: null,
  defaultModels: null,
  gradingModel: 'claude-haiku-4-5',
  gradingEffort: null,
  judgmentModel: null,
  judgmentEffort: null,
  summarisingModel: null,
  ...over
})
const row = (model: string, effort: string | null, auto = true): ModelRoute => ({ model, effort, modelClass: null, auto })
const pairs = (rows: Array<{ model: string; effort: string | null }>): string[] =>
  rows.map((r) => `${r.model}${r.effort ? `@${r.effort}` : ''}`)

describe('the model table (t638)', () => {
  it('⭐ draws only purpose rows when nothing is configured, so a removed row stays gone', () => {
    const rows = modelTableRows(worker(), claude)
    expect(pairs(rows)).toEqual(['claude-haiku-4-5'])
    expect(rows[0]?.stored).toBe(false)
    // ⛔ A table nobody touched writes nothing back — the inert state routing reads.
    expect(routesToStore(rows)).toEqual([])
  })

  it('⛔ never seeds "CLI default": the account effort where legal, else medium, else the middle level', () => {
    expect(seedEffort(LEVELS, 'high')).toBe('high')
    expect(seedEffort(LEVELS, null)).toBe('medium')
    expect(seedEffort(['a', 'b', 'c'], 'zzz')).toBe('b')
    expect(seedEffort([], 'high')).toBeNull()
  })

  it("orders lines by the adapter's model order, then strongest effort first", () => {
    const rows = modelTableRows(
      worker({ modelRoutes: [row('claude-sonnet-5', 'high'), row('claude-opus-5-5', 'medium'), row('claude-opus-5-5', 'xhigh')] }),
      claude
    )
    expect(pairs(rows)).toEqual([
      'claude-opus-5-5@xhigh',
      'claude-opus-5-5@medium',
      'claude-sonnet-5@high',
      'claude-haiku-4-5'
    ])
    // Written back in that order, which is the order plain Auto reads: the strongest ticked first.
    expect(pairs(routesToStore(rows))).toEqual(['claude-opus-5-5@xhigh', 'claude-opus-5-5@medium', 'claude-sonnet-5@high'])
  })

  it('always has a line for the default, grading, judgment and summary choices', () => {
    const w = worker({
      modelRoutes: [row('claude-opus-5', 'high')],
      defaultModel: 'claude-opus-5',
      defaultEffort: 'low',
      judgmentModel: 'claude-sonnet-5',
      judgmentEffort: 'max',
      summarisingModel: 'claude-opus-5-5'
    })
    const rows = modelTableRows(w, claude)
    expect(pairs(rows)).toContain('claude-opus-5@low')
    expect(pairs(rows)).toContain('claude-sonnet-5@max')
    expect(pairs(rows)).toContain('claude-opus-5-5@low')
    expect(rows.filter((r) => isDefaultRow(w, claude, r)).map((r) => r.effort)).toEqual(['low'])
    expect(rows.filter((r) => isJudgmentRow(w, claude, r)).map((r) => r.model)).toEqual(['claude-sonnet-5'])
    expect(rows.filter((r) => isGradingRow(w, claude, r)).map((r) => r.model)).toEqual(['claude-haiku-4-5'])
    expect(rows.filter((r) => isSummaryRow(w, r)).map((r) => r.model)).toEqual(['claude-opus-5-5'])
  })

  it('⚠️ a default effort on a model with no levels is the plain line, not a second one', () => {
    const w = worker({ defaultModel: 'claude-haiku-4-5', defaultEffort: 'medium' })
    expect(effectiveEffort(claude, 'claude-haiku-4-5', 'medium')).toBeNull()
    const rows = modelTableRows(w, claude)
    expect(rows.filter((r) => r.model === 'claude-haiku-4-5')).toHaveLength(1)
    expect(rows.filter((r) => isDefaultRow(w, claude, r)).map((r) => r.model)).toEqual(['claude-haiku-4-5'])
  })

  it('reads the default per quota pool on a multi-pool adapter', () => {
    const agy: ModelOptions = {
      adapterId: 'antigravity-cli',
      costModelId: 'google',
      selectableEffort: false,
      models: [
        { id: 'gemini-3.7-flash-high', contextWindow: null, effortLevels: [], pool: 'gemini' },
        { id: 'claude-sonnet-4-6', contextWindow: null, effortLevels: [], pool: 'claude' }
      ],
      pools: [
        { id: 'gemini', label: 'Gemini', models: ['gemini-3.7-flash-high'] },
        { id: 'claude', label: 'Claude/GPT', models: ['claude-sonnet-4-6'] }
      ]
    }
    const w = worker({ gradingModel: null, defaultModels: { gemini: 'gemini-3.7-flash-high', claude: 'claude-sonnet-4-6' } })
    const rows = modelTableRows(w, agy)
    expect(rows.filter((r) => isDefaultRow(w, agy, r)).map((r) => r.model)).toEqual([
      'gemini-3.7-flash-high',
      'claude-sonnet-4-6'
    ])
    expect(rows.every((r) => r.effort === null)).toBe(true)
  })

  it('keeps a stored line for a model the adapter no longer lists, at the end', () => {
    const rows = modelTableRows(worker({ modelRoutes: [row('claude-opus-4-8', 'high')] }), claude)
    expect(pairs(rows).at(-1)).toBe('claude-opus-4-8@high')
  })
})
