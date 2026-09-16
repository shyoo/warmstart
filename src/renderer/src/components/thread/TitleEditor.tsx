/**
 * The task page's heading, and the one place a task is renamed (t479, 2026-09-16).
 *
 * ⛔ **A title had no editor.** It was the prompt's first line, or the label the controller wrote,
 * and the only way to change either was on a draft. A conversation that starts as *"can you look at
 * why the tests hang"* is, three turns later, the thread where the PTY reaper got fixed — and with
 * several of them open in the sidebar the names are what you switch by. So the heading is the
 * control: press the pencil (or the title), type, Enter. Esc puts it back.
 *
 * ⚠️ Through `task.update { title }`, which already existed for drafts. It trims, keeps the old
 * title on an empty string, and **clears the controller's one-line summary** — a label about text
 * that no longer exists — so the name typed here is the one every list shows. `admit()` at its end
 * leaves every held or terminal status alone (`TERMINAL_OR_HELD`), so renaming a conversation that
 * is waiting on you cannot re-dispatch it; `tasks.test.ts` pins that.
 *
 * ⚠️ The draft page keeps its own title box in `DraftControls`; this component is not drawn there.
 */
import { useEffect, useRef, useState } from 'react'
import type { Task } from '@shared/tasks'
import { rpc } from '../../lib/daemon'
import { taskLabel } from '../../lib/taskview'

export function TitleEditor({
  task,
  onRenamed
}: {
  task: Pick<Task, 'id' | 'seq' | 'title' | 'titleSummary'>
  onRenamed: () => Promise<void>
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) input.current?.select()
  }, [editing])

  const begin = (): void => {
    // ⚠️ Starts from the *title*, not the label: the label may be the controller's summary, and
    // editing a summary would rename the task to a sentence nobody typed.
    setDraft(task.title)
    setError(null)
    setEditing(true)
  }

  const save = async (): Promise<void> => {
    // ⚠️ Pressing Save blurs the box and submits the form: one write, not two.
    if (busy) return
    const next = draft.trim()
    if (!next || next === task.title) {
      setEditing(false)
      return
    }
    setBusy(true)
    try {
      await rpc('task.update', { id: task.id, title: next })
      await onRenamed()
      setEditing(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (editing) {
    return (
      <form
        className="title-editor"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <span className="title-editor-seq">t{task.seq} ·</span>
        <input
          ref={input}
          className="title-editor-input"
          aria-label="Task title"
          value={draft}
          disabled={busy}
          maxLength={500}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              setEditing(false)
            }
          }}
          // ⚠️ Leaving the box saves, like every inline rename people are used to; Esc is the way
          // to abandon it. A blur that discarded the typing would lose a name to a stray click.
          onBlur={() => void save()}
        />
        <button
          type="submit"
          className="btn btn--primary"
          disabled={busy}
          onMouseDown={(e) => e.preventDefault()}
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          className="btn btn--ghost"
          disabled={busy}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setEditing(false)}
        >
          Cancel
        </button>
        {error && <span className="title-editor-error warn">{error}</span>}
      </form>
    )
  }

  return (
    <h3 className="title-editable" title={`${task.title}\n\nPress to rename`}>
      <button type="button" className="title-editable-text" onClick={begin}>
        t{task.seq} · {taskLabel(task)}
      </button>
      <button
        type="button"
        className="title-rename"
        aria-label="Rename this task"
        title="Rename this task"
        onClick={begin}
      >
        ✎
      </button>
    </h3>
  )
}
