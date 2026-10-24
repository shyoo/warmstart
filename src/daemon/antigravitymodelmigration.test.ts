import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'

let dir: string
let db: typeof import('./db.js')

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-agymodelmigration-'))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
})

afterAll(() => {
  db.closeDb()
  rmSync(dir, { recursive: true, force: true })
})

it('repairs rejected worker choices, preserves routing assertions and replays without changes', () => {
  const file = join(dir, 'migration.db')
  db.openDb(file)
  const routes = [
    { model: 'claude-sonnet-4-6', effort: null, tags: ['Med', 'Audio'], auto: true },
    { model: 'claude-opus-4-6-thinking', effort: 'high', tags: ['High'], auto: false },
    { model: 'gemini-3.8-flash', effort: 'low', tags: ['Low'], auto: true },
    { model: 'custom-model', effort: null, tags: [], auto: false }
  ]
  for (const [id, adapter] of [['agy', 'antigravity-cli'], ['other', 'local-llm']] as const) {
    db.db().prepare(`insert into workers
      (id, label, adapter_id, isolation_root, enabled, human_occupied, max_concurrent, role,
       created_at, default_model, default_effort, grading_model, grading_effort,
       summarising_model, summarising_effort, judgment_model, judgment_effort,
       default_models_json, model_routes_json)
      values (?, ?, ?, ?, 1, 0, 1, 'worker', 1000, 'claude-sonnet-4-6', null,
        'claude-opus-4-6-thinking', 'low', 'claude-sonnet-4-6', null,
        'claude-opus-4-6-thinking', null, ?, ?)`).run(
      id, id, adapter, join(dir, id),
      JSON.stringify({ claude: 'claude-sonnet-4-6', gemini: 'gemini-3.8-flash', custom: null }),
      JSON.stringify(routes)
    )
  }
  db.db().prepare(`insert into workers
    (id, label, adapter_id, isolation_root, enabled, human_occupied, max_concurrent, role, created_at)
    values ('empty', 'empty', 'antigravity-cli', ?, 1, 0, 1, 'worker', 1000)`).run(join(dir, 'empty'))

  const snapshot = (): unknown[] => db.db().prepare('select * from workers order by id').all()
  const original = snapshot()
  const replay = (): void => {
    db.db().exec(`pragma user_version = ${db.versionBefore('select id, default_models_json, model_routes_json')}`)
    db.closeDb()
    db.openDb(file)
  }
  replay()
  const worker = db.db().prepare('select * from workers where id = ?').get('agy')!
  expect(worker.default_model).toBe('claude-sonnet-5-5')
  expect(worker.default_effort).toBe('medium')
  expect(worker.grading_model).toBe('claude-opus-5-5')
  expect(worker.grading_effort).toBe('low')
  expect(worker.summarising_model).toBe('claude-sonnet-5-5')
  expect(worker.summarising_effort).toBe('medium')
  expect(worker.judgment_model).toBe('claude-opus-5-5')
  expect(worker.judgment_effort).toBe('medium')
  expect(JSON.parse(worker.default_models_json as string)).toEqual({
    claude: 'claude-sonnet-5-5', gemini: 'gemini-3.8-flash', custom: null
  })
  expect(JSON.parse(worker.model_routes_json as string)).toEqual([
    { ...routes[0], model: 'claude-sonnet-5-5', effort: 'medium' },
    { ...routes[1], model: 'claude-opus-5-5' },
    routes[2], routes[3]
  ])
  const migrated = snapshot()
  expect(migrated.slice(1)).toEqual(original.slice(1)) // Empty config and other adapter stay intact.
  replay()
  expect(snapshot()).toEqual(migrated)
})
