import { Cost } from './Cost'
import { LooseEnds } from './LooseEnds'

/**
 * Everything that is true of the whole fleet rather than of one project.
 *
 * ⚠️ Deliberately no live-session list (owner's call, 2026-08-26). What is running right now belongs
 * to the project it is running for, and until sessions carry a project id there is nothing here that
 * could say which.
 */
export function Overview({
  now,
  onOpenCostModel
}: {
  now: number
  onOpenCostModel?: () => void
}): React.JSX.Element {
  return (
    <div className="stack">
      {/* ⛔ Above the cost model, because it is the only thing on this page that is *waiting on a
          person*. Everything below it is a number to read; this is a decision somebody owes. */}
      <LooseEnds />
      <Cost now={now} onOpenCostModel={onOpenCostModel} />
    </div>
  )
}
