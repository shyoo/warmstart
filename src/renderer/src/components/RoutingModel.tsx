import { CostModel } from './CostModel'
import { QualityModel } from './QualityModel'
import { RoutingOverview } from './RoutingOverview'
import { VelocityModel } from './VelocityModel'

/**
 * Analytics &rsaquo; Routing Model.
 *
 * ⛔ **One page per axis of the objective vector, plus the overview that ties them together.** The
 * scheduler weighs exactly three things — quality, cost and velocity — and each has its own body of
 * measurement, its own failure modes and its own honest gaps. Splitting them into tabs is not a
 * layout choice: a single page could only ever say what the score *is*, while a reader asking "why
 * did it pick that account" is asking about one axis at a time.
 *
 * ⚠️ The Cost tab is the same `CostModel` page it has always been, moved rather than rewritten. It
 * is the cost half of this same model, and it was reachable from a sibling nav item that implied
 * otherwise.
 */
export type RoutingTab = 'overview' | 'quality' | 'cost' | 'velocity'

export const ROUTING_TABS: Array<{ id: RoutingTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'quality', label: 'Quality' },
  { id: 'cost', label: 'Cost' },
  { id: 'velocity', label: 'Velocity' }
]

export function RoutingModel({
  tab,
  setTab,
  now
}: {
  tab: RoutingTab
  setTab: (tab: RoutingTab) => void
  now: number
}): React.JSX.Element {
  return (
    <div className="panel">
      <header className="panel-head">
        <div>
          <h2>Routing Model</h2>
          <p className="panel-sub">
            How the scheduler decides which account runs each task — the score, the three axes it is
            built from, and the decisions it has actually made.
          </p>
        </div>
      </header>

      <div className="tabs">
        {ROUTING_TABS.map((t) => (
          <button
            key={t.id}
            className={`tab${tab === t.id ? ' tab--active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'overview' ? (
        <RoutingOverview />
      ) : tab === 'quality' ? (
        <QualityModel />
      ) : tab === 'cost' ? (
        <CostModel now={now} />
      ) : (
        <VelocityModel />
      )}
    </div>
  )
}
