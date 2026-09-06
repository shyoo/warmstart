import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Migration 50 — re-deciding a leak flag whose definition changed underneath it.
 *
 * ⛔ **30 of this fleet's 32 completed reviews were marked leaked, and Quality per Task read
 * `ungraded` for every key but one because of it.** `statistics.ts` averages *clean* reviews only,
 * and the old test — *does the blinded text contain a vendor word anywhere* — is true of almost
 * every diff in a repository whose subject matter is coding agents. The grades were there the whole
 * time; nothing could use them.
 *
 * ⛔ **Recomputed from evidence, never assumed false.** `runs.prompt` still holds the exact text the
 * reviewer was given, so the flag is re-measured against it. A review whose run or prompt is gone
 * keeps whatever it has: clearing a flag nobody could re-check would be inventing a clean review,
 * which is the one thing this feature must not do.
 */

let dir: string
let db: typeof import('./db.js')

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-blindingmigration-'))
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

function seedReview(id: string, prompt: string | null): void {
  db.db()
    .prepare(
      `insert into runs (id, worker_id, started_at, prompt, kind, quota_unverified)
       values (?, 'worker-1', 1000, ?, 'quality_review', 0)`
    )
    .run(`run-${id}`, prompt)
  db.db()
    .prepare(
      `insert into quality_reviews (id, task_id, run_id, reviewer_worker_id, reviewer_adapter,
                                    subject_adapter, status, rubric_version, blinded, blinding_leak,
                                    created_at)
       values (?, ?, ?, 'worker-1', 'claude-code', 'antigravity-cli', 'complete', 'v1', 1, 1, 1000)`
    )
    .run(id, `task-${id}`, `run-${id}`)
}

function seedTask(id: string): void {
  db.db()
    .prepare(
      `insert into tasks (id, seq, title, status, created_by_json, mandate_json, budget_json,
                          created_at, updated_at)
       values (?, ?, 'x', 'completed', '{}', '{}', '{}', 1000, 1000)`
    )
    .run(`task-${id}`, id.length)
}

const leakOf = (id: string): number =>
  (
    db.db().prepare('select blinding_leak as n from quality_reviews where id = ?').get(id) as {
      n: number
    }
  ).n

describe('re-deciding blinding_leak on reviews graded before the definition changed', () => {
  it('clears the flag on a review whose prompt merely discusses agents, and keeps it on one that attributes the work', () => {
    const file = join(dir, 'replay.db')
    db.openDb(file)
    seedTask('subject')
    seedTask('attributed')
    seedReview('subject', 'The change adds a gemini tokenizer quirk workaround to antigravity-cli.')
    seedReview('attributed', 'Body of the change.\n\nGenerated-By: Gemini 3.8 Flash')

    // ⚠️ Rewound by a fragment of the migration's own **code**, not by a number and not by its
    // comment: an index typed in here becomes a test of somebody else's migration the first time one
    // is inserted before it, and the transpiler strips comments before `toString` ever sees them.
    const before = db.versionBefore('update quality_reviews set blinding_leak = ? where id = ?')
    db.db().exec(`pragma user_version = ${before}`)
    db.closeDb()
    db.openDb(file)

    expect(leakOf('subject')).toBe(0)
    expect(leakOf('attributed')).toBe(1)
  })

  it('leaves a review whose prompt is gone exactly as it found it', () => {
    // ⛔ Not cleared. There is nothing left to re-measure against, and a flag cleared without
    //    evidence is a review claiming to be clean on the strength of a missing row.
    const file = join(dir, 'noprompt.db')
    db.openDb(file)
    seedTask('orphan')
    seedReview('orphan', null)

    const before = db.versionBefore('update quality_reviews set blinding_leak = ? where id = ?')
    db.db().exec(`pragma user_version = ${before}`)
    db.closeDb()
    db.openDb(file)

    expect(leakOf('orphan')).toBe(1)
  })
})
