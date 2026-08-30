/**
 * Reading a `stream` transport's output.
 *
 * ⛔ **There is no such thing as "the stream-json format".** Measured 2026-08-25 against all three
 * CLIs, and they agree on almost nothing:
 *
 * | | Claude Code | Antigravity | Codex |
 * |---|---|---|---|
 * | envelope key | `type` | **`event`** | `type` |
 * | terminal record | `result` | `result` (nested under the key) | `turn.completed` |
 * | assistant text | `assistant` → `content[]` blocks | `step_update` | `item.completed` → `item.text` |
 * | usage | ⛔ not in the stream — from the transcript | **in the stream** | **in the stream** |
 * | rate limit | `rate_limit_event` | none seen | none seen |
 *
 * A parser keyed on `record.type` — which this was until M5 measured `agy` — reads **nothing** from
 * Antigravity, silently. Not an error, not a warning: an empty event list for every line.
 *
 * So framing is generic and **decoding belongs to the adapter**, beside `transcriptPath` and
 * `probeQuota` and every other place a vendor's quirks are allowed to live. The scheduler still never
 * asks which adapter it is looking at; it asks for events and gets events.
 *
 * ⛔ This is still not terminal parsing. These are each CLI's own machine-readable records on its own
 * declared protocol; nothing here reads a rendered screen.
 */

export interface RateLimitInfo {
  /** `allowed`, `allowed_warning` or `rejected` on Claude Code 2.1.223. Open: a vendor may add one. */
  status: string
  resetsAt: number | null
  rateLimitType: string
  overageStatus?: string
  isUsingOverage?: boolean
}

/**
 * Tokens a turn actually spent, as the CLI reports them.
 *
 * ⚠️ Only emitted by adapters that put usage in the stream. Claude Code does not: its numbers come
 * from the transcript, which is exact and includes the compaction sampling iteration the stream would
 * miss (cost-model.md §6). Where both exist, the transcript wins — this is the fallback for CLIs that
 * have no transcript agentyard can read.
 */
export interface StreamUsage {
  input: number
  output: number
  thinking: number
  cacheRead: number
  cacheWrite: number
}

export type StreamEvent =
  | { kind: 'rate_limit'; info: RateLimitInfo }
  | {
      kind: 'result'
      /** The final text of the turn. What a consult's answer is read out of. */
      text: string | null
      costUsd: number | null
      isError: boolean
      terminalReason: string | null
    }
  /** Assistant prose as it arrives, so a chat reply can be shown before the turn ends. */
  | { kind: 'assistant_text'; text: string }
  /** ⚠️ Cumulative for the turn, not a delta. Callers must replace rather than add. */
  | { kind: 'usage'; usage: StreamUsage; final: boolean }
  /**
   * The CLI's own account of **why** a turn ended, which the terminal record cannot give.
   *
   * ⛔ Measured 2026-08-30 on claude-code 2.1.251 (R14.c): an agent that asked a question and stopped
   * emits `post_turn_summary` with `status_category: "blocked"` and a `needs_action` sentence — while
   * its `result` reads `stop_reason: "end_turn"`, `terminal_reason: "completed"`, `is_error: false`,
   * i.e. **identical to a finished task**. Without this record, "the agent is waiting on you" and
   * "the agent is done" are the same bytes, and the operator gets `awaiting_human` with no reason.
   *
   * ⚠️ `category` is an open string. `blocked` is the only value measured; a vendor may add others,
   * and nothing may assume that not-blocked means anything at all.
   */
  | { kind: 'turn_status'; category: string; detail: string | null; needsAction: string | null }
  | { kind: 'init'; sessionId: string | null; model: string | null; permissionMode: string | null }
  | { kind: 'other'; type: string }

/**
 * One stream event, as a line a person can read.
 *
 * ⛔ A `stream` session has no TUI. Its stdout is `stream-json`, and the session pane used to
 * receive those bytes verbatim — so the first task anyone dispatched filled the terminal with raw
 * JSON. That is the machine's copy of the conversation being shown to a human, which is the inverse
 * of the rule the whole design runs on: the TUI is for people, the structured record is for the
 * scheduler.
 *
 * ⚠️ Nothing here parses screen text back into state. This is one-way — events that already exist
 * because the scheduler needed them, rendered on the way past. Returns '' for anything with nothing
 * to say, and the caller writes nothing at all in that case.
 */
export function renderForHuman(event: StreamEvent): string {
  const dim = (s: string) => `[2m${s}[0m`
  const eol = '\r\n'

  switch (event.kind) {
    case 'assistant_text':
      return event.text.replace(/\n/g, eol)
    case 'init':
      return dim(`— ${event.model ?? 'model unknown'} · ${event.permissionMode ?? 'mode unknown'}`) + eol
    case 'usage': {
      if (!event.final) return ''
      const u = event.usage
      // ⭐ Context first. The cumulative counters are what the cost model bills from, but the number
      // a person steering a session needs is how full the window is right now.
      const context = u.input + u.cacheRead + u.cacheWrite
      return (
        dim(
          `— context ${context.toLocaleString()} · out ${u.output.toLocaleString()} · ` +
            `cache read ${u.cacheRead.toLocaleString()}`
        ) + eol
      )
    }
    case 'rate_limit': {
      const resets = event.info.resetsAt
        ? ` · resets ${new Date(event.info.resetsAt).toLocaleTimeString()}`
        : ''
      return dim(`— rate limit: ${event.info.status}${resets}`) + eol
    }
    case 'result':
      return (
        (event.text ? event.text.replace(/\n/g, eol) + eol : '') +
        dim(`— ${event.isError ? 'failed' : 'done'}${event.terminalReason ? `: ${event.terminalReason}` : ''}`) +
        eol
      )
    // ⚠️ Only when it says the turn stopped for a person. Every other category is bookkeeping the
    // scheduler wants and a reader watching the pane does not.
    case 'turn_status':
      return event.category === 'blocked'
        ? dim(`— waiting on you${event.needsAction ? `: ${event.needsAction}` : ''}`) + eol
        : ''
    // ⛔ Everything else is protocol. It goes to the scheduler and not to the screen.
    case 'other':
      return ''
  }
}

/**
 * How one CLI's records become agentyard's events. Implemented by each adapter.
 *
 * May return several: one record can mean two things. Antigravity's terminal `result` carries both
 * the response text *and* the turn's usage, and a decoder that had to pick one would silently lose
 * the other.
 */
export type StreamDecoder = (
  record: Record<string, unknown>
) => StreamEvent | StreamEvent[] | null

/**
 * Bytes arrive in arbitrary chunks; a record is only real once its newline has.
 *
 * ⚠️ Every CLI also writes human-readable diagnostics to the same pipe — measured: `codex exec`
 * opens with `Reading additional input from stdin...`, and `agy` prints a plain-English explanation
 * when a tool is auto-denied. Lines that are not JSON objects are skipped rather than logged as
 * errors, because they are normal.
 */
export class StreamParser {
  private buffer = ''

  constructor(private readonly decode: StreamDecoder) {}

  push(chunk: string): StreamEvent[] {
    this.buffer += chunk
    const events: StreamEvent[] = []
    let newline = this.buffer.indexOf('\n')

    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      newline = this.buffer.indexOf('\n')
      if (!line.startsWith('{')) continue
      let record: Record<string, unknown>
      try {
        record = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      const decoded = this.decode(record)
      if (Array.isArray(decoded)) events.push(...decoded)
      else if (decoded) events.push(decoded)
    }

    // A pathological line with no newline must not grow without bound.
    if (this.buffer.length > 4 * 1024 * 1024) this.buffer = ''
    return events
  }
}

/**
 * Strip terminal control sequences out of text that is about to be shown as *prose*.
 *
 * ⛔ Not a retreat from the rule. AGENTS.md forbids parsing ANSI to determine **state**, and nothing
 * here reads anything: this only removes bytes that mean "make the next word dim" from a string a
 * person is going to read in a table cell. A CLI's last words are the most useful thing a failed
 * dispatch can carry, and they arrive with the colour codes still in them.
 *
 * ⚠️ Measured 2026-08-27: a benched worker's reason rendered as
 * `the agent exited after 3s… It said: ←[2m— claude-sonnet-5 · auto←[0m Your organization has…`,
 * which reads as corruption and buries the one sentence that mattered.
 */
// eslint-disable-next-line no-control-regex
const ANSI = /[\u001B\u009B][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PR-TZcf-ntqry=><~]/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '')
}

// ---------------------------------------------------------------------------- shared helpers

export function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** Concatenate the text blocks of a message, ignoring tool_use and thinking blocks. */
export function textBlocks(message: unknown): string {
  const record = asRecord(message)
  if (!record) return ''
  const content = record.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(
      (block): block is { type: string; text: string } =>
        !!block &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string'
    )
    .map((block) => block.text)
    .join('')
}
