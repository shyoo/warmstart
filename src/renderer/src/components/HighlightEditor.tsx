import { memo, useDeferredValue, useEffect, useRef } from 'react'
import { highlightLines } from '../lib/mdhighlight'

/**
 * A markdown source editor that colours what it holds (t994): a transparent `<textarea>` laid over
 * a `<pre>` drawing the same text in colour.
 *
 * ⛔ **The textarea is the editor; the layer is paint.** Typing, selection, undo, IME, spellcheck and
 * the clipboard are the browser's own, and the layer is `aria-hidden` text nodes — never markup made
 * from the text (`lib/mdhighlight.ts` returns tokens whose texts concatenate back to each line).
 * ⚠️ The two must wrap identically, so they share one CSS rule for font, padding and `white-space`
 * (`.hl-editor > *`); the grid puts both in one cell, so the box grows with its text and never
 * scrolls inside itself.
 *
 * ⚠️ The layer draws a deferred copy of the text, so typing into the whole document stays
 * responsive while a 400 KB file re-colours behind it.
 */
export function HighlightEditor({
  value,
  onChange,
  onBlur,
  onCaret,
  ariaLabel,
  autoFocus,
  placeholder
}: {
  value: string
  onChange: (value: string) => void
  onBlur?: () => void
  /** Where the caret is, for *Split at cursor*. */
  onCaret?: (offset: number) => void
  ariaLabel: string
  autoFocus?: boolean
  placeholder?: string
}): React.JSX.Element {
  const painted = useDeferredValue(value)
  const box = useRef<HTMLTextAreaElement>(null)
  // A card just added is where the operator types next — after its `* New` line, not before it.
  useEffect(() => {
    const el = box.current
    if (!autoFocus || !el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
    el.scrollIntoView({ block: 'nearest' })
    // Once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <div className="hl-editor">
      <HighlightLayer text={painted} />
      <textarea
        ref={box}
        className="hl-input"
        value={value}
        aria-label={ariaLabel}
        placeholder={placeholder}
        spellCheck
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        onSelect={(event) => onCaret?.(event.currentTarget.selectionStart)}
      />
    </div>
  )
}

const HighlightLayer = memo(function HighlightLayer({ text }: { text: string }): React.JSX.Element {
  const lines = highlightLines(text)
  return (
    <pre className="hl-layer" aria-hidden="true">
      {lines.map((tokens, i) => (
        <span key={i} className="hl-line">
          {tokens.map((token, j) =>
            token.kind === 'text' ? token.text : (
              <span key={j} className={`hl-${token.kind}`}>
                {token.text}
              </span>
            )
          )}
          {/* ⚠️ A newline after every line, and a space after the last: a trailing empty line in a
              textarea still takes height, and without something in it the layer is a line short. */}
          {i < lines.length - 1 ? '\n' : ' '}
        </span>
      ))}
    </pre>
  )
})
