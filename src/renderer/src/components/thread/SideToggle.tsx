import type { JSX } from 'react'
import type { ThreadSide } from '../../lib/threadside'

/**
 * The two buttons at the right of a thread's title bar (t1011): one shows or hides the status
 * ledger, the other swaps the scratchpad into its place.
 *
 * ⛔ **Pictograms in `currentColor`**, on the precedent `TaskTypeIcon` sets, so one set of shapes
 * serves every theme. Each is a toggle (`aria-pressed`) named by its `title`, because a bare icon says
 * nothing to a screen reader or a first-time hover. ⚠️ Which pane is *showing* is the pressed state
 * of exactly one of them, or neither when the column is closed.
 */
export function SideToggle({
  side,
  hasScratchpad,
  onToggle
}: {
  side: ThreadSide
  /** False for a thread with no project behind it: there is no scratchpad to open. */
  hasScratchpad: boolean
  onToggle: (clicked: 'status' | 'scratchpad') => void
}): JSX.Element {
  return (
    <div className="side-toggle" role="group" aria-label="Side pane">
      <button
        type="button"
        className="side-toggle-btn"
        data-pane="status"
        aria-pressed={side === 'status'}
        title={side === 'status' ? 'Hide the status pane' : 'Show the status pane'}
        onClick={() => onToggle('status')}
      >
        <Icon>
          {/* A window with its right column: the ledger. */}
          <rect x="2" y="3" width="12" height="10" rx="1.8" />
          <path d="M10 3v10" />
        </Icon>
      </button>
      {hasScratchpad && (
        <button
          type="button"
          className="side-toggle-btn"
          data-pane="scratchpad"
          aria-pressed={side === 'scratchpad'}
          title={side === 'scratchpad' ? 'Close the scratchpad' : 'Open the scratchpad beside this thread'}
          onClick={() => onToggle('scratchpad')}
        >
          <Icon>
            {/* A note with a pencil stroke across it. */}
            <path d="M4 2.5h6.5L13 5v8.5H4Z" />
            <path d="M6 7.5h5M6 10h3" />
          </Icon>
        </button>
      )}
    </div>
  )
}

function Icon({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}
