import type { JSX, ReactNode, Ref } from 'react'

export interface SideTimelineProps {
  /** Number of entries in the chronological timeline (runs, compactions, reviews). */
  count: number
  /** Ref forwarded to the underlying `<details>` element so the ledger peek can scroll to and open it. */
  detailsRef?: Ref<HTMLDetailsElement>
  children: ReactNode
}

/**
 * Collapsible timeline box for the right status sidebar, closed by default so the sidebar stays
 * uncluttered until the reader expands it or jumps to a run from `LedgerPeek`.
 */
export function SideTimeline({ count, detailsRef, children }: SideTimelineProps): JSX.Element {
  return (
    <details className="detail-side-box side-timeline-disclosure" ref={detailsRef}>
      {/* ⚠️ The label carries the distinction: attempts and context compactions in chronological order. */}
      <summary
        className="side-label side-timeline-summary"
        title="Chronological timeline of task attempts and context compactions."
      >
        <span className="side-timeline-caret" aria-hidden="true">
          ▶
        </span>
        <span className="side-timeline-title">timeline · runs, compactions &amp; reviews</span>
        <span className="side-timeline-count">({count})</span>
      </summary>
      <div className="side-timeline-body">{children}</div>
    </details>
  )
}
