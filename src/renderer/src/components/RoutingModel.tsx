import { useRef } from 'react'
import { ROUTING_MODEL_VERSION } from '@shared/routing'
import { CostModel } from './CostModel'
import { ModelsModel } from './ModelsModel'
import { QualityModel } from './QualityModel'
import { RoutingOverview } from './RoutingOverview'
import { VelocityModel } from './VelocityModel'

/**
 * Analytics &rsaquo; Routing Model — written up as a paper, because it is one.
 *
 * ⛔ **One section per axis of the objective vector, plus the introduction that ties them
 * together.** The scheduler weighs exactly three things — quality, cost and velocity — and each has
 * its own body of measurement, its own failure modes and its own honest gaps. Splitting them into
 * numbered sections is not a layout choice: a single page could only ever say what the score *is*,
 * while a reader asking "why did it pick that account" is asking about one axis at a time.
 *
 * ⚠️ The page is a **paper**, not a dashboard: a title, a summary, a table of contents, and
 * numbered sections in a single measured column, with the arithmetic typeset rather than drawn in
 * ASCII. That is deliberate. The routing model is the core of the product and the page is where an
 * operator decides whether to trust it; a scoreboard invites a glance, a paper invites checking.
 * Every number in it is still read back from the ledger or evaluated from the published constants —
 * the format changed, the rule that every belief carries its basis did not.
 *
 * ⚠️ The Cost section is the same `CostModel` page it has always been, moved rather than rewritten.
 * It is the cost half of this same model, and it was reachable from a sibling nav item that implied
 * otherwise.
 *
 * ⭐ **Models earns a section on the same principle.** Routing scores `(worker, model)` pairs, and
 * two terms — `fitness` and `price` — exist only at that granularity; none of the other four has
 * anywhere to show a per-model number, because none of them is scoped below an account.
 */
export type RoutingTab = 'overview' | 'quality' | 'cost' | 'velocity' | 'models'

/**
 * ⛔ The labels are the words the tabs print and the UI suite clicks on (`test/ui.test.mjs`); the
 * section numbers are drawn by CSS in front of them so a label stays one word.
 */
export const ROUTING_TABS: Array<{ id: RoutingTab; label: string; section: string }> = [
  { id: 'overview', label: 'Overview', section: 'Introduction and the model' },
  { id: 'quality', label: 'Quality', section: 'The quality axis' },
  { id: 'cost', label: 'Cost', section: 'The cost axis' },
  { id: 'velocity', label: 'Velocity', section: 'The velocity axis' },
  { id: 'models', label: 'Models', section: 'Choosing a model, not only an account' }
]

export function RoutingModel({
  tab,
  setTab,
  now,
  onOpenQualityReview
}: {
  tab: RoutingTab
  setTab: (tab: RoutingTab) => void
  now: number
  /** ⛔ Grading is commissioned from one place now. The Quality section explains and links. */
  onOpenQualityReview: () => void
}): React.JSX.Element {
  const contents = useRef<HTMLElement>(null)
  const index = ROUTING_TABS.findIndex((t) => t.id === tab)
  const previous = index > 0 ? ROUTING_TABS[index - 1] : null
  const next = index >= 0 && index < ROUTING_TABS.length - 1 ? ROUTING_TABS[index + 1] : null
  /**
   * The pager at the foot of a section is read after scrolling to the bottom of it, so the section
   * it opens must be shown from its top: scroll back to the contents strip, where the section
   * heading follows. ⚠️ Not to the title — the reader is turning a page, not reopening the paper.
   */
  const turnTo = (id: RoutingTab): void => {
    setTab(id)
    contents.current?.scrollIntoView({ block: 'start' })
  }
  return (
    <div className="panel paper">
      <header className="paper-head">
        <h2 className="paper-title">Routing Model v{ROUTING_MODEL_VERSION}</h2>
        <p className="paper-subtitle">
          Account, model, and timing selection for every agent task
        </p>
        <p className="paper-byline">
          Warmstart · Scheduler architecture and routing mechanics · Metrics reflect live fleet state and configured constants
        </p>
      </header>

      <section className="paper-abstract">
        <h4>Summary</h4>
        <p>
          Dispatching coding agents across multiple subscriptions balances three competing factors:{' '}
          <em>quality</em>, <em>cost</em>, and <em>velocity</em>. Choosing the right account, model, and session context
          depends on live prompt caches, quota window resets, and per-project objectives.
          Warmstart evaluates every eligible (account, model) pair using a deterministic scoring formula with zero token overhead.
          Weights are calculated from your configured quality, cost, and velocity objectives, while metrics update continuously
          from active cache state, quota limits, and execution history. Every routing decision is logged with its full calculation.
        </p>
      </section>

      <nav className="tabs paper-contents" aria-label="Contents" ref={contents}>
        {ROUTING_TABS.map((t) => (
          <button
            key={t.id}
            className={`tab${tab === t.id ? ' tab--active' : ''}`}
            title={t.section}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === 'overview' ? (
        <RoutingOverview />
      ) : tab === 'quality' ? (
        <QualityModel onOpenQualityReview={onOpenQualityReview} />
      ) : tab === 'cost' ? (
        <CostModel now={now} />
      ) : tab === 'velocity' ? (
        <VelocityModel />
      ) : (
        <ModelsModel />
      )}

      {/* ⛔ Previous/next at the foot of every section, because the contents strip is at the top
          and a section is several screens long. Each link names the section it turns to, numbered
          as the contents strip numbers it; the class is not `.tab`, so the UI suite's tab lookup
          by label still finds exactly one button per section. */}
      <nav className="paper-pager" aria-label="Previous and next section">
        {previous ? (
          <button
            className="paper-pager-link paper-pager-link--previous"
            onClick={() => turnTo(previous.id)}
            title={previous.section}
          >
            <span className="paper-pager-label">Previous</span>
            <span className="paper-pager-target">
              <span className="paper-pager-number">§{index}</span> {previous.section}
            </span>
          </button>
        ) : (
          <span />
        )}
        {next ? (
          <button
            className="paper-pager-link paper-pager-link--next"
            onClick={() => turnTo(next.id)}
            title={next.section}
          >
            <span className="paper-pager-label">Next</span>
            <span className="paper-pager-target">
              <span className="paper-pager-number">§{index + 2}</span> {next.section}
            </span>
          </button>
        ) : (
          <span />
        )}
      </nav>
    </div>
  )
}
