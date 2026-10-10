import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Migration 89 — GPT 6.1 Sol replaces GPT 6 Sol as a Codex worker's default.
 *
 * ⛔ Only the stored *default* moves. A model table row, a grading choice or another adapter's
 * model that happens to share the id is the operator's word and is left as written.
 */

let dir: string
let db: typeof import('./db.js')

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-codexdefaultmigration-'))
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

function seedWorker(id: string, adapter: string, defaultModel: string | null, grading: string | null): void {
  db.db()
    .prepare(
      `insert into workers (id, label, adapter_id, isolation_root, enabled, human_occupied,
                            max_concurrent, role, created_at, default_model, default_effort, grading_model)
       values (?, ?, ?, ?, 1, 0, 1, 'worker', 1000, ?, 'high', ?)`
    )
    .run(id, id, adapter, join(dir, id), defaultModel, grading)
}

const row = (id: string): { default_model: string | null; default_effort: string | null; grading_model: string | null } =>
  db.db().prepare('select default_model, default_effort, grading_model from workers where id = ?').get(id) as {
    default_model: string | null
    default_effort: string | null
    grading_model: string | null
  }

function replay(file: string): void {
  // ⚠️ Rewound by a fragment of the migration's own SQL, never by a number.
  const before = db.versionBefore("set default_model = 'gpt-6.1-sol'")
  db.db().exec(`pragma user_version = ${before}`)
  db.closeDb()
  db.openDb(file)
}

describe('a Codex worker whose default is GPT 6 Sol', () => {
  it('moves to GPT 6.1 Sol, keeping its effort and every other choice', () => {
    const file = join(dir, 'replay.db')
    db.openDb(file)
    seedWorker('codex-sol', 'openai-compatible', 'gpt-6-sol', 'gpt-6-sol')
    seedWorker('codex-astra', 'openai-compatible', 'gpt-6-astra', null)
    seedWorker('codex-none', 'openai-compatible', null, null)
    // The id belongs to Codex alone: another adapter's default of the same string is not ours to move.
    seedWorker('other', 'local-llm', 'gpt-6-sol', null)

    replay(file)

    expect(row('codex-sol')).toEqual({ default_model: 'gpt-6.1-sol', default_effort: 'high', grading_model: 'gpt-6-sol' })
    expect(row('codex-astra').default_model).toBe('gpt-6-astra')
    expect(row('codex-none').default_model).toBeNull()
    expect(row('other').default_model).toBe('gpt-6-sol')
  })

  it('is replay-safe: a second pass changes nothing', () => {
    const file = join(dir, 'replay.db')
    replay(file)
    expect(row('codex-sol').default_model).toBe('gpt-6.1-sol')
  })
})
