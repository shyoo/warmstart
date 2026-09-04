import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

let dir: string
let db: typeof import('./db.js')

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-quotawarningmigration-'))
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
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

const taskColumns = (): string[] =>
  (db.db().prepare('pragma table_info(tasks)').all() as { name: string }[]).map((c) => c.name)

describe('the durable quota-preemption warning migration', () => {
  it('adds its nullable evidence column and survives replay', () => {
    const file = join(dir, 'replay.db')
    db.openDb(file)
    expect(taskColumns()).toContain('quota_preempt_json')

    const before = db.versionBefore('quota_preempt_json text')
    db.db().exec(`pragma user_version = ${before}`)
    db.closeDb()
    expect(() => db.openDb(file)).not.toThrow()
    expect(taskColumns()).toContain('quota_preempt_json')
  })
})
