import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { contextOf, sumUsage } from './transcript.js'
import { encodeProjectDir } from './adapters/claude-code.js'

/**
 * Metering has to be exact - every scheduling gate downstream is arithmetic over these numbers, and
 * the three traps in docs/cost-model.md §6 are all silent when you get them wrong. These fixtures
 * are shaped from real transcript records sampled 2026-08-25.
 */

describe('sumUsage', () => {
  it('sums iterations[] and ignores the top level, which excludes compaction sampling', () => {
    // The top level reports one iteration's worth; iterations[] carries both. Reading the top level
    // undercounts exactly the events that matter most.
    const totals = sumUsage({
      input_tokens: 2,
      output_tokens: 690,
      cache_read_input_tokens: 186_145,
      cache_creation: { ephemeral_1h_input_tokens: 3981, ephemeral_5m_input_tokens: 0 },
      iterations: [
        {
          input_tokens: 2,
          output_tokens: 690,
          cache_read_input_tokens: 186_145,
          cache_creation: { ephemeral_1h_input_tokens: 3981, ephemeral_5m_input_tokens: 0 }
        },
        {
          input_tokens: 0,
          output_tokens: 5631,
          cache_read_input_tokens: 331_874,
          cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 }
        }
      ]
    })

    expect(totals.output).toBe(690 + 5631)
    expect(totals.cacheRead).toBe(186_145 + 331_874)
    expect(totals.cacheWrite1h).toBe(3981)
  })

  it('falls back to the top level when there are no iterations', () => {
    const totals = sumUsage({
      input_tokens: 12,
      output_tokens: 40,
      cache_read_input_tokens: 900,
      cache_creation: { ephemeral_1h_input_tokens: 100, ephemeral_5m_input_tokens: 25 }
    })
    expect(totals).toMatchObject({ input: 12, output: 40, cacheRead: 900 })
  })

  it('keeps the two cache TTLs apart, because they price at 2.0x and 1.25x', () => {
    const totals = sumUsage({
      cache_creation: { ephemeral_1h_input_tokens: 4000, ephemeral_5m_input_tokens: 1000 }
    })
    expect(totals.cacheWrite1h).toBe(4000)
    expect(totals.cacheWrite5m).toBe(1000)
  })

  it('attributes an undifferentiated older cache_creation to the default TTL rather than losing it', () => {
    const totals = sumUsage({ cache_creation_input_tokens: 2048 })
    expect(totals.cacheWrite1h).toBe(2048)
    expect(totals.cacheWrite5m).toBe(0)
  })

  it('reads thinking tokens once per turn, not once per iteration', () => {
    const totals = sumUsage({
      output_tokens_details: { thinking_tokens: 237 },
      iterations: [{ output_tokens: 100 }, { output_tokens: 200 }]
    })
    expect(totals.thinking).toBe(237)
    expect(totals.output).toBe(300)
  })
})

describe('contextOf', () => {
  it('counts everything the model was holding when it answered', () => {
    const totals = sumUsage({
      input_tokens: 2,
      cache_read_input_tokens: 186_145,
      cache_creation: { ephemeral_1h_input_tokens: 3981, ephemeral_5m_input_tokens: 0 }
    })
    expect(contextOf(totals)).toBe(190_128)
  })
})

describe('encodeProjectDir', () => {
  it('matches the on-disk name Claude Code uses', () => {
    // Verified against a real transcript directory on 2026-08-25: every character that is not a
    // letter or a digit becomes a dash, including the drive colon and every separator.
    expect(encodeProjectDir('C:\\code\\my_project')).toBe('C--code-my-project')
    expect(encodeProjectDir('/home/x/proj.v2')).toBe('-home-x-proj-v2')
  })
})

describe('TranscriptTailer compact_boundary handling and recordCompaction', () => {
  let dir: string
  let db: typeof import('./db.js')
  let transcriptModule: typeof import('./transcript.js')
  let compactionModule: typeof import('./compaction.js')

  beforeAll(async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    dir = mkdtempSync(join(tmpdir(), 'agentyard-transcript-test-'))
    process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
    db = await import('./db.js')
    transcriptModule = await import('./transcript.js')
    compactionModule = await import('./compaction.js')
    db.openDb(join(dir, 'transcript_test.db'))
    db.db().prepare(`
      insert into workers (id, label, adapter_id, isolation_root, enabled, human_occupied, max_concurrent, role, created_at)
      values ('w1', 'Claude 1', 'claude-code', ?, 1, 0, 1, 'worker', ?)
    `).run(join(dir, 'iso'), Date.now())
  })

  afterAll(async () => {
    const { rmSync } = await import('node:fs')
    db.closeDb?.()
    rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(() => {
    db.db().prepare('delete from compactions').run()
    db.db().prepare('delete from turns').run()
    db.db().prepare('delete from sessions').run()
  })

  it('TranscriptTailer parses compact_boundary and passes timestamp to onCompact', async () => {
    const { writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const transcriptFile = join(dir, 'session-tailer.jsonl')
    const sessionId = 'session-tailer-1'

    const line = JSON.stringify({
      type: 'system',
      subtype: 'compact_boundary',
      timestamp: '2026-09-01T22:20:15.000Z',
      compactMetadata: {
        trigger: 'manual',
        preTokens: 84254,
        durationMs: 115000
      }
    })
    writeFileSync(transcriptFile, line + '\n', 'utf8')

    let recordedMeta: { preTokens: number | null; durationMs: number | null; trigger?: string | null; ts?: number } | null = null
    const tailer = new transcriptModule.TranscriptTailer(sessionId, transcriptFile, {
      onTurn() {},
      onCompact(_sid, meta) {
        recordedMeta = meta
      }
    })

    tailer.start()
    await new Promise((r) => setTimeout(r, 200))
    tailer.stop()

    expect(recordedMeta).not.toBeNull()
    const m = recordedMeta!
    expect(m.preTokens).toBe(84254)
    expect(m.durationMs).toBe(115000)
    expect(m.trigger).toBe('manual')
    expect(m.ts).toBe(Date.parse('2026-09-01T22:20:15.000Z'))
  })

  /**
   * ⛔ There is no shared transcript format, and until 2026-09-06 this tailer assumed there was.
   * Muse Code keys on `payload_type`, nests usage under `payload.event.usage` and dates records in
   * microseconds — a Claude-shaped reader meters **nothing** from it, silently, and an unmetered run
   * reports as costing nothing rather than as unknown.
   *
   * ⚠️ The `requestStartedAt` assertion is the half that is easy to lose: the previous record's time
   * is the earliest plausible start of the next request, the cache clock counts from it, and the
   * bookkeeping stays in the tailer precisely so every adapter does not have to redo it.
   */
  it('reads a foreign transcript through the adapter’s own decoder, and keeps the request clock', async () => {
    const { writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { museCode } = await import('./adapters/muse-code.js')
    const file = join(dir, 'muse-session.jsonl')
    const sessionId = 'session-muse-1'

    const lines = [
      // An ordinary record: no usage, but its timestamp is what the next request started after.
      {
        recorded_at: 1_788_754_280_000_000,
        payload_type: 'runtime.session.metadata',
        payload: { kind: 'metadata' }
      },
      {
        recorded_at: 1_788_754_289_278_935,
        payload_type: 'runtime.session',
        payload: {
          source_run_record_id: '33d871da',
          event: {
            kind: 'model_completed',
            model: 'muse-spark-1.3-contributor',
            usage: {
              cache_read_tokens: 24_433,
              cache_write_tokens: 0,
              cached_tokens: 24_433,
              input_tokens: 24_679,
              output_tokens: 88,
              reasoning_tokens: 75
            }
          }
        }
      }
    ]
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8')

    const turns: Array<import('@shared/protocol.js').Turn> = []
    const tailer = new transcriptModule.TranscriptTailer(
      sessionId,
      file,
      { onTurn: (t) => turns.push(t), onCompact() {} },
      museCode.decodeTranscript
    )
    tailer.start()
    await new Promise((r) => setTimeout(r, 200))
    tailer.stop()

    expect(turns).toHaveLength(1)
    const turn = turns[0]!
    expect(turn.requestId).toBe('33d871da')
    expect(turn.ts).toBe(1_788_754_289_279)
    // The metadata record before it, not the turn's own stamp.
    expect(turn.requestStartedAt).toBe(1_788_754_280_000)
    // ⛔ `input_tokens` includes the cached prefix on this vendor; 24,679 − 24,433 fresh.
    expect(turn.inputTokens).toBe(246)
    expect(turn.cacheReadTokens).toBe(24_433)
    expect(turn.contextTokens).toBe(24_679)
  })

  it('⭐ recordCompaction deduplicates a replayed compact_boundary when session is resumed', async () => {
    const sessionId = 'session-replay-1'
    const T1 = Date.parse('2026-09-01T22:20:15.000Z')

    // Seed session in DB
    db.db().prepare(`
      insert into sessions (id, worker_id, adapter_id, transport, cwd, state, purpose, tokens_since_compact, started_at)
      values (?, 'w1', 'claude-code', 'stream', 'C:\\ws', 'live', 'work', 50000, ?)
    `).run(sessionId, T1 - 10000)

    compactionModule.noteCompactionAsked({
      sessionId,
      taskId: 't113',
      reason: 'warm prefix compaction',
      preTokens: 84254
    })

    // First time the boundary is processed (run 1):
    const firstResult = transcriptModule.recordCompaction(sessionId, {
      preTokens: 84254,
      durationMs: 115000,
      trigger: 'manual',
      ts: T1
    })
    expect(firstResult).toBe(true)
    expect(compactionModule.compactionsForTask('t113')).toHaveLength(1)

    // Second time the boundary is processed (replayed on resume from offset 0 in run 2):
    const secondResult = transcriptModule.recordCompaction(sessionId, {
      preTokens: 84254,
      durationMs: 115000,
      trigger: 'manual',
      ts: T1
    })
    expect(secondResult).toBe(false)
    // Must still have exactly 1 compaction for t113, not 2!
    expect(compactionModule.compactionsForTask('t113')).toHaveLength(1)
  })
})

