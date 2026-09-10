import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { RoutingCandidate } from '@shared/routing.js'

/**
 * The routing ledger.
 *
 * ⛔ What these pin is that a decision is kept **whole**: the weights that were in force, every
 * candidate's term-by-term derivation, and the basis it was decided on. A table that stored only the
 * winner and its total would answer "which account got it" and could never answer "why", which is
 * the only question anybody asks of a routing decision afterwards.
 */

let dir: string
let db: typeof import('./db.js')
let ledger: typeof import('./routingdecisions.js')

function candidate(patch: Partial<RoutingCandidate> = {}): RoutingCandidate {
  return {
    workerId: 'w1',
    label: 'ClaudeFirst',
    adapterId: 'claude-code',
    model: 'claude-sonnet-5',
    warm: false,
    quotaUnverified: false,
    score: 0,
    chosen: false,
    terms: [
      {
        name: 'cold',
        weight: 1.19,
        weightFormula: '0.8 + 2.0×cost − 0.7×velocity',
        value: 1,
        basis: 'no session to reuse, so a start pays a full cache write',
        sign: -1,
        contribution: -1.19
      }
    ],
    ...patch
  }
}

function record(patch: Partial<Parameters<typeof ledger.recordRoutingDecision>[0]> = {}): void {
  ledger.recordRoutingDecision({
    taskId: 'task-1',
    taskSeq: 7,
    taskTitle: 'do the thing',
    projectId: 'p1',
    chosenWorkerId: 'w1',
    chosenLabel: 'ClaudeFirst',
    objective: { cost: 0.3, velocity: 0.3, quality: 0.4 },
    weights: { cold: 1.19, cacheWarmth: 1.48 },
    weightFormulas: { cold: '0.8 + 2.0×cost − 0.7×velocity', cacheWarmth: '1.0 + 2.2×cost − 0.6×velocity' },
    epsilon: 0.05,
    basis: 'score',
    warm: false,
    candidates: [candidate({ chosen: true, score: 1.2 }), candidate({ workerId: 'w2', label: 'Antigravity', score: 0.4 })],
    ...patch
  })
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-routingledger-'))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  ledger = await import('./routingdecisions.js')
  db.openDb(join(dir, 'ledger.db'))
})

beforeEach(() => {
  db.db().exec('delete from routing_decisions')
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* Windows holds the file briefly; the temp directory is disposable either way. */
  }
})

describe('recording a decision', () => {
  it('keeps every candidate’s derivation, not just the winner’s total', () => {
    record()
    const [decision] = ledger.routingDecisions().decisions
    expect(decision).toBeDefined()
    expect(decision?.candidates).toHaveLength(2)
    // ⛔ The basis, in words, is the part that makes the number checkable rather than believable.
    expect(decision?.candidates[0]?.terms[0]?.basis).toMatch(/full cache write/)
    expect(decision?.candidates[0]?.terms[0]?.weightFormula).toMatch(/2.0×cost/)
  })

  it('keeps the weights that were in force, so a later settings change cannot rewrite history', () => {
    record()
    const [decision] = ledger.routingDecisions().decisions
    expect(decision?.objective).toEqual({ cost: 0.3, velocity: 0.3, quality: 0.4 })
    expect(decision?.weights.cacheWarmth).toBeCloseTo(1.48, 10)
  })

  it('marks exactly one candidate as chosen', () => {
    record()
    const [decision] = ledger.routingDecisions().decisions
    expect(decision?.candidates.filter((c) => c.chosen)).toHaveLength(1)
  })

  it('records how the winner was picked, so a consulted decision is distinguishable', () => {
    record({ basis: 'controller' })
    record({ basis: 'pinned' })
    const bases = ledger.routingDecisions().decisions.map((d) => d.basis)
    expect(bases).toContain('controller')
    expect(bases).toContain('pinned')
  })

  it('stores the title rather than joining it, so a deleted task still shows where its work went', () => {
    record({ taskTitle: 'x'.repeat(900) })
    const [decision] = ledger.routingDecisions().decisions
    // ⚠️ A task's title *is* its prompt on this fleet, so it is trimmed at write time.
    expect(decision?.taskTitle.length).toBe(400)
  })
})

describe('paging', () => {
  it('reports a total that is not the page length, so a pager knows where it ends', () => {
    for (let i = 0; i < 12; i += 1) record({ taskSeq: i })
    const page = ledger.routingDecisions(5, 0)
    expect(page.decisions).toHaveLength(5)
    expect(page.total).toBe(12)
  })

  it('walks backwards through the history without repeating a row', () => {
    for (let i = 0; i < 12; i += 1) record({ taskSeq: i })
    const first = ledger.routingDecisions(5, 0).decisions.map((d) => d.id)
    const second = ledger.routingDecisions(5, 5).decisions.map((d) => d.id)
    expect(new Set([...first, ...second]).size).toBe(10)
  })

  it('bounds a limit nobody should be able to ask for', () => {
    for (let i = 0; i < 3; i += 1) record()
    expect(ledger.routingDecisions(10_000, 0).limit).toBe(50)
    expect(ledger.routingDecisions(0, -4).offset).toBe(0)
  })

  it('answers an empty ledger with an empty page rather than throwing', () => {
    const page = ledger.routingDecisions()
    expect(page.decisions).toEqual([])
    expect(page.total).toBe(0)
  })
})
