import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Task } from '@shared/tasks.js'
import type { Session, Worker } from '@shared/protocol.js'
import type { Complexity } from './complexity.js'
import type { WorkerChoice } from './scheduler.js'
import { exploreRoute } from './exploration.js'

let dir: string
let db: typeof import('./db.js')

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mac-exploration-'))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  db.openDb(join(dir, 'exploration.db'))
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // Windows file handle
  }
})

function makeWorker(id = 'worker-1', label = 'Worker 1', adapterId = 'claude-code'): Worker {
  return {
    id,
    label,
    adapterId,
    enabled: true,
    humanOccupied: false,
    installed: true,
    identity: { loggedIn: true },
    maxConcurrent: 1,
    role: 'worker',
    isolationRoot: '/tmp/w1',
    createdAt: Date.now()
  } as unknown as Worker
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    seq: 1,
    title: 'Test task',
    kind: 'work',
    status: 'ready',
    constraints: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides
  } as Task
}

function makeComplexity(band: 'low' | 'medium' | 'high' = 'low'): Complexity {
  return {
    band,
    score: band === 'low' ? 0.2 : band === 'medium' ? 0.5 : 0.8,
    signals: [],
    basis: `test complexity ${band}`
  }
}

function makeChoice(worker: Worker, model: string, overrides: Partial<WorkerChoice> = {}): WorkerChoice {
  return {
    worker,
    session: null,
    reason: '',
    quotaUnverified: false,
    score: 1.0,
    model,
    routedBy: 'score',
    scored: [
      {
        workerId: worker.id,
        label: worker.label,
        adapterId: worker.adapterId,
        model,
        warm: false,
        quotaUnverified: false,
        score: 1.0,
        chosen: true,
        terms: []
      }
    ],
    ...overrides
  }
}

describe('model exploration', () => {
  const worker = makeWorker()
  const winner = makeChoice(worker, 'claude-sonnet-5')
  const alt1 = makeChoice(worker, 'claude-haiku-4', { score: 0.8 })
  const alt2 = makeChoice(worker, 'claude-opus-4', { score: 0.6 })
  const candidates = [winner, alt1, alt2]
  const complexity = makeComplexity('low')

  it('flag off: a thousand decisions explore zero times', () => {
    const task = makeTask()
    const settings = { modelExploration: false, modelExplorationRate: 0.1 }

    for (let i = 0; i < 1000; i++) {
      const res = exploreRoute({
        task,
        winner,
        candidates,
        complexity,
        settings,
        random: () => 0
      })
      expect(res.explored).toBe(false)
      expect(res.choice).toBe(winner)
    }
  })

  it('on: rate holds within tolerance over 10,000 runs', () => {
    const task = makeTask()
    const settings = { modelExploration: true, modelExplorationRate: 0.1 }

    let exploredCount = 0
    const runs = 10_000
    for (let i = 0; i < runs; i++) {
      const res = exploreRoute({
        task,
        winner,
        candidates,
        complexity,
        settings,
        random: Math.random
      })
      if (res.explored) exploredCount++
    }

    const rate = exploredCount / runs
    // 0.10 ± 0.02
    expect(rate).toBeGreaterThan(0.08)
    expect(rate).toBeLessThan(0.12)
  })

  describe('every exclusion asserted individually', () => {
    const alwaysExploreRandom = () => 0 // Always < 0.10
    const settings = { modelExploration: true, modelExplorationRate: 0.1 }

    it('excludes when flag is off', () => {
      const res = exploreRoute({
        task: makeTask(),
        winner,
        candidates,
        complexity,
        settings: { modelExploration: false, modelExplorationRate: 0.1 },
        random: alwaysExploreRandom
      })
      expect(res.explored).toBe(false)
    })

    it('excludes when task pinned model via task.constraints.model', () => {
      const task = makeTask({ constraints: { model: 'claude-sonnet-5' } })
      const res = exploreRoute({
        task,
        winner,
        candidates,
        complexity,
        settings,
        random: alwaysExploreRandom
      })
      expect(res.explored).toBe(false)
    })

    it('excludes when task pinned model via task.constraints.modelsByWorker', () => {
      const task = makeTask({
        constraints: { modelsByWorker: { [worker.id]: 'claude-sonnet-5' } }
      })
      const res = exploreRoute({
        task,
        winner,
        candidates,
        complexity,
        settings,
        random: alwaysExploreRandom
      })
      expect(res.explored).toBe(false)
    })

    it('excludes when winner is warm (session is live)', () => {
      const warmWinner = makeChoice(worker, 'claude-sonnet-5', {
        session: { id: 's1', workerId: worker.id } as unknown as Session
      })
      const res = exploreRoute({
        task: makeTask(),
        winner: warmWinner,
        candidates,
        complexity,
        settings,
        random: alwaysExploreRandom
      })
      expect(res.explored).toBe(false)
    })

    it('excludes when winner is reopenable (resumable session)', () => {
      const reopenableWinner = makeChoice(worker, 'claude-sonnet-5', {
        resumable: { id: 's1', workerId: worker.id } as unknown as Session
      })
      const res = exploreRoute({
        task: makeTask(),
        winner: reopenableWinner,
        candidates,
        complexity,
        settings,
        random: alwaysExploreRandom
      })
      expect(res.explored).toBe(false)
    })

    it('excludes when winner was chosen by sticky routing', () => {
      const stickyWinner = makeChoice(worker, 'claude-sonnet-5', {
        routedBy: 'sticky'
      })
      const res = exploreRoute({
        task: makeTask(),
        winner: stickyWinner,
        candidates,
        complexity,
        settings,
        random: alwaysExploreRandom
      })
      expect(res.explored).toBe(false)
    })

    it('excludes when task.kind === plan', () => {
      const planTask = makeTask({ kind: 'plan' })
      const res = exploreRoute({
        task: planTask,
        winner,
        candidates,
        complexity,
        settings,
        random: alwaysExploreRandom
      })
      expect(res.explored).toBe(false)
    })

    it('excludes when task complexity band is high', () => {
      const highComplexity = makeComplexity('high')
      const res = exploreRoute({
        task: makeTask(),
        winner,
        candidates,
        complexity: highComplexity,
        settings,
        random: alwaysExploreRandom
      })
      expect(res.explored).toBe(false)
    })

    it('excludes when worker offers only 1 routable model', () => {
      const singleCandidateField = [winner]
      const res = exploreRoute({
        task: makeTask(),
        winner,
        candidates: singleCandidateField,
        complexity,
        settings,
        random: alwaysExploreRandom
      })
      expect(res.explored).toBe(false)
    })
  })

  it('prefers an alternative whose fitness is unmeasured', () => {
    const task = makeTask()
    const settings = { modelExploration: true, modelExplorationRate: 0.1 }

    // claude-sonnet-5 is benchmarked in coding-agents.2026-09.json
    // unknown-model-xyz has neither benchmark prior nor quality reviews -> fitness is unmeasured (null)
    // claude-opus-4 is benchmarked
    const unmeasuredAlt = makeChoice(worker, 'unknown-model-xyz', { score: 0.5 })
    const measuredAlt = makeChoice(worker, 'claude-opus-4', { score: 0.7 })

    const res = exploreRoute({
      task,
      winner,
      candidates: [winner, measuredAlt, unmeasuredAlt],
      complexity,
      settings,
      random: () => 0.05
    })

    expect(res.explored).toBe(true)
    expect(res.choice.model).toBe('unknown-model-xyz')
    expect(res.choice.routedBy).toBe('explore')
  })

  it('the RNG is injected and controls whether exploration triggers', () => {
    const task = makeTask()
    const settings = { modelExploration: true, modelExplorationRate: 0.1 }

    let calls = 0
    const deterministicRandom = () => {
      calls++
      return 0.2 // >= 0.10, so roll does not trigger
    }

    const res1 = exploreRoute({
      task,
      winner,
      candidates,
      complexity,
      settings,
      random: deterministicRandom
    })
    expect(calls).toBe(1)
    expect(res1.explored).toBe(false)

    // Roll 0.01 (< 0.10), so roll triggers
    const res2 = exploreRoute({
      task,
      winner,
      candidates,
      complexity,
      settings,
      random: () => 0.01
    })
    expect(res2.explored).toBe(true)
    expect(res2.choice.routedBy).toBe('explore')
  })
})
