import { describe, expect, it } from 'vitest'
import { StreamParser, describeStream, renderForHuman, type StreamEvent } from './stream.js'
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

const rateLimitNoWindows =
  '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1787684400,' +
  '"rateLimitType":"five_hour"}}'

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

  /**
   * ⛔ **The record that made Claude Code look mute.** This used to assert `other` — nothing
   * forwarded, nothing shown — and the reasoning was right about half the question: an empty
   * `assistant_text` would make a chat pane look like the model answered with nothing. What it
   * missed is that a tool call is not the absence of an answer, it is the answer.
   *
   * ⭐ Measured 2026-09-13 on a real 1,679-record session in this repository: 814 assistant records
   * carried a tool call and 1,310 carried no prose at all, so 78% of the agent's working day was
   * decoded into `other` and dropped. The pane and the peephole both sat blank for minutes at a time
   * while the agent read files and ran the suite.
   */
  it('reports a tool call as a tool call, never as empty prose', () => {
    const [event, ...rest] = parse('claude-code', [
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash",' +
        '"input":{"command":"npm test","description":"Run the suite"}}]}}'
    ])
    expect(rest).toHaveLength(0)
    expect(event).toMatchObject({
      kind: 'tool_use',
      name: 'Bash',
      summary: '[run: npm test]',
      detail: 'npm test'
    })
  })

  it('carries prose and the tool calls beside it, in the order they were written', () => {
    const events = parse('claude-code', [
      '{"type":"assistant","message":{"content":[' +
        '{"type":"thinking","thinking":"","signature":"x"},' +
        '{"type":"text","text":"Let me look at the decoder."},' +
        '{"type":"tool_use","name":"Read","input":{"file_path":"src/daemon/stream.ts"}}]}}'
    ])
    expect(events.map((e) => e.kind)).toEqual(['assistant_text', 'tool_use'])
    expect(events[1]).toMatchObject({ summary: '[Tool: Read src/daemon/stream.ts]' })
  })

  /**
   * ⛔ **The thinking words do not exist, and this pins that rather than hoping.** Measured
   * 2026-09-13 on claude 2.1.270: a `thinking` block in the stream carries `thinking: ""` and a
   * signature, with `--include-partial-messages` and without it, and the transcript agrees (490 of
   * 496 thinking blocks in a real session were empty). So a `thinking` content block is worth no
   * event at all — what says a phase happened is the `system/thinking_tokens` record below.
   */
  it('emits nothing for a thinking block, because the vendor sends no words in one', () => {
    const [event] = parse('claude-code', [
      '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"","signature":"s"}]}}'
    ])
    expect(event?.kind).toBe('other')
  })

  it('reads a thinking phase off the record that carries its estimate', () => {
    const events = parse('claude-code', [
      '{"type":"system","subtype":"thinking_tokens","estimated_tokens":50,"estimated_tokens_delta":50}',
      '{"type":"system","subtype":"thinking_tokens","estimated_tokens":147,"estimated_tokens_delta":97}'
    ])
    // ⚠️ `start` is the first record of a phase — tokens equal to the delta — and it is the only one
    // the peephole pushes a row for. See index.ts.
    expect(events).toEqual([
      { kind: 'thinking', tokens: 50, start: true },
      { kind: 'thinking', tokens: 147, start: false }
    ])
  })

  it('reads prose deltas only where the caller asked for partial output', () => {
    const line =
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0,' +
      '"delta":{"type":"text_delta","text":"Remov"}}}'
    expect(parse('claude-code', [line])).toEqual([{ kind: 'assistant_delta', text: 'Remov' }])
  })

  /**
   * ⛔ The framed copy is still what the peephole reads — it is the only one that is framed — so it
   * is marked rather than suppressed. `renderForHuman` and `describeStream` both drop a `streamed`
   * message, because those words are already on the screen a character at a time.
   */
  it('marks a whole message as already streamed when partial output is on', () => {
    const record = { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }
    const decode = adapter('claude-code').decodeStream
    expect(decode?.(record, { partialMessages: true })).toMatchObject({ streamed: true })
    expect(decode?.(record, { partialMessages: false })).not.toHaveProperty('streamed')
  })

  it('does not claim usage: this adapter is metered from its transcript', () => {
    const events = parse('claude-code', [rateLimit, '{"type":"result","result":"x"}'])
    expect(events.some((e) => e.kind === 'usage')).toBe(false)
  })

  /**
   * ⛔ Verbatim from the R14 capture, 2026-08-30, claude-code 2.1.251. The agent asked a
   * multiple-choice question, nobody answered, and it stopped — and the two records below are what
   * came out. Read them together: only the first says anything happened that needs a person.
   */
  const POST_TURN_BLOCKED =
    '{"type":"system","subtype":"post_turn_summary","summarizes_uuid":"ee873804",' +
    '"status_category":"blocked",' +
    '"status_detail":"let me know which approach you\'d like (OAuth, server-side session cookies, ' +
    'or magic-link email) whenever you\'re ready.",' +
    '"needs_action":"let me know which approach you\'d like (OAuth, server-side session cookies, ' +
    'or magic-link email) whenever you\'re ready.","uuid":"834bea03"}'
  const RESULT_OF_A_BLOCKED_TURN =
    '{"type":"result","subtype":"success","stop_reason":"end_turn","terminal_reason":"completed",' +
    '"is_error":false,"result":"I\'ll wait — let me know which approach you\'d like.",' +
    '"total_cost_usd":0.1967302}'

  it('decodes the record that says the agent stopped for a person', () => {
    const [event] = parse('claude-code', [POST_TURN_BLOCKED])
    expect(event).toMatchObject({ kind: 'turn_status', category: 'blocked' })
    expect(event?.kind === 'turn_status' && event.needsAction).toContain('which approach')
  })

  it('⛔ cannot tell a blocked turn from a finished one by its result alone', () => {
    // This is the whole reason `turn_status` exists. The terminal record of a turn that stopped to
    // ask a question is byte-for-byte the shape of one that finished the work: end_turn, completed,
    // not an error. Anything reading only this reports "done" or "ended without saying why".
    const [result] = parse('claude-code', [RESULT_OF_A_BLOCKED_TURN])
    expect(result).toMatchObject({ kind: 'result', isError: false, terminalReason: 'completed' })
  })

  it('takes the category as it comes and does not invent a taxonomy', () => {
    // ⚠️ `blocked` is the only value measured. A vendor may add others, and a decoder that mapped
    // the unknown onto a known one would be guessing about the thing this record exists to say.
    const [event] = parse('claude-code', [
      '{"type":"system","subtype":"post_turn_summary","status_category":"something_new"}'
    ])
    expect(event).toMatchObject({ kind: 'turn_status', category: 'something_new', needsAction: null })
  })

  it('encodes stream prompts with the `type` user envelope', () => {
    const encoded = adapter('claude-code').encodeStreamPrompt?.('hello world')
    expect(encoded).toBeDefined()
    const parsed = JSON.parse(encoded!) as {
      type: string
      message: { role: string; content: Array<{ type: string; text: string }> }
    }
    expect(parsed).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hello world' }] }
    })
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

  it('preserves agy terminal error text instead of reporting a silent ERROR', () => {
    const failed =
      '{"event":"result","result":{"conversation_id":"379cc136","status":"ERROR",' +
      '"error":"rebase stopped with a conflict in HANDOFF.md"}}'
    expect(parse('antigravity-cli', [failed]).find((e) => e.kind === 'result')).toMatchObject({
      isError: true,
      terminalReason: 'ERROR',
      text: 'rebase stopped with a conflict in HANDOFF.md'
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

  it('extracts both assistant text and usage when step_update carries both', () => {
    const mixed =
      '{"event":"step_update","step_update":{"conversation_id":"379cc136","step_index":1,"state":"DONE",' +
      '"step_type":"agent_response","text_delta":"working on it...","duration_seconds":1.2,' +
      '"usage":{"input_tokens":1000,"output_tokens":50,"thinking_tokens":10,"cache_read_tokens":0,"total_tokens":1050}}}'
    const events = parse('antigravity-cli', [mixed])
    expect(events.map((e) => e.kind).sort()).toEqual(['assistant_text', 'usage'])
    expect(events.find((e) => e.kind === 'assistant_text')).toMatchObject({ text: 'working on it...' })
    expect(events.find((e) => e.kind === 'usage')).toMatchObject({
      final: false,
      usage: { input: 1000, output: 50, thinking: 10, cacheRead: 0, cacheWrite: 0 }
    })
  })

  /**
   * ⚠️ The **wording is unchanged** and that is deliberate: these lines are what the peephole stores
   * and what `activity.proseOf` skips by prefix, so respelling them would start quoting tool calls
   * back onto threads as though the agent had written them. What changed is the envelope — a
   * declared `tool_use` event rather than prose in brackets — so a view can lay one out, and so
   * claude-code could join this vocabulary instead of inventing a second one.
   */
  it('reports a tool call as a tool call, keeping the wording the peephole filters on', () => {
    const toolCall =
      '{"event":"step_update","step_update":{"conversation_id":"379cc136","step_index":2,"state":"ACTIVE",' +
      '"step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"git status","toolAction":"Running command","toolSummary":"Command execution"}}}}'
    const events = parse('antigravity-cli', [toolCall])
    expect(events.find((e) => e.kind === 'tool_use')).toMatchObject({
      name: 'run_command',
      summary: '[Tool: Running command — Command execution]'
    })
    // ⛔ And not as prose. A tool announcement arriving as `assistant_text` is indistinguishable
    // downstream from the agent's own words.
    expect(events.some((e) => e.kind === 'assistant_text')).toBe(false)
  })

  it('formats command-line and target-file parameters when tool action is not set', () => {
    const runCall =
      '{"event":"step_update","step_update":{"conversation_id":"379cc136","step_index":2,"state":"ACTIVE",' +
      '"step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"npm test"}}}}'
    const [runEvent] = parse('antigravity-cli', [runCall])
    expect(runEvent).toMatchObject({ kind: 'tool_use', summary: '[run: npm test]' })

    const fileCall =
      '{"event":"step_update","step_update":{"conversation_id":"379cc136","step_index":3,"state":"ACTIVE",' +
      '"step_type":"tool","tool_name":"view_file","tool_info":{"name":"view_file","parameters":{"TargetFile":"src/index.ts"}}}}'
    const [fileEvent] = parse('antigravity-cli', [fileCall])
    expect(fileEvent).toMatchObject({ kind: 'tool_use', summary: '[view_file: src/index.ts]' })
  })

  it('extracts result text from various result formats and trims whitespace', () => {
    const withSummary =
      '{"event":"result","result":{"conversation_id":"379cc136","status":"SUCCESS","summary":"All tests passed.\\n"}}'
    const [event1] = parse('antigravity-cli', [withSummary])
    expect(event1).toMatchObject({ kind: 'result', text: 'All tests passed.\n', isError: false })

    const withDirectResponse =
      '{"event":"result","status":"SUCCESS","response":"Refactored the parser."}'
    const [event2] = parse('antigravity-cli', [withDirectResponse])
    expect(event2).toMatchObject({ kind: 'result', text: 'Refactored the parser.', isError: false })
  })

  it('encodes stream prompts with the `event` user envelope', () => {
    // ⛔ agy Go CLI expects {"event":"user","message":{...}}. Sending {"type":"user",...} causes
    // immediate exit with error: 'stream input message is missing the "event" field'.
    const encoded = adapter('antigravity-cli').encodeStreamPrompt?.('hello world')
    expect(encoded).toBeDefined()
    const parsed = JSON.parse(encoded!) as {
      event: string
      message: { role: string; content: Array<{ type: string; text: string }> }
    }
    expect(parsed).toEqual({
      event: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hello world' }] }
    })
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

  it('decodes error messages from turn.failed into result text', () => {
    expect(
      parse('openai-compatible', ['{"type":"turn.failed","error":{"message":"backend-api error"}}']).find(
        (e) => e.kind === 'result'
      )
    ).toMatchObject({ isError: true, terminalReason: 'turn.failed', text: 'backend-api error' })
  })

  it('decodes error item in item.completed into assistant_text', () => {
    expect(
      parse('openai-compatible', ['{"type":"item.completed","item":{"type":"error","message":"rate limited"}}']).find(
        (e) => e.kind === 'assistant_text'
      )
    ).toMatchObject({ kind: 'assistant_text', text: 'rate limited' })
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

  it('adapters with custom prompt encoding produce valid parseable envelopes', () => {
    for (const id of ['claude-code', 'antigravity-cli']) {
      const ad = adapter(id)
      const encoded = ad.encodeStreamPrompt?.('sample prompt')
      expect(encoded, id).toBeTruthy()
      expect(() => {
        JSON.parse(encoded!)
      }, id).not.toThrow()
    }
  })
})

/**
 * What a person sees when the session has no TUI.
 *
 * ⛔ The pane used to receive `stream-json` verbatim, so the first task anyone dispatched printed
 * raw JSON at them. These check the two halves of the fix: prose reaches the screen, and protocol
 * does not.
 */
describe('renderForHuman', () => {
  it('shows assistant prose as prose', () => {
    const out = renderForHuman({ kind: 'assistant_text', text: 'Removed the menu bar.' })
    expect(out).toContain('Removed the menu bar.')
    expect(out).not.toContain('{')
  })

  it('leads a finished turn with the context size, not the cumulative counters', () => {
    // ⭐ Cumulative cache reads are what the cost model bills from; the number a person steering a
    // session needs is how full the window is right now. Real values from the 2026-08-26 run.
    const out = renderForHuman({
      kind: 'usage',
      final: true,
      usage: { input: 2, output: 83, thinking: 0, cacheRead: 62_127, cacheWrite: 148 }
    })
    expect(out.indexOf('context')).toBeLessThan(out.indexOf('cache read'))
    expect(out).toContain((2 + 62_127 + 148).toLocaleString())
  })

  it('says nothing at all for a turn still in progress', () => {
    expect(
      renderForHuman({
        kind: 'usage',
        final: false,
        usage: { input: 2, output: 10, thinking: 0, cacheRead: 5, cacheWrite: 0 }
      })
    ).toBe('')
  })

  it('never puts protocol on the screen', () => {
    expect(renderForHuman({ kind: 'other', type: 'tool_use' })).toBe('')
  })

  it('renders a rate-limit warning as a sentence', () => {
    const out = renderForHuman({
      kind: 'rate_limit',
      info: { status: 'allowed_warning', resetsAt: null, rateLimitType: 'five_hour' }
    })
    expect(out).toContain('allowed_warning')
  })

  it('tells a watching person the agent is waiting on them', () => {
    const out = renderForHuman({
      kind: 'turn_status',
      category: 'blocked',
      detail: null,
      needsAction: 'let me know which approach you want'
    })
    expect(out).toContain('waiting on you')
    expect(out).toContain('which approach')
  })

  it('says nothing for a turn status that is not about a person', () => {
    expect(
      renderForHuman({ kind: 'turn_status', category: 'in_progress', detail: 'x', needsAction: null })
    ).toBe('')
  })

  it('ends a turn with a verdict a person can act on', () => {
    const out = renderForHuman({
      kind: 'result',
      text: 'Done.',
      costUsd: null,
      isError: true,
      terminalReason: 'max turns'
    })
    expect(out).toContain('failed')
    expect(out).toContain('max turns')
  })
})

/**
 * The second tier: the same events, shaped for a view that can lay one out.
 *
 * ⛔ **Not a replacement for `renderForHuman`.** The rendered form still feeds `scrollback`, which
 * `turnend.ts` reads to find a completion an MCP-less adapter could not report, so removing it would
 * quietly take a completion signal with it. These two run side by side and answer different
 * questions: what should a terminal print, and what should a pane draw.
 */
describe('describeStream', () => {
  it('gives a tool call its own kind and keeps the long form for the disclosure', () => {
    expect(
      describeStream({
        kind: 'tool_use',
        name: 'Bash',
        summary: '[run: npm test]',
        detail: 'npm test -- --reporter=verbose'
      })
    ).toEqual({
      kind: 'tool',
      text: '[run: npm test]',
      detail: 'npm test -- --reporter=verbose',
      tone: 'dim'
    })
  })

  /**
   * ⚠️ The number is the content. Claude Code publishes an estimate and no words (measured
   * 2026-09-13 on 2.1.270, and again in a real session's transcript: 490 of 496 thinking blocks
   * empty), so a row that claimed to show reasoning would be showing something else.
   */
  it('carries a thinking phase as an estimate, never as words', () => {
    const line = describeStream({ kind: 'thinking', tokens: 1470, start: true })
    expect(line).toMatchObject({ kind: 'thinking', thinkingTokens: 1470 })
    expect(line?.text).toBe('Thinking')
  })

  it('puts the live window readings on the rate-limit row and marks a caution', () => {
    const line = describeStream({
      kind: 'rate_limit',
      info: {
        status: 'allowed_warning',
        resetsAt: null,
        rateLimitType: 'five_hour',
        windows: [{ id: 'session', label: 'Claude 5h', percent: 91, resetsAt: null }]
      }
    })
    expect(line).toMatchObject({ kind: 'rate_limit', tone: 'warn' })
    expect(line?.detail).toContain('Claude 5h 91%')
  })

  it('leaves an `allowed` rate limit dim, because a reading is not a caution', () => {
    const line = describeStream({
      kind: 'rate_limit',
      info: { status: 'allowed', resetsAt: null, rateLimitType: 'five_hour' }
    })
    expect(line?.tone).toBe('dim')
  })

  /**
   * ⛔ The typing goes to the terminal rung and nowhere else. A structured view that appended a row
   * per fragment would draw one word per line, which is the t272 failure with a different renderer.
   */
  it('draws no row for a fragment, and none for a message already drawn as fragments', () => {
    expect(describeStream({ kind: 'assistant_delta', text: 'Remov' })).toBeNull()
    expect(describeStream({ kind: 'assistant_text', text: 'Removed it.', streamed: true })).toBeNull()
    expect(describeStream({ kind: 'assistant_text', text: 'Removed it.' })).toMatchObject({
      kind: 'text'
    })
  })

  it('says nothing about usage, which is a fact about the session rather than a line of it', () => {
    expect(
      describeStream({
        kind: 'usage',
        final: true,
        usage: { input: 1, output: 1, thinking: 0, cacheRead: 0, cacheWrite: 0 }
      })
    ).toBeNull()
    expect(describeStream({ kind: 'other', type: 'stream_event' })).toBeNull()
  })
})

/**
 * ⭐ The free live quota reading, which was decoded and dropped until t423.
 *
 * ⛔ The window **ids** are the load-bearing part, not the numbers: every gate downstream keys on
 * them, so a live reading that called the five-hour pool something the config cache does not would
 * read as a different window at the same percentage. See `UNIFIED_WINDOWS` in claude-code.ts.
 */
describe('claude-code unifiedWindows', () => {
  const withWindows =
    '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1789342200,' +
    '"rateLimitType":"five_hour","overageStatus":"allowed","overageResetsAt":1790812800,' +
    '"isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.12,"resetsAt":1789342200},' +
    '"seven_day":{"utilization":0.43,"resetsAt":1789606800}}}}'

  it('reads a utilization fraction as a percentage, under the ids the cache already uses', () => {
    const [event] = parse('claude-code', [withWindows])
    expect(event).toMatchObject({
      kind: 'rate_limit',
      info: {
        overageResetsAt: 1790812800000,
        windows: [
          { id: 'session', label: 'Claude 5h', percent: 12, resetsAt: 1789342200000 },
          { id: 'weekly_all', label: 'Claude 7d', percent: 43, resetsAt: 1789606800000 }
        ]
      }
    })
  })

  /**
   * ⚠️ A key nobody has mapped is skipped rather than guessed at, and `publishStreamWindows` then
   * declines the whole reading rather than losing the window it could not name. Conservative is the
   * cheap direction: the account keeps the cadence it already had.
   */
  it('skips a window it has no id for rather than inventing one', () => {
    const [event] = parse('claude-code', [
      '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":null,' +
        '"rateLimitType":"five_hour","unifiedWindows":{"lunar_month":{"utilization":0.5}}}}'
    ])
    expect(event).toMatchObject({ kind: 'rate_limit' })
    expect((event as { info: { windows?: unknown } }).info.windows).toBeUndefined()
  })

  it('leaves an older record that carries no windows alone', () => {
    const [event] = parse('claude-code', [rateLimitNoWindows])
    expect((event as { info: { windows?: unknown } }).info.windows).toBeUndefined()
  })
})
