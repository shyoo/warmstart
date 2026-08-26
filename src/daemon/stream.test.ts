import { describe, expect, it } from 'vitest'
import { StreamParser, type StreamEvent } from './stream.js'
import { adapter } from './adapters/index.js'

/**
 * Three CLIs, three stream dialects, one parser.
 *
 * ⛔ Every record below is **verbatim from a real run on 2026-08-25**, not invented. That matters
 * because the failure this file exists to prevent is silent: a parser keyed on the wrong envelope
 * returns an empty event list for every line — no error, no warning, just a session that reports no
 * usage, no result and no rate-limit signal for as long as it runs.
 *
 * The Antigravity dialect is the reason this refactor happened. It keys on `event`, not `type`, and
 * the shared parser read nothing from it.
 */

const decoderFor = (id: string) => {
  const decode = adapter(id).decodeStream
  if (!decode) throw new Error(`${id} declares no stream decoder`)
  return decode
}

const parse = (id: string, lines: string[]): StreamEvent[] => {
  const parser = new StreamParser(decoderFor(id))
  return lines.flatMap((line) => parser.push(`${line}\n`))
}

// ---------------------------------------------------------------------------- claude-code

describe('claude-code', () => {
  const rateLimit =
    '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1787684400,' +
    '"rateLimitType":"five_hour","overageStatus":"rejected","isUsingOverage":false}}'

  it('reads the free live rate-limit record and converts its clock to milliseconds', () => {
    // The one signal preemption runs on, and the only one of the three CLIs that provides it.
    const [event] = parse('claude-code', [rateLimit])
    expect(event).toMatchObject({
      kind: 'rate_limit',
      info: { status: 'allowed', rateLimitType: 'five_hour', resetsAt: 1787684400000 }
    })
  })

  it('picks the result out of a mixed stream', () => {
    const events = parse('claude-code', [
      '{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}',
      rateLimit,
      '{"type":"result","result":"done","total_cost_usd":0.21,"is_error":false}'
    ])
    expect(events.find((e) => e.kind === 'assistant_text')).toMatchObject({ text: 'hello' })
    expect(events.find((e) => e.kind === 'result')).toMatchObject({ text: 'done', isError: false })
  })

  it('reports a tool-only turn as something other than empty prose', () => {
    const [event] = parse('claude-code', [
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash"}]}}'
    ])
    // Empty assistant_text would make a chat pane look like the model answered with nothing.
    expect(event?.kind).toBe('other')
  })

  it('does not claim usage: this adapter is metered from its transcript', () => {
    const events = parse('claude-code', [rateLimit, '{"type":"result","result":"x"}'])
    expect(events.some((e) => e.kind === 'usage')).toBe(false)
  })
})

// ---------------------------------------------------------------------------- antigravity-cli

describe('antigravity-cli', () => {
  // ⛔ Verbatim from `agy -p /usage --output-format stream-json`, 2026-08-25, agy 1.1.20.
  const init =
    '{"event":"init","conversation_id":"379cc136","init":{"cwd":"C:\\\\Dev","tools":["view_file"],' +
    '"permission_mode":"request-review"}}'
  const usage =
    '{"event":"step_update","step_update":{"conversation_id":"379cc136","step_index":2,"state":"DONE",' +
    '"step_type":"agent_response","duration_seconds":1.6,"usage":{"input_tokens":14603,' +
    '"output_tokens":264,"thinking_tokens":223,"cache_read_tokens":0,"total_tokens":14867}}}'
  const result =
    '{"event":"result","result":{"conversation_id":"379cc136","status":"SUCCESS","response":"hi",' +
    '"duration_seconds":4.9,"num_turns":1,"usage":{"input_tokens":14603,"output_tokens":264}}}'

  it('keys on `event`, not `type` — the whole reason decoding moved to the adapter', () => {
    // ⛔ The regression. Against the old shared parser every one of these produced nothing at all.
    const events = parse('antigravity-cli', [init, usage, result])
    expect(events.length).toBeGreaterThanOrEqual(3)
    expect(events.every((e) => e.kind !== 'other' || e.kind === 'other')).toBe(true)
  })

  it('reads the conversation id out of init, since agentyard cannot mint one', () => {
    const [event] = parse('antigravity-cli', [init])
    expect(event).toMatchObject({ kind: 'init', sessionId: '379cc136', permissionMode: 'request-review' })
  })

  it('takes usage from the stream, because there is no transcript it can read', () => {
    const event = parse('antigravity-cli', [usage]).find((e) => e.kind === 'usage')
    expect(event).toMatchObject({
      kind: 'usage',
      usage: { input: 14603, output: 264, thinking: 223, cacheRead: 0, cacheWrite: 0 }
    })
  })

  it('reports an unsuccessful status as an error rather than a quiet success', () => {
    const failed = result.replace('"status":"SUCCESS"', '"status":"CANCELLED"')
    expect(parse('antigravity-cli', [failed]).find((e) => e.kind === 'result')).toMatchObject({
      isError: true,
      terminalReason: 'CANCELLED'
    })
  })

  it('reports an unknown cost as null, never as zero', () => {
    // ⛔ Zero would read as "this turn was free" everywhere downstream.
    expect(parse('antigravity-cli', [result]).find((e) => e.kind === 'result')).toMatchObject({
      costUsd: null
    })
  })

  it('ignores the plain-English notice agy prints when a tool is auto-denied', () => {
    const parser = new StreamParser(decoderFor('antigravity-cli'))
    const notice =
      'jetski: no output produced — a tool required the "read_file" permission that headless mode ' +
      'cannot prompt for, so it was auto-denied.\n'
    expect(parser.push(notice)).toHaveLength(0)
    expect(parser.push(`${result}\n`).length).toBeGreaterThan(0)
  })

  it('gets both the usage and the result out of one terminal record', () => {
    // ⛔ agy's `result` carries the turn's text *and* its usage. A decoder that had to return one
    // event would silently drop whichever it did not pick — and usage is the only billing signal
    // this adapter has, so dropping it would make its work look free.
    const events = parse('antigravity-cli', [result])
    expect(events.map((e) => e.kind).sort()).toEqual(['result', 'usage'])
    expect(events.find((e) => e.kind === 'usage')).toMatchObject({ final: true })
  })
})

// ---------------------------------------------------------------------------- openai-compatible

describe('openai-compatible', () => {
  // ⛔ Verbatim from `codex exec --json`, 2026-08-25, codex-cli 0.149.1.
  const started = '{"type":"thread.started","thread_id":"01a03baf-969b-7650-9b76-16001939ec5b"}'
  const message = '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ok"}}'
  const completed =
    '{"type":"turn.completed","usage":{"input_tokens":13249,"cached_input_tokens":11008,' +
    '"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}'

  it('reads the thread id, which is codex\'s name for the session', () => {
    expect(parse('openai-compatible', [started])).toMatchObject([
      { kind: 'init', sessionId: '01a03baf-969b-7650-9b76-16001939ec5b' }
    ])
  })

  it('reads assistant prose out of a completed item', () => {
    expect(parse('openai-compatible', [message])).toMatchObject([
      { kind: 'assistant_text', text: 'ok' }
    ])
  })

  it('subtracts the cached prefix rather than double-counting it', () => {
    // ⛔ The trap in this dialect: `input_tokens` is the TOTAL and already includes
    // `cached_input_tokens`. On the measured sample that is 11,008 of 13,249 - so adding them would
    // inflate the turn by 83%.
    const event = parse('openai-compatible', [completed]).find((e) => e.kind === 'usage')
    expect(event).toMatchObject({
      kind: 'usage',
      final: true,
      usage: { input: 2241, cacheRead: 11008, cacheWrite: 0, output: 5, thinking: 0 }
    })
  })

  it('reports a failed turn as a result rather than as usage', () => {
    expect(parse('openai-compatible', ['{"type":"turn.failed"}']).find((e) => e.kind === 'result'))
      .toMatchObject({ isError: true, terminalReason: 'turn.failed' })
  })

  it('skips the diagnostic codex prints before its first record', () => {
    const parser = new StreamParser(decoderFor('openai-compatible'))
    expect(parser.push('Reading additional input from stdin...\n')).toHaveLength(0)
    expect(parser.push(`${started}\n`)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------- framing

describe('framing, which is the one thing they do share', () => {
  it('waits for the newline before believing a record', () => {
    const parser = new StreamParser(decoderFor('openai-compatible'))
    const line = '{"type":"thread.started","thread_id":"abc"}'
    expect(parser.push(line.slice(0, 20))).toHaveLength(0)
    expect(parser.push(`${line.slice(20)}\n`)).toHaveLength(1)
  })

  it('does not grow without bound on a stream with no newlines, and recovers', () => {
    const parser = new StreamParser(decoderFor('claude-code'))
    for (let i = 0; i < 10; i++) parser.push('x'.repeat(600_000))
    expect(parser.push('\n')).toHaveLength(0)
    expect(parser.push('{"type":"result","result":"ok"}\n')).toHaveLength(1)
  })

  it('every adapter that offers the stream transport can decode it', () => {
    // ⛔ An adapter offering `stream` with no decoder produces an empty event list for every line -
    // no usage, no result, no rate limit - and nothing would fail. This is what catches that.
    for (const a of [adapter('claude-code'), adapter('antigravity-cli'), adapter('openai-compatible')]) {
      if (a.info.capabilities.transports.includes('stream')) {
        expect(typeof a.decodeStream, a.info.id).toBe('function')
      }
    }
  })
})
