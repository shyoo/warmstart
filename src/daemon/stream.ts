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
 * | usage | in the stream on 2.1.251, but ⛔ **metered from the transcript** — see below | **in the stream** | **in the stream** |
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

import type { QuotaWindow, SessionStreamLine } from '@shared/protocol.js'

export interface RateLimitInfo {
  /** `allowed`, `allowed_warning` or `rejected` on Claude Code 2.1.223. Open: a vendor may add one. */
  status: string
  resetsAt: number | null
  rateLimitType: string
  overageStatus?: string
  isUsingOverage?: boolean
  /** When the overage allowance itself refills, where the vendor says. */
  overageResetsAt?: number | null
  /**
   * Every window this record described, with how full each one is **now**.
   *
   * ⭐ **A free live quota reading, and it was being thrown away.** Measured 2026-09-13 on claude
   * 2.1.270: `rate_limit_info.unifiedWindows` carries `{five_hour: {utilization, resetsAt},
   * seven_day: {…}}` on every `rate_limit_event` — which rides a turn already being paid for. Until
   * this field existed the only numbers the fleet had came from `.claude.json`, a cache the vendor
   * refreshes on its own schedule and which has been measured 19 days stale.
   *
   * ⚠️ Absent on adapters and versions that say nothing, which is not the same as *empty*: a caller
   * must leave the existing reading alone rather than publishing a snapshot with no windows in it.
   */
  windows?: QuotaWindow[]
}

/**
 * Tokens a turn actually spent, as the CLI reports them.
 *
 * ⚠️ Only emitted by adapters that put usage in the stream. Claude Code's stream **does** carry it
 * — measured 2026-08-30 on 2.1.251, a full `usage` block with `iterations` on the `result` record,
 * correcting the 2026-08-25 reading on 2.1.223 — and this adapter still deliberately does not decode
 * it. Its numbers come from the transcript, which is exact and includes the compaction sampling
 * iteration (cost-model.md §6); decoding both would double-count the turn, because `index.ts` credits
 * every final `usage` event it is given. Where both exist, the transcript wins. This is the fallback
 * for CLIs that have no transcript agentyard can read.
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
  /**
   * Assistant prose as it arrives, so a chat reply can be shown before the turn ends.
   *
   * ⚠️ `streamed` means the same words already reached watchers as `assistant_delta` events. The
   * peephole still wants this one — it is framed and deduplicated where the deltas are neither —
   * and the session view must not print it a second time.
   */
  | { kind: 'assistant_text'; text: string; streamed?: boolean }
  /**
   * A fragment of the prose now being written, on an adapter asked for partial output.
   *
   * ⛔ **The live view only.** It carries however many characters happened to arrive together, mid
   * word as often as not, and reassembling those is exactly what t284 got wrong in both directions.
   * The peephole is fed by the framed `assistant_text` that follows; this is the typing.
   */
  | { kind: 'assistant_delta'; text: string }
  /**
   * A tool call, summarised by the adapter that knows its vendor's argument shapes.
   *
   * ⛔ **The reason Claude Code looked mute and Antigravity did not.** Measured on a real 1,679-record
   * session (2026-09-13): 1,310 of its assistant records carried **no text block at all** — 814 were
   * tool calls and 496 were thinking — and `textBlocks` drops every one of them, so 78% of what the
   * agent did reached neither the peephole nor the pane. Antigravity had synthesised these lines
   * since M5; this is the same thing, declared as an event instead of smuggled through prose.
   *
   * ⚠️ `summary` is one line and is what the peephole shows; `detail` is the long form and may be a
   * whole command. Both are agent output: text, never markup, never read back for state.
   */
  | { kind: 'tool_use'; name: string; summary: string; detail?: string | null }
  /**
   * The model is thinking, and this is how much of it there has been.
   *
   * ⛔ **The count, never the words, and that is the vendor's choice rather than a simplification
   * here.** Measured 2026-09-13 on claude 2.1.270: a `thinking` content block in the stream carries
   * `thinking: ""` and a signature, and with `--include-partial-messages` the `thinking_delta`
   * carries `thinking: ""` too. The transcript agrees — 490 of 496 thinking blocks in a real session
   * were empty. So a thinking bubble on this vendor is a phase and an estimate, and anything that
   * claims to show the reasoning itself is showing something else.
   *
   * `start` marks the first record of a phase, which is the one worth a row in a bounded tail.
   */
  | { kind: 'thinking'; tokens: number; start: boolean }
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
      // ⚠️ Already on the screen a character at a time. Printing the framed copy as well is how a
      // streamed turn ends up saying everything twice.
      return event.streamed ? '' : event.text.replace(/\n/g, eol)
    case 'assistant_delta':
      return event.text.replace(/\n/g, eol)
    case 'tool_use':
      return dim(`· ${event.summary}`) + eol
    // ⚠️ One row per phase, not one per record: the estimate ticks several times a turn and a
    // terminal cannot revise a line it has already written.
    case 'thinking':
      return event.start ? dim('· thinking…') + eol : ''
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
 * The same event as a record the session pane can lay out, or `null` where it has nothing to show.
 *
 * ⛔ **Beside `renderForHuman`, not instead of it.** The rendered form still feeds `scrollback`,
 * which `turnend.ts` reads for adapters that have no MCP tools to report with, so removing it would
 * take a completion signal with it. This is the *second tier*: the same events, shaped for a view
 * that can collapse a row rather than for a terminal that can only append to one.
 *
 * ⚠️ `usage` is deliberately absent. A context size is a fact about the session and is already on the
 * session detail with its basis; repeating it once per turn in a reading pane is noise.
 */
export function describeStream(event: StreamEvent): Omit<SessionStreamLine, 'seq' | 'ts'> | null {
  switch (event.kind) {
    case 'assistant_text':
      return event.streamed || !event.text.trim() ? null : { kind: 'text', text: event.text }
    // ⛔ The typing is carried by `session.data` into the terminal rung, never as its own record
    // here: a structured view that appended a row per fragment would draw one word per line, which
    // is the t272 failure with a different renderer.
    case 'assistant_delta':
      return null
    case 'tool_use':
      return { kind: 'tool', text: event.summary, detail: event.detail ?? null, tone: 'dim' }
    case 'thinking':
      return { kind: 'thinking', text: 'Thinking', tone: 'dim', thinkingTokens: event.tokens }
    case 'init':
      return {
        kind: 'note',
        text: `${event.model ?? 'model unknown'} · ${event.permissionMode ?? 'mode unknown'}`,
        tone: 'dim'
      }
    case 'rate_limit': {
      const windows = (event.info.windows ?? [])
        .map((w) => `${w.label} ${Math.round(w.percent)}%`)
        .join(' · ')
      const resets = event.info.resetsAt
        ? `resets ${new Date(event.info.resetsAt).toISOString()}`
        : null
      return {
        kind: 'rate_limit',
        text: `Rate limit: ${event.info.status}`,
        detail: [windows, event.info.rateLimitType, resets].filter(Boolean).join(' · ') || null,
        // ⚠️ A caution is not a refusal, and the pane says which. `allowed` is bookkeeping.
        tone: event.info.status === 'allowed' ? 'dim' : 'warn'
      }
    }
    case 'result':
      return {
        kind: 'result',
        text: event.isError ? 'Turn failed' : 'Turn finished',
        detail: event.terminalReason ?? event.text ?? null,
        tone: event.isError ? 'error' : 'dim'
      }
    case 'turn_status':
      return event.category === 'blocked'
        ? { kind: 'note', text: 'Waiting on you', detail: event.needsAction, tone: 'warn' }
        : null
    case 'usage':
    case 'other':
      return null
  }
}

/**
 * A tool call as one line, in the vocabulary `activity.proseOf` already knows how to skip.
 *
 * ⛔ **The bracketed prefixes are load-bearing, not decoration.** The peephole stores these beside
 * the agent's prose, and `closingProse` hands *the prose* to a debate seat's thread and to the
 * completion fallbacks; a tool line that does not look like one is quoted back as though the agent
 * had said it. `antigravity-cli` has written `[run: …]` / `[Tool: …]` since M5 and the filter list
 * is built from those, so anything new spells itself the same way.
 */
export function toolLine(label: string, detail?: string | null): string {
  const trimmed = (detail ?? '').replace(/\s+/g, ' ').trim()
  return trimmed ? `[${label}: ${trimmed}]` : `[${label}]`
}

/**
 * How one CLI's records become agentyard's events. Implemented by each adapter.
 *
 * May return several: one record can mean two things. Antigravity's terminal `result` carries both
 * the response text *and* the turn's usage, and a decoder that had to pick one would silently lose
 * the other.
 *
 * ⚠️ `ctx` is what the *session* asked for, never what the adapter is. It exists because
 * `--include-partial-messages` changes what a record means: with it on, a whole `assistant` record
 * is a repeat of deltas already sent, and only the caller that passed the flag knows that. An
 * adapter that does not care declares one parameter and is assignable unchanged.
 */
export interface DecodeContext {
  /** The session was spawned asking for partial output, and the adapter declared it could. */
  partialMessages: boolean
}

export type StreamDecoder = (
  record: Record<string, unknown>,
  ctx?: DecodeContext
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

  constructor(
    private readonly decode: StreamDecoder,
    private readonly ctx: DecodeContext = { partialMessages: false }
  ) {}

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
      const decoded = this.decode(record, this.ctx)
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
 * Lives in `@shared/ansi` since 2026-09-11, because the renderer needs the same strip for the
 * thread messages written before the daemon cleaned them. Re-exported here so every daemon caller
 * keeps its import; the rule and the measurements are on the shared copy.
 */
export { stripAnsi } from '@shared/ansi.js'

// ---------------------------------------------------------------------------- shared helpers

export function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * The tool calls in an Anthropic-shaped message, in the order they were written.
 *
 * ⛔ **The 78% `textBlocks` throws away.** See `StreamEvent.tool_use` for the measurement. Returns
 * the raw name and input so the *adapter* decides how to say it — a tool's arguments are a vendor's
 * shape, and this module has no business knowing that Claude's shell tool keys its command on
 * `command` while Antigravity's keys it on `CommandLine`.
 */
export function toolBlocks(message: unknown): Array<{ name: string; input: Record<string, unknown> }> {
  const record = asRecord(message)
  const content = record?.content
  if (!Array.isArray(content)) return []
  const out: Array<{ name: string; input: Record<string, unknown> }> = []
  for (const raw of content) {
    const block = asRecord(raw)
    if (!block || block.type !== 'tool_use') continue
    const name = typeof block.name === 'string' ? block.name : ''
    if (!name) continue
    out.push({ name, input: asRecord(block.input) ?? {} })
  }
  return out
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
