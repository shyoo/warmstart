import { useEffect, useState } from 'react'
import type { RpcResult } from '@shared/protocol'
import type { Task } from '@shared/tasks'
import { DEBATE_VERDICT_LABELS } from '@shared/tasks'
import { rpc } from '../../lib/daemon'
import { Markdown } from './Markdown'

/**
 * The debate board: one column per seat, one row per round, the organizer's words between them.
 *
 * ⛔ **Every cell is agent output, so it is text.** It is parsed by `lib/markdown.ts`'s closed
 * subset and drawn as elements this codebase writes — no raw HTML, no `dangerouslySetInnerHTML`,
 * and a link's `href` is whitelisted at the parse. A debate is the one screen in this app where
 * several untrusted agents' words sit next to each other, which makes that rule more load-bearing
 * here than anywhere else, not less.
 *
 * ⭐ **The citation report is beside the name that made the claim**, unresolved paths only. A
 * debater naming a file is making a claim about where something lives, and in a repository that
 * claim is checkable. ⛔ It is a report, never a penalty: it does not score the seat, does not
 * exclude it and does not edit its words.
 */
export function DebateBoard({ task }: { task: Task }): React.JSX.Element | null {
  const [board, setBoard] = useState<RpcResult<'task.debateState'>>(null)

  // ⚠️ Re-read whenever the task row changes, which is what a round landing looks like from here:
  // `writeDebateState` emits `task.changed`, and `updatedAt` moves with it.
  useEffect(() => {
    if (task.kind !== 'debate') {
      setBoard(null)
      return
    }
    let live = true
    void rpc('task.debateState', { id: task.id })
      .then((next) => {
        if (live) setBoard(next)
      })
      .catch(() => {
        if (live) setBoard(null)
      })
    return () => {
      live = false
    }
  }, [task.id, task.kind, task.updatedAt])

  if (task.kind !== 'debate' || !board) return null
  const { debate, seats, organizer } = board
  const rounds = Math.max(1, ...seats.map((s) => s.rounds.length))

  return (
    <section className="debate-board" aria-label="The debate">
      <header className="debate-board-head">
        <span className="debate-board-title">
          {seats.length} seat{seats.length === 1 ? '' : 's'} · round {debate.round} of at most{' '}
          {debate.rounds} · {debate.exchange === 'full' ? 'verbatim exchange' : 'organizer’s digest'}
        </span>
        {debate.verdict && (
          <span className="debate-board-verdict">Verdict: {DEBATE_VERDICT_LABELS[debate.verdict]}</span>
        )}
      </header>

      {seats.length === 0 ? (
        <p className="dim">The seats have not been filed yet.</p>
      ) : (
        Array.from({ length: rounds }, (_, r) => (
          <div key={`round-${r}`} className="debate-round">
            <h4 className="debate-round-label">Round {r + 1}</h4>
            <div className="debate-round-seats">
              {seats.map((seat, i) => {
                const position = seat.rounds[r]
                // ⛔ Unresolved only. A list of every path that *did* resolve is a wall of text
                // saying nothing happened, which is how a report stops being read.
                const missing = (position?.citations ?? []).filter((c) => !c.exists)
                return (
                  <article key={seat.taskId} className="debate-seat">
                    <header className="debate-seat-head">
                      <span className="debate-seat-name">
                        Seat {i + 1} · t{seat.seq}
                      </span>
                      <span className="debate-seat-who">
                        {[seat.model, seat.adapterId].filter(Boolean).join(' · ') || seat.status}
                      </span>
                    </header>
                    {missing.length > 0 && (
                      <p className="debate-seat-citations">
                        ⚠️ Cites {missing.length} path{missing.length === 1 ? '' : 's'} that do not
                        resolve in this repository: {missing.map((c) => c.path).join(', ')}. A report,
                        not a penalty.
                      </p>
                    )}
                    {position ? (
                      <div className="debate-seat-text">
                        <Markdown text={position.text} />
                      </div>
                    ) : (
                      <p className="dim">
                        {seat.status === 'completed' ? 'No position recorded.' : `Still ${seat.status}.`}
                      </p>
                    )}
                  </article>
                )
              })}
            </div>
            {/* The organizer's own turn for this round, which is the brief that opened the next one
                or — on the last row — the agreement. */}
            {organizer[r] && (
              <div className="debate-organizer">
                <span className="debate-organizer-label">Organizer</span>
                <Markdown text={organizer[r].text} />
              </div>
            )}
          </div>
        ))
      )}
    </section>
  )
}
