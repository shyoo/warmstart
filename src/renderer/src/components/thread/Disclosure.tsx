/**
 * The two collapsibles the thread uses to keep a wall of text out of the way without hiding it.
 *
 * ⚠️ Shared by the thread, the run list and the draft controls — three callers that each used to
 * reach into `TaskThread.tsx` for them. Kept apart from both so neither imports the other back.
 */
import { useState } from 'react'
import { when } from '../../lib/format'

/**
 * Collapsible prompt disclosure with character count and copy-to-clipboard.
 */
export function PromptDisclosure({
  prompt,
  label = 'Prompt sent to agent',
  defaultOpen = false
}: {
  prompt: string
  label?: string
  defaultOpen?: boolean
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const copy = (e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    void navigator.clipboard.writeText(prompt).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <details className="prompt-disclosure" open={defaultOpen}>
      <summary className="prompt-disclosure-summary">
        <span className="prompt-disclosure-title">
          <span className="prompt-disclosure-icon">📋</span> {label}
        </span>
        <span className="prompt-disclosure-meta">
          <span>{prompt.length.toLocaleString()} chars</span>
          <button
            type="button"
            className="btn btn--xs btn--ghost prompt-copy-btn"
            onClick={copy}
            title="Copy full prompt text"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </span>
      </summary>
      <div className="prompt-disclosure-body">
        <pre className="prompt-pre">{prompt}</pre>
      </div>
    </details>
  )
}

/**
 * The prompt a run was sent, as a chip under a chat bubble: `📋 1,475`.
 *
 * ⛔ **A chip, not a row.** The thread used to spend a full-width disclosure on every run — *"Prompt
 * sent for run 3f9a…"* — which in a conversation put a bar of chrome between every pair of bubbles.
 * The count is what a reader scanning wants (how much was this agent handed?); the text is one click
 * away, in a dialog rather than unfolded inside the bubble, because a prompt is routinely longer than
 * the whole conversation around it.
 */
export function PromptChip({
  prompt,
  title = 'The prompt this run was sent'
}: {
  prompt: string
  title?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const count = prompt.length.toLocaleString()
  const copy = () => {
    void navigator.clipboard.writeText(prompt).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <>
      <button
        type="button"
        className="prompt-chip"
        title={`${title} — ${count} characters. Click to read or copy it.`}
        aria-label={`${title}, ${count} characters`}
        onClick={() => setOpen(true)}
      >
        📋 {count}
      </button>
      {open && (
        <div className="confirm-shade" role="presentation" onClick={() => setOpen(false)}>
          <div
            className="confirm-dialog prompt-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={title}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpen(false)
            }}
          >
            <div className="prompt-dialog-head">
              <h3>{title}</h3>
              <span className="num dim">{count} chars</span>
            </div>
            <pre className="prompt-pre prompt-dialog-body">{prompt}</pre>
            <div className="confirm-actions">
              <button type="button" className="btn" onClick={copy}>
                {copied ? 'Copied' : 'Copy'}
              </button>
              <button type="button" className="btn btn--primary" autoFocus onClick={() => setOpen(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

/**
 * Collapsible intermediate activity disclosure with step count and copy-to-clipboard.
 */
export function ActivityDisclosure({
  activity,
  label = 'Intermediate activity',
  defaultOpen = false
}: {
  activity: Array<{ text: string; ts: number }>
  label?: string
  defaultOpen?: boolean
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const fullText = activity.map((a) => a.text).join('\n')
  const copy = (e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    void navigator.clipboard.writeText(fullText).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <details className="prompt-disclosure activity-disclosure" open={defaultOpen}>
      <summary className="prompt-disclosure-summary">
        <span className="prompt-disclosure-title">
          <span className="prompt-disclosure-icon">⚡</span> {label}
        </span>
        <span className="prompt-disclosure-meta">
          <span>
            {activity.length} {activity.length === 1 ? 'step' : 'steps'}
          </span>
          <button
            type="button"
            className="btn btn--xs btn--ghost prompt-copy-btn"
            onClick={copy}
            title="Copy intermediate activity text"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </span>
      </summary>
      <div className="prompt-disclosure-body">
        <div className="activity-disclosure-list">
          {activity.map((line, i) => (
            <div key={`${line.ts}-${i}`} className="activity-disclosure-line">
              <span className="activity-disclosure-ts">{when(line.ts)}</span>
              <span className="activity-disclosure-text">{line.text}</span>
            </div>
          ))}
        </div>
      </div>
    </details>
  )
}
