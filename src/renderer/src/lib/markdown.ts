/**
 * The markdown a thread message is allowed to carry, parsed into blocks and inline runs.
 *
 * ⛔ **This replaces the rule that there was no markdown here, and the rule was right for what it
 * was written about.** `codeSpans` says every message in a task thread is written by this codebase
 * or typed by an operator, and that identifiers in backticks were the whole of what they contained.
 * That stopped being true when conversations arrived: an agent's reply is *its own prose*, written
 * by a CLI whose house style is markdown, and t369's thread rendered `**So the order is:**` and
 * `## Yes — macOS` as literal asterisks and hashes down the page (reported 2026-09-11). The reader
 * got the punctuation and none of the structure it encodes — the same failure the backticks had,
 * one layer up.
 *
 * ⛔ **A closed list of constructs, and no HTML, ever.** Agent output is untrusted text
 * (AGENTS.md: *the TUI is for humans, the transcript is for the machine*), so nothing here produces
 * markup from the message's own characters: there is no raw-HTML passthrough, no `dangerouslySet…`
 * anywhere downstream, and the only attribute any of this can reach is a link's `href` — which is
 * whitelisted to `http`, `https` and `mailto` here, at the parse, so a `javascript:` URL is not a
 * link at all and renders as the text it was written as.
 *
 * ⛔ **Nothing here reads state out of a message.** It decides how text is *drawn*. No caller may
 * branch on a block kind to decide what a run did — that is what the transcript and the typed
 * events are for.
 *
 * ⚠️ **Deliberately not CommonMark.** No nested block structure, no reference links, no tables, no
 * setext headings, no HTML entities. Those are a parser's worth of edge cases in exchange for
 * constructs that do not appear in the output this exists to render; what is here is what an agent
 * CLI actually emits. A construct this does not know is left as the literal characters the agent
 * wrote, which is the same thing the whole thread did before and is never wrong, only plain.
 *
 * ⚠️ **Split from the rendering on purpose**, for the reason `codeSpans` gives: the parsing is what
 * can be wrong in an interesting way, and a pure function over strings is the only shape of that a
 * test can pin cheaply.
 */

/** One run of text inside a block, and what it is set as. */
export interface Inline {
  kind: 'text' | 'code' | 'strong' | 'em' | 'strike' | 'link'
  text: string
  /** Only on `link`, and only ever an `http`, `https` or `mailto` URL. */
  href?: string
}

export type Block =
  | { kind: 'heading'; level: number; spans: Inline[] }
  | { kind: 'paragraph'; spans: Inline[] }
  /** ⚠️ `text` is verbatim, including its newlines: a code fence is the one place they are data. */
  | { kind: 'code'; lang: string | null; text: string }
  | { kind: 'list'; ordered: boolean; start: number; items: Array<{ spans: Inline[]; depth: number }> }
  | { kind: 'quote'; spans: Inline[] }
  | { kind: 'rule' }

/** ⛔ The whole of what a link may point at. Everything else stays literal text. */
const SAFE_SCHEME = /^(https?:|mailto:)/i

/**
 * ⚠️ **Order matters and the code span goes first.** Backticks are the strongest fence in this
 * grammar — `**` inside one is two asterisks, not emphasis — so the code alternative has to win the
 * match, which in a single regex means being written first.
 *
 * ⚠️ No newline inside any of them, for the reason `CODE_SPAN` gives in `codespans.ts`: a lone `*`
 * an operator typed would otherwise swallow every line up to the next one.
 */
const INLINE =
  /(`[^`\n]+`)|(\*\*[^\n]+?\*\*)|(~~[^\n]+?~~)|(\*[^\s*][^\n]*?\*|_[^\s_][^\n]*?_)|(\[[^\]\n]*\]\([^)\s]+\))|(https?:\/\/[^\s<>"'`]+)/i

/**
 * ⭐ **A bare URL is a link.** *"Pull request opened for `…` into `main`: https://github.com/…/pull/141"*
 * printed an address nobody could click (t401, 2026-09-12), and agents write bare URLs far more often
 * than `[text](url)`. ⚠️ Trailing sentence punctuation is not part of it — a URL at the end of a
 * sentence would otherwise open `…/pull/141.` — and a closing bracket is kept only when the URL
 * opened one, so `(see https://x/y)` does not swallow the parenthesis.
 */
function trimUrl(url: string): string {
  let out = url.replace(/[.,;:!?]+$/, '')
  while (out.endsWith(')') && (out.match(/\(/g)?.length ?? 0) < (out.match(/\)/g)?.length ?? 0)) {
    out = out.slice(0, -1).replace(/[.,;:!?]+$/, '')
  }
  return out
}

/**
 * Split one line's worth of text into its inline runs.
 *
 * ⛔ Total, like `codeSpans`: concatenating every `text` back, minus the fences, is the input. A
 * string with no markup in it returns one `text` run rather than an empty list.
 */
export function inlineSpans(text: string): Inline[] {
  const out: Inline[] = []
  let rest = text
  while (rest.length > 0) {
    const match = INLINE.exec(rest)
    if (!match || match.index === undefined) break
    if (match.index > 0) out.push({ kind: 'text', text: rest.slice(0, match.index) })
    let token = match[0]
    if (match[6]) {
      // ⚠️ Only `http`/`https` can reach this alternative, so the scheme whitelist below holds for it
      // by construction; the trim can shorten the token, and what it cut is left for the next pass.
      token = trimUrl(token)
      out.push({ kind: 'link', text: token, href: token })
      rest = rest.slice(match.index + token.length)
      continue
    }
    if (token.startsWith('`')) {
      out.push({ kind: 'code', text: token.slice(1, -1) })
    } else if (token.startsWith('**')) {
      out.push({ kind: 'strong', text: token.slice(2, -2) })
    } else if (token.startsWith('~~')) {
      out.push({ kind: 'strike', text: token.slice(2, -2) })
    } else if (token.startsWith('[')) {
      const split = token.indexOf('](')
      const label = token.slice(1, split)
      const href = token.slice(split + 2, -1)
      // ⛔ Whitelisted at the parse, not at the render: a scheme this does not know never becomes an
      // `href`, so no component downstream has to remember to check one.
      if (SAFE_SCHEME.test(href)) out.push({ kind: 'link', text: label || href, href })
      else out.push({ kind: 'text', text: token })
    } else {
      out.push({ kind: 'em', text: token.slice(1, -1) })
    }
    rest = rest.slice(match.index + token.length)
  }
  if (rest.length > 0) out.push({ kind: 'text', text: rest })
  return out
}

const HEADING = /^(#{1,6})\s+(.*)$/
const FENCE = /^\s*(?:```|~~~)\s*([A-Za-z0-9_+-]*)\s*$/
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/
const BULLET = /^(\s*)[-*+]\s+(.*)$/
const NUMBERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/
const QUOTE = /^\s*>\s?(.*)$/

/** How far a list item may be indented before the indentation stops meaning anything. */
const MAX_DEPTH = 3

function depthOf(indent: string): number {
  return Math.min(MAX_DEPTH, Math.floor(indent.replace(/\t/g, '  ').length / 2))
}

/**
 * Parse a whole message into blocks.
 *
 * ⛔ **A fence is opened by its own line and closed by the next one, and nothing inside it is
 * parsed.** An unterminated fence runs to the end of the message rather than failing: an agent's
 * reply can be truncated mid-block, and the honest rendering of half a code block is half a code
 * block, not a page of text set as prose.
 *
 * ⚠️ **Line breaks inside a paragraph are kept**, which CommonMark would fold away. This is a chat
 * transcript: an agent that wrote three short lines meant three lines, and joining them is a change
 * to what it said. The renderer sets paragraphs `pre-wrap` to match.
 */
export function markdownBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let para: string[] = []
  let quote: string[] = []

  const flushParagraph = (): void => {
    if (para.length === 0) return
    blocks.push({ kind: 'paragraph', spans: inlineSpans(para.join('\n')) })
    para = []
  }
  const flushQuote = (): void => {
    if (quote.length === 0) return
    blocks.push({ kind: 'quote', spans: inlineSpans(quote.join('\n')) })
    quote = []
  }
  const flush = (): void => {
    flushParagraph()
    flushQuote()
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string
    const fence = FENCE.exec(line)
    if (fence) {
      flush()
      const body: string[] = []
      i += 1
      while (i < lines.length && !FENCE.test(lines[i] as string)) {
        body.push(lines[i] as string)
        i += 1
      }
      blocks.push({ kind: 'code', lang: fence[1] || null, text: body.join('\n') })
      continue
    }

    if (line.trim() === '') {
      flush()
      continue
    }

    const quoted = QUOTE.exec(line)
    if (quoted) {
      flushParagraph()
      quote.push(quoted[1] as string)
      continue
    }
    flushQuote()

    // ⚠️ Ahead of the bullet, because `---` matches `[-*+]\s+` the moment somebody writes `- - -`
    // and a rule set as a one-item list is the wrong reading of an unambiguous line.
    if (RULE.test(line)) {
      flush()
      blocks.push({ kind: 'rule' })
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      flush()
      blocks.push({
        kind: 'heading',
        level: (heading[1] as string).length,
        spans: inlineSpans(heading[2] as string)
      })
      continue
    }

    const bullet = BULLET.exec(line)
    const numbered = NUMBERED.exec(line)
    if (bullet || numbered) {
      flushParagraph()
      const ordered = !bullet
      const indent = (bullet ? bullet[1] : numbered?.[1]) as string
      const body = (bullet ? bullet[2] : numbered?.[3]) as string
      const last = blocks[blocks.length - 1]
      // ⚠️ Runs of the same kind join into one list; a bullet run interrupted by an ordered one
      // starts a second list, because they are two lists and numbering one from the other's start
      // would print numbers nobody wrote.
      if (last && last.kind === 'list' && last.ordered === ordered) {
        last.items.push({ spans: inlineSpans(body), depth: depthOf(indent) })
      } else {
        blocks.push({
          kind: 'list',
          ordered,
          start: ordered ? Number.parseInt(numbered?.[2] ?? '1', 10) : 1,
          items: [{ spans: inlineSpans(body), depth: depthOf(indent) }]
        })
      }
      continue
    }

    para.push(line)
  }
  flush()
  return blocks
}

/**
 * Is there anything in this text a markdown reading would change?
 *
 * ⚠️ For the one caller that needs to ask rather than render: a message of plain prose parses to a
 * single paragraph of a single `text` run, and is identical either way.
 */
export function hasMarkdown(text: string): boolean {
  const blocks = markdownBlocks(text)
  if (blocks.length !== 1) return true
  const only = blocks[0]
  if (!only || only.kind !== 'paragraph') return true
  return only.spans.length !== 1 || only.spans[0]?.kind !== 'text'
}
