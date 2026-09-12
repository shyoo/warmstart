import { Fragment } from 'react'
import { stripAnsi } from '@shared/ansi'
import { markdownBlocks, type Block, type Inline } from '../../lib/markdown'

/**
 * A thread message set as the markdown its author wrote.
 *
 * ⛔ **Nothing here builds markup out of message characters.** Every element below is written in
 * this file; the message only ever supplies text nodes and one whitelisted `href`. There is no
 * `dangerouslySetInnerHTML` on this path and there must never be one — agent output is untrusted
 * text (AGENTS.md), and `lib/markdown.ts` is the only thing that decides what any of it means.
 *
 * ⛔ **Links open in the real browser, never in the shell.** `target="_blank"` is caught by
 * `setWindowOpenHandler` in `src/main/index.ts`, which denies the navigation and hands the URL to
 * `shell.openExternal`. An in-window navigation would replace the app with a web page and there
 * would be no way back to it.
 */
export function Markdown({ text }: { text: string }): React.JSX.Element {
  // ⚠️ Stripped here as well as where the daemon writes: a thread written before 2026-09-11 holds
  // check output with vitest's colour codes in it, and a person reading it now should not.
  const blocks = markdownBlocks(stripAnsi(text))
  return (
    <div className="md">
      {blocks.map((block, i) => (
        <MarkdownBlock key={i} block={block} />
      ))}
    </div>
  )
}

function MarkdownBlock({ block }: { block: Block }): React.JSX.Element {
  switch (block.kind) {
    case 'rule':
      return <hr className="md-rule" />
    case 'code':
      // ⚠️ The language is shown rather than highlighted. Naming it is most of what it is for, and
      // a highlighter would be a second grammar reading agent output — see `lib/markdown.ts`.
      return (
        <pre className="md-code" {...(block.lang ? { 'data-lang': block.lang } : {})}>
          <code>{block.text}</code>
        </pre>
      )
    case 'heading': {
      // ⛔ A class, not `h1`–`h6`. These live inside a chat bubble in a pane that has its own
      // document outline, and six levels of real heading inside a message would wreck it for a
      // screen reader without telling a sighted reader anything the size does not already say.
      const level = Math.min(6, Math.max(1, block.level))
      return (
        <div className={`md-h md-h${level}`} role="heading" aria-level={level}>
          <Spans spans={block.spans} />
        </div>
      )
    }
    case 'quote':
      return (
        <blockquote className="md-quote">
          <Spans spans={block.spans} />
        </blockquote>
      )
    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul'
      return (
        <Tag className="md-list" {...(block.ordered && block.start !== 1 ? { start: block.start } : {})}>
          {block.items.map((item, i) => (
            <li key={i} className={`md-item md-depth${item.depth}`}>
              <Spans spans={item.spans} />
            </li>
          ))}
        </Tag>
      )
    }
    default:
      return (
        <p className="md-p">
          <Spans spans={block.spans} />
        </p>
      )
  }
}

function Spans({ spans }: { spans: Inline[] }): React.JSX.Element {
  return (
    <>
      {spans.map((span, i) => {
        switch (span.kind) {
          case 'code':
            return (
              <code className="msg-code" key={i}>
                {span.text}
              </code>
            )
          case 'strong':
            return <strong key={i}>{span.text}</strong>
          case 'em':
            return <em key={i}>{span.text}</em>
          case 'strike':
            return <s key={i}>{span.text}</s>
          case 'link':
            return (
              <a
                className="md-link"
                key={i}
                href={span.href}
                target="_blank"
                rel="noreferrer"
                title={span.href}
              >
                {span.text}
              </a>
            )
          default:
            return <Fragment key={i}>{span.text}</Fragment>
        }
      })}
    </>
  )
}
