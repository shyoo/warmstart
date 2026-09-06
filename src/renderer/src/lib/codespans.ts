/**
 * The one piece of markdown a thread message is allowed to carry: an inline code span.
 *
 * ⛔ **Not a markdown renderer, and it must not become one.** Every message in a task thread is
 * written by this codebase — `landing.ts`, `finish.ts`, `scheduler.ts` — or typed by the operator,
 * and what those messages have always contained is *identifiers in backticks*: a branch, a ref, a
 * sha, a file. They were being printed with the backticks showing, which is the worst of both
 * readings: punctuation the reader has to ignore, and no distinction between `main` the branch and
 * main the adjective. Rendering headings, links or emphasis is a different feature with a different
 * risk — an agent's own prose reaching this path — and nothing here needs it.
 *
 * ⚠️ **Split from the rendering on purpose.** The parsing is what can be wrong in an interesting
 * way (an unmatched backtick, a backtick inside a path, a span across a newline), and a pure
 * function over strings is the only shape of that a test can pin cheaply.
 */

/** One run of message text, and whether it was fenced. */
export interface Span {
  text: string
  code: boolean
}

/**
 * ⚠️ **No newline inside a span.** A lone backtick in prose — which an operator will type — would
 * otherwise swallow every line up to the next one and render a paragraph as an identifier. Keeping
 * the match on one line means the worst an unmatched backtick can do is print itself.
 */
const CODE_SPAN = /`([^`\n]+)`/g

/**
 * Split message text into plain and fenced runs, in order.
 *
 * ⛔ Total: concatenating every `text` back together, minus the fences, is the original message. A
 * span that matches nothing returns the whole string as one plain run rather than an empty list.
 */
export function codeSpans(text: string): Span[] {
  if (!text.includes('`')) return text ? [{ text, code: false }] : []
  const out: Span[] = []
  let last = 0
  for (const match of text.matchAll(CODE_SPAN)) {
    const at = match.index
    if (at > last) out.push({ text: text.slice(last, at), code: false })
    out.push({ text: match[1] as string, code: true })
    last = at + match[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last), code: false })
  return out
}
