/**
 * The task pane's ledger rows: one label, one answer, and the four answers that need arithmetic.
 *
 * ⛔ `Fact` is the row itself and is used by every pane in the thread, which is why it lives with
 * the facts rather than in the file that happens to draw the most of them.
 */
import type { Run } from '@shared/tasks'
import type { Session } from '@shared/protocol'
import { conversationIdFor } from '../../lib/conversation'
import { tokens } from '../../lib/format'
import { modelFacts } from '../../lib/taskview'

/**
 * What this task is actually running on.
 *
 * ⛔ **Two facts, and which one leads is the whole point.** What the transcript says answered each
 * turn is a measurement; what a dispatch starting now would ask for is a prediction. `modelFacts`
 * decides between them — see the note there for why leading with the prediction made this row
 * contradict the run list beneath it — and this draws the answer.
 */
export function ModelFact({
  session,
  ran,
  requested
}: {
  session: Session | null
  ran: string | null
  requested: { model: string | null; effort: string | null; source: string; undecided?: boolean }
}): React.JSX.Element {
  const { headline, note } = modelFacts({
    observed: session ? { model: session.model ?? null, effort: session.effort ?? null } : null,
    ran,
    requested
  })
  return (
    <>
      <span title={headline.title}>{headline.text}</span>
      {note && (
        <div className={`tbl-sub ${note.tone}`} title={note.title}>
          {note.text}
        </div>
      )}
    </>
  )
}

/**
 * What changing the model or the effort costs, said before it is changed.
 *
 * ⛔ Prompt caches are **model-scoped**, so switching model does not degrade the cache — it leaves it
 * behind entirely, and the next turn rebuilds the whole prefix. Effort is cheaper and not free: it
 * invalidates the message history on every model, and on some it takes the tools and system caches
 * with it. Anthropic publishes both as a hierarchy; this is the two rows that apply here.
 *
 * ⚠️ Priced in this repo's own units — a warm read is 0.1·C and a cold rebuild 2.0·C (§1) — rather
 * than in dollars, because the fleet runs on subscriptions where the marginal dollar is not the
 * currency that runs out. The window is.
 *
 * ⭐ Only ever shown when there is a live conversation with context in it. A task that has not run,
 * or whose session is closed, loses nothing by being re-pointed, and warning there would train the
 * operator to dismiss the warning that matters.
 */
export function CacheCost({
  session,
  changing
}: {
  session: Session | null
  changing: 'model' | 'effort'
}): React.JSX.Element | null {
  const held = session?.contextTokens ?? 0
  if (!session || held <= 0) return null

  return (
    <div className="warn tbl-sub">
      {changing === 'model' ? (
        <>
          This conversation holds {tokens(held)} of cached context. Prompt caches belong to one model,
          so switching discards all of it — the next turn rebuilds the prefix at 2.0·C instead of
          reading it at 0.1·C.
        </>
      ) : (
        <>
          Changing effort invalidates this conversation’s {tokens(held)} of message cache. Cheaper
          than a model switch, which also discards the tools and system prefix — but not free.
        </>
      )}{' '}
      Applies to the next run; this session keeps what it started with.
    </div>
  )
}

export function Fact({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="fact">
      <span className="fact-label">{label}</span>
      <span className="fact-value">{children}</span>
    </div>
  )
}

/**
 * Which conversation this task is in, and whether the latest run had to build it.
 *
 * ⛔ **This used to infer reuse from the clock** - `session.startedAt < run.startedAt` - on the
 * argument that nothing needed to record the intent because a recorded intent could disagree with
 * what happened. It disagreed with what happened. `spawnSession` inserts its row before `startRun`
 * inserts the run's, so a brand-new session is *always* older than its own first run by a
 * millisecond or two: measured against this install 2026-08-28, the heuristic rendered **"reused,
 * context kept" on 19 of 20 runs**, every one of which was a cold start. It reported the exact
 * inverse of the truth, on the one number an operator would use to judge what a task cost.
 *
 * ⚠️ `startedWarm` is now written at dispatch by the code that made the choice. Null means the run
 * predates the column, and null renders as **nothing** rather than as a guess.
 */
export function SessionFact({ runs, sessions }: { runs: Run[]; sessions: Session[] }): React.JSX.Element {
  const run = runs[0]
  if (!run) return <span className="dim">none yet</span>
  // ⚠️ Resolved by the same function the run rows use, so the id in the ledger and the id beside the
  // latest run cannot be two different strings.
  const conversation = conversationIdFor(run, sessions)
  if (!conversation) return <span className="dim">none yet</span>

  return (
    <>
      <span className="mono" title={`Conversation ${conversation}`}>
        {conversation.slice(0, 12)}
      </span>{' '}
      {run.startedWarm === null ? null : run.startedWarm ? (
        <span
          className="ok"
          title="This run inherited a conversation that already existed — continued in a live session, or resumed one that had closed. The prompt prefix was read, not rebuilt."
        >
          reused, context kept
        </span>
      ) : (
        <span
          className="dim"
          title="A new conversation, so the prompt prefix was built from nothing. Measured on this machine: 41,542 cache-creation tokens for a trivial prompt in an empty directory."
        >
          new conversation
        </span>
      )}
    </>
  )
}
