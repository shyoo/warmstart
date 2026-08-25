import { useEffect, useRef } from 'react'
import { Terminal as Xterm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { rpc, useDaemonEvents } from '../lib/daemon'

/**
 * The real agent TUI, not a reconstruction.
 *
 * ⛔ These bytes are for the human. Nothing reads them to decide anything - session state, usage and
 * context all come from the transcript. See AGENTS.md.
 *
 * `interactive` is the "take the keyboard" switch: read-only by default, because a stray keystroke
 * into a running agent is a real edit to somebody's repository.
 */
export function TerminalPane({
  sessionId,
  interactive
}: {
  sessionId: string
  interactive: boolean
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Xterm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const interactiveRef = useRef(interactive)
  interactiveRef.current = interactive

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const style = getComputedStyle(document.body)
    const term = new Xterm({
      fontFamily: style.getPropertyValue('--font-mono').trim() || 'monospace',
      fontSize: 12,
      lineHeight: 1.2,
      cursorBlink: interactiveRef.current,
      convertEol: false,
      scrollback: 5000,
      theme: {
        background: style.getPropertyValue('--color-bg').trim() || '#0e1013',
        foreground: style.getPropertyValue('--color-text').trim() || '#e6e8ec'
      }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    fit.fit()
    termRef.current = term
    fitRef.current = fit

    // Replay what the daemon buffered, so reopening the window does not look like lost history.
    void rpc('session.backscroll', { id: sessionId }).then(({ data }) => {
      if (data) term.write(data)
    })

    term.onData((data) => {
      if (interactiveRef.current) void rpc('session.write', { id: sessionId, data })
    })

    const resize = () => {
      try {
        fit.fit()
        void rpc('session.resize', { id: sessionId, cols: term.cols, rows: term.rows })
      } catch {
        // The pane can be measured mid-layout; the next resize corrects it.
      }
    }
    const observer = new ResizeObserver(resize)
    observer.observe(host)
    resize()

    return () => {
      observer.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [sessionId])

  useDaemonEvents((event) => {
    if (event.type === 'session.data' && event.sessionId === sessionId) {
      termRef.current?.write(event.data)
    }
    if (event.type === 'session.exit' && event.sessionId === sessionId) {
      termRef.current?.write(`\r\n\x1b[2m-- session exited (${event.exitCode ?? '?'}) --\x1b[0m\r\n`)
    }
  })

  return <div className="term" ref={hostRef} />
}
