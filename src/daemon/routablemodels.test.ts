import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The routable-models allowlist: an opt-in list of models a worker may be dispatched on.
 *
 * ⛔ What this pins: the column round-trips through `worker.update`/`getWorker`, `null` and `[]`
 * both resolve to exactly the one model this worker uses today (never "every model the adapter can
 * price"), an id the cost model does not declare is refused before it is stored, and the migration
 * that adds the column survives being replayed.
 */

let dir: string
let dbPath: string
let db: typeof import('./db.js')
let workers: typeof import('./workers.js')
let api: typeof import('./api.js')

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mac-routablemodels-'))
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
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

describe('the routable-models column', () => {
  it('round-trips through worker.update and getWorker', () => {
    const w = claudeWorker()
    workers.updateWorker(w.id, { routableModels: ['claude-sonnet-5', 'claude-haiku-4-5'] })
    const reread = workers.requireWorker(w.id)
    expect(reread.routableModels).toEqual(['claude-sonnet-5', 'claude-haiku-4-5'])
  })

  it('clears back to null, not an empty-string sentinel, when unset', () => {
    const w = claudeWorker()
    workers.updateWorker(w.id, { routableModels: ['claude-opus-5'] })
    workers.updateWorker(w.id, { routableModels: null })
    expect(workers.requireWorker(w.id).routableModels).toBeNull()
  })

  it('a null allowlist resolves to exactly this worker\'s current default model', () => {
    const w = claudeWorker()
    workers.updateWorker(w.id, { defaultModel: 'claude-sonnet-5' })
    const reread = workers.requireWorker(w.id)
    expect(reread.routableModels).toBeNull()
    expect(workers.routableModelsFor(reread)).toEqual(['claude-sonnet-5'])
  })

  it('an empty allowlist resolves the same way a null one does', () => {
    const w = claudeWorker()
    workers.updateWorker(w.id, { defaultModel: 'claude-opus-5', routableModels: [] })
    const reread = workers.requireWorker(w.id)
    expect(workers.routableModelsFor(reread)).toEqual(['claude-opus-5'])
  })

  it('resolves to [null] — the CLI\'s own choice — when the worker has no default at all', () => {
    const w = claudeWorker()
    const reread = workers.requireWorker(w.id)
    expect(reread.defaultModel).toBeNull()
    expect(workers.routableModelsFor(reread)).toEqual([null])
  })

  it('an explicit allowlist is returned verbatim, ignoring the default model', () => {
    const w = claudeWorker()
    workers.updateWorker(w.id, {
      defaultModel: 'claude-opus-5',
      routableModels: ['claude-sonnet-5', 'claude-haiku-4-5']
    })
    expect(workers.routableModelsFor(workers.requireWorker(w.id))).toEqual([
      'claude-sonnet-5',
      'claude-haiku-4-5'
    ])
  })

  it('refuses an id the cost model does not declare, before anything is stored', () => {
    const w = claudeWorker()
    expect(() =>
      api.checkWorkerDefaults('claude-code', { routableModels: ['not-a-real-model'] })
    ).toThrow(/not a model/)
    // Nothing was written by the throwing call.
    expect(workers.requireWorker(w.id).routableModels).toBeNull()
  })

  it('accepts every id the adapter\'s cost model actually declares', () => {
    expect(() =>
      api.checkWorkerDefaults('claude-code', {
        routableModels: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5']
      })
    ).not.toThrow()
  })

  it('the migration replays cleanly after versionBefore rewinds it', () => {
    const w = claudeWorker()
    workers.updateWorker(w.id, { routableModels: ['claude-sonnet-5'] })

    db.db().exec(`pragma user_version = ${db.versionBefore('routable_models_json')}`)
    db.closeDb()
    // Reopening replays the routable-models migration (and everything after it) a second time.
    expect(() => db.openDb(dbPath)).not.toThrow()

    // The column, and the data written before the rewind, both survived the replay.
    expect(workers.requireWorker(w.id).routableModels).toEqual(['claude-sonnet-5'])
  })
})
