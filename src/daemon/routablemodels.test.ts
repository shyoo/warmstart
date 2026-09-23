import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ModelRoute } from '@shared/modelroutes.js'

/**
 * A worker's model table: (model, effort) rows with a class and an auto-route flag (t638).
 *
 * ⛔ What this pins: the column round-trips through `worker.update`/`getWorker`; a table with no
 * auto row resolves to exactly the one model this worker uses today (never "every model the adapter
 * can price"); Auto Model gets one pair per model, narrowed to a class *before* that reduction; a
 * row the cost model cannot price, an effort the model does not declare and a repeated pair are
 * refused before anything is stored; and migration 81 folds the three maps it replaced into rows
 * and survives being replayed.
 */

let dir: string
let dbPath: string
let db: typeof import('./db.js')
let workers: typeof import('./workers.js')
let api: typeof import('./api.js')

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mac-routablemodels-'))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  workers = await import('./workers.js')
  api = await import('./api.js')
  dbPath = join(dir, 'routablemodels.db')
  db.openDb(dbPath)
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    // A held handle on Windows is not a test failure.
  }
})

let seq = 0
function claudeWorker(): ReturnType<typeof workers.createWorker> {
  seq += 1
  return workers.createWorker({ adapterId: 'claude-code', label: `worker-${seq}` })
}

const row = (
  model: string,
  effort: string | null,
  auto = true,
  modelClass: ModelRoute['modelClass'] = null
): ModelRoute => ({ model, effort, modelClass, auto })

describe('the model table column', () => {
  it('round-trips through worker.update and getWorker', () => {
    const w = claudeWorker()
    const routes = [row('claude-sonnet-5', 'high'), row('claude-haiku-4-5', null, false, 'low')]
    workers.updateWorker(w.id, { modelRoutes: routes })
    expect(workers.requireWorker(w.id).modelRoutes).toEqual(routes)
  })

  it('clears back to null, not an empty-array sentinel, when unset or emptied', () => {
    const w = claudeWorker()
    workers.updateWorker(w.id, { modelRoutes: [row('claude-opus-5', 'high')] })
    workers.updateWorker(w.id, { modelRoutes: null })
    expect(workers.requireWorker(w.id).modelRoutes).toBeNull()
    workers.updateWorker(w.id, { modelRoutes: [row('claude-opus-5', 'high')] })
    workers.updateWorker(w.id, { modelRoutes: [] })
    expect(workers.requireWorker(w.id).modelRoutes).toBeNull()
  })

  it("an empty table resolves to exactly this worker's current default model", () => {
    const w = claudeWorker()
    workers.updateWorker(w.id, { defaultModel: 'claude-sonnet-5' })
    expect(workers.routableModelsFor(workers.requireWorker(w.id))).toEqual(['claude-sonnet-5'])
  })

  it('⛔ a table with rows but no auto-route tick resolves the same way an empty one does', () => {
    const w = claudeWorker()
    workers.updateWorker(w.id, {
      defaultModel: 'claude-opus-5',
      modelRoutes: [row('claude-sonnet-5', 'high', false), row('claude-haiku-4-5', null, false)]
    })
    expect(workers.routableModelsFor(workers.requireWorker(w.id))).toEqual(['claude-opus-5'])
  })

  it("resolves to [null] — the CLI's own choice — when the worker has no default at all", () => {
    const w = claudeWorker()
    const reread = workers.requireWorker(w.id)
    expect(reread.defaultModel).toBeNull()
    expect(workers.routableModelsFor(reread)).toEqual([null])
  })

  it("auto rows are returned in the operator's order, ignoring the default model", () => {
    const w = claudeWorker()
    workers.updateWorker(w.id, {
      defaultModel: 'claude-opus-5',
      modelRoutes: [row('claude-sonnet-5', 'high'), row('claude-opus-5', 'max', false), row('claude-haiku-4-5', null)]
    })
    expect(workers.routableCandidatesFor(workers.requireWorker(w.id))).toEqual([
      { model: 'claude-sonnet-5', effort: 'high' },
      { model: 'claude-haiku-4-5', effort: null }
    ])
  })

  it('⭐ one pair per model, and the class filter runs before that reduction', () => {
    const w = claudeWorker()
    workers.updateWorker(w.id, {
      modelRoutes: [
        row('claude-opus-5-5', 'medium', true, 'med'),
        row('claude-opus-5-5', 'high', true, 'high'),
        row('claude-sonnet-5', 'high', true)
      ]
    })
    const reread = workers.requireWorker(w.id)
    // Plain Auto: the first opus row the operator listed, never both.
    expect(workers.routableCandidatesFor(reread)).toEqual([
      { model: 'claude-opus-5-5', effort: 'medium' },
      { model: 'claude-sonnet-5', effort: 'high' }
    ])
    // Auto (high): the medium row is `med`, so the high row is the one that counts.
    expect(workers.routableCandidatesFor(reread, 'high')).toEqual([{ model: 'claude-opus-5-5', effort: 'high' }])
    expect(workers.routableCandidatesFor(reread, 'med')).toEqual([
      { model: 'claude-opus-5-5', effort: 'medium' },
      { model: 'claude-sonnet-5', effort: 'high' }
    ])
    expect(workers.routableCandidatesFor(reread, 'low')).toEqual([])
  })

  it("the class filter on an inherited default reads the default row's class", () => {
    const w = claudeWorker()
    workers.updateWorker(w.id, {
      defaultModel: 'claude-opus-5',
      defaultEffort: 'low',
      modelRoutes: [row('claude-opus-5', 'low', false, 'low')]
    })
    const reread = workers.requireWorker(w.id)
    expect(workers.routableCandidatesFor(reread, 'low')).toEqual([{ model: 'claude-opus-5', effort: null }])
    expect(workers.routableCandidatesFor(reread, 'high')).toEqual([])
  })

  it('refuses a model the cost model does not declare, before anything is stored', () => {
    const w = claudeWorker()
    expect(() => api.checkWorkerDefaults('claude-code', { modelRoutes: [row('not-a-real-model', null)] })).toThrow(
      /not a model/
    )
    expect(workers.requireWorker(w.id).modelRoutes).toBeNull()
  })

  it('refuses an effort the model does not declare, and any effort on an adapter with no flag', () => {
    expect(() => api.checkWorkerDefaults('claude-code', { modelRoutes: [row('claude-haiku-4-5', 'high')] })).toThrow(
      /has no effort level/
    )
    expect(() => api.checkWorkerDefaults('claude-code', { modelRoutes: [row('claude-opus-5', 'nope')] })).toThrow(
      /has no effort level/
    )
    expect(() =>
      api.checkWorkerDefaults('antigravity-cli', { modelRoutes: [row('gemini-3.7-flash-high', 'high')] })
    ).toThrow(/takes no effort flag/)
  })

  it('refuses an invalid class and a repeated (model, effort) pair', () => {
    expect(() =>
      api.checkWorkerDefaults('claude-code', {
        modelRoutes: [row('claude-opus-5', 'high', true, 'xhigh' as unknown as ModelRoute['modelClass'])]
      })
    ).toThrow(/invalid model class/)
    expect(() =>
      api.checkWorkerDefaults('claude-code', {
        modelRoutes: [row('claude-opus-5', 'high'), row('claude-opus-5', 'high', false)]
      })
    ).toThrow(/listed twice/)
  })

  it('⭐ accepts the same model at two efforts — the thing the three maps could not say', () => {
    expect(() =>
      api.checkWorkerDefaults('claude-code', {
        modelRoutes: [row('claude-opus-5', 'high'), row('claude-opus-5', 'medium'), row('claude-haiku-4-5', null, false)]
      })
    ).not.toThrow()
  })

  it('a judgment model and effort round-trip, and are validated like the grading pair', () => {
    const w = claudeWorker()
    workers.updateWorker(w.id, { judgmentModel: 'claude-sonnet-5', judgmentEffort: 'low' })
    expect(workers.requireWorker(w.id)).toMatchObject({ judgmentModel: 'claude-sonnet-5', judgmentEffort: 'low' })
    expect(() => api.checkWorkerDefaults('claude-code', { judgmentModel: 'nope' })).toThrow(/not a model/)
    expect(() =>
      api.checkWorkerDefaults('claude-code', { judgmentModel: 'claude-haiku-4-5', judgmentEffort: 'high' })
    ).toThrow(/has no effort level/)
    expect(() => api.checkWorkerDefaults('claude-code', { judgmentEffort: 'high' })).toThrow(/set a judgment model/)
  })

  it('⛔ migration 81 folds the three legacy maps into rows, then clears them', () => {
    const w = claudeWorker()
    db.db().exec(`pragma user_version = ${db.versionBefore('model_routes_json')}`)
    db.db()
      .prepare(
        `update workers set model_routes_json = null, routable_models_json = ?, model_efforts_json = ?,
                            model_classes_json = ? where id = ?`
      )
      .run(
        JSON.stringify(['claude-sonnet-5', 'claude-opus-5']),
        JSON.stringify({ 'claude-opus-5': 'high', 'claude-opus-5-5': 'max' }),
        JSON.stringify({ 'claude-sonnet-5': 'high', 'claude-haiku-4-5': 'low' }),
        w.id
      )
    db.closeDb()
    db.openDb(dbPath)

    expect(workers.requireWorker(w.id).modelRoutes).toEqual([
      row('claude-sonnet-5', null, true, 'high'),
      row('claude-opus-5', 'high', true),
      // Never routable, but an operator set an effort or a class on them — kept as manual rows.
      row('claude-opus-5-5', 'max', false),
      row('claude-haiku-4-5', null, false, 'low')
    ])
    const legacy = db
      .db()
      .prepare('select routable_models_json, model_efforts_json, model_classes_json from workers where id = ?')
      .get(w.id)
    expect({ ...legacy }).toEqual({ routable_models_json: null, model_efforts_json: null, model_classes_json: null })
  })

  it('migration 81 replays cleanly and does not undo an edit made after it', () => {
    const w = claudeWorker()
    workers.updateWorker(w.id, { modelRoutes: [row('claude-sonnet-5', 'high')] })

    db.db().exec(`pragma user_version = ${db.versionBefore('model_routes_json')}`)
    db.closeDb()
    expect(() => db.openDb(dbPath)).not.toThrow()
    expect(workers.requireWorker(w.id).modelRoutes).toEqual([row('claude-sonnet-5', 'high')])
  })
})
