/**
 * Markdown source, coloured — the scratchpad editor's tint layer (t994).
 *
 * ⛔ **Text in, text out.** Every line becomes tokens whose texts concatenate back to exactly that
 * line, because the layer is drawn *under* a transparent `<textarea>` holding the same text: one
 * character out and every caret after it sits on the wrong glyph. Nothing here renders markdown —
 * the Preview does that through `lib/markdown.ts` — it only names what a run of characters is so CSS
 * can colour it, the way an editor colours a `.md` file.
 *
 * ⚠️ Line-local apart from code fences. A highlighter that misreads a construct costs a colour, not
 * a character, so it stays simple.
 */

export type MdTokenKind =
  | 'text'
  | 'heading'
  | 'rule'
  | 'marker-new'
  | 'marker-done'
  | 'bullet'
  | 'quote'
  | 'fence'
  | 'code'
  | 'strong'
  | 'em'
  | 'link'

export interface MdToken {
  kind: MdTokenKind
  text: string
}

const FENCE = /^[ \t]{0,3}(```|~~~)/
const RULE = /^[ \t]{0,3}-{3,}[ \t]*$/
const HEADING = /^[ \t]{0,3}#{1,6}(?:[ \t]|$)/
/** The scratchpad's own card markers: `* New`, `* Filed t994`, `* Sent t990`, `* Completed`. See `lib/scratchpad.ts`. */
const MARKER = /^\*[ \t]+(?:new|completed|(?:filed|sent)[ \t]+t\d+(?:\.\d+)*)[ \t]*$/i
const LIST = /^([ \t]*)([*+-]|\d+[.)])([ \t]+)/
const QUOTE = /^([ \t]*>[ \t]?)/
/** Inline code, bold, italics and links, leftmost first. */
const INLINE = /(`+)[^`]*?\1|\*\*[^*\n]+?\*\*|__[^_\n]+?__|\*[^*\s][^*\n]*?\*|(?<![\w])_[^_\s][^_\n]*?_(?![\w])|\[[^\]\n]*\]\([^)\n]*\)/g

function inline(text: string): MdToken[] {
  const out: MdToken[] = []
  let at = 0
  for (const match of text.matchAll(INLINE)) {
    const start = match.index ?? 0
    if (start > at) out.push({ kind: 'text', text: text.slice(at, start) })
    const run = match[0]
    const kind: MdTokenKind = run.startsWith('`')
      ? 'code'
      : run.startsWith('[')
        ? 'link'
        : run.startsWith('**') || run.startsWith('__')
          ? 'strong'
          : 'em'
    out.push({ kind, text: run })
    at = start + run.length
  }
  if (at < text.length) out.push({ kind: 'text', text: text.slice(at) })
  return out
}

function line(text: string): MdToken[] {
  if (RULE.test(text)) return [{ kind: 'rule', text }]
  if (HEADING.test(text)) return [{ kind: 'heading', text }]
  if (MARKER.test(text)) return [{ kind: /^\*[ \t]+new\b/i.test(text) ? 'marker-new' : 'marker-done', text }]
  const list = LIST.exec(text)
  if (list) {
    const [whole, indent = '', bullet = '', gap = ''] = list
    return [
      ...(indent ? [{ kind: 'text' as const, text: indent }] : []),
      { kind: 'bullet', text: bullet },
      { kind: 'text', text: gap },
      ...inline(text.slice(whole.length))
    ]
  }
  const quote = QUOTE.exec(text)?.[1]
  if (quote) return [{ kind: 'quote', text: quote }, ...inline(text.slice(quote.length))]
  return text === '' ? [] : inline(text)
}

export function highlightLines(text: string): MdToken[][] {
  let fence: string | null = null
  return text.split('\n').map((source) => {
    const open = FENCE.exec(source)?.[1]
    if (open) {
      if (fence === null) fence = open
      else if (open === fence) fence = null
      return [{ kind: 'fence', text: source }]
    }
    if (fence !== null) return source === '' ? [] : [{ kind: 'code', text: source }]
    return line(source)
  })
}
