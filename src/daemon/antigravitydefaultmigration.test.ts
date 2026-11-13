import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Migration 95 — Gemini 4 Hydrogen (High) replaces Gemini 3.8 Flash as Antigravity default.
 *
 * ⛔ Only the default model and effort move. Model table routes and custom worker choices
 * stay as written.
 */

let dir: string
let db: typeof import('./db.js')

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-agydefaultmigration-'))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

function seedWorker(
  id: string,
  adapter: string,
  defaultModel: string | null,
  defaultEffort: string | null,
  defaultModels: Record<string, string | null> | null
): void {
  db.db()
    .prepare(
      `insert into workers (id, label, adapter_id, isolation_root, enabled, human_occupied,
                            max_concurrent, role, created_at, default_model, default_effort, default_models_json)
       values (?, ?, ?, ?, 1, 0, 1, 'worker', 1000, ?, ?, ?)`
    )
    .run(id, id, adapter, join(dir, id), defaultModel, defaultEffort, defaultModels ? JSON.stringify(defaultModels) : null)
}

const row = (id: string): { default_model: string | null; default_effort: string | null; default_models_json: string | null } =>
  db.db().prepare('select default_model, default_effort, default_models_json from workers where id = ?').get(id) as {
    default_model: string | null
    default_effort: string | null
    default_models_json: string | null
  }

function replay(file: string): void {
  // ⚠️ Rewound by a fragment of the migration's own SQL, never by a number.
  const before = db.versionBefore("set default_model = 'gemini-4-hydrogen'")
  db.db().exec(`pragma user_version = ${before}`)
  db.closeDb()
  db.openDb(file)
}

describe('an Antigravity worker whose default is Gemini 3.8 Flash', () => {
  it('moves to Gemini 4 Hydrogen High, updating default models and keeping custom choices', () => {
    const file = join(dir, 'replay.db')
    db.openDb(file)
    seedWorker('agy-default', 'antigravity-cli', 'gemini-3.8-flash', null, { gemini: 'gemini-3.8-flash', claude: 'claude-sonnet-5-5' })
    seedWorker('agy-legacy-null', 'antigravity-cli', null, null, { gemini: 'gemini-3.8-flash', claude: 'claude-sonnet-5-5' })
    seedWorker('agy-custom-argon', 'antigravity-cli', 'gemini-4-argon', 'medium', { gemini: 'gemini-4-argon' })
    seedWorker('agy-empty', 'antigravity-cli', null, null, null)
    seedWorker('other', 'local-llm', 'gemini-3.8-flash', null, null)

    replay(file)

    const def = row('agy-default')
    expect(def.default_model).toBe('gemini-4-hydrogen')
    expect(def.default_effort).toBe('high')
    expect(JSON.parse(def.default_models_json!)).toEqual({ gemini: 'gemini-4-hydrogen', claude: 'claude-sonnet-5-5' })

    const legacyNull = row('agy-legacy-null')
    expect(legacyNull.default_model).toBe('gemini-4-hydrogen')
    expect(legacyNull.default_effort).toBe('high')
    expect(JSON.parse(legacyNull.default_models_json!)).toEqual({ gemini: 'gemini-4-hydrogen', claude: 'claude-sonnet-5-5' })

    const custom = row('agy-custom-argon')
    expect(custom.default_model).toBe('gemini-4-argon')
    expect(custom.default_effort).toBe('medium')

    const empty = row('agy-empty')
    expect(empty.default_model).toBeNull()
    expect(empty.default_effort).toBeNull()
    expect(empty.default_models_json).toBeNull()

    const other = row('other')
    expect(other.default_model).toBe('gemini-3.8-flash')
  })

  it('is replay-safe: a second pass changes nothing', () => {
    const file = join(dir, 'replay.db')
    replay(file)
    const def = row('agy-default')
    expect(def.default_model).toBe('gemini-4-hydrogen')
    expect(def.default_effort).toBe('high')
  })
})
