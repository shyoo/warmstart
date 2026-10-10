import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ScratchpadDoc } from '@shared/protocol'
import type { Project, Task } from '@shared/tasks'
import { errorMessage } from '@shared/errors'
import { rpc } from '../lib/daemon'
import {
  conversationTargets,
  insertAfter,
  mergeWithNext,
  moveBeside,
  moveItem,
  openCount,
  parseScratch,
  promptOf,
  removeItem,
  markerLength,
  scratchRows,
  serializeScratch,
  setBody,
  setTag,
  settleToTop,
  splitAt,
  tagOf,
  taskForRef,
  titleOf,
  withoutMarker,
  withText,
  type ScratchDoc,
  type ScratchItem,
  type ScratchRow,
  type ScratchTag
} from '../lib/scratchpad'
import { ImageChips, usePastedImages, type PasteImages } from '../lib/pasteimages'
import { taskLabelShort } from '../lib/taskview'
import { HighlightEditor } from './HighlightEditor'
import type { ComposerSeed } from './NewTask'
import { Pill, PillOptions, PillSelect, SegmentedControl, type PillOption } from './Pill'
import { Markdown } from './thread/Markdown'

/** How long typing must pause before the file is written. */
const SAVE_AFTER_MS = 700
/** How often an idle page asks whether the file changed elsewhere — VS Code, another window. */
const POLL_MS = 3000
/** Let a newly filed card show its result briefly before it joins the older prompts. */
const FILED_VISIBLE_MS = 4000
const FOLD_FADE_MS = 350
const NEW_CARD = '* New\n\n'

/**
 * A project's prompt scratchpad (t994): the markdown file the operator drafts prompts in, as cards.
 *
 * ⛔ **The file is the record, this page is an editor of it.** Each card is the text between two
 * `---` lines; every action — reorder, merge, split, tag, delete — is a text edit written back to the
 * same file (`lib/scratchpad.ts`), so it reads the same in VS Code. The daemon writes only over the
 * version this page last read (`scratchpad.save`); when the file moved underneath, the page stops
 * saving and asks which copy wins, rather than choosing.
 *
 * ⭐ **New is what is open.** Only cards marked `* New` show; everything else folds in place under a
 * count (operator's decision, t994). Filing a card — as a task or into a conversation — rewrites its
 * marker to `* Filed t###` / `* Sent t###`, then the card folds after a short confirmation period
 * and moves up with the earlier prompts, so the open ones stay together at the bottom (t1025).
 *
 * ⭐ **The status is the dropdown, not a line of the card (t1025).** A card's editor shows its text
 * without the marker line; *New* / *Completed* in the head writes it. The file, and *Whole document*,
 * still carry the marker.
 */
export function Scratchpad({
  project,
  composeFrom,
  onOpenTask,
  onOpenCount,
  compact = false
}: {
  project: Project
  composeFrom: (seed: ComposerSeed) => void
  onOpenTask: (taskId: string) => void
  /** Tells the tab label how many cards are open, as edits land. */
  onOpenCount?: (count: number) => void
  /**
   * Drawn in a narrow column beside a thread (t1011) rather than as the page. ⚠️ It then scrolls in
   * its own pane, not the page's `.content`: landing at the bottom must not carry the thread with it.
   */
  compact?: boolean
}): React.JSX.Element {
  const projectId = project.id
  const [meta, setMeta] = useState<ScratchpadDoc | null>(null)
  const [doc, setDocState] = useState<ScratchDoc | null>(null)
  const [saveState, setSaveState] = useState<'saved' | 'unsaved' | 'saving'>('saved')
  const [conflict, setConflict] = useState<ScratchpadDoc | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [shown, setShown] = useState<ReadonlySet<number>>(() => new Set())
  const [fading, setFading] = useState<ReadonlySet<number>>(() => new Set())
  const [whole, setWhole] = useState(false)
  const [mode, setMode] = useState<'edit' | 'preview'>('edit')
  const [flipped, setFlipped] = useState<ReadonlySet<number>>(() => new Set())
  const [focusKey, setFocusKey] = useState<number | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])

  // ⚠️ The save loop reads these, not state: it runs from timers and promise callbacks that would
  // otherwise close over a document several keystrokes old.
  const docRef = useRef<ScratchDoc | null>(null)
  const baseRef = useRef('')
  const dirtyRef = useRef(false)
  const savingRef = useRef(false)
  const againRef = useRef(false)
  const conflictRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const filedTimers = useRef(new Map<number, ReturnType<typeof setTimeout>[]>())
  const caretRef = useRef(new Map<number, number>())
  const rootRef = useRef<HTMLDivElement>(null)

  const adopt = useCallback((next: ScratchpadDoc) => {
    const parsed = parseScratch(next.text)
    baseRef.current = next.version
    docRef.current = parsed
    dirtyRef.current = false
    setMeta(next)
    setDocState(parsed)
    setSaveState('saved')
  }, [])

  const refreshTasks = useCallback(() => {
    void rpc('task.list', { projectId })
      .then(setTasks)
      .catch(() => setTasks([]))
  }, [projectId])

  const flush = useMemo(() => {
    const run = async (): Promise<void> => {
      if (conflictRef.current || !docRef.current || !dirtyRef.current) return
      if (savingRef.current) {
        againRef.current = true
        return
      }
      savingRef.current = true
      setSaveState('saving')
      const text = serializeScratch(docRef.current)
      try {
        const result = await rpc('scratchpad.save', { projectId, text, baseVersion: baseRef.current })
        if (result.saved) {
          baseRef.current = result.doc.version
          setMeta(result.doc)
          setError(null)
          if (docRef.current && serializeScratch(docRef.current) === text) {
            dirtyRef.current = false
            setSaveState('saved')
          } else {
            againRef.current = true
          }
        } else {
          conflictRef.current = true
          setConflict(result.doc)
          setSaveState('unsaved')
        }
      } catch (err) {
        setError(errorMessage(err))
        setSaveState('unsaved')
      } finally {
        savingRef.current = false
        if (againRef.current) {
          againRef.current = false
          void run()
        }
      }
    }
    return run
  }, [projectId])

  const change = useCallback(
    (next: ScratchDoc) => {
      docRef.current = next
      dirtyRef.current = true
      setDocState(next)
      setSaveState('unsaved')
      clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => void flush(), SAVE_AFTER_MS)
    },
    [flush]
  )

  useEffect(() => {
    void rpc('scratchpad.get', { projectId })
      .then(adopt)
      .catch((err) => setError(errorMessage(err)))
    refreshTasks()
  }, [projectId, adopt, refreshTasks])

  /**
   * Pick up an edit made elsewhere, but only while nothing here is unsaved: a page holding edits
   * finds out at its next save, which is refused and asks.
   */
  useEffect(() => {
    const check = (): void => {
      if (dirtyRef.current || savingRef.current || conflictRef.current || document.hidden) return
      void rpc('scratchpad.get', { projectId })
        .then((latest) => {
          if (latest.version !== baseRef.current && !dirtyRef.current && !savingRef.current) adopt(latest)
        })
        .catch(() => undefined)
    }
    const timer = setInterval(check, POLL_MS)
    window.addEventListener('focus', check)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', check)
    }
  }, [projectId, adopt])

  // ⛔ Leaving the page writes what was typed, rather than waiting for a timer that will not fire.
  useEffect(
    () => () => {
      clearTimeout(timerRef.current)
      // A card still waiting out its confirmation period goes up now, or it would stay where it was.
      for (const [key, timers] of filedTimers.current) {
        for (const timer of timers) clearTimeout(timer)
        const found = findCard(docRef.current, key)
        if (found) {
          const moved = settleToTop(found.doc, found.at)
          if (moved !== found.doc) {
            docRef.current = moved
            dirtyRef.current = true
          }
        }
      }
      filedTimers.current.clear()
      void flush()
    },
    [flush]
  )

  useEffect(() => {
    if (doc) onOpenCount?.(openCount(doc))
  }, [doc, onOpenCount])

  // Open at the bottom, where the newest prompts are — once, on the first load.
  const landed = useRef(false)
  useEffect(() => {
    if (landed.current || !doc) return
    landed.current = true
    const scroller = rootRef.current?.closest(compact ? '.detail-side--scratchpad' : '.content')
    if (scroller) scroller.scrollTop = scroller.scrollHeight
  }, [doc, compact])

  const resolve = (keep: 'mine' | 'theirs'): void => {
    if (!conflict) return
    conflictRef.current = false
    setConflict(null)
    if (keep === 'theirs') {
      adopt(conflict)
      return
    }
    baseRef.current = conflict.version
    void flush()
  }

  // ------------------------------------------------------------------- card actions, by key

  const reveal = useCallback((keys: number[]) => {
    setShown((prev) => new Set([...prev, ...keys]))
  }, [])

  /** The card with this key in the document as it is now, or null once it has gone. */
  const find = (key: number): Found | null => findCard(docRef.current, key)

  const tagCard = useCallback(
    (key: number, tag: ScratchTag | null) => {
      const found = findCard(docRef.current, key)
      if (!found) return
      reveal([key])
      change(setTag(found.doc, found.at, tag))
      for (const timer of filedTimers.current.get(key) ?? []) clearTimeout(timer)
      filedTimers.current.delete(key)
      setFading((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
      if (tag && tag.kind !== 'new') {
        const fade = setTimeout(() => setFading((prev) => new Set(prev).add(key)), FILED_VISIBLE_MS - FOLD_FADE_MS)
        const fold = setTimeout(() => {
          const settled = findCard(docRef.current, key)
          if (settled) {
            const moved = settleToTop(settled.doc, settled.at)
            if (moved !== settled.doc) change(moved)
          }
          setShown((prev) => {
            const next = new Set(prev)
            next.delete(key)
            return next
          })
          setFading((prev) => {
            const next = new Set(prev)
            next.delete(key)
            return next
          })
          filedTimers.current.delete(key)
        }, FILED_VISIBLE_MS)
        filedTimers.current.set(key, [fade, fold])
      }
    },
    [change, reveal]
  )

  const actions = useMemo<CardActions>(
    () => ({
      edit: (key, text) => {
        const found = find(key)
        if (found) change(setBody(found.doc, found.at, withText(found.item.body, text)))
      },
      settle: (key) => {
        const found = find(key)
        if (!found) return
        const split = setBody(found.doc, found.at, found.item.body, true)
        const added = split.items.length - found.doc.items.length
        if (added > 0) {
          reveal(split.items.slice(found.at, found.at + 1 + added).map((item) => item.key))
          change(carryNew(split, found, added))
        }
      },
      caret: (key, offset) => caretRef.current.set(key, offset),
      move: (key, to) => {
        const found = find(key)
        if (found) change(moveItem(found.doc, found.at, to))
      },
      moveOnto: (key, ontoKey, side) => {
        const found = find(key)
        const onto = find(ontoKey)
        if (found && onto) change(moveBeside(found.doc, found.at, onto.at, side))
      },
      insertBelow: (key) => {
        const current = docRef.current ?? parseScratch('')
        const at = key === null ? current.items.length - 1 : (find(key)?.at ?? current.items.length - 1)
        const added = insertAfter(current, NEW_CARD, at)
        setFocusKey(added.key)
        change(added.doc)
      },
      split: (key) => {
        const found = find(key)
        if (!found) return
        // The caret is in the text the editor shows, which starts after the marker line.
        const caret = caretRef.current.get(key)
        const next = splitAt(
          found.doc,
          found.at,
          caret === undefined ? found.item.body.length : caret + markerLength(found.item.body)
        )
        if (next === found.doc) {
          setNote('Put the cursor inside the text where it should be cut, then choose Split.')
          return
        }
        reveal(next.items.slice(found.at, found.at + 2).map((item) => item.key))
        change(carryNew(next, found, 1))
      },
      merge: (key) => {
        const found = find(key)
        if (found) change(mergeWithNext(found.doc, found.at))
      },
      tag: tagCard,
      remove: (key) => {
        const found = find(key)
        if (!found) return
        if (!confirm(`Delete "${titleOf(found.item.body, 60)}"? It is removed from the scratchpad file.`)) return
        change(removeItem(found.doc, found.at))
      },
      copy: (key) => {
        const found = find(key)
        if (!found) return
        void navigator.clipboard
          ?.writeText(promptOf(found.item.body))
          .then(() => setNote('Copied.'))
          .catch(() => setNote('Could not copy to the clipboard.'))
      },
      flip: (key) =>
        setFlipped((prev) => {
          const next = new Set(prev)
          if (!next.delete(key)) next.add(key)
          return next
        }),
      file: (key, kind, pasted) => {
        const prompt = promptOf(find(key)?.item.body ?? '')
        if (!prompt) {
          setNote('This prompt is empty.')
          return
        }
        if (pasted?.busy) {
          setNote('An image is still uploading; try again in a moment.')
          return
        }
        composeFrom({
          prompt,
          ...(kind ? { kind } : {}),
          ...(pasted && pasted.images.length > 0 ? { attachments: pasted.images } : {}),
          onFiled: (task) => {
            // The task owns the uploads now; leaving the chips would offer them to the next filing.
            pasted?.clear()
            tagCard(key, { kind: kind === 'conversation' ? 'sent' : 'filed', ref: `t${task.seq}` })
            refreshTasks()
          }
        })
      },
      send: async (key, target, pasted) => {
        const prompt = promptOf(find(key)?.item.body ?? '')
        if (!prompt) {
          setNote('This prompt is empty.')
          return
        }
        if (pasted?.busy) {
          setNote('An image is still uploading; try again in a moment.')
          return
        }
        try {
          const sent = await rpc('task.message', {
            id: target.id,
            text: prompt,
            ...(pasted && pasted.ids.length > 0 ? { attachmentIds: pasted.ids } : {})
          })
          if (sent.outcome === 'ignored') {
            setNote(`t${target.seq} is no longer there; nothing was sent.`)
            return
          }
          pasted?.clear()
          tagCard(key, { kind: 'sent', ref: `t${target.seq}` })
          setNote(`Sent to t${target.seq}.`)
          refreshTasks()
        } catch (err) {
          setError(errorMessage(err))
        }
      },
      openTask: onOpenTask
    }),
    // `find` reads only the ref.
    [change, reveal, tagCard, composeFrom, refreshTasks, onOpenTask]
  )

  const rows = useMemo(() => (doc ? scratchRows(doc, showAll, shown) : []), [doc, showAll, shown])
  const counts = useMemo(() => {
    const items = doc?.items ?? []
    return { all: items.length, fresh: items.filter((item) => tagOf(item.body)?.kind === 'new').length }
  }, [doc])
  const targets = useMemo(() => conversationTargets(tasks), [tasks])
  const wholeText = useMemo(() => (whole && doc ? serializeScratch(doc) : ''), [whole, doc])

  return (
    <div className={`scratchpad${compact ? ' scratchpad--compact' : ''}`} ref={rootRef}>
      <ScratchpadFile meta={meta} projectRoot={project.root} beforeChange={flush} onChanged={adopt} />

      <div className="scratchpad-bar">
        <button className="btn btn--primary" onClick={() => actions.insertBelow(null)} disabled={!doc}>
          + New prompt
        </button>
        <SegmentedControl
          ariaLabel="Show prompts as"
          value={mode}
          onChange={(value) => {
            setMode(value as 'edit' | 'preview')
            setFlipped(new Set())
          }}
          options={[
            { value: 'edit', label: 'Markdown', title: 'The source, coloured — edit in place' },
            { value: 'preview', label: 'Rendered', title: 'Drawn as the thread draws markdown' }
          ]}
        />
        <label className="scratchpad-toggle">
          <input type="checkbox" checked={showAll} onChange={(event) => setShowAll(event.target.checked)} />
          Show filed and older
        </label>
        <label className="scratchpad-toggle" title="Every prompt in one editor, joined by --- as in the file">
          <input type="checkbox" checked={whole} onChange={(event) => setWhole(event.target.checked)} />
          Whole document
        </label>
        <span className="scratchpad-counts dim">
          {counts.fresh} new · {counts.all} in all
        </span>
        <span className={`scratchpad-save scratchpad-save--${saveState}`} aria-live="polite">
          {saveState === 'saving' ? 'Saving…' : saveState === 'unsaved' ? 'Unsaved' : 'Saved'}
        </span>
      </div>

      {conflict && (
        <div className="notice scratchpad-conflict" role="alert">
          <p>
            <strong>The file changed on disk</strong> since this page read it (another editor or window). Nothing
            was saved here until you choose.
          </p>
          <div className="form-actions">
            <button className="btn" onClick={() => resolve('theirs')}>
              Load the file (drop my unsaved edit)
            </button>
            <button className="btn btn--warn" onClick={() => resolve('mine')}>
              Keep mine (overwrite the file)
            </button>
          </div>
        </div>
      )}
      {error && <div className="alert">{error}</div>}
      {note && (
        <div className="notice scratchpad-note" onClick={() => setNote(null)}>
          {note}
        </div>
      )}

      {!doc ? (
        <div className="empty-inline">
          <p className="dim">Loading the scratchpad…</p>
        </div>
      ) : whole ? (
        <div className="scratchpad-whole">
          <HighlightEditor
            value={wholeText}
            onChange={(text) => change(parseScratch(text))}
            ariaLabel="The whole scratchpad"
          />
        </div>
      ) : doc.items.length === 0 ? (
        <div className="empty-inline">
          <p>No prompts yet.</p>
          <p className="dim">
            Draft prompts here before they are ready to file. A line of <code>---</code> starts the next one; a
            new prompt is marked <code>* New</code> until it is filed or sent.
          </p>
        </div>
      ) : (
        <div className="scratchpad-cards">
          {rows.map((row, r) =>
            row.kind === 'fold' ? (
              <button key={`fold-${row.keys[0]}`} className="scratchpad-fold" onClick={() => reveal(row.keys)}>
                ▸ {row.keys.length} {row.keys.length === 1 ? 'older prompt' : 'older prompts'}
              </button>
            ) : (
              <ScratchCard
                key={row.item.key}
                item={row.item}
                last={row.index === doc.items.length - 1}
                above={neighbour(rows, r, -1)}
                below={neighbour(rows, r, 1)}
                preview={(mode === 'preview') !== flipped.has(row.item.key)}
                fading={!showAll && fading.has(row.item.key)}
                autoFocus={focusKey === row.item.key}
                tasks={tasks}
                targets={targets}
                actions={actions}
              />
            )
          )}
        </div>
      )}
      <button className="btn btn--primary scratchpad-new-bottom" onClick={() => actions.insertBelow(null)} disabled={!doc}>
        + New prompt
      </button>
    </div>
  )
}

/**
 * A New card cut in two is two New prompts: the pieces after the first are marked too, or they would
 * fold away as *older* the next time the file is read.
 */
function carryNew(doc: ScratchDoc, from: Found, added: number): ScratchDoc {
  if (tagOf(from.item.body)?.kind !== 'new') return doc
  let next = doc
  for (let at = from.at + 1; at <= from.at + added; at++) {
    const body = next.items[at]?.body ?? ''
    if (!tagOf(body)) next = setTag(next, at, { kind: 'new' })
  }
  return next
}

interface Found {
  doc: ScratchDoc
  at: number
  item: ScratchItem
}

function findCard(doc: ScratchDoc | null, key: number): Found | null {
  const at = doc?.items.findIndex((item) => item.key === key) ?? -1
  const item = doc?.items[at]
  return doc && item ? { doc, at, item } : null
}

/**
 * The file position of the nearest card drawn above or below row `r`.
 *
 * ⚠️ Not `index ± 1`: with older prompts folded, that is usually a card nobody can see, and a move
 * that swaps with it leaves the card exactly where it was on screen.
 */
function neighbour(rows: ScratchRow[], r: number, step: -1 | 1): number | undefined {
  for (let i = r + step; i >= 0 && i < rows.length; i += step) {
    const row = rows[i]
    if (row?.kind === 'item') return row.index
  }
  return undefined
}

interface CardActions {
  edit: (key: number, body: string) => void
  /** On blur: a `---` typed into the card splits it there. */
  settle: (key: number) => void
  caret: (key: number, offset: number) => void
  move: (key: number, to: number) => void
  moveOnto: (key: number, ontoKey: number, side: 'before' | 'after') => void
  insertBelow: (key: number | null) => void
  split: (key: number) => void
  merge: (key: number) => void
  tag: (key: number, tag: ScratchTag | null) => void
  remove: (key: number) => void
  copy: (key: number) => void
  flip: (key: number) => void
  /** `pasted` is the card's own pasted images (t1025): they go with the filing or the message. */
  file: (key: number, kind?: 'conversation', pasted?: PasteImages) => void
  send: (key: number, target: Task, pasted?: PasteImages) => Promise<void>
  openTask: (taskId: string) => void
}

const DRAG_TYPE = 'application/x-warmstart-scratch-card'

const ScratchCard = memo(function ScratchCard({
  item,
  last,
  above,
  below,
  preview,
  fading,
  autoFocus,
  tasks,
  targets,
  actions
}: {
  item: ScratchItem
  last: boolean
  /** The card drawn above and below this one, skipping folds: where Move up / Move down lands. */
  above: number | undefined
  below: number | undefined
  preview: boolean
  fading: boolean
  autoFocus: boolean
  tasks: Task[]
  targets: Task[]
  actions: CardActions
}): React.JSX.Element {
  const [dropping, setDropping] = useState<'before' | 'after' | null>(null)
  // Images pasted into this card wait here, uploaded already, for File as task… or Send (t1025).
  const pasted = usePastedImages()
  const tag = tagOf(item.body)
  const linked = tag && (tag.kind === 'filed' || tag.kind === 'sent') ? taskForRef(tasks, tag.ref) : undefined
  const key = item.key

  const sendOptions: PillOption[] = [
    ...targets.map((t) => ({ value: t.id, label: `t${t.seq} · ${taskLabelShort(t, 60)}` })),
    { value: '', label: 'New conversation…', hint: 'Opens the composer with this prompt, as a Conversation' }
  ]
  const moreOptions: PillOption[] = [
    { value: 'copy', label: 'Copy prompt' },
    { value: 'below', label: 'New prompt below' },
    { value: 'split', label: 'Split at cursor', hint: 'Cuts this prompt in two where the cursor was last' },
    { value: 'merge', label: 'Merge with next', disabled: last },
    { value: 'up', label: 'Move up', disabled: above === undefined },
    { value: 'down', label: 'Move down', disabled: below === undefined },
    { value: 'delete', label: 'Delete…' }
  ]
  const onMore = (value: string): void => {
    if (value === 'copy') actions.copy(key)
    else if (value === 'below') actions.insertBelow(key)
    else if (value === 'split') actions.split(key)
    else if (value === 'merge') actions.merge(key)
    else if (value === 'up' && above !== undefined) actions.move(key, above)
    else if (value === 'down' && below !== undefined) actions.move(key, below)
    else if (value === 'delete') actions.remove(key)
  }

  return (
    <article
      className={`scratch-card${fading ? ' scratch-card--fading' : ''}`}
      data-tag={tag?.kind ?? 'none'}
      data-drop={dropping ?? undefined}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(DRAG_TYPE)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        setDropping(dropSide(event.currentTarget, event.clientY))
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropping(null)
      }}
      onDrop={(event) => {
        event.preventDefault()
        setDropping(null)
        const from = Number(event.dataTransfer.getData(DRAG_TYPE))
        if (Number.isFinite(from) && from !== key) actions.moveOnto(from, key, dropSide(event.currentTarget, event.clientY))
      }}
    >
      <header className="scratch-card-head">
        <span
          className="scratch-grip"
          draggable
          title="Drag to reorder"
          aria-hidden="true"
          onDragStart={(event) => {
            event.dataTransfer.setData(DRAG_TYPE, String(key))
            event.dataTransfer.effectAllowed = 'move'
          }}
        >
          ⋮⋮
        </span>
        <StatusPill tag={tag} linked={linked} onPick={(next) => actions.tag(key, next)} onOpenTask={actions.openTask} />
        <div className="scratch-card-actions">
          <button className="btn btn--quiet" onClick={() => actions.flip(key)}>
            {preview ? 'Edit' : 'Preview'}
          </button>
          <button className="btn btn--primary" onClick={() => actions.file(key, undefined, pasted)}>
            File as task…
          </button>
          <Pill
            ariaLabel="Send to a conversation"
            title="Send this prompt to one of this project's open conversations"
            align="right"
            label="Send ▾"
            menu={(close) => (
              <PillOptions
                ariaLabel="Conversations"
                options={sendOptions}
                // Nothing is ticked: each row is an action, not a stored choice.
                value="(none)"
                onPick={(value) => {
                  close()
                  const target = targets.find((t) => t.id === value)
                  if (target) void actions.send(key, target, pasted)
                  else actions.file(key, 'conversation', pasted)
                }}
              />
            )}
          />
          <Pill
            ariaLabel="More for this prompt"
            align="right"
            label="⋯"
            menu={(close) => (
              <PillOptions
                ariaLabel="Prompt actions"
                options={moreOptions}
                value=""
                onPick={(value) => {
                  close()
                  onMore(value)
                }}
              />
            )}
          />
        </div>
      </header>
      {preview ? (
        <div className="scratch-card-preview" onDoubleClick={() => actions.flip(key)}>
          <Markdown text={promptOf(item.body) || '*Empty prompt*'} />
        </div>
      ) : (
        <HighlightEditor
          value={withoutMarker(item.body)}
          onChange={(text) => actions.edit(key, text)}
          onBlur={() => actions.settle(key)}
          onCaret={(offset) => actions.caret(key, offset)}
          onPaste={pasted.onPaste}
          ariaLabel={`Prompt: ${titleOf(item.body, 60)}`}
          autoFocus={autoFocus}
        />
      )}
      <ImageChips paste={pasted} />
    </article>
  )
})

function dropSide(card: HTMLElement, clientY: number): 'before' | 'after' {
  const box = card.getBoundingClientRect()
  return clientY < box.top + box.height / 2 ? 'before' : 'after'
}

const STATUS_OPTIONS: PillOption[] = [
  { value: 'new', label: 'New', hint: 'Open: shown by default, counted on the tab' },
  { value: 'done', label: 'Completed', hint: 'Moves up with the earlier prompts' }
]

/**
 * A card's status as a dropdown (t1025) — the one place it is shown or changed; the marker line itself
 * is not part of the card's text. A filed or sent card reads *Completed* and names its task beside it.
 */
function StatusPill({
  tag,
  linked,
  onPick,
  onOpenTask
}: {
  tag: ScratchTag | null
  linked: Task | undefined
  onPick: (tag: ScratchTag) => void
  onOpenTask: (taskId: string) => void
}): React.JSX.Element {
  const status = tag ? (tag.kind === 'new' ? 'new' : 'done') : ''
  const label = status === 'new' ? 'New' : status === 'done' ? 'Completed' : 'No status'
  const ref = tag && (tag.kind === 'filed' || tag.kind === 'sent') ? tag : null
  return (
    <>
      <PillSelect
        ariaLabel="Prompt status"
        title="New prompts stay open; Completed ones move up with the earlier prompts"
        className={`scratch-status scratch-status--${status || 'none'}`}
        label={`${label} ▾`}
        value={status}
        options={STATUS_OPTIONS}
        muted={status === ''}
        onChange={(next) => {
          if (next !== status) onPick(next === 'new' ? { kind: 'new' } : { kind: 'done' })
        }}
      />
      {ref &&
        (linked ? (
          <button
            className={`scratch-tag scratch-tag--${ref.kind}`}
            title={`Open t${linked.seq} · ${taskLabelShort(linked, 80)}`}
            onClick={() => onOpenTask(linked.id)}
          >
            {ref.kind === 'filed' ? 'Filed' : 'Sent'} {ref.ref}
          </button>
        ) : (
          <span className={`scratch-tag scratch-tag--${ref.kind}`} title="Not a task in this project">
            {ref.kind === 'filed' ? 'Filed' : 'Sent'} {ref.ref}
          </span>
        ))}
    </>
  )
}

/**
 * Which file this is, and the one setting it has: point it somewhere inside the project, or back at
 * the private default. ⛔ Refusals are the daemon's (`setScratchpadPath`); this only asks.
 */
function ScratchpadFile({
  meta,
  projectRoot,
  beforeChange,
  onChanged
}: {
  meta: ScratchpadDoc | null
  projectRoot: string
  beforeChange: () => Promise<void>
  onChanged: (doc: ScratchpadDoc) => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)

  const choose = async (next: string | null): Promise<void> => {
    if (!meta) return
    setBusy(true)
    setRefusal(null)
    try {
      await beforeChange()
      onChanged(await rpc('scratchpad.setPath', { projectId: meta.projectId, path: next }))
      setEditing(false)
    } catch (err) {
      setRefusal(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <header className="scratchpad-head">
      <div className="scratchpad-file">
        <span className="dim">{meta?.relativePath ? 'File' : 'Private file'}</span>{' '}
        <span className="mono tbl-path" title={meta?.path}>
          {meta?.path ?? '…'}
        </span>
        {meta && !meta.exists && <span className="dim"> · created on the first edit</span>}
        {!editing && (
          <button
            className="btn btn--quiet"
            disabled={!meta}
            onClick={() => {
              setPath(meta?.relativePath ?? '')
              setEditing(true)
            }}
          >
            Change file…
          </button>
        )}
      </div>
      {editing && (
        <form
          className="scratchpad-file-form"
          onSubmit={(event) => {
            event.preventDefault()
            void choose(path)
          }}
        >
          <label className="dim" htmlFor="scratchpad-path">
            A .md file inside {projectRoot}
          </label>
          <input
            id="scratchpad-path"
            className="text-input mono"
            value={path}
            placeholder="internal_docs/prompt_history.md"
            onChange={(event) => setPath(event.target.value)}
          />
          <div className="form-actions">
            <button className="btn btn--primary" type="submit" disabled={busy || !path.trim()}>
              Use this file
            </button>
            {meta?.relativePath && (
              <button className="btn" type="button" disabled={busy} onClick={() => void choose(null)}>
                Back to the private file
              </button>
            )}
            <button className="btn btn--quiet" type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
          <p className="dim">
            The private file lives in Warmstart&rsquo;s data directory, outside the repository. A file in the project
            is yours to keep out of git.
          </p>
          {refusal && <div className="alert">{refusal}</div>}
        </form>
      )}
    </header>
  )
}
