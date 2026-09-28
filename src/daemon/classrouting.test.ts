import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Worker } from '@shared/protocol.js'
import type { TaskConstraints } from '@shared/tasks.js'
import { routeClass, samePair, type ModelRoute } from '@shared/modelroutes.js'
import { MODEL_CLASSES, type ModelClass } from '@shared/modelclass.js'

/**
 * `Auto Model (<class>)` runs one of that class's rows — model *and* effort — end to end (t811).
 *
 * ⛔ **The incident.** t809 and t810 (2026-09-28) were filed `Auto Model (med)` on ClaudeFirst, whose
 * table reads `opus-5-5 · high` (built-in class: high), `opus-5-5 · medium` (med), `sonnet-5 ·
 * medium` (low). The composer had hidden its Effort pill for Auto but still filed the account's
 * remembered `effort: high`. Scoring picked the `med` row, `opus-5-5 · medium`; the dispatch then ran
 * the task's own effort over it, and both tasks ran Opus 5.5 at `high` — the `high` class.
 *
 * ⚠️ These drive `chooseTarget` and then `dispatchModelChoice`, the function `dispatch` itself calls
 * to decide what to spawn, because the scoring half was right all along: a test that stops at
 * `chooseTarget` passed throughout the incident.
 */

let dir: string
let db: typeof import('./db.js')
let workers: typeof import('./workers.js')
let tasks: typeof import('./tasks.js')
let scoring: typeof import('./scoring.js')
let scheduler: typeof import('./scheduler.js')
let origClaudeInstalled: () => boolean

beforeAll(async () => {
  // ⛔ A temp data directory, never the real one. This opens a database and writes to it.
  dir = mkdtempSync(join(tmpdir(), 'agentyard-classrouting-'))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  workers = await import('./workers.js')
  tasks = await import('./tasks.js')
  scoring = await import('./scoring.js')
  scheduler = await import('./scheduler.js')
  const { claudeCode } = await import('./adapters/claude-code.js')
  origClaudeInstalled = claudeCode.isInstalled
  claudeCode.isInstalled = () => true
  db.openDb(join(dir, 'classrouting.db'))
})

afterAll(async () => {
  const { claudeCode } = await import('./adapters/claude-code.js')
  claudeCode.isInstalled = origClaudeInstalled
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

beforeEach(() => {
  // One account per test: nothing here is about choosing between accounts.
  db.db().prepare('update workers set enabled = 0').run()
})

/** ClaudeFirst's table as the store held it when t809 ran, read from `workers.model_routes_json`. */
const CLAUDE_FIRST: ModelRoute[] = [
  { model: 'claude-opus-5-5', effort: 'high', modelClass: null, auto: true },
  { model: 'claude-opus-5-5', effort: 'medium', modelClass: 'med', auto: true },
  { model: 'claude-sonnet-5', effort: 'medium', modelClass: 'low', auto: true }
]

let seq = 0
function account(routes: ModelRoute[], defaults: { model?: string; effort?: string } = {}): Worker {
  seq += 1
  const w = workers.createWorker({ adapterId: 'claude-code', label: `ClassWorker-${seq}`, enabled: true })
  return workers.updateWorker(w.id, {
    defaultModel: defaults.model ?? 'claude-opus-5-5',
    defaultEffort: defaults.effort ?? 'medium',
    modelRoutes: routes
  })
}

/** What a task filed with these constraints would be spawned as: the scoring pick, then the dispatch. */
function dispatched(worker: Worker, constraints: Partial<TaskConstraints>): { model: string | null; effort: string | null } {
  const task = tasks.createTask({
    title: `class routing ${seq}`,
    constraints: { workerId: worker.id, adapterId: 'claude-code', ...constraints }
  })
  const choice = scoring.chooseTarget(task)
  expect(choice.worker?.id, choice.reason).toBe(worker.id)
  const picked = scheduler.dispatchModelChoice(task, workers.requireWorker(worker.id), choice)
  return { model: picked.model, effort: picked.effort }
}

/** The class the worker's own table files this exact pair under, or null if it is not a row at all. */
function classOfRow(worker: Worker, pair: { model: string | null; effort: string | null }): ModelClass | null {
  const row = (workers.requireWorker(worker.id).modelRoutes ?? []).find((r) => samePair(r, pair))
  return row ? routeClass(row) : null
}

describe('⛔ t809/t810: Auto Model (med) with an effort the composer was not showing', () => {
  it('runs the med row, Opus 5.5 at medium, not Opus 5.5 at high', () => {
    const w = account(CLAUDE_FIRST)
    // The constraints exactly as `tasks.constraints_json` recorded them for t809 and t810.
    const got = dispatched(w, { modelClass: 'med', effort: 'high' })
    expect(got).toEqual({ model: 'claude-opus-5-5', effort: 'medium' })
    expect(classOfRow(w, got)).toBe('med')
  })

  it('still runs the med row when the task names no effort at all', () => {
    const w = account(CLAUDE_FIRST)
    expect(dispatched(w, { modelClass: 'med' })).toEqual({ model: 'claude-opus-5-5', effort: 'medium' })
  })
})

describe('every class, against every effort a task could carry', () => {
  // ⛔ `undefined` is the composer's honest answer; every other level is one a stale pill, a
  // reassignment or an MCP caller could put beside a class.
  const EFFORTS = [undefined, 'low', 'medium', 'high', 'xhigh', 'max'] as const
  const EXPECTED: Record<ModelClass, { model: string; effort: string }> = {
    high: { model: 'claude-opus-5-5', effort: 'high' },
    med: { model: 'claude-opus-5-5', effort: 'medium' },
    low: { model: 'claude-sonnet-5', effort: 'medium' }
  }

  for (const modelClass of MODEL_CLASSES) {
    for (const effort of EFFORTS) {
      it(`Auto Model (${modelClass}) with effort ${effort ?? '(none)'} dispatches a ${modelClass} row`, () => {
        const w = account(CLAUDE_FIRST)
        const got = dispatched(w, { modelClass, ...(effort ? { effort } : {}) })
        expect(classOfRow(w, got)).toBe(modelClass)
        expect(got).toEqual(EXPECTED[modelClass])
      })
    }
  }
})

describe('a class routed to a model other than the account default', () => {
  it('bounds the effort against the model that runs, not the one the resolver guessed', () => {
    // ⚠️ The resolver sees the account's default (Opus), where `low` has no row, so only the dispatch
    // — which knows the router picked Sonnet — can see that `sonnet-5 · high` is not the `low` row.
    const w = account(CLAUDE_FIRST)
    const got = dispatched(w, { modelClass: 'low', effort: 'high' })
    expect(got).toEqual({ model: 'claude-sonnet-5', effort: 'medium' })
  })
})

describe('a task effort that is itself one of the class rows', () => {
  it('is honoured, because it names a pair the class already contains', () => {
    const w = account([
      { model: 'claude-opus-5-5', effort: 'high', modelClass: 'high', auto: true },
      { model: 'claude-opus-5-5', effort: 'xhigh', modelClass: 'high', auto: false },
      { model: 'claude-sonnet-5', effort: 'medium', modelClass: 'med', auto: true }
    ])
    expect(dispatched(w, { modelClass: 'high', effort: 'xhigh' })).toEqual({ model: 'claude-opus-5-5', effort: 'xhigh' })
    // …and the class's own auto row when the task says nothing.
    expect(dispatched(w, { modelClass: 'high' })).toEqual({ model: 'claude-opus-5-5', effort: 'high' })
  })

  it('follows an operator class override, not the built-in keyword heuristic', () => {
    // Sonnet overridden into `high`: `sonnet-5 · max` is a high row here, so Auto (high) may run it.
    const w = account([
      { model: 'claude-sonnet-5', effort: 'max', modelClass: 'high', auto: true },
      { model: 'claude-opus-5-5', effort: 'medium', modelClass: 'med', auto: true }
    ])
    const high = dispatched(w, { modelClass: 'high', effort: 'medium' })
    expect(high).toEqual({ model: 'claude-sonnet-5', effort: 'max' })
    expect(dispatched(w, { modelClass: 'med', effort: 'max' })).toEqual({ model: 'claude-opus-5-5', effort: 'medium' })
  })
})

describe('choices the class guard must leave alone', () => {
  it('a pinned model runs at the effort the task pinned beside it', () => {
    const w = account(CLAUDE_FIRST)
    expect(dispatched(w, { model: 'claude-sonnet-5', effort: 'max' })).toEqual({ model: 'claude-sonnet-5', effort: 'max' })
  })

  it("the account's default model runs at the effort the task pinned beside it", () => {
    const w = account(CLAUDE_FIRST)
    expect(dispatched(w, { modelPolicy: 'inherit', effort: 'xhigh' })).toEqual({ model: 'claude-opus-5-5', effort: 'xhigh' })
  })

  it('plain Auto, which names no class, keeps an effort somebody chose', () => {
    const w = account(CLAUDE_FIRST)
    expect(dispatched(w, { effort: 'low' })).toEqual({ model: 'claude-opus-5-5', effort: 'low' })
  })

  it('plain Auto with no effort runs the first auto row as listed', () => {
    const w = account(CLAUDE_FIRST)
    expect(dispatched(w, {})).toEqual({ model: 'claude-opus-5-5', effort: 'high' })
  })
})
