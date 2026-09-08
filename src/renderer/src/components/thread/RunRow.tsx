/**
 * One row per thing that happened to this task: a run, a review, a compaction.
 *
 * ⛔ Every row here reports a *measurement*, and several report two that disagree — the transcript's
 * token counts beside the account's own window readings. The docblocks below say which is which and
 * why merging them would destroy the instrument. ⚠️ The arithmetic they share lives in
 * [`lib/threadview.ts`](../../lib/threadview.ts), where a suite can reach it.
 */
import { useState } from 'react'
import type { Compaction, Run } from '@shared/tasks'
import type { Session } from '@shared/protocol'
import {
  RUBRIC_DIMENSIONS,
  rubricFor,
  type QualityReview
} from '@shared/review'
import { rpc, type FleetEntry } from '../../lib/daemon'
import { conversationIdFor } from '../../lib/conversation'
import { duration, money, quotaWindowDeltas, spendDeltas, timeRange, tokens } from '../../lib/format'
import { Money, runPriceTitle } from '../Price'
import { modelLabel } from '../../lib/modelname'
import { outcomeClass } from '../../lib/threadview'
import { ActivityDisclosure, PromptDisclosure } from './Disclosure'

/**
 * One attempt, with what it cost — twice over, and deliberately not reconciled.
 *
 * ⛔ The token counts are exact assistant-turn metering from the agent's own transcript. The window
 * figures are the *account's* view, read either side of the run, and they include everything the CLI
 * spent that never reached a transcript. The two disagreeing is the measurement, not a bug — HANDOFF
 * calls that gap the instrument. Merging them would destroy it.
 */
export function RunRow({
  index,
  run,
  sessions,
  fleet,
  now
}: {
  index: number
  run: Run
  /** Every session any run of this task used, so this run's can be named rather than guessed at. */
  sessions: Session[]
  fleet: FleetEntry[]
  now: number
}): React.JSX.Element {
  const worker = fleet.find((f) => f.worker.id === run.workerId)?.worker.label
  const spent = run.inputTokens + run.outputTokens + run.cacheReadTokens + run.cacheWriteTokens
  const session = sessions.find((s) => s.id === run.sessionId)
  const modelName = run.model ?? session?.model ?? 'CLI default'
  const effort = session?.effort ?? null
  const agentWorkingMs = (run.endedAt ?? now) - run.startedAt - run.blockedMs
  const totalDurationMs = (run.endedAt ?? now) - run.startedAt

  return (
    <div className="side-run">
      <div className="side-run-head">
        <span className="side-run-seq">#{index} Run</span>
        <span className="num dim">{timeRange(run.startedAt, run.endedAt, now)}</span>
      </div>
      <div className="side-run-facts">
        <div className="side-run-fact">
          <span className="side-run-key">run_id:</span>
          <span className="side-run-val mono" title={`Run ${run.id}`}>
            {run.id.slice(0, 8)}
          </span>
        </div>
        <div className="side-run-fact">
          <span className="side-run-key">session:</span>
          <span className="side-run-val">
            <ConversationId run={run} sessions={sessions} workerLabel={worker} />
          </span>
        </div>
        <div className="side-run-fact">
          <span className="side-run-key">model:</span>
          <span className="side-run-val" title={modelName}>
            {modelName}
            {effort ? ` · ${effort}` : ''}
          </span>
        </div>
        {run.prompt && (
          <div className="side-run-fact">
            <span className="side-run-key">prompt:</span>
            <span className="side-run-val">
              <PromptDisclosure prompt={run.prompt} label="link" />
            </span>
          </div>
        )}
        {run.activity && run.activity.length > 0 && (
          <div className="side-run-fact">
            <span className="side-run-key">activity:</span>
            <span className="side-run-val">
              <ActivityDisclosure activity={run.activity} label="link" />
            </span>
          </div>
        )}
        {run.startedWarm !== null && (
          <div className="side-run-fact">
            <span className="side-run-key">fresh:</span>
            <span className="side-run-val">
              <span
                className={run.startedWarm ? 'ok' : 'dim'}
                title={
                  run.startedWarm
                    ? 'This run inherited a conversation that already existed — continued in a live session, or resumed one that had closed.'
                    : 'This run opened a new conversation and built its context from nothing.'
                }
              >
                {run.startedWarm ? 'reused' : 'new'}
              </span>
            </span>
          </div>
        )}
        <div className="side-run-fact">
          <span className="side-run-key">status:</span>
          <span className="side-run-val">
            <span
              className={outcomeClass(run.outcome)}
              title={
                run.outcome === 'blocked'
                  ? 'The agent stopped to ask something rather than because anything went wrong. Answer it and the task carries on.'
                  : undefined
              }
            >
              {run.outcome ?? 'running'}
            </span>
          </span>
        </div>
        {/* ⛔ Price and tokens are two rows here for the same reason they are two rows in the
            ledger above: they measure the same work by two instruments that are never reconciled,
            and stacking one under the other made the second read as a gloss on the first. */}
        <div className="side-run-fact">
          <span className="side-run-key">price:</span>
          <span className="side-run-val">
            <Money
              usd={run.price?.usd ?? null}
              estimated={run.price?.estimated ?? false}
              title={runPriceTitle(run.price)}
            />
          </span>
        </div>
        <div className="side-run-fact">
          <span className="side-run-key">tokens:</span>
          <span
            className="side-run-val num"
            title={
              'What this run spent: input + output + cache read + cache write, summed from the ' +
              'transcript. ⛔ Not the size of the context — a single long conversation re-reads its ' +
              'whole window every turn, so the total runs far ahead of it.'
            }
          >
            {tokens(spent || null)}
          </span>
        </div>
        <div className="side-run-fact">
          <span className="side-run-key">agent time:</span>
          <span
            className="side-run-val num dim"
            title={
              run.blockedMs > 0
                ? `${duration(agentWorkingMs)} working, ${duration(run.blockedMs)} of it waiting on a person.`
                : 'Nothing waited on a person during this attempt, so all of it was work.'
            }
          >
            {duration(agentWorkingMs)}
            {run.blockedMs > 0 && <span className="dim"> (+{duration(run.blockedMs)} waiting)</span>}
          </span>
        </div>
        <div className="side-run-fact">
          <span className="side-run-key">total duration:</span>
          <span className="side-run-val num dim" title="Total wall-clock duration from dispatch to end.">
            {duration(totalDurationMs)}
          </span>
        </div>
        {(run.quotaBefore || run.quotaAfter) && (
          <div className="side-run-fact side-run-fact--usage">
            <span className="side-run-key">usage:</span>
            <span className="side-run-val">
              <QuotaDelta run={run} />
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * One quality review in the timeline — ⭐ `#N Quality Review`, which is the label this feature was
 * asked for by name.
 *
 * ⚠️ The dimensions are behind a disclosure. The composite is what a glance wants; the seven
 * rationales are what somebody arguing with the number wants, and they are long.
 */
export function ReviewRow({
  index,
  review,
  runs,
  fleet,
  now,
  refresh
}: {
  index: number
  review: QualityReview
  runs: Run[]
  fleet: FleetEntry[]
  now: number
  refresh?: () => Promise<void>
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const reviewer = fleet.find((f) => f.worker.id === review.reviewerWorkerId)?.worker.label
  const run = runs.find((r) => r.id === review.runId)
  const spent = run
    ? run.inputTokens + run.outputTokens + run.cacheReadTokens + run.cacheWriteTokens
    : null
  const rubric = rubricFor(review.rubricVersion)

  const removeReview = async () => {
    if (!confirm('Remove this quality review record?')) return
    setDeleting(true)
    try {
      await rpc('review.delete', { reviewId: review.id })
      await refresh?.()
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="side-run">
      <div className="side-run-head">
        <span className="side-run-seq">#{index} Quality Review</span>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
          <span className="num dim">{timeRange(review.createdAt, review.completedAt, now)}</span>
          <button
            type="button"
            className="linkish dim"
            title="Remove this quality review record"
            disabled={deleting}
            onClick={() => void removeReview()}
            style={{ fontSize: '0.8rem' }}
          >
            {deleting ? 'removing…' : '✕ Remove'}
          </button>
        </div>
      </div>
      <div className="side-run-facts">
        <div className="side-run-fact">
          <span className="side-run-key">score:</span>
          <span className="side-run-val">
            {review.status === 'complete' && review.composite !== null ? (
              <strong className="num">{review.composite.toFixed(1)} / 10</strong>
            ) : (
              <span className={review.status === 'pending' ? 'dim' : 'warn'}>
                {review.status === 'pending' ? 'grading…' : review.status}
              </span>
            )}
          </span>
        </div>
        <div className="side-run-fact">
          <span className="side-run-key">reviewer:</span>
          <span
            className="side-run-val dim"
            title="A different agent than the one that did the work. A review never grades its own author."
          >
            {reviewer ?? review.reviewerAdapter}
            {review.reviewerModel ? ` · ${modelLabel(review.reviewerModel)}` : ''}
          </span>
        </div>
        {review.diffFiles !== null && (
          <div className="side-run-fact">
            <span className="side-run-key">diff:</span>
            <span className="side-run-val num dim">
              {review.diffFiles} file(s) +{review.diffInsertions}/-{review.diffDeletions}
              {review.diffTruncated ? ' · truncated' : ''}
            </span>
          </div>
        )}
        {spent !== null && (
          <div className="side-run-fact">
            <span className="side-run-key">tokens:</span>
            <span className="side-run-val num dim">{tokens(spent)}</span>
          </div>
        )}
        {(review.mixedAuthorship || review.blindingLeak) && (
          <div className="side-run-fact">
            <span className="side-run-key">caveat:</span>
            <span
              className="side-run-val warn"
              title={
                'A score carrying either of these is not clean evidence about one agent. Mixed ' +
                'authorship means more than one agent contributed work; a blinding leak means a ' +
                'name survived in the prose that could not be redacted without destroying the text.'
              }
            >
              {[review.mixedAuthorship ? 'mixed authorship' : '', review.blindingLeak ? 'blinding leak' : '']
                .filter(Boolean)
                .join(' · ')}
            </span>
          </div>
        )}
        {review.failureReason && (
          <div className="side-run-fact">
            <span className="side-run-key">reason:</span>
            <span className="side-run-val dim">{review.failureReason}</span>
          </div>
        )}
        {review.summary && (
          <div className="side-run-fact">
            <span className="side-run-key">summary:</span>
            <span className="side-run-val dim">{review.summary}</span>
          </div>
        )}
        {review.scores && (
          <>
            <button type="button" className="linkish" onClick={() => setOpen(!open)}>
              {open ? 'hide' : 'show'} the seven dimensions
            </button>
            {open && (
              <div className="review-dimensions">
                {RUBRIC_DIMENSIONS.map((dimension) => {
                  const entry = review.scores?.[dimension]
                  if (!entry) return null
                  const definition = rubric?.labels[dimension]
                  return (
                    <div className="side-run-fact" key={dimension}>
                      <span
                        className="side-run-key"
                        title={
                          definition && rubric
                            ? `${definition.asks} Weight ${rubric.weights[dimension].toFixed(2)}.`
                            : `Rubric ${review.rubricVersion} is not available in this build.`
                        }
                      >
                        {definition?.label ?? dimension}:
                      </span>
                      <span className="side-run-val">
                        <strong className="num">
                          {entry.score === null ? 'n/a' : `${entry.score}/10`}
                        </strong>
                        <span className="dim"> {entry.rationale}</span>
                      </span>
                    </div>
                  )
                })}
                <div className="side-run-fact">
                  <span className="side-run-key">rubric:</span>
                  <span
                    className="side-run-val dim"
                    title="The composite is a weighted mean computed with this stored, immutable rubric version."
                  >
                    v{review.rubricVersion} · weighted mean over the dimensions scored
                  </span>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

export function CompactionRow({
  index,
  compaction: c,
  sessions,
  fleet,
  now
}: {
  index: number
  compaction: Compaction
  sessions: Session[]
  fleet: FleetEntry[]
  now: number
}): React.JSX.Element {
  const landed = c.landedAt !== null
  const pending = !landed && now - (c.askedAt ?? c.ts) < 4 * 60 * 1000
  const saved =
    c.preTokens !== null && c.postTokens !== null && c.preTokens > c.postTokens
      ? c.preTokens - c.postTokens
      : null
  const startTs = c.askedAt ?? c.ts
  const endTs = c.landedAt ?? (c.durationMs ? startTs + c.durationMs : null)

  const session = sessions.find((s) => s.id === c.sessionId)
  const worker = session ? fleet.find((f) => f.worker.id === session.workerId)?.worker.label : null

  return (
    <div className="side-run">
      <div className="side-run-head">
        <span className="side-run-seq">#{index} Compact</span>
        <span className="num dim">
          {timeRange(startTs, landed ? endTs : pending ? null : endTs, now)}
        </span>
      </div>
      <div className="side-run-facts">
        <div className="side-run-fact">
          <span className="side-run-key">session:</span>
          <span className="side-run-val mono" title={`Session ${c.sessionId}`}>
            {worker ? `${worker}/` : ''}{c.sessionId.slice(0, 8)}
          </span>
        </div>
        <div className="side-run-fact">
          <span className="side-run-key">trigger:</span>
          <span
            className="side-run-val dim"
            title={
              c.trigger === 'clock'
                ? 'The cache clock bought this: it decided a shrink was worth more than holding the prefix as it was.'
                : c.trigger === 'agent'
                  ? 'The agent compacted its own context.'
                  : 'The CLI compacted on its own when the context filled. This fleet only watched it happen.'
            }
          >
            {c.trigger}
          </span>
        </div>
        <div className="side-run-fact">
          <span className="side-run-key">result:</span>
          <span className="side-run-val">
            <span
              className={landed ? 'ok' : pending ? 'dim' : 'warn'}
              title={
                landed
                  ? undefined
                  : pending
                    ? 'Asked for, and not yet confirmed by a compaction boundary in the transcript.'
                    : 'Asked for and never confirmed. The session did not honour it, and the clock falls back to a handoff rather than asking a third time.'
              }
            >
              {landed ? 'compacted' : pending ? 'asked' : 'failed'}
            </span>
            {c.durationMs !== null && <span className="num dim"> · {duration(c.durationMs)}</span>}
          </span>
        </div>
        <div className="side-run-fact">
          <span className="side-run-key">context:</span>
          <span
            className="side-run-val num"
            title={
              'Context before the compaction, and after it. The second number is measured by the ' +
              'first turn that follows - until one does, it is unknown rather than zero.'
            }
          >
            <span>{tokens(c.preTokens)} → {tokens(c.postTokens)}</span>
            {saved !== null && (
              <span className="ok" title="Tokens every subsequent turn no longer has to read.">
                {' '}({tokens(saved)} smaller)
              </span>
            )}
          </span>
        </div>
        {c.reason && (
          <div className="side-run-fact">
            <span className="side-run-key">reason:</span>
            <span className="side-run-val dim">{c.reason}</span>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Which conversation served this run, as the string you would actually type.
 *
 * ⛔ **The vendor's id where the CLI named its own conversation, ours where it took ours.** This is
 * what goes after `--resume` or `--conversation`, so it has to be the real one rather than whichever
 * we happen to file the row under — an id that looks right and resumes nothing is worse than no id.
 *
 * ⚠️ A run with no session shows nothing rather than a dash with a tooltip: dispatch can fail before
 * anything is spawned, and that run genuinely was not served by a conversation. A session row that
 * has since gone falls back to the session id, which is what `--session-id` was given.
 */
export function ConversationId({
  run,
  sessions,
  workerLabel
}: {
  run: Run
  sessions: Session[]
  workerLabel?: string
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const id = conversationIdFor(run, sessions)
  const displayId = id ? id.slice(0, 12) : run.sessionId ? run.sessionId.slice(0, 8) : null
  const textToCopy = id ?? run.sessionId ?? ''

  const copy = (): void => {
    if (!textToCopy) return
    void navigator.clipboard
      .writeText(textToCopy)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      })
      // ⚠️ Silent. A clipboard permission this window does not have is not something to interrupt
      // somebody reading a ledger about, and the id is on screen either way.
      .catch(() => undefined)
  }

  if (!displayId) {
    return (
      <span className="mono">
        {workerLabel ? `${workerLabel} / ` : ''}
        <span className="dim">none</span>
      </span>
    )
  }

  return (
    <span className="mono">
      {workerLabel ? `${workerLabel} / ` : ''}
      <button
        className="conv-id mono"
        onClick={copy}
        title={`Conversation ${textToCopy} — click to copy. This is the id to pass after --resume or --conversation.`}
      >
        {copied ? 'copied' : displayId}
      </button>
    </span>
  )
}

/**
 * What this run cost the account's window — and what it spent past the plan limit.
 *
 * ⛔ Each opening window always keeps its own row. One reading is a state, not a cost, and rendering
 * "41%" beside a run invites it to be read as the run's price. Until the background closing reading
 * arrives, `41% → n/a` makes the missing half explicit and leaves a stable row for the result.
 * The pay-as-you-go meters bracketed beside the run keep the same contract one row down: a purse
 * drawn down reads `spent = from − to`, a cumulative counter `to − from`, and a meter one reading
 * never carried is not a cost at all.
 */
export function QuotaDelta({ run }: { run: Run }): React.JSX.Element | null {
  const before = run.quotaBefore
  const after = run.quotaAfter
  if (!before) return null
  const rows = quotaWindowDeltas(before, after)
  const spend = spendDeltas(before, after)

  if (rows.length === 0 && spend.length === 0) return null
  return (
    <div className="side-run-quota side-run-quota--windows num">
      {rows.map((r) => (
        <span key={r.label} title="the account's own window, read before the run and after it">
          {r.label} {Math.round(r.from)}% → {r.to === null ? 'n/a' : `${Math.round(r.to)}%`}
          {r.to !== null && (
            <span className={r.to > r.from ? 'warn' : 'dim'}>
              {' '}
              ({r.to > r.from ? '+' : ''}
              {Math.round(r.to - r.from)})
            </span>
          )}
        </span>
      ))}
      {spend.map((r) => (
        <span key={r.label} title="pay-as-you-go spend on this account, read before the run and after it">
          {r.label} {r.from === null ? 'n/a' : money(r.from)} →{' '}
          {r.to === null ? 'n/a' : money(r.to)}
          {r.spent !== null && (
            <span className={r.spent > 0 ? 'warn' : 'dim'}>
              {' '}
              ({r.spent > 0 ? '+' : ''}
              {money(r.spent)})
            </span>
          )}
        </span>
      ))}
      {/* ⚠️ A stale reading either side makes the difference meaningless, and it is the difference
          being shown. Say so on the number rather than beside it. */}
      {(before.stale || after?.stale) && (
        <span className="warn" title="One of the two readings was already too old to act on.">
          reading not fresh
        </span>
      )}
    </div>
  )
}
