import { useEffect, useRef, useState } from 'react'
import { MAX_TAG_LENGTH, MAX_TAGS, cleanTags, tagKey, tagsLabel } from '@shared/modeltags'
import { Pill } from './Pill'

/**
 * Tags, drawn once and used everywhere a pair's tags or a task's tag requirement is shown or chosen
 * (t1042): the Settings → Workers matrix, the composer, the plan-piece editor, the thread's
 * reassignment control and the quota redirect.
 *
 * ⛔ **The closed control is one line high and a fixed width, whatever it holds.** At most two short
 * chips and `+N`, each ellipsized; the full list is the tooltip and the accessible name. A row with
 * twelve tags is the same height as a row with one, because the matrix is a table of single lines and
 * a wrapping cell would push the purpose columns around.
 *
 * ⚠️ The popover is `Pill`'s: portalled out of the table's horizontal scroller, flipped and clamped
 * to the viewport, scrolling inside itself, Escape to close, focus returned to the button. It is not
 * rebuilt here because every one of those was a bug once.
 */

/** The most chips drawn before `+N`. */
const SHOWN = 2

export function TagChips({ tags, empty = 'No tags' }: { tags: readonly string[]; empty?: string }): React.JSX.Element {
  if (tags.length === 0) return <span className="tag-chips-empty">{empty}</span>
  const shown = tags.slice(0, SHOWN)
  const hidden = tags.length - shown.length
  return (
    <span className="tag-chips">
      {shown.map((t) => (
        <span key={tagKey(t)} className="tag-chip">
          {t}
        </span>
      ))}
      {hidden > 0 && <span className="tag-chip tag-chip--more">+{hidden}</span>}
    </span>
  )
}

/**
 * A tag button that opens a menu. `menu` is the picker, usually; the closed face is always chips.
 *
 * ⚠️ `disabled` closes an open menu (`Pill`), so a caller that is busy for the length of an RPC must
 * disable the inputs *inside* the menu instead, or every edit would shut the popover it came from.
 */
export function TagsPill({
  tags,
  ariaLabel,
  title,
  empty,
  disabled,
  align,
  className,
  menu
}: {
  tags: readonly string[]
  ariaLabel: string
  title?: string
  empty?: string
  disabled?: boolean
  align?: 'left' | 'right'
  className?: string
  menu: (close: () => void) => React.ReactNode
}): React.JSX.Element {
  const all = tags.length > 0 ? tagsLabel(tags) : (empty ?? 'No tags')
  return (
    <Pill
      className={`tags-pill${className ? ` ${className}` : ''}`}
      ariaLabel={`${ariaLabel}: ${all}`}
      title={title ? `${title} — ${all}` : all}
      label={<TagChips tags={tags} empty={empty} />}
      muted={tags.length === 0}
      disabled={disabled}
      align={align}
      menu={menu}
    />
  )
}

/**
 * The menu body: one checkbox per tag the fleet knows, and — where `onAdd` is given — a box to make
 * a new one.
 *
 * ⛔ **A tag is created by putting it on something.** There is no catalogue to add to first: the
 * add box applies the tag to the pair at hand, and it appears in every other picker because a pair
 * now carries it. `onRemove` is offered only for a tag the subject carries, as an explicit action
 * beside the checkbox for a person who looks for *Remove* rather than *untick*.
 *
 * ⚠️ Changing a selection writes immediately and the menu stays open: a picker that shuts after each
 * tick makes "ZDR and Audio" two trips.
 */
export function TagPicker({
  available,
  selected,
  onChange,
  onAdd,
  onRemove,
  busy,
  label,
  limitHint
}: {
  /** Every tag that can be ticked. A selected tag missing from this list is still drawn, ticked. */
  available: readonly string[]
  selected: readonly string[]
  /** The whole new selection, never a diff — the caller stores it. */
  onChange: (next: string[]) => void
  /** Allow typing a new tag. Absent for a task's requirement, which can only pick what exists. */
  onAdd?: boolean
  onRemove?: boolean
  busy?: boolean
  label: string
  limitHint?: string
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const firstRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    firstRef.current?.focus()
  }, [])

  const chosen = new Set(selected.map(tagKey))
  // A selected tag nobody carries any more stays on the list, ticked: dropping it would silently
  // change what the subject asks for.
  const rows = cleanTags([...available, ...selected])
  const full = selected.length >= MAX_TAGS

  const toggle = (tag: string): void => {
    const key = tagKey(tag)
    if (chosen.has(key)) onChange(selected.filter((t) => tagKey(t) !== key))
    else if (!full) onChange([...selected, tag])
  }
  const add = (): void => {
    const [tag] = cleanTags([draft])
    if (!tag || tag.length > MAX_TAG_LENGTH) return
    setDraft('')
    // Typing a tag that already exists ticks it rather than making a second spelling.
    const existing = rows.find((t) => tagKey(t) === tagKey(tag))
    const spelled = existing ?? tag
    if (!chosen.has(tagKey(spelled)) && !full) onChange([...selected, spelled])
  }

  return (
    <div className="tag-picker" role="group" aria-label={label}>
      {rows.length === 0 ? (
        <p className="tag-picker-empty">No tags yet.</p>
      ) : (
        <ul className="tag-picker-list">
          {rows.map((tag, i) => {
            const on = chosen.has(tagKey(tag))
            return (
              <li key={tagKey(tag)} className="tag-picker-row">
                <label className="tag-picker-label" title={tag}>
                  <input
                    ref={i === 0 ? firstRef : undefined}
                    type="checkbox"
                    checked={on}
                    disabled={busy || (!on && full)}
                    onChange={() => toggle(tag)}
                  />
                  <span className="tag-picker-name">{tag}</span>
                </label>
                {onRemove && on && (
                  <button
                    type="button"
                    className="tag-picker-remove"
                    disabled={busy}
                    aria-label={`Remove tag ${tag}`}
                    title={`Remove ${tag}`}
                    onClick={() => toggle(tag)}
                  >
                    ×
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {full && <p className="tag-picker-note">{limitHint ?? `At most ${MAX_TAGS} tags.`}</p>}
      {onAdd && (
        <form
          className="tag-picker-add"
          onSubmit={(e) => {
            e.preventDefault()
            add()
          }}
        >
          <input
            type="text"
            className="tag-picker-input"
            value={draft}
            maxLength={MAX_TAG_LENGTH}
            disabled={busy || full}
            placeholder="Add a tag"
            aria-label={`New tag for ${label}`}
            onChange={(e) => setDraft(e.target.value)}
            // Enter adds, explicitly, rather than leaning on implicit form submission. ⚠️ Not while an
            // input method is composing: that Enter confirms the composition, it is not "add".
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault()
                add()
              }
            }}
          />
          <button type="submit" className="btn" disabled={busy || full || cleanTags([draft]).length === 0}>
            Add
          </button>
        </form>
      )}
    </div>
  )
}
