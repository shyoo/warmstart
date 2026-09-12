import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Migration 69 — a delivery row whose URL is not a pull request was never a delivery.
 *
 * ⛔ t389 (2026-09-12) recorded `…/issues/133` as its second delivery, lifted from the command line
 * gh's "already exists" error quotes, and `gh pr view` failed on it every five minutes. The repair
 * removes such rows and keeps every real pull request exactly as it was.
 */

let dir: string
let db: typeof import('./db.js')

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-deliverymigration-'))
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

function seedDelivery(id: string, url: string): void {
  db.db()
    .prepare(
      `insert into projects (id, name, root, vcs, created_at)
       values (?, ?, ?, 'git', 1000) on conflict(id) do nothing`
    )
    .run('project-1', 'demo', join(dir, 'repo'))
  db.db()
    .prepare(
      `insert into tasks (id, seq, title, status, created_by_json, mandate_json, budget_json,
                          created_at, updated_at)
       values ('task-1', 1, 'x', 'completed', '{}', '{}', '{}', 1000, 1000) on conflict(id) do nothing`
    )
    .run()
  db.db()
    .prepare(
      `insert into task_deliveries (id, task_id, project_id, provider, url, target, branch, head_sha,
                                    state, created_at, updated_at)
       values (?, 'task-1', 'project-1', 'github', ?, 'main', 'warmstart/t1-x', ?, 'open', 1000, 1000)`
    )
    .run(id, url, 'a'.repeat(40))
}

const ids = (): string[] =>
  (db.db().prepare('select id from task_deliveries order by id').all() as Array<{ id: string }>).map((r) => r.id)

describe('repairing deliveries that were never pull requests', () => {
  it('removes an issue URL recorded as a delivery, and keeps the real pull request', () => {
    const file = join(dir, 'replay.db')
    db.openDb(file)
    seedDelivery('issue', 'https://github.com/shyoo/awardtracker/issues/133')
    seedDelivery('pull', 'https://github.com/shyoo/awardtracker/pull/139')

    // ⚠️ Rewound by a fragment of the migration's own code, never by a number.
    db.db().exec(`pragma user_version = ${db.versionBefore('add column retire_blocked')}`)
    db.closeDb()
    db.openDb(file)

    expect(ids()).toEqual(['pull'])
    // ⚠️ And replay-safe: running it again over its own result changes nothing.
    db.db().exec(`pragma user_version = ${db.versionBefore('add column retire_blocked')}`)
    db.closeDb()
    db.openDb(file)
    expect(ids()).toEqual(['pull'])
  })
})
