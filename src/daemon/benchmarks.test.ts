import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { benchmarkPrior, benchmarkTable, loadBenchmarks, resetBenchmarks } from './benchmarks.js'
import coding from '../../benchmarks/coding-agents.2026-09.json' with { type: 'json' }
import anthropicCosts from '../../costmodels/anthropic.subscription.2026-08.json' with { type: 'json' }
import googleCosts from '../../costmodels/google.antigravity.2026-08.json' with { type: 'json' }
import openaiCosts from '../../costmodels/openai.codex.2026-08.json' with { type: 'json' }
import localCosts from '../../costmodels/local.llm.2026-09.json' with { type: 'json' }

/**
 * The benchmark prior loader.
 *
 * ⛔ What this pins: exact-id lookups beat family prefixes, an id nothing names is `unknown` rather
 * than a guess, `null` is never coerced to 0, and every published `agentic` value is a real
 * probability-like fraction — the same "unknown is a verdict" rule the rest of this codebase holds
 * quota and pace readings to.
 */

afterEach(() => resetBenchmarks())

describe('benchmarkPrior', () => {
  it('hits an exact id from the built-in file', () => {
    const p = benchmarkPrior('claude-opus-5')
    expect(p.agentic).toBeCloseTo(0.846, 3)
    expect(p.basis).toContain('claude-opus-5')
    expect(p.source).toBeTruthy()
  })

  it('falls back to the longest matching family prefix when the exact id is absent', () => {
    const p = benchmarkPrior('claude-opus-9-preview')
    expect(p.agentic).toBeCloseTo(0.846, 3)
    expect(p.basis).toContain('family')
  })

  it('prefers the longest family match over a shorter one', () => {
    const p = benchmarkPrior('gemini-3.8-flash-xhigh')
    expect(p.agentic).toBeCloseTo(0.813, 3)
  })

  it('returns null and an explanatory basis for a model nobody has named', () => {
    const p = benchmarkPrior('some-model-nobody-has-heard-of')
    expect(p.agentic).toBeNull()
    expect(p.basis.toLowerCase()).toContain('unknown')
    expect(p.source).toBeNull()
  })

  it('returns null, never coerced to a number, for a null model id', () => {
    const p = benchmarkPrior(null)
    expect(p.agentic).toBeNull()
  })

  it('every model entry in the built-in file is null or within 0..1', () => {
    for (const m of coding.models) {
      if (m.agentic === null) continue
      expect(m.agentic).toBeGreaterThanOrEqual(0)
      expect(m.agentic).toBeLessThanOrEqual(1)
    }
  })

  it('every family entry in the built-in file is null or within 0..1', () => {
    for (const f of coding.families ?? []) {
      if (f.agentic === null) continue
      expect(f.agentic).toBeGreaterThanOrEqual(0)
      expect(f.agentic).toBeLessThanOrEqual(1)
    }
  })

  it('covers exactly the model ids declared across costmodels/*.json', () => {
    const costIds: string[] = []
    for (const data of [anthropicCosts, googleCosts, openaiCosts, localCosts] as Array<{
      models?: Array<{ id: string }>
    }>) {
      for (const m of data.models ?? []) costIds.push(m.id)
    }
    const benchmarkIds = new Set(coding.models.map((m) => m.id))
    for (const id of costIds) expect(benchmarkIds.has(id)).toBe(true)
  })
})

describe('loadBenchmarks', () => {
  let dir: string

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('a user file of the same id wins over the compiled-in one', () => {
    dir = mkdtempSync(join(tmpdir(), 'mac-benchmarks-'))
    writeFileSync(
      join(dir, 'override.json'),
      JSON.stringify({
        id: coding.id,
        schema_version: 1,
        effective_from: '2026-09-05',
        scale: '0..1, higher is better',
        sources: [],
        models: [{ id: 'claude-opus-5', agentic: 0.11, basis: 'published', source: null, note: 'test override' }]
      })
    )
    loadBenchmarks([dir])
    const p = benchmarkPrior('claude-opus-5')
    expect(p.agentic).toBeCloseTo(0.11, 3)
  })

  it('a broken file in the search path is skipped, not fatal', () => {
    dir = mkdtempSync(join(tmpdir(), 'mac-benchmarks-'))
    writeFileSync(join(dir, 'broken.json'), '{ not json')
    expect(() => loadBenchmarks([dir])).not.toThrow()
    // The built-in file still loaded, since the broken one has a different (missing) id.
    expect(benchmarkTable().length).toBeGreaterThan(0)
  })
})
