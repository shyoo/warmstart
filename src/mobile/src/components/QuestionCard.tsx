import { useState } from 'react'
import type { Question } from '@shared/tasks'
import { rpc } from '../api.js'
import { answerIsEmpty, startsMulti } from '../lib/question.js'

/**
 * Answering, on the phone, a question an agent asked.
 *
 * ⛔ **Not an approval, and it must not look like one** — the desktop's rule
 * (`renderer/components/Questions.tsx`), kept because the reason for it does not change with the
 * screen. An approval is a verdict from a closed set. A question's answer set was written by
 * whoever asked, its options carry the asker's own prose about what each one costs, and the useful
 * answer is very often *a choice plus a caveat*. So there is always a text box, on every kind.
 *
 * ⚠️ A **parked** question renders identically. The session that asked has ended, so the answer
 * goes onto the thread and into the next run's prompt instead of back into a tool result. That
 * difference is not the operator's problem, so it is one line of explanation and not a different
 * control.
 */
export function QuestionCard({
  question,
  onAnswered
}: {
  question: Question
  onAnswered: () => void
}): React.JSX.Element {
  const [multi, setMulti] = useState(() => startsMulti(question))
  const [chosen, setChosen] = useState<string[]>([])
  /**
   * The **Other** row: an answer the asker did not think of.
   *
   * ⛔ Its own row among the options rather than only the box beneath them. Under a list of
   * choices a bare text box reads as a footnote to whichever one you picked, so an operator whose
   * real answer was *none of these* either picks the closest and hopes the caveat carries it, or
   * answers nothing. Selecting it clears the chosen options rather than adding to them: "Other,
   * and also option two" is not what the word means.
   */
  const [other, setOther] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const hasOptions = question.options.length > 0
  const optionIds = other ? [] : chosen
  const empty = answerIsEmpty(optionIds, text)

  const toggle = (id: string): void => {
    setOther(false)
    setChosen((prev) => (multi ? (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]) : [id]))
  }

  const toggleMulti = (): void => {
    setMulti((prev) => {
      if (prev && chosen.length > 1) setChosen(chosen.slice(0, 1))
      return !prev
    })
  }

  const answer = async (): Promise<void> => {
    setBusy(true)
    try {
      await rpc('question.answer', {
        id: question.id,
        optionIds,
        ...(text.trim() ? { text: text.trim() } : {})
      })
      setError(null)
      onAnswered()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That answer did not land. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="m-card m-question">
      <div className="m-card-head">
        <span className="m-mark m-mark--question">?</span>
        <p className="m-card-title">{question.header ?? 'A decision is wanted'}</p>
      </div>
      <p className="m-question-text">{question.question}</p>
      {question.parkedAt && (
        <p className="m-meta">The session that asked this has ended. Answering it starts the work again.</p>
      )}

      {hasOptions && (
        <>
          <div className="m-question-options">
            {question.options.map((option) => (
              <button
                key={option.id}
                type="button"
                className={`m-question-option${chosen.includes(option.id) ? ' m-question-option--on' : ''}`}
                disabled={busy}
                onClick={() => toggle(option.id)}
              >
                <span className={`m-question-mark${multi ? ' m-question-mark--multi' : ''}`}>
                  {chosen.includes(option.id) ? '✓' : ''}
                </span>
                <span className="m-question-option-body">
                  <span className="m-question-option-label">{option.label}</span>
                  {/* ⛔ Shown, never folded into a tooltip a phone has no way to open. This is the
                      asker's account of what choosing it means, and it is the part that makes the
                      choice answerable. */}
                  {option.detail && <span className="m-question-option-detail">{option.detail}</span>}
                </span>
              </button>
            ))}
            <button
              type="button"
              className={`m-question-option${other ? ' m-question-option--on' : ''}`}
              disabled={busy}
              onClick={() => {
                setOther((prev) => {
                  if (!prev) setChosen([])
                  return !prev
                })
              }}
            >
              <span className={`m-question-mark${multi ? ' m-question-mark--multi' : ''}`}>{other ? '✓' : ''}</span>
              <span className="m-question-option-body">
                <span className="m-question-option-label">Other — write your own answer</span>
                <span className="m-question-option-detail">
                  None of these fits. What you type below is sent on its own, with no option attached.
                </span>
              </span>
            </button>
          </div>
          <button type="button" className="m-link m-question-mode" disabled={busy} onClick={toggleMulti}>
            {multi ? '✓ multiple choices — switch to one' : '+ select multiple'}
          </button>
        </>
      )}

      <label className="m-field m-question-field">
        <span>{!hasOptions || other ? 'Your answer' : 'Anything to add?'}</span>
        <textarea
          className="m-input m-textarea"
          rows={hasOptions && !other ? 2 : 4}
          value={text}
          placeholder={
            !hasOptions || other
              ? 'This goes back to the agent as it is.'
              : 'A choice plus a caveat is a better answer than either alone.'
          }
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
        />
      </label>

      {error && <p className="m-error">{error}</p>}
      <div className="m-actions">
        <button className="m-btn m-btn--primary" disabled={busy || empty} onClick={() => void answer()}>
          {busy ? 'Answering…' : 'Answer'}
        </button>
      </div>
      <p className="m-meta">
        {other && !text.trim()
          ? 'Write the answer above — Other sends what you type and nothing else.'
          : question.parkedAt
            ? 'Recorded on the thread, and carried into the next run’s prompt.'
            : 'The agent is holding for this.'}
      </p>
    </section>
  )
}
