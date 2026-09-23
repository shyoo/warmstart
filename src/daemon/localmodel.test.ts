import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isLocalModelId, LOCAL_MODEL_PREFIX, localModelId, localModelLabel, servedModelOf } from '@shared/localmodel.js'
import { benchmarkPrior } from './benchmarks.js'
import { routesFromLegacy } from '@shared/modelroutes.js'

/**
 * A local model is whatever the server serves, named `local-llm:<served id>` (t486, 2026-09-16).
 *
 * ⛔ The bug this pins: the cost model listed one id, `qwen3-coder-30b-a3b`, so it was the only
 * default a person could set and the one every migration wrote — while llama.cpp ignores the
 * `model` field on a single-model server, so a Qwen3.8-27B endpoint answered and every run,
 * cost row and grade said the 30B coder had.
 */

const GGUF = 'C:\\models\\qwen3-coder\\Qwen3-Coder-30B-A3B-Instruct-UD-Q3_K_XL.gguf'

describe('naming a served model', () => {
  it('namespaces the id verbatim, and strips only the namespace', () => {
    expect(localModelId(GGUF)).toBe(`local-llm:${GGUF}`)
    expect(localModelId(`local-llm:${GGUF}`)).toBe(`local-llm:${GGUF}`)
    expect(servedModelOf(`local-llm:${GGUF}`)).toBe(GGUF)
    expect(servedModelOf('gpt-5.6-luna')).toBe('gpt-5.6-luna')
  })

  it('recognises only a namespaced id with something after the prefix', () => {
    expect(isLocalModelId(`local-llm:${GGUF}`)).toBe(true)
    expect(isLocalModelId(LOCAL_MODEL_PREFIX)).toBe(false)
    expect(isLocalModelId('qwen3-coder-30b-a3b')).toBe(false)
    expect(isLocalModelId(null)).toBe(false)
  })

  it('labels a path by its file name without .gguf, and keeps a catalogue name whole', () => {
    expect(localModelLabel(`local-llm:${GGUF}`)).toBe('Qwen3-Coder-30B-A3B-Instruct-UD-Q3_K_XL')
    expect(localModelLabel('local-llm:/srv/models/Qwen3.8-27B-UD-Q4_K_XL.gguf')).toBe('Qwen3.8-27B-UD-Q4_K_XL')
    expect(localModelLabel('local-llm:unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL')).toBe('unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL')
    expect(localModelLabel('local-llm:qwen3-coder-30b-a3b')).toBe('qwen3-coder-30b-a3b')
  })
})

describe('a benchmark prior for a served model', () => {
  it('matches the family by the file name, and says it was inferred that way', () => {
    const prior = benchmarkPrior(`local-llm:${GGUF}`)
    expect(prior.agentic).not.toBeNull()
    expect(prior.basis).toContain("matched family 'qwen3-coder'")
    expect(prior.basis).toContain('matched by its file name')
    expect(prior.source).toBeNull()
  })

  it('stays unknown for a file no leaderboard names', () => {
    const prior = benchmarkPrior('local-llm:C:\\models\\Mystery-7B.gguf')
    expect(prior.agentic).toBeNull()
    expect(prior.basis).toContain('unknown, not a guess')
  })
})

describe('what the daemon does with a served model', () => {
  let dir: string
  let db: typeof import('./db.js')
  let workers: typeof import('./workers.js')
  let sessions: typeof import('./sessions.js')
  let api: typeof import('./api/workers.js')
  let support: typeof import('./api/support.js')
  const LOCAL = 'aaaaaaaa-0000-4000-8000-000000000021'
  const OTHER = 'aaaaaaaa-0000-4000-8000-000000000022'

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'agentyard-localmodel-'))
    process.env.WARMSTART_DATA_DIR = dir
    db = await import('./db.js')
    db.openDb(join(dir, 'localmodel.db'))
    workers = await import('./workers.js')
    sessions = await import('./sessions.js')
    api = await import('./api/workers.js')
    support = await import('./api/support.js')
  })

  afterAll(() => {
    db.closeDb()
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // A held file handle on Windows is not a test failure.
    }
  })

  function worker(id: string, label: string, adapterId: string, servedModels: string[] | null): void {
    db.db()
      .prepare(
        `insert or replace into workers (id, label, adapter_id, isolation_root, enabled,
                                         human_occupied, max_concurrent, role, identity_json, created_at)
         values (?,?,?,?,1,0,1,'worker',?,?)`
      )
      .run(id, label, adapterId, `http://127.0.0.1:${label.length}`, JSON.stringify({ loggedIn: true, servedModels, contextWindow: servedModels ? 16384 : null }), Date.now())
  }

  it('⛔ the migration clears the pinned name and nothing a person chose', () => {
    worker(LOCAL, 'Coder', 'local-llm', null)
    worker(OTHER, 'Big', 'local-llm', null)
    db.db().prepare("update workers set default_model = 'qwen3-coder-30b-a3b', grading_model = 'qwen3-coder-30b-a3b', summarising_model = 'qwen3-coder-30b-a3b' where id = ?").run(LOCAL)
    db.db().prepare("update workers set default_model = 'local-llm:Qwen3.8-27B.gguf', grading_model = 'qwen3-coder-30b-a3b' where id = ?").run(OTHER)

    const before = db.versionBefore("adapter_id = 'local-llm' and ${column} = 'qwen3-coder-30b-a3b'")
    db.db().exec(`pragma user_version = ${before}`)
    db.closeDb()
    db.openDb(join(dir, 'localmodel.db'))

    const coder = workers.requireWorker(LOCAL)
    expect([coder.defaultModel, coder.gradingModel, coder.summarisingModel]).toEqual([null, null, null])
    const big = workers.requireWorker(OTHER)
    expect(big.defaultModel).toBe('local-llm:Qwen3.8-27B.gguf')
    expect(big.gradingModel).toBeNull()
  })

  it('offers each local worker the models its own endpoint reported, and the adapter their union', async () => {
    worker(LOCAL, 'Coder', 'local-llm', ['local-llm:Qwen3-Coder.gguf'])
    worker(OTHER, 'Big', 'local-llm', ['local-llm:Qwen3.8-27B.gguf'])

    expect(workers.knownModelIds('local-llm', LOCAL)).toEqual(['local-llm:Qwen3-Coder.gguf'])
    expect(workers.knownModelIds('local-llm').sort()).toEqual(['local-llm:Qwen3-Coder.gguf', 'local-llm:Qwen3.8-27B.gguf'])
    // A cloud adapter's list is its cost model's, and it never gains a worker entry.
    expect(workers.knownModelIds('claude-code')).toContain('claude-haiku-4-5')

    const options = await api.apiWorkers({ version: '0', startedAt: Date.now(), port: 0 })['model.options']()
    const local = options.filter((o) => o.adapterId === 'local-llm')
    expect(local.find((o) => !o.workerId)?.models.map((m) => m.id).sort()).toEqual(['local-llm:Qwen3-Coder.gguf', 'local-llm:Qwen3.8-27B.gguf'])
    expect(local.find((o) => o.workerId === LOCAL)?.models.map((m) => m.id)).toEqual(['local-llm:Qwen3-Coder.gguf'])
    expect(local.find((o) => o.workerId === LOCAL)?.models[0]?.contextWindow).toBe(32768)
    expect(options.filter((o) => o.adapterId === 'claude-code').every((o) => !o.workerId)).toBe(true)
  })

  it('accepts any id under the namespace as a default, and refuses a bare name with the reason', () => {
    expect(() => support.checkWorkerDefaults('local-llm', { defaultModel: 'local-llm:Anything-At-All.gguf' })).not.toThrow()
    expect(() => support.checkWorkerDefaults('local-llm', { modelRoutes: routesFromLegacy(['local-llm:A.gguf', 'local-llm:B.gguf']) })).not.toThrow()
    expect(() => support.checkWorkerDefaults('local-llm', { defaultModel: 'qwen3-coder-30b-a3b' })).toThrow(/local-llm:<id the server reports>/)
    expect(() => support.checkWorkerDefaults('local-llm', { gradingModel: 'gpt-oss-120b' })).toThrow(/is not how Local LLM names a model/)
    // The namespace is the adapter's: a cloud adapter does not take it.
    expect(() => support.checkWorkerDefaults('claude-code', { defaultModel: 'local-llm:x.gguf' })).toThrow(/can be priced for/)
  })

  it('records the model the server named only on a session that asked for none', () => {
    const asked = 'cccccccc-0000-4000-8000-000000000001'
    const open = 'cccccccc-0000-4000-8000-000000000002'
    const now = Date.now()
    const insert = db.db().prepare(
      `insert into sessions (id, worker_id, adapter_id, transport, cwd, model, state, purpose, started_at)
       values (?,?,?,?,?,?,'starting','work',?)`
    )
    insert.run(asked, LOCAL, 'local-llm', 'stream', dir, 'local-llm:Chosen.gguf', now)
    insert.run(open, LOCAL, 'local-llm', 'stream', dir, null, now)

    sessions.noteModelChosen(asked, 'local-llm:Served.gguf')
    sessions.noteModelChosen(open, 'local-llm:Served.gguf')
    sessions.noteModelChosen(open, 'local-llm:Later.gguf')

    expect(sessions.getSession(asked)?.model).toBe('local-llm:Chosen.gguf')
    expect(sessions.getSession(open)?.model).toBe('local-llm:Served.gguf')
    // The window a worker's endpoint reported wins over the template's default.
    expect(sessions.getSession(open)?.contextWindow).toBe(16384)
  })
})
