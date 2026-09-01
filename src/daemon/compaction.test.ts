import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * The compaction ledger.
 *
 * ⛔ Written against a question that had no answer: *did it compact?* Measured 2026-08-31, the
 * operator switched `autoCompact` on at 07:48Z and by the end of the day still could not tell
 * whether anything had happened. Nothing was wrong with the switch. There was simply no record: the
 * clock sent `/compact` down a session's input, logged a line to a file nobody reads, and the
 * boundary record zeroed `tokens_since_compact` - a side effect, not a receipt.
 *
 * ⚠️ Every test here is about a **null**, because the nulls are what the ledger is for. A
 * compaction that was asked for and never landed, and an "after" size that nothing has measured
 * yet, are both real states that a success-only table would have rendered as silence.
 */

let dir: string
let db: typeof import('./db.js')
let compaction: typeof import('./compaction.js')

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-compaction-'))
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
  db = await import('./db.js')
  compaction = await import('./compaction.js')
  db.openDb(join(dir, 'compaction.db'))
})

afterAll(() => {
  db.closeDb?.()
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  db.db().prepare('delete from compactions').run()
})

const SESSION = 'ef5e90dc-a837-4f8f-b287-2758c31e356d'

describe('asking for a compaction', () => {
  it('records the ask before anything is known to have worked', () => {
    compaction.noteCompactionAsked({
      sessionId: SESSION,
      taskId: 't71',
      reason: 'nothing queued - past the break-even',
      preTokens: 278_275
    })

    const [row] = compaction.compactionsForTask('t71')
    expect(row?.trigger).toBe('clock')
    expect(row?.preTokens).toBe(278_275)
    // ⛔ The two that make it a request rather than a receipt.
    expect(row?.landedAt).toBeNull()
    expect(row?.postTokens).toBeNull()
  })

  it('⭐ leaves an ask that never landed standing, which is the whole finding', () => {
    compaction.noteCompactionAsked({
      sessionId: SESSION,
      taskId: 't71',
      reason: 'past the break-even',
      preTokens: 278_275
    })
    // No boundary ever arrives. HANDOFF R6 - whether `/compact` is honoured as a user message on
    // the stream transport - is answered by this row existing, not by its absence.
    expect(compaction.compactionsForTask('t71')[0]?.landedAt).toBeNull()
  })
})

describe('a compaction that landed', () => {
  it('closes the ask it answers rather than opening a second row', () => {
    compaction.noteCompactionAsked({
      sessionId: SESSION,
      taskId: 't71',
      reason: 'past the break-even',
      preTokens: 278_275
    })
    const landed = compaction.noteCompactionLanded(SESSION, {
      preTokens: 278_275,
      durationMs: 139_000,
      trigger: 'manual'
    })

    expect(compaction.compactionsForTask('t71')).toHaveLength(1)
    expect(landed?.landedAt).not.toBeNull()
    expect(landed?.durationMs).toBe(139_000)
    // ⚠️ Still `clock`: the trigger records who *decided*, and the clock did. The CLI reporting
    // `manual` only says the boundary came from a slash command rather than an auto-compaction,
    // which is exactly what the clock sends.
    expect(landed?.trigger).toBe('clock')
  })

  it('records a compaction nobody asked for rather than dropping it', () => {
    // The CLI compacts on its own when a context fills. Leaving those out would make the ledger
    // read as though the clock were the only thing ever shrinking a context.
    const landed = compaction.noteCompactionLanded(SESSION, {
      preTokens: 190_000,
      durationMs: 116_000,
      trigger: null
    })

    expect(landed?.trigger).toBe('auto')
    expect(landed?.askedAt).toBeNull()
    expect(landed?.landedAt).not.toBeNull()
  })

  it('keeps an agent-driven compaction apart from one the fleet bought', () => {
    const landed = compaction.noteCompactionLanded(SESSION, {
      preTokens: 90_000,
      durationMs: null,
      trigger: 'manual'
    })
    expect(landed?.trigger).toBe('agent')
  })
})

describe('what the compaction actually left behind', () => {
  const postTokens = (): number | null =>
    (
      db.db().prepare('select post_tokens from compactions where session_id = ?').get(SESSION) as {
        post_tokens: number | null
      }
    ).post_tokens

  it('is unknown until a turn measures it, and null is that answer', () => {
    const landed = compaction.noteCompactionLanded(SESSION, {
      preTokens: 278_275,
      durationMs: null
    })
    // ⛔ The boundary record carries a pre-size and no counterpart, so at this moment the compacted
    // size is genuinely unknown. Filling it in from an estimate would be the one number on the row
    // that nobody measured.
    expect(landed?.preTokens).toBe(278_275)
    expect(postTokens()).toBeNull()

    compaction.fillPostTokens(SESSION, 42_000)
    expect(postTokens()).toBe(42_000)
  })

  it('takes the first measurement only, because later growth is not the compaction', () => {
    compaction.noteCompactionLanded(SESSION, { preTokens: 278_275, durationMs: null })
    compaction.fillPostTokens(SESSION, 42_000)
    compaction.fillPostTokens(SESSION, 61_000)

    expect(postTokens()).toBe(42_000)
  })

  it('does not attach a measurement to a compaction that never landed', () => {
    compaction.noteCompactionAsked({
      sessionId: SESSION,
      taskId: 't71',
      reason: 'past the break-even',
      preTokens: 278_275
    })
    compaction.fillPostTokens(SESSION, 42_000)

    expect(compaction.compactionsForTask('t71')[0]?.postTokens).toBeNull()
  })
})
