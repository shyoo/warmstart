/**
 * Answer a TUI's terminal queries on a PTY nobody is watching.
 *
 * ⭐ Measured 2026-09-13 on Muse Code 1.2.1 (macOS, this app's own probe PTY): at startup the TUI
 * writes `ESC[6n` (*report cursor position*) at +2.3s and again at +4.3s, and when neither is
 * answered it **exits 0 at +6.4s having drawn nothing** — before `usageRefresh.readyMs` has even
 * elapsed, so `/usage` was typed into a process that was already gone and the probe reported
 * *"the probe session did not start"*. Run through the user's own config root it says why on the
 * way out: *"The cursor position could not be read within a normal duration"*. 1.0.3, which the
 * adapter was measured against, did not ask.
 *
 * ⛔ A PTY a person is watching does not have this problem: xterm.js in the renderer answers the
 * query itself and the reply travels back through `session.write`. Only a session with no terminal
 * on the other end — the usage probe — leaves it unanswered, which is why this is attached to
 * probe sessions and nothing else.
 *
 * ⚠️ **This does not parse ANSI to determine state** (architecture §4). It answers a *request* the
 * process addressed to its terminal, with a fixed stand-in for a screen this app never emulates:
 * the cursor is reported at the home position. That was enough for the TUI to start and to draw
 * the panel `parseUsage` reads; nothing here is ever read as a fact about the session. Only the
 * one query measured to be fatal is answered — "conservative is the cheap direction" — and the
 * colour, device-attribute and keyboard-protocol queries the same startup sends are left alone,
 * because the TUI was measured to carry on without them.
 */

/** DSR 6: *where is the cursor?* Answered as CPR `ESC[<row>;<col>R`. */
const CURSOR_POSITION_REQUEST = '\x1b[6n'
const CURSOR_AT_HOME = '\x1b[1;1R'

/** The longest prefix of a query that can be left dangling at the end of one PTY chunk. */
const CARRY = CURSOR_POSITION_REQUEST.length - 1

export interface TerminalAnswerer {
  /** Feed one chunk of PTY output; returns what to write back to the process, if anything. */
  push(data: string): string
  /** How many queries have been answered so far. */
  readonly answered: number
}

/**
 * One answerer per session, because a query can straddle two `onData` chunks: node-pty delivers
 * whatever `read()` returned, and `ESC[6` at the end of one chunk with `n` at the start of the next
 * is the same request.
 */
export function terminalAnswerer(): TerminalAnswerer {
  let carry = ''
  let answered = 0
  return {
    get answered() {
      return answered
    },
    push(data: string): string {
      const text = carry + data
      let reply = ''
      let from = 0
      for (;;) {
        const at = text.indexOf(CURSOR_POSITION_REQUEST, from)
        if (at < 0) break
        reply += CURSOR_AT_HOME
        answered += 1
        from = at + CURSOR_POSITION_REQUEST.length
      }
      // Keep only a tail that could be the start of a request; the rest has been looked at.
      const tail = text.slice(from)
      carry = tail.length > CARRY ? tail.slice(-CARRY) : tail
      return reply
    }
  }
}
