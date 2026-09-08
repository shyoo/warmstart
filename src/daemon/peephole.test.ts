import { describe, expect, it } from 'vitest'
import { adapters } from './adapters/index.js'
import {
  activityFor,
  clearActivity,
  consumeRunActivity,
  noteActivity,
  runActivityFor,
  type OutputFraming
} from './activity.js'
import { setEventSink } from './events.js'
import type { StreamEvent } from './stream.js'

/**
 * How each worker type's output reaches the peephole, and why it is the **adapter** that says so.
 *
 * ⛔ The two ways of getting this wrong are opposites, and this repository has now shipped both.
 * t272: every `run.output.delta` became its own row, so a muse turn read `landing / corners.test.ts
 * / pass. The / tree / is clean` — one word per block. t284, fixing that globally: every
 * `assistant_text` became a continuation, so Claude Code's separate messages were concatenated with
 * no separator at all (`…what t269 recorded.Now let me make the edits.`) and every linebreak the
 * agent wrote was dropped.
 *
 * ⚠️ Neither defect is visible from the bytes — `'landing'` and `'I will start by…'` are both just
 * text without a trailing newline. So the fix is a declared capability, and these tests exist to
 * stop it leaking across worker types again: each adapter's *own* records go through its *own*
 * decoder at its *own* declared framing, and a new adapter fails here until somebody says which
 * shape it emits.
 */

const ALL = adapters()

/** One turn as each CLI actually writes it, and what a person should be able to read afterwards. */
interface Sample {
  framing: OutputFraming
  /** Records exactly as the CLI emits them, in order. */
  records: Array<Record<string, unknown>>
  /** The peephole rows they should produce. */
  rows: string[]
}

const SAMPLES: Record<string, Sample> = {
  // Whole messages: one record per assistant turn, its own linebreaks inside it.
  'claude-code': {
    framing: 'message',
    records: [
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: "I'll start by understanding the routing code." }] }
      },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Now let me make the edits.\n\nStarting with `judgment.ts`:' }
          ]
        }
      }
    ],
    rows: [
      "I'll start by understanding the routing code.",
      'Now let me make the edits.',
      'Starting with `judgment.ts`:'
    ]
  },
  // `item.completed` — codex publishes an `agent_message` only once it has finished writing one.
  'openai-compatible': {
    framing: 'message',
    records: [
      { type: 'item.completed', item: { type: 'agent_message', text: 'Reading the failing test.' } },
      { type: 'item.completed', item: { type: 'agent_message', text: 'The assertion was inverted.' } }
    ],
    rows: ['Reading the failing test.', 'The assertion was inverted.']
  },
  // Deltas: a few tokens at a time, and the boundary between two of them is often mid-word.
  'muse-code': {
    framing: 'delta',
    records: [
      { payload_type: 'run.output.delta', payload: { text: 'landing' } },
      { payload_type: 'run.output.delta', payload: { text: ' corners.test.ts' } },
      { payload_type: 'run.output.delta', payload: { text: ' pass. The tree is clean' } }
    ],
    rows: ['landing corners.test.ts pass. The tree is clean']
  },
  'antigravity-cli': {
    framing: 'delta',
    records: [
      { event: 'step_update', step_update: { text_delta: 'squ' } },
      { event: 'step_update', step_update: { text_delta: 'ashing the' } },
      { event: 'step_update', step_update: { text_delta: ' commit' } }
    ],
    rows: ['squashing the commit']
  },
  'local-llm': {
    framing: 'delta',
    records: [
      { type: 'assistant_text', text: 'checking the ' },
      { type: 'assistant_text', text: 'endpoint is alive' }
    ],
    rows: ['checking the endpoint is alive']
  }
}

/** Every `assistant_text` a decoder produces for these records, in order. */
function proseFrom(
  decode: (record: Record<string, unknown>) => StreamEvent | StreamEvent[] | null,
  records: Array<Record<string, unknown>>
): string[] {
  const out: string[] = []
  for (const record of records) {
    const decoded = decode(record)
    const events = Array.isArray(decoded) ? decoded : decoded ? [decoded] : []
    for (const event of events) if (event.kind === 'assistant_text') out.push(event.text)
  }
  return out
}

describe('every worker type declares how its output is framed', () => {
  it('declares one of the two shapes, and nothing else', () => {
    expect(ALL.length).toBeGreaterThan(0)
    for (const a of ALL) {
      expect(['message', 'delta']).toContain(a.info.capabilities.outputFraming)
    }
  })

  it('has a sample turn on file for every adapter that decodes a stream', () => {
    // ⛔ The guard against the next adapter. One that can produce prose and has not said how that
    // prose is framed gets whatever the last person assumed, which is the bug twice over.
    const decoding = ALL.filter((a) => a.decodeStream).map((a) => a.info.id)
    for (const id of decoding) {
      expect(SAMPLES[id], `no peephole sample for '${id}'`).toBeDefined()
    }
  })

  it('declares the framing its own sample was written for', () => {
    for (const [id, sample] of Object.entries(SAMPLES)) {
      const found = ALL.find((a) => a.info.id === id)
      expect(found, `adapter '${id}' is not registered`).toBeDefined()
      expect(found!.info.capabilities.outputFraming).toBe(sample.framing)
    }
  })
})

describe('a turn off each worker type, read end to end', () => {
  for (const [id, sample] of Object.entries(SAMPLES)) {
    it(`reads back as prose on ${id}`, () => {
      const found = ALL.find((a) => a.info.id === id)
      const decode = found?.decodeStream
      expect(decode, `'${id}' has no stream decoder`).toBeDefined()

      const taskId = `t-wire-${id}`
      clearActivity(taskId)
      // ⛔ The adapter's *declared* framing, not the sample's — reading it off `info` is what makes
      // this a test of the wiring rather than of the fixture. A declaration that flips breaks here.
      const framing = found!.info.capabilities.outputFraming
      for (const text of proseFrom(decode!, sample.records)) {
        noteActivity(taskId, text, undefined, framing)
      }
      expect(activityFor(taskId).map((l) => l.text)).toEqual(sample.rows)
    })
  }

  it('never runs two separate messages together, on any message-framed adapter', () => {
    // ⛔ The t284 symptom itself, stated as a property: no row may contain the end of one message
    // and the start of the next.
    for (const [id, sample] of Object.entries(SAMPLES)) {
      if (sample.framing !== 'message') continue
      const taskId = `t-glue-${id}`
      clearActivity(taskId)
      const decode = ALL.find((a) => a.info.id === id)!.decodeStream!
      const prose = proseFrom(decode, sample.records)
      for (const text of prose) noteActivity(taskId, text, undefined, sample.framing)
      const rows = activityFor(taskId).map((l) => l.text)
      expect(rows.length).toBeGreaterThanOrEqual(prose.length)
      for (const row of rows) {
        // Each row came from exactly one message.
        const owners = prose.filter((m) => m.replace(/\s+/g, ' ').includes(row))
        expect(owners.length, `'${row}' does not sit inside a single message on ${id}`).toBe(1)
      }
    }
  })
})

describe('a message is a message', () => {
  it('gives two messages two rows, with nothing glued between them', () => {
    clearActivity('t-msg-pair')
    noteActivity('t-msg-pair', 'I understand what t269 recorded.', undefined, 'message')
    noteActivity('t-msg-pair', 'Now let me make the edits.', undefined, 'message')
    const rows = activityFor('t-msg-pair').map((l) => l.text)
    expect(rows).toEqual(['I understand what t269 recorded.', 'Now let me make the edits.'])
    expect(rows.join(' ')).not.toContain('recorded.Now')
  })

  it('keeps the linebreaks the agent wrote', () => {
    clearActivity('t-msg-breaks')
    noteActivity('t-msg-breaks', 'First paragraph.\n\nSecond paragraph.\nThird.', undefined, 'message')
    expect(activityFor('t-msg-breaks').map((l) => l.text)).toEqual([
      'First paragraph.',
      'Second paragraph.',
      'Third.'
    ])
  })

  it('is what an unannotated call gets, because that is the framing that cannot destroy text', () => {
    clearActivity('t-msg-default')
    noteActivity('t-msg-default', 'one thing')
    noteActivity('t-msg-default', 'another thing')
    expect(activityFor('t-msg-default').map((l) => l.text)).toEqual(['one thing', 'another thing'])
  })

  it('collapses runs of spaces inside a line, and caps a very long one', () => {
    clearActivity('t-msg-wide')
    noteActivity('t-msg-wide', '  reading   the   file  ', undefined, 'message')
    noteActivity('t-msg-wide', 'x'.repeat(5000), undefined, 'message')
    const rows = activityFor('t-msg-wide').map((l) => l.text)
    expect(rows[0]).toBe('reading the file')
    expect(rows[1]!.length).toBeLessThan(500)
  })

  it('says nothing for a message that says nothing', () => {
    clearActivity('t-msg-empty')
    noteActivity('t-msg-empty', '   \n \n  ', undefined, 'message')
    expect(activityFor('t-msg-empty')).toHaveLength(0)
  })

  it('normalises a CRLF transcript rather than showing the carriage returns', () => {
    clearActivity('t-msg-crlf')
    noteActivity('t-msg-crlf', 'first line\r\nsecond line', undefined, 'message')
    expect(activityFor('t-msg-crlf').map((l) => l.text)).toEqual(['first line', 'second line'])
  })

  it('stays inside the bound a long run is held to', () => {
    clearActivity('t-msg-bound')
    for (let i = 0; i < 200; i++) noteActivity('t-msg-bound', `message ${i}`, undefined, 'message')
    const tail = activityFor('t-msg-bound')
    expect(tail.length).toBeLessThanOrEqual(40)
    expect(tail[tail.length - 1]?.text).toBe('message 199')
  })

  it('tells watchers to push a row, never to replace the last one', () => {
    const seen: Array<{ text: string; append?: true }> = []
    setEventSink((e) => {
      if (e.type === 'task.activity' && e.taskId === 't-msg-wire') seen.push(e)
    })
    try {
      clearActivity('t-msg-wire')
      seen.length = 0
      noteActivity('t-msg-wire', 'first message', undefined, 'message')
      noteActivity('t-msg-wire', 'second\nmessage', undefined, 'message')
      expect(seen.map((e) => [e.text, e.append ?? false])).toEqual([
        ['first message', false],
        ['second', false],
        ['message', false]
      ])
    } finally {
      setEventSink(() => {})
    }
  })

  it('reaches the run tail a finished run persists, the same as a delta does', () => {
    clearActivity('t-msg-run')
    noteActivity('t-msg-run', 'looked at the diff', 'r-msg-run', 'message')
    noteActivity('t-msg-run', 'ran the suite\nit passed', 'r-msg-run', 'message')
    expect(runActivityFor('r-msg-run').map((l) => l.text)).toEqual([
      'looked at the diff',
      'ran the suite',
      'it passed'
    ])
    expect(consumeRunActivity('r-msg-run')).toHaveLength(3)
  })
})

describe('the two framings do not leak into one another', () => {
  it('reads the same bytes differently, which is the whole point', () => {
    const turn = ['Reading the file.', 'Writing the fix.']

    clearActivity('t-mix-msg')
    for (const t of turn) noteActivity('t-mix-msg', t, undefined, 'message')

    clearActivity('t-mix-delta')
    for (const t of turn) noteActivity('t-mix-delta', t, undefined, 'delta')

    expect(activityFor('t-mix-msg').map((l) => l.text)).toEqual(turn)
    // ⚠️ Concatenated without a separator — correct for a token stream, and exactly what must never
    // happen to whole messages.
    expect(activityFor('t-mix-delta').map((l) => l.text)).toEqual([
      'Reading the file.Writing the fix.'
    ])
  })

  it('settles a half-spoken delta line before a message stands beside it', () => {
    // An adapter may announce a tool one way and stream prose the other. The open line is finished,
    // not extended, so the two never share a row.
    clearActivity('t-mix-open')
    noteActivity('t-mix-open', 'search', undefined, 'delta')
    noteActivity('t-mix-open', 'ing files', undefined, 'delta')
    noteActivity('t-mix-open', 'Found three matches.', undefined, 'message')
    expect(activityFor('t-mix-open').map((l) => l.text)).toEqual([
      'searching files',
      'Found three matches.'
    ])
  })

  it('does not settle an empty open line into a blank row', () => {
    clearActivity('t-mix-blank')
    noteActivity('t-mix-blank', '   ', undefined, 'delta')
    noteActivity('t-mix-blank', 'the only thing said', undefined, 'message')
    expect(activityFor('t-mix-blank').map((l) => l.text)).toEqual(['the only thing said'])
  })
})
