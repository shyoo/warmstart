import { useCallback, useEffect, useState } from 'react'
import type { Question } from '@shared/tasks'
import { rpc, useDaemonEvents } from '../lib/daemon'

/**
 * Answering a question an agent asked.
 *
 * ⛔ **Not an approval, and it must not look like one.** An approval is a verdict from a closed set,
 * which is why it is three buttons in a strip. A question's answer set was written by whoever asked,
 * its options carry the asker's own prose about what each one costs, and the useful answer is very
 * often *a choice plus a caveat*. So there is always a text box, on every kind — an interface that
 * made you pick one of three and say nothing else would throw away the sentence that mattered.
 *
 * ⚠️ A **parked** question renders identically. The session that asked has gone, so answering it
 * cannot return into a tool result any more — it goes into the thread, and the next run reads it.
 * From the operator's side that difference is not their problem, so it is one line of explanation
 * and not a different control.
 */
export function QuestionCard({
  question,
  onAnswered,
  compact = false
}: {
  question: Question
  onAnswered?: () => void
  /** The strip above the work, where there is room for the options and nothing else. */
  compact?: boolean
}): React.JSX.Element {
  const [chosen, setChosen] = useState<string[]>([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  const multi = question.kind === 'multi'
  const hasOptions = question.options.length > 0

  const toggle = (id: string): void => {
    setChosen((prev) =>
      multi ? (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]) : [id]
    )
  }

  const answer = async (optionIds = chosen): Promise<void> => {
    setBusy(true)
    try {
      await rpc('question.answer', {
        id: question.id,
        optionIds,
        ...(text.trim() ? { text: text.trim() } : {})
      })
      onAnswered?.()
    } finally {
      setBusy(false)
    }
  }

  // ⛔ Nothing chosen and nothing typed is not an answer. The agent is waiting on content, and an
  // empty submission would reach it as "the operator gave no answer" — which is what parking already
  // says, more honestly, without anyone having pressed a button.
  const empty = chosen.length === 0 && !text.trim()

  if (compact) {
    return (
      <span className="attention-answers">
        {question.options.slice(0, 3).map((option) => (
          <button
            key={option.id}
            className="btn"
            disabled={busy}
            title={option.detail ?? option.label}
            onClick={() => void answer([option.id])}
          >
            {option.label}
          </button>
        ))}
      </span>
    )
  }

  return (
    <div className={`question-card${question.parkedAt ? ' question-card--parked' : ''}`}>
      <div className="question-head">
        <span className="tag tag--human">{question.header ?? 'a decision is wanted'}</span>
        {question.parkedAt && (
          <span className="dim question-parked">
            The session that asked this has ended. Answering it starts the work again.
          </span>
        )}
      </div>
      <p className="question-text">{question.question}</p>

      {hasOptions && (
        <div className="question-options">
          {question.options.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`question-option${chosen.includes(option.id) ? ' question-option--on' : ''}`}
              disabled={busy}
              onClick={() => toggle(option.id)}
            >
              <span className={`question-mark${multi ? ' question-mark--multi' : ''}`}>
                {chosen.includes(option.id) ? '✓' : ''}
              </span>
              <span className="question-option-body">
                <span className="question-option-label">{option.label}</span>
                {/* ⛔ Shown, never truncated into a tooltip. This is the asker's account of what
                    choosing it means, and it is the part that makes the choice answerable. */}
                {option.detail && <span className="question-option-detail">{option.detail}</span>}
              </span>
            </button>
          ))}
          {multi && <p className="question-hint dim">Choose as many as apply.</p>}
        </div>
      )}

      <textarea
        className="ask-input question-input"
        rows={hasOptions ? 2 : 3}
        value={text}
        placeholder={
          hasOptions
            ? 'Anything to add? A choice plus a caveat is a better answer than either alone.'
            : 'Your answer — this goes back to the agent as it is.'
        }
        onChange={(e) => setText(e.target.value)}
      />

      <div className="question-actions">
        <button
          className="btn btn--primary"
          disabled={busy || empty}
          onClick={() => void answer()}
        >
          {busy ? 'Answering…' : 'Answer'}
        </button>
        <span className="dim question-hint">
          {question.parkedAt
            ? 'Recorded on the thread, and carried into the next run’s prompt.'
            : 'The agent is holding for this.'}
        </span>
      </div>
    </div>
  )
}

/**
 * Every open question on one task, in its thread.
 *
 * ⛔ The thread and not the ledger. A question is something to answer, and everything else that a
 * person answers about a task lives beside the composer — putting it in the read-only column on the
 * right would make it look like a fact rather than a prompt.
 */
export function TaskQuestions({ taskId }: { taskId: string }): React.JSX.Element | null {
  const [open, setOpen] = useState<Question[]>([])

  const refresh = useCallback(() => {
    void rpc('question.forTask', { taskId })
      .then((all) => setOpen(all.filter((q) => q.answeredAt === null)))
      .catch(() => setOpen([]))
  }, [taskId])

  useEffect(refresh, [refresh])
  useDaemonEvents((event) => {
    if (
      event.type === 'question.opened' ||
      event.type === 'question.answered' ||
      event.type === 'question.parked'
    ) {
      if (event.question.taskId === taskId) refresh()
    }
  })

  if (open.length === 0) return null
  return (
    <div className="question-list">
      {open.map((question) => (
        <QuestionCard key={question.id} question={question} onAnswered={refresh} />
      ))}
    </div>
  )
}
