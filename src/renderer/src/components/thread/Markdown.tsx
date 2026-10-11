import { Fragment, useState } from 'react'
import { stripAnsi } from '@shared/ansi'
import { foldAt } from '../../lib/collapse'
import { markdownBlocks, type Block, type Inline, type TableAlign } from '../../lib/markdown'

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
export function Markdown({
  text,
  onOpenFile
}: {
  text: string
  onOpenFile?: (path: string) => void
}): React.JSX.Element {
  // ⚠️ Stripped here as well as where the daemon writes: a thread written before 2026-09-11 holds
  // check output with vitest's colour codes in it, and a person reading it now should not.
  const blocks = markdownBlocks(stripAnsi(text))
  return (
    <div className="md">
      {blocks.map((block, i) => (
        <MarkdownBlock key={i} block={block} onOpenFile={onOpenFile} />
      ))}
    </div>
  )
}

/**
 * `Markdown`, folded past `COLLAPSE_AFTER_LINES` behind a press — for an agent's whole closing
 * reply (t734). Open by press only, and the rest is in the DOM either way (`hidden`). See `foldAt`.
 */
export function FoldedMarkdown({
  text,
  onOpenFile
}: {
  text: string
  onOpenFile?: (path: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const folded = foldAt(text)
  if (!folded) return <Markdown text={text} onOpenFile={onOpenFile} />
  return (
    <>
      <Markdown text={folded.head} onOpenFile={onOpenFile} />
      <div hidden={!open}>
        <Markdown text={folded.rest} onOpenFile={onOpenFile} />
      </div>
      <button
        type="button"
        className="approval-toggle"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        {open ? 'Show less' : `Show more (${folded.restLines} more lines)`}
      </button>
    </>
  )
}

function MarkdownBlock({
  block,
  onOpenFile
}: {
  block: Block
  onOpenFile?: (path: string) => void
}): React.JSX.Element {
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
          <Spans spans={block.spans} onOpenFile={onOpenFile} />
        </div>
      )
    }
    case 'quote':
      return (
        <blockquote className="md-quote">
          <Spans spans={block.spans} onOpenFile={onOpenFile} />
        </blockquote>
      )
    case 'table':
      // ⚠️ Scrolls sideways inside its own wrapper: a nine-column table in a chat bubble would
      // otherwise widen the whole thread pane. Alignment is a class, never an inline style.
      return (
        <div className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {block.header.map((cell, c) => (
                  <th key={c} className={alignClass(block.align[c])}>
                    <Spans spans={cell} onOpenFile={onOpenFile} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c} className={alignClass(block.align[c])}>
                      <Spans spans={cell} onOpenFile={onOpenFile} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul'
      return (
        <Tag className="md-list" {...(block.ordered && block.start !== 1 ? { start: block.start } : {})}>
          {block.items.map((item, i) => (
            <li key={i} className={`md-item md-depth${item.depth}`}>
              <Spans spans={item.spans} onOpenFile={onOpenFile} />
            </li>
          ))}
        </Tag>
      )
    }
    default:
      return (
        <p className="md-p">
          <Spans spans={block.spans} onOpenFile={onOpenFile} />
        </p>
      )
  }
}

function alignClass(align: TableAlign | undefined): string | undefined {
  return align ? `md-cell-${align}` : undefined
}

function Spans({
  spans,
  onOpenFile
}: {
  spans: Inline[]
  onOpenFile?: (path: string) => void
}): React.JSX.Element {
  return (
    <>
      {spans.map((span, i) => {
        switch (span.kind) {
          case 'artifact': {
            const target = span.path ?? span.text
            return onOpenFile ? (
              <button
                key={i}
                type="button"
                className="md-artifact"
                title={`Open ${target} in Viewer`}
                onClick={() => onOpenFile(target)}
              >
                <svg className="md-artifact-icon" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M3 2.5A1.5 1.5 0 0 1 4.5 1h5l3.5 3.5v9A1.5 1.5 0 0 1 11.5 15h-7A1.5 1.5 0 0 1 3 13.5v-11z" />
                  <path d="M9.5 1v3.5H13" />
                </svg>
                <span className="md-artifact-text">{span.text}</span>
              </button>
            ) : (
              <span key={i} className="md-artifact md-artifact--static" title={target}>
                <svg className="md-artifact-icon" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M3 2.5A1.5 1.5 0 0 1 4.5 1h5l3.5 3.5v9A1.5 1.5 0 0 1 11.5 15h-7A1.5 1.5 0 0 1 3 13.5v-11z" />
                  <path d="M9.5 1v3.5H13" />
                </svg>
                <span className="md-artifact-text">{span.text}</span>
              </span>
            )
          }
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
