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
