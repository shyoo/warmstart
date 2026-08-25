import { useState } from 'react'
import { useAppInfo, useDaemonStatus, useFleet, useNow } from './lib/daemon'
import { FleetStrip } from './components/FleetStrip'
import { Workers } from './components/Workers'
import { Doctor } from './components/Doctor'
import { TerminalPane } from './components/Terminal'

/**
 * The shell.
 *
 * M1 is the fleet substrate: workers, quota, sessions and a terminal. Projects and tasks arrive at
 * M2, so the sidebar says so plainly rather than showing empty furniture.
 */

type View = 'workers' | 'sessions' | 'doctor'

export function App(): React.JSX.Element {
  const info = useAppInfo()
  const status = useDaemonStatus()
  const connected = status.state === 'connected'
  const { fleet, refresh } = useFleet(connected)
  const now = useNow()
  const [view, setView] = useState<View>('workers')
  const [openSession, setOpenSession] = useState<string | null>(null)
  const [keyboard, setKeyboard] = useState(false)

  const sessions = fleet.flatMap((f) => f.sessions)

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <h1>agentyard</h1>
          <span className="version">v{info?.version ?? '—'}</span>
        </div>

        <nav className="nav-group">
          <h2>Fleet</h2>
          <NavItem active={view === 'workers'} onClick={() => setView('workers')}>
            Workers
            <span className="nav-count num">{fleet.length}</span>
          </NavItem>
          <NavItem active={view === 'sessions'} onClick={() => setView('sessions')}>
            Sessions
            <span className="nav-count num">{sessions.length}</span>
          </NavItem>
        </nav>

        <nav className="nav-group">
          <h2>Projects</h2>
          <p className="nav-empty">Tasks and projects arrive in M2.</p>
        </nav>

        <nav className="nav-group">
          <h2>Settings</h2>
          <NavItem active={view === 'doctor'} onClick={() => setView('doctor')}>
            Doctor
          </NavItem>
        </nav>
      </aside>

      <main className="main">
        <FleetStrip fleet={fleet} now={now} />

        <div className="content">
          {!connected ? (
            <DaemonNotice status={status} />
          ) : view === 'workers' ? (
            <Workers fleet={fleet} refresh={refresh} />
          ) : view === 'doctor' ? (
            <Doctor />
          ) : (
            <SessionsView
              fleet={fleet}
              openSession={openSession}
              setOpenSession={setOpenSession}
              keyboard={keyboard}
              setKeyboard={setKeyboard}
            />
          )}
        </div>

        <footer className="statusbar">
          <span>
            <span className={`dot ${connected ? 'dot--ok' : 'dot--down'}`} />
            {status.state === 'connected'
              ? `orchestratord v${status.version} · pid ${status.pid} · 127.0.0.1:${status.port}`
              : status.state === 'error'
                ? `orchestratord: ${status.message}`
                : `orchestratord: ${status.state}`}
          </span>
          <span className="statusbar-spacer" />
          <span className="num">
            {fleet.length} worker{fleet.length === 1 ? '' : 's'} · {sessions.length} session
            {sessions.length === 1 ? '' : 's'}
          </span>
          <span>{info?.platform}</span>
        </footer>
      </main>
    </div>
  )
}

function NavItem({
  active,
  onClick,
  children
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button className={`nav-item${active ? ' nav-item--active' : ''}`} onClick={onClick}>
      {children}
    </button>
  )
}

function DaemonNotice({
  status
}: {
  status: ReturnType<typeof useDaemonStatus>
}): React.JSX.Element {
  return (
    <div className="empty">
      <h2>{status.state === 'error' ? 'orchestratord did not start' : 'Starting orchestratord…'}</h2>
      <p>
        The fleet runs in a background daemon so that closing this window stops nothing. Quota
        windows are hours long; progress should not depend on a window being open.
      </p>
      {status.state === 'error' && (
        <>
          <div className="alert">{status.message}</div>
          <button className="btn btn--primary" onClick={() => void window.agentyard.startDaemon()}>
            Try again
          </button>
        </>
      )}
    </div>
  )
}

function SessionsView({
  fleet,
  openSession,
  setOpenSession,
  keyboard,
  setKeyboard
}: {
  fleet: ReturnType<typeof useFleet>['fleet']
  openSession: string | null
  setOpenSession: (id: string | null) => void
  keyboard: boolean
  setKeyboard: (v: boolean) => void
}): React.JSX.Element {
  const sessions = fleet.flatMap((f) => f.sessions.map((s) => ({ session: s, worker: f.worker })))
  const selected = openSession ?? sessions[0]?.session.id ?? null

  if (sessions.length === 0) {
    return (
      <div className="empty-inline">
        <p>No live sessions.</p>
        <p className="dim">
          A session is one agent process. M1 can host and stream them; M2 gives them tasks to work
          on.
        </p>
      </div>
    )
  }

  return (
    <div className="panel">
      <header className="panel-head">
        <div>
          <h2>Sessions</h2>
          <p className="panel-sub">
            The real agent TUI. Read-only until you take the keyboard — a stray keystroke into a
            running agent is a real edit to a real repository.
          </p>
        </div>
        <label className="check">
          <input type="checkbox" checked={keyboard} onChange={(e) => setKeyboard(e.target.checked)} />
          take the keyboard
        </label>
      </header>

      <div className="tabs">
        {sessions.map(({ session, worker }) => (
          <button
            key={session.id}
            className={`tab${selected === session.id ? ' tab--active' : ''}`}
            onClick={() => setOpenSession(session.id)}
          >
            <span className="mono">{session.id.slice(0, 6)}</span>
            <span className="dim">{worker.label}</span>
          </button>
        ))}
      </div>

      {selected && <TerminalPane sessionId={selected} interactive={keyboard} />}
    </div>
  )
}
