import React from 'react'

/**
 * Routing Model view under Analytics.
 *
 * Explains how the scheduler scores workers and sessions to route tasks,
 * and acts as the destination for future live routing traces and candidate inspectability.
 */
export function RoutingModel(): React.JSX.Element {
  return (
    <div className="panel">
      <header className="panel-head">
        <div>
          <h2>Routing Model</h2>
          <p className="panel-sub">
            How the scheduler selects the worker, session, and moment where each task is executed
            at lowest cost and highest velocity.
          </p>
        </div>
        <span className="tag tag--idle">In Development</span>
      </header>

      <div className="notice" style={{ marginBottom: 'var(--sp-4)' }}>
        <strong>Live Routing Analytics coming soon.</strong> Real-time candidate scoring tables,
        consult logs, and dispatch trace visualizations are currently being developed.
        Below is the conceptual model the scheduler executes on every tick.
      </div>

      <section className="doc-section">
        <h3>1. The Objective Vector</h3>
        <p className="panel-sub" style={{ marginBottom: 'var(--sp-3)' }}>
          Every dispatch decision balances three fundamental forces configured in Fleet &amp; Project
          settings:
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 'var(--sp-3)' }}>
          <div className="card" style={{ padding: 'var(--sp-3)', background: 'var(--color-surface)' }}>
            <h4 style={{ margin: '0 0 var(--sp-1)', fontSize: 'var(--text-body)', fontWeight: 600 }}>Cost Weight</h4>
            <p className="dim" style={{ margin: 0, fontSize: 'var(--text-dense)' }}>
              Prioritizes reusing warm prompt caches, cheaper models, and high-efficiency agents.
              Suppresses speculative cold starts.
            </p>
          </div>
          <div className="card" style={{ padding: 'var(--sp-3)', background: 'var(--color-surface)' }}>
            <h4 style={{ margin: '0 0 var(--sp-1)', fontSize: 'var(--text-body)', fontWeight: 600 }}>Velocity Weight</h4>
            <p className="dim" style={{ margin: 0, fontSize: 'var(--text-dense)' }}>
              Dispatches immediately to any available worker without waiting for optimal cache
              resets. Prefers parallel execution over serialized reuse.
            </p>
          </div>
          <div className="card" style={{ padding: 'var(--sp-3)', background: 'var(--color-surface)' }}>
            <h4 style={{ margin: '0 0 var(--sp-1)', fontSize: 'var(--text-body)', fontWeight: 600 }}>Quality Weight</h4>
            <p className="dim" style={{ margin: 0, fontSize: 'var(--text-dense)' }}>
              Selects frontier models and high-capability agents for complex tasks, tolerating
              higher token consumption.
            </p>
          </div>
        </div>
      </section>

      <section className="doc-section">
        <h3>2. Routing Evaluation Rules</h3>
        <table className="tbl">
          <thead>
            <tr>
              <th>Factor</th>
              <th>How it affects scoring</th>
              <th>Fallback / Gate</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="tbl-strong">Warm Session Affinity</td>
              <td>
                Reusing an open, warm session provides up to a 90% token discount. Candidates holding
                the existing conversation score highest.
              </td>
              <td className="dim">Cold start if expired or model differs</td>
            </tr>
            <tr>
              <td className="tbl-strong">Window &amp; Quota Risk</td>
              <td>
                Accounts approaching their quota window limit (high-water mark 92%) are penalized.
              </td>
              <td className="dim">Holds task if all workers exceed limit</td>
            </tr>
            <tr>
              <td className="tbl-strong">Worker Capacity</td>
              <td>
                Workers running at their <code>maxConcurrent</code> capacity cannot accept work.
              </td>
              <td className="dim">Task held in queue until a slot frees</td>
            </tr>
            <tr>
              <td className="tbl-strong">Learned Agent Multipliers</td>
              <td>
                Priced token estimates adjust based on historical efficiency factors (from the Cost Model).
              </td>
              <td className="dim">Neutral baseline (×1.00) when unmeasured</td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>
  )
}
