import { useCallback, useEffect, useRef, useState } from 'react'
import type { Question } from '@shared/tasks'
import { rpc, useDaemonEvents } from '../lib/daemon'
import { isSubmitKey, useUiSettings } from '../lib/uisettings'
import { ImageChips, usePastedImages } from '../lib/pasteimages'
import { useIsRemote } from '../lib/target'
import { Pill, PillOptions, type PillOption } from './Pill'

/** The same answer-time attachments the task composer offers — a question is where a person most
 * needs to hand over a directory, because that is where an agent's NEEDS DECISION lands. */
const ANSWER_ATTACH_OPTIONS: PillOption[] = [
  { value: 'file', label: 'Add file or image' },
  { value: 'folder', label: 'Add folder' }
]

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
  const { settings } = useUiSettings()
  const [isMulti, setIsMulti] = useState(question.kind === 'multi')
  const [chosen, setChosen] = useState<string[]>([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  /**
   * The **Other** row: an answer the asker did not think of.
   *
   * ⛔ Its own row among the options and not just the box underneath, which is what this used to
   * be. The box was there the whole time, but beneath a list of numbered choices it reads as a
   * footnote to whichever one you picked — so an operator whose real answer was *none of these*
   * either picked the closest option and hoped the caveat carried it, or answered nothing. Claude
   * Code's own `AskUserQuestion` offers *Other* as a choice for exactly this reason, and the set of
   * answers is genuinely open: the options are one agent's guess at what you might say.
   *
   * ⚠️ Selecting it clears the chosen options rather than adding to them. "Other, and also option
   * two" is not what the word means, and `renderAnswer` would hand the agent both.
   */
  const [other, setOther] = useState(false)
  const textRef = useRef<HTMLTextAreaElement>(null)
  // ⛔ The same attachments the composer offers, because the question card is where an agent's
  // NEEDS DECISION lands — and answering "attach C:\Dev\site" with nowhere to attach it is the
  // t521 dead end. A folder answered with is granted to the task exactly as a composed one is.
  const paste = usePastedImages()
  const attachmentPickerRef = useRef<HTMLInputElement>(null)
  const remoteFleet = useIsRemote()

  useEffect(() => {
    setIsMulti(question.kind === 'multi')
  }, [question.kind])

  const hasOptions = question.options.length > 0

  const toggle = (id: string): void => {
    setOther(false)
    setChosen((prev) =>
      isMulti ? (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]) : [id]
    )
  }

  const toggleMulti = (): void => {
    setIsMulti((prev) => {
      const next = !prev
      if (!next && chosen.length > 1) {
        setChosen(chosen.slice(0, 1))
      }
      return next
    })
  }

  const chooseOther = (): void => {
    setOther((prev) => {
      if (prev) return false
      setChosen([])
      // ⚠️ After the state settles, so the box it focuses is the one this click just made relevant.
      setTimeout(() => textRef.current?.focus(), 0)
      return true
    })
  }

  const answer = async (optionIds = other ? [] : chosen): Promise<void> => {
    setBusy(true)
    try {
      await rpc('question.answer', {
        id: question.id,
        optionIds,
        ...(text.trim() ? { text: text.trim() } : {}),
        ...(paste.ids.length > 0 ? { attachmentIds: paste.ids } : {})
      })
      onAnswered?.()
    } finally {
      setBusy(false)
    }
  }

  // ⛔ Nothing chosen, nothing typed and nothing attached is not an answer. The agent is waiting on
  // content, and an empty submission would reach it as "the operator gave no answer" — which is
  // what parking already says, more honestly, without anyone having pressed a button. An attached
  // folder on its own *is* content: granting a directory the agent asked for needs no prose.
  const empty = (other || chosen.length === 0) && !text.trim() && paste.ids.length === 0

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
        <span className="tag tag--human">{question.header ?? 'Decision needed'}</span>
        {hasOptions && (
          <button
            type="button"
            className="question-mode-toggle"
            onClick={toggleMulti}
            title={isMulti ? 'Switch to single-choice' : 'Switch to multiple-checkboxes'}
          >
            {isMulti ? '✓ multiple choices' : '+ select multiple'}
          </button>
        )}
        {question.parkedAt && (
          <span className="dim question-parked">
            The previous session ended. Answering will resume execution on a new run.
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
              <span className={`question-mark${isMulti ? ' question-mark--multi' : ''}`}>
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
          {/* The row for an answer that is not on the list. Same shape as the options, because it
              is one of them — the difference is that you write it. */}
          <button
            type="button"
            className={`question-option question-option--other${other ? ' question-option--on' : ''}`}
            disabled={busy}
            onClick={chooseOther}
          >
            <span className={`question-mark${isMulti ? ' question-mark--multi' : ''}`}>
              {other ? '✓' : ''}
            </span>
            <span className="question-option-body">
              <span className="question-option-label">Other — custom response</span>
              <span className="question-option-detail">
                Specify a custom response below without selecting a predefined option.
              </span>
            </span>
          </button>
          {isMulti && !other && <p className="question-hint dim">Choose all that apply.</p>}
        </div>
      )}

      <textarea
        ref={textRef}
        className="ask-input question-input"
        rows={hasOptions && !other ? 2 : 3}
        value={text}
        placeholder={
          !hasOptions || other
            ? 'Type your response here...'
            : 'Optional comment or instructions for the agent...'
        }
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (isSubmitKey(e, settings.enterBehavior) && !busy && !empty && !paste.busy) {
            e.preventDefault()
            void answer()
          }
        }}
      />

      <ImageChips paste={paste} />
      <div className="question-actions">
        <input
          ref={attachmentPickerRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.currentTarget.files ?? [])]
            e.currentTarget.value = ''
            void paste.addFiles(files)
          }}
        />
        <Pill
          className="composer-attachment"
          ariaLabel="Add attachment"
          title="Attach file, image, or folder — a folder answered with is granted to this task"
          label="+"
          menu={(close) => (
            <PillOptions
              // ⚠️ A folder is attached by *path*, and the OS picker only knows this computer's
              // disk; on a remote fleet that path would name nothing. Files upload their bytes.
              options={remoteFleet ? ANSWER_ATTACH_OPTIONS.filter((o) => o.value !== 'folder') : ANSWER_ATTACH_OPTIONS}
              value=""
              ariaLabel="Add attachment"
              onPick={(next) => {
                close()
                if (next === 'file') attachmentPickerRef.current?.click()
                else if (next === 'folder') void paste.addFolders()
              }}
            />
          )}
        />
        <button
          className="btn btn--primary"
          disabled={busy || empty || paste.busy}
          onClick={() => void answer()}
        >
          {busy ? 'Answering…' : 'Answer'}
        </button>
        <span className="dim question-hint">
          {other && !text.trim()
            ? 'Enter your response in the text field above.'
            : question.parkedAt
              ? 'Saved to thread and included in the next agent turn.'
              : 'Agent is waiting for your response.'}
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
export function TaskQuestions({
  taskId,
  taskStatus
}: {
  taskId: string
  taskStatus?: string
}): React.JSX.Element | null {
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

  if (taskStatus === 'completed' || taskStatus === 'cancelled') return null
  if (open.length === 0) return null
  return (
    <div className="question-list">
      {open.map((question) => (
        <QuestionCard key={question.id} question={question} onAnswered={refresh} />
      ))}
    </div>
  )
}
