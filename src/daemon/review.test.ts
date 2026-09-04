import { describe, expect, it } from 'vitest'
import { composite, RUBRIC_DIMENSIONS, RUBRIC_WEIGHTS } from '@shared/review.js'
import { buildReviewPrompt, parseReviewReply, rubricText } from './review.js'

/**
 * What a 7 means.
 *
 * ⛔ **The worked example below is hand-written, not produced by a model**, and that is the point of
 * it: it fixes what the numbers mean *before* any agent is asked to produce one. It is the only
 * fixed point this rubric has — §12 of the plan is explicit that nothing yet calibrates the scale
 * across providers — so it belongs in a test, where a change to the weights that moves it has to be
 * deliberate.
 *
 * The change it grades is `d31b2e9` in this repository: the fleet's narrowing control was floating
 * below the whole fleet strip and was moved into a left rail beneath the *Fleet* label.
 * `FleetStrip.tsx` +34/−36, `app.css` +18/−1, `test/ui.test.mjs` +36/−0.
 */
const WORKED_EXAMPLE = {
  requirement_fidelity: 9,
  correctness: 8,
  tests: 9,
  codebase_fit: 9,
  scope_discipline: 8,
  maintainability: 8,
  self_sufficiency: 9
}

function scored(values: Partial<Record<string, number | null>>): Parameters<typeof composite>[0] {
  const out: Record<string, { score: number | null; rationale: string }> = {}
  for (const [key, score] of Object.entries(values)) {
    out[key] = { score: score ?? null, rationale: 'because' }
  }
  return out
}

describe('the composite', () => {
  it('scores the hand-calibrated worked example at 8.6', () => {
    // 9×.20 + 8×.20 + 9×.15 + 9×.15 + 8×.10 + 8×.10 + 9×.10
    expect(composite(scored(WORKED_EXAMPLE))).toBe(8.6)
  })

  it('renormalises over the dimensions actually scored, rather than dragging a null to zero', () => {
    // A pure-CSS change has no behaviour to assert, so `tests` is null and not 0.
    const all8 = composite(scored({ ...allAt(8) }))
    const withNull = composite(scored({ ...allAt(8), tests: null }))
    expect(all8).toBe(8)
    // ⛔ Still 8. Treating the null as a zero would give 6.8, which would mark every doc and CSS
    // change in the repository down for a dimension that does not apply to it.
    expect(withNull).toBe(8)
  })

  it('is null when nothing was scored, which is not the same as zero', () => {
    expect(composite(scored({ ...allAtNull() }))).toBeNull()
  })

  it('weighs correctness and fidelity at 40% between them, because a wrong patch is a failure', () => {
    expect(RUBRIC_WEIGHTS.requirement_fidelity + RUBRIC_WEIGHTS.correctness).toBeCloseTo(0.4, 10)
    const total = RUBRIC_DIMENSIONS.reduce((n, d) => n + RUBRIC_WEIGHTS[d], 0)
    expect(total).toBeCloseTo(1, 10)
  })

  it('moves when a dimension moves, so the number is recomputable from what is stored', () => {
    const perfect = composite(scored(allAt(10)))
    const broken = composite(scored({ ...allAt(10), correctness: 0 }))
    expect(perfect).toBe(10)
    // Correctness alone is a fifth of the number.
    expect(broken).toBe(8)
  })
})

function allAt(n: number): Record<string, number> {
  return Object.fromEntries(RUBRIC_DIMENSIONS.map((d) => [d, n]))
}
function allAtNull(): Record<string, null> {
  return Object.fromEntries(RUBRIC_DIMENSIONS.map((d) => [d, null]))
}

/**
 * ⛔ **No repair pass and no re-ask.** A malformed reply is a finding about that model worth
 * keeping, and a second turn to fix it doubles the cost of the cheapest thing in the system. Every
 * case here has to fail *without writing a score*, because a 0 is a real grade.
 */
describe('parsing a reviewer’s reply', () => {
  const good = {
    rubric_version: '1.0',
    scores: Object.fromEntries(
      RUBRIC_DIMENSIONS.map((d) => [d, { score: 8, rationale: `${d} looked fine — src/x.ts:10` }])
    ),
    summary: 'A tidy change.',
    notable: ['src/x.ts:10 reuses the existing helper', 'no new dependency']
  }

  it('accepts a well-formed verdict', () => {
    const parsed = parseReviewReply(good)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.summary).toBe('A tidy change.')
    expect(parsed.notable).toHaveLength(2)
    expect(composite(parsed.scores)).toBe(8)
  })

  it('rejects a verdict for a different rubric version', () => {
    const parsed = parseReviewReply({ ...good, rubric_version: '1.1' })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.reason).toContain('expected 1.0')
  })

  it('accepts a null score, which is how "this dimension does not apply" is said', () => {
    const parsed = parseReviewReply({
      ...good,
      scores: { ...good.scores, tests: { score: null, rationale: 'CSS only; no behaviour to assert.' } }
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.scores.tests.score).toBeNull()
  })

  it('rejects a missing dimension by name, rather than scoring six of seven', () => {
    const scores = { ...good.scores } as Record<string, unknown>
    delete scores.codebase_fit
    const parsed = parseReviewReply({ ...good, scores })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.reason).toContain('codebase_fit')
  })

  it('rejects a score outside 0-10, and one that is not an integer', () => {
    for (const score of [11, -1, 7.5, '8']) {
      const parsed = parseReviewReply({
        ...good,
        scores: { ...good.scores, correctness: { score, rationale: 'x' } }
      })
      expect(parsed.ok, `score ${JSON.stringify(score)} should be rejected`).toBe(false)
    }
  })

  it('rejects a score with no rationale, because an unexplained number is not evidence', () => {
    const parsed = parseReviewReply({
      ...good,
      scores: { ...good.scores, tests: { score: 4, rationale: '   ' } }
    })
    expect(parsed.ok).toBe(false)
  })

  it('rejects a reply with no scores object at all', () => {
    expect(parseReviewReply({ summary: 'looks good to me' }).ok).toBe(false)
  })

  it('rejects a reply with no summary', () => {
    expect(parseReviewReply({ ...good, summary: '' }).ok).toBe(false)
  })

  it('keeps at most three notable observations, and survives having none', () => {
    const many = parseReviewReply({ ...good, notable: ['a', 'b', 'c', 'd', 'e'] })
    expect(many.ok && many.notable).toHaveLength(3)
    const none = parseReviewReply({ ...good, notable: 'not a list' })
    expect(none.ok && none.notable).toEqual([])
  })
})

describe('the prompt', () => {
  const diff = {
    base: 'a'.repeat(40),
    head: 'b'.repeat(40),
    files: 3,
    insertions: 89,
    deletions: 36,
    truncated: false,
    text: 'diff --git a/x b/x'
  }

  const build = (over: Partial<Parameters<typeof buildReviewPrompt>[0]> = {}): string =>
    buildReviewPrompt({
      task: { title: 'Move the narrowing control into a left rail' },
      followUps: [],
      history: '1 run(s).\nRun 1: completed.',
      diff,
      trunkSha: null,
      ...over
    })

  it('carries every dimension with its key and its weight, so the judge scores what is stored', () => {
    const rubric = rubricText()
    for (const dimension of RUBRIC_DIMENSIONS) {
      expect(rubric).toContain(`"${dimension}"`)
      expect(rubric).toContain(RUBRIC_WEIGHTS[dimension].toFixed(2))
    }
  })

  it('states the effort instruction before the rubric, which is the whole economics of this', () => {
    const prompt = build()
    expect(prompt.indexOf('KEEP THIS TO A SINGLE PASS')).toBeGreaterThan(-1)
    expect(prompt.indexOf('KEEP THIS TO A SINGLE PASS')).toBeLessThan(prompt.indexOf('=== RUBRIC ==='))
  })

  it('never asks for a holistic score — the composite is the daemon’s, not the judge’s', () => {
    expect(build()).toContain('Do not include an overall score')
  })

  it('says the diff was truncated, because a judge that does not know scores the part as the whole', () => {
    expect(build()).not.toContain('shown in full and the rest are listed')
    expect(build({ diff: { ...diff, truncated: true } })).toContain(
      'shown in full and the rest are listed'
    )
  })

  it('points at AGENTS.md rather than restating it, which is what makes fit repository-relative', () => {
    expect(build()).toContain('AGENTS.md')
  })

  it('tells the reviewer to trust the diff over a working tree that has moved on', () => {
    expect(build({ trunkSha: 'c'.repeat(40) })).toContain('Trust the diff below over the files on disk')
  })
})
