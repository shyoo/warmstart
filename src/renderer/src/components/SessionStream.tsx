import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { SessionStreamLine } from '@shared/protocol'
import { rpc, useDaemonEvents } from '../lib/daemon'
import { mergeStreamLines } from '../lib/streamview'

/**
 * What a dispatched agent is doing, drawn from the records it publishes.
 *
 * ⛔ **Not a terminal, and it says so on screen.** A `stream` session has no TTY to mirror: work runs
 * on pipes because `--print` refuses to start under one. So the honest thing is not a fake screen but
 * the structured events themselves — a tool call as a tool call, a thinking phase as a phase, the
 * vendor's own rate-limit caution as its own row. `TerminalPane` still draws the *real* thing wherever
 * a real one exists, which is a PTY session and the terminal this pane can open beside it.
 *
 * ⛔ Every string here is agent output. It is rendered as text, in elements this codebase writes;
 * there is no markdown pass and no `dangerouslySetInnerHTML` (docs/ui.md).
 */
export function SessionStream({
  sessionId,
  live
}: {
  sessionId: string
  live: boolean
}): React.JSX.Element {
  const [lines, setLines] = useState<SessionStreamLine[]>([])
  const [open, setOpen] = useState<Set<number>>(new Set())
  const [backfillFailed, setBackfillFailed] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const pinnedRef = useRef(true)

  useEffect(() => {
    let current = true
    setLines([])
    setOpen(new Set())
    setBackfillFailed(false)
    // ⚠️ Tolerated rather than surfaced as an error: a desktop driving a remote that predates this
    // method reaches a daemon with no `session.streamlog`, and the live feed below still works. A
    // missing backfill is a shorter history, not a broken pane.
    void rpc('session.streamlog', { id: sessionId })
      .then(({ lines: got }) => {
        if (current) setLines(got)
      })
      .catch(() => {
        if (current) setBackfillFailed(true)
      })
    return () => {
      current = false
    }
  }, [sessionId])

  useDaemonEvents((event) => {
    if (event.type !== 'session.stream' || event.sessionId !== sessionId) return
    setLines((prev) => mergeStreamLines(prev, event.line))
  })

  // ⛔ Only while the reader is already at the bottom. A pane that scrolled on every line would drag
  // somebody reading a tool call twenty rows up back down to the newest one, every few seconds.
  useLayoutEffect(() => {
    const host = scrollRef.current
    if (host && pinnedRef.current) host.scrollTop = host.scrollHeight
  }, [lines])

  const onScroll = (): void => {
    const host = scrollRef.current
    if (!host) return
    pinnedRef.current = host.scrollHeight - host.scrollTop - host.clientHeight < 32
  }

  const toggle = (seq: number): void =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(seq)) next.delete(seq)
      else next.add(seq)
      return next
    })

  return (
    <div className="sstream" ref={scrollRef} onScroll={onScroll}>
      {lines.length === 0 && (
        <p className="dim">
          {live
            ? 'Nothing said yet. The agent has been started and has not spoken.'
            : 'This session published nothing that is still held in memory.'}
        </p>
      )}
      {lines.map((line) => (
        <StreamRow
          key={line.seq}
          line={line}
          open={open.has(line.seq)}
          toggle={() => toggle(line.seq)}
        />
      ))}
      {live && <p className="sstream-live dim">watching…</p>}
      {backfillFailed && (
        <p className="dim">
          Only lines from the moment this pane opened: this daemon does not serve the earlier ones.
        </p>
      )}
    </div>
  )
}

/**
 * One row.
 *
 * ⚠️ A thinking row is the one that carries a number rather than words, and the number is an
 * **estimate the vendor publishes** — the reasoning text itself is not available on Claude Code at
 * all (see `StreamEvent.thinking`). Saying `Thinking · ~1.2k tokens` is the whole of what is known,
 * and writing anything more confident would be inventing it.
 */
function StreamRow({
  line,
  open,
  toggle
}: {
  line: SessionStreamLine
  open: boolean
  toggle: () => void
}): React.JSX.Element {
  const detail = line.detail?.trim() ? line.detail.trim() : null
  const tone = line.tone ?? 'normal'
  const body = (
    <>
      <span className="sstream-mark" aria-hidden="true">
        {MARKS[line.kind]}
      </span>
      <span className="sstream-text">
        {line.text}
        {line.kind === 'thinking' && typeof line.thinkingTokens === 'number' && line.thinkingTokens > 0 && (
          <span className="sstream-count"> · ~{compact(line.thinkingTokens)} tokens</span>
        )}
      </span>
    </>
  )

  if (!detail) {
    return <div className={`sstream-row sstream-row--${line.kind} sstream-row--${tone}`}>{body}</div>
  }
  return (
    <div className={`sstream-row sstream-row--${line.kind} sstream-row--${tone}`}>
      <button className="sstream-open" onClick={toggle} aria-expanded={open}>
        {body}
      </button>
      {open && <pre className="sstream-detail">{detail}</pre>}
    </div>
  )
}

/** ⚠️ Decoration, and marked `aria-hidden`: the row's words are the content. */
const MARKS: Record<SessionStreamLine['kind'], string> = {
  text: '',
  thinking: '·',
  tool: '›',
  rate_limit: '!',
  result: '—',
  note: '—'
}

function compact(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}
