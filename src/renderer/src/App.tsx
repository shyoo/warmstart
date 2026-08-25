import { useEffect, useState } from 'react'
import type { AppInfo } from '@shared/ipc'

/**
 * The M0 shell.
 *
 * This deliberately shows a real zero-state rather than mock data. The plan requires that a clean
 * profile with no workers configured opens, says so, and offers the wizard
 * (transient_docs/implementation_plan_2026-08-24.md §15) — so that behaviour exists from the first
 * commit rather than being retrofitted after mock data has shaped the layout.
 *
 * M1 fills the fleet strip and sidebar; M2 fills the content area with the task table.
 */
export function App(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    void window.agentyard.getAppInfo().then(setInfo)
  }, [])

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <h1>agentyard</h1>
          <span className="version num">{info ? `v${info.version}` : ''}</span>
        </div>

        <nav className="nav-group">
          <h2>Projects</h2>
          <p className="nav-empty">None yet — M2</p>
        </nav>

        <nav className="nav-group">
          <h2>Resources</h2>
          <p className="nav-empty">None yet — M2</p>
        </nav>

        <nav className="nav-group">
          <h2>Settings</h2>
          <p className="nav-empty">Workers · M1</p>
        </nav>
      </aside>

      <main className="main">
        <header className="fleet">
          <span className="fleet-label">Fleet</span>
          <span style={{ color: 'var(--color-text-faint)', fontSize: 'var(--text-dense)' }}>
            no workers configured
          </span>
        </header>

        <section className="content">
          <div className="empty">
            <h2>No workers yet</h2>
            <p>
              agentyard schedules coding-agent tasks across the accounts you own, routing each one to
              the worker, session and moment where it is cheapest to run. It needs at least one
              worker before it can do anything.
            </p>
            <p>Milestones, in order:</p>
            <ol>
              <li>
                <strong>M1</strong> — worker commissioning, quota polling, PTY sessions, live TUI
              </li>
              <li>
                <strong>M2</strong> — tasks, dependencies, worktree pool, landing
              </li>
              <li>
                <strong>M3</strong> — the cache clock, affinity routing, preemption
              </li>
            </ol>
            <div className="note">
              <strong>M0 scaffold.</strong> This window is the shell only. The scheduler, PTYs, store
              and MCP server live in <span className="mono">orchestratord</span>, which does not
              exist yet — so closing this window currently stops nothing because there is nothing to
              stop. See <span className="mono">HANDOFF.md</span> for what to pick up next.
            </div>
          </div>
        </section>

        <footer className="statusbar">
          <span>
            <span className={`dot ${info?.daemonEndpoint ? 'dot--ok' : 'dot--down'}`} />
            orchestratord: {info?.daemonEndpoint ?? 'not running (M1)'}
          </span>
          <span className="mono">{info?.platform ?? ''}</span>
        </footer>
      </main>
    </div>
  )
}
