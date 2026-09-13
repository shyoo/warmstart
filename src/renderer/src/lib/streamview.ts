import type { SessionStreamLine } from '@shared/protocol'

/**
 * How many rows a live session view holds.
 *
 * ⚠️ Bounded on the watcher's side as well as the daemon's, and for a different reason: the daemon
 * bounds its own memory, this bounds a React array that is re-rendered on every line. The daemon
 * keeps more than this, so a backfill can be trimmed here without the two disagreeing about what
 * happened — the older rows simply are not drawn.
 */
export const STREAM_VIEW_LINES = 400

/**
 * Fold one `session.stream` event into the rows a pane is drawing.
 *
 * ⛔ **Keyed on `seq`, because the backfill and the live feed overlap.** A pane opens, asks for the
 * log, and starts receiving events in the same breath: every line published between the request and
 * the answer arrives twice. `seq` is monotonic per daemon, so a line already held is the same line —
 * appending it again would draw the agent saying everything twice at exactly the moment somebody
 * opened the pane to read it.
 *
 * ⚠️ Out-of-order arrival is possible in principle and cheap to be right about, so rows are kept
 * sorted rather than assumed sorted.
 */
export function mergeStreamLines(
  prev: SessionStreamLine[],
  line: SessionStreamLine
): SessionStreamLine[] {
  if (prev.some((l) => l.seq === line.seq)) return prev
  const last = prev[prev.length - 1]
  const next = last && last.seq < line.seq ? [...prev, line] : [...prev, line].sort((a, b) => a.seq - b.seq)
  return next.length > STREAM_VIEW_LINES ? next.slice(-STREAM_VIEW_LINES) : next
}
