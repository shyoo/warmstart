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

/**
 * Waiting for a boundary.
 *
 * ⛔ The resume path holds a task's own prompt back until the conversation it revived has shrunk, so
 * "the compaction landed" has to be something a caller can *wait on* rather than something it
 * discovers by polling a row. ⚠️ One-shot, per session, and unsubscribable — a waiter that fired
 * twice would send the same prompt twice, and one that never unsubscribed would fire on the next
 * task's compaction months later.
 */
describe('telling somebody the compaction landed', () => {
  it('wakes a waiter once, and not again on the next compaction', () => {
    let woken = 0
    compaction.onCompactionLanded(SESSION, () => woken++)

    compaction.compactionLanded(SESSION)
    compaction.compactionLanded(SESSION)

    expect(woken).toBe(1)
  })

  it('wakes nobody on a session that is not the one being waited for', () => {
    let woken = 0
    compaction.onCompactionLanded(SESSION, () => woken++)
    compaction.compactionLanded('00000000-0000-0000-0000-000000000000')
    expect(woken).toBe(0)
  })

  it('a waiter that gave up is not woken - it has already sent the prompt', () => {
    // ⛔ The timeout path. A `/compact` that is never honoured must not leave a listener behind that
    // a much later boundary would fire into a run that finished hours ago.
    let woken = 0
    const stop = compaction.onCompactionLanded(SESSION, () => woken++)
    stop()
    stop()
    compaction.compactionLanded(SESSION)
    expect(woken).toBe(0)
  })

  it('one waiter throwing does not rob the others', () => {
    let woken = 0
    compaction.onCompactionLanded(SESSION, () => {
      throw new Error('a listener that fails is still a listener')
    })
    compaction.onCompactionLanded(SESSION, () => woken++)
    expect(() => compaction.compactionLanded(SESSION)).not.toThrow()
    expect(woken).toBe(1)
  })
})

/**
 * The compaction the stall watchdog has to know about.
 *
 * ⛔ Measured on t105, 2026-09-02. The resume path issued `/compact` at 06:51:03 and the boundary
 * arrived at 06:53:11 — two minutes and eight seconds, which is what a compaction costs. At 06:52:15,
 * squarely inside that, the watchdog told the operator the task *"looks stuck rather than slow"*: no
 * turn, and a process tree that had used 0.7 CPU-seconds in seventy seconds. Every one of those
 * observations was true, and the conclusion was wrong, because a session answering `/compact` looks
 * exactly like a session waiting on something that will never come.
 */
describe('knowing a session is mid-compaction', () => {
  const asked = (): void => {
    compaction.noteCompactionAsked({
      sessionId: SESSION,
      taskId: 't105',
      reason: 'compacting the resumed conversation before prompting',
      preTokens: 41_048
    })
  }

  it('is in flight from the ask until the boundary', () => {
    asked()
    expect(compaction.compactionInFlight(SESSION)).toBe(true)
  })

  it('is not in flight once the boundary lands', () => {
    asked()
    compaction.noteCompactionLanded(SESSION, { preTokens: 41_048, durationMs: 128_000 })
    expect(compaction.compactionInFlight(SESSION)).toBe(false)
  })

  it('⛔ stops excusing silence after the grace window, so an unhonoured /compact cannot mute the watchdog', () => {
    asked()
    const later = Date.now() + compaction.COMPACTION_GRACE_MS + 1
    expect(compaction.compactionInFlight(SESSION, later)).toBe(false)
  })

  it('covers a compaction that takes the two minutes t105 took', () => {
    asked()
    expect(compaction.compactionInFlight(SESSION, Date.now() + 128_000)).toBe(true)
  })

  it('says nothing about a session that has never compacted', () => {
    expect(compaction.compactionInFlight('00000000-0000-0000-0000-000000000000')).toBe(false)
    expect(compaction.lastCompactionLandedAt('00000000-0000-0000-0000-000000000000')).toBeNull()
  })

  it('reports the most recent boundary, which the watchdog counts as a turn', () => {
    compaction.noteCompactionLanded(SESSION, { preTokens: 90_000, durationMs: null })
    const landed = compaction.lastCompactionLandedAt(SESSION)
    expect(landed).not.toBeNull()
    expect(Date.now() - (landed ?? 0)).toBeLessThan(60_000)
  })

  it('does not treat an ask on another session as this one compacting', () => {
    asked()
    expect(compaction.compactionInFlight('11111111-1111-1111-1111-111111111111')).toBe(false)
  })
})
