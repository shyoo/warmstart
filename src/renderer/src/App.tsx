import { useCallback, useEffect, useState } from 'react'
import type { Project, ResourceAvailability } from '@shared/tasks'
import { rpc, useAppInfo, useDaemonEvents, useDaemonStatus, useFleet, useNow } from './lib/daemon'
import { FleetStrip } from './components/FleetStrip'
import { Workers } from './components/Workers'
import { Conversations } from './components/Conversations'
import { Logs } from './components/Logs'
import { FleetSettings } from './components/FleetSettings'
import { Doctor } from './components/Doctor'
import { Approvals } from './components/Approvals'
import { Projects } from './components/Projects'
import { Tasks } from './components/Tasks'
import { Overview } from './components/Overview'
import { Project as ProjectView, type ProjectTab } from './components/Project'
import { SidebarResizer } from './components/SidebarResizer'
import { AppSettings } from './components/AppSettings'

/**
 * The shell.
 *
 * Two strips above the work, in the order an operator needs them: the fleet, so the cost of what is
 * running is never hidden, and the Approvals bar, which is empty almost always and takes one
 * keystroke when it is not.
 */

/**
 * Where you are, as an object rather than a flat enum.
 *
 * ⚠️ This was seven sibling views, one of which happened to be called Projects — so a project was a
 * list you visited, not the thing work belongs to. A route that carries a project id is what makes
 * "the project is the unit of work" true of the code and not only of the sidebar.
 */
type Route =
  | { kind: 'overview' }
  | { kind: 'project'; id: string; tab: ProjectTab }
  /**
   * ⚠️ Temporary, and it removes itself. `tasks.project_id` is nullable, so a database can already
   * hold work that belongs to no project - and in a sidebar built out of projects, that work would
   * simply be unreachable. This entry appears only while such tasks exist and disappears the moment
   * the last one is given a home, which is what the require-a-project migration does.
   */
  | { kind: 'unassigned' }
  | { kind: 'settings'; page: 'workers' | 'logs' | 'global' | 'conversations' }

export function App(): React.JSX.Element {
  const info = useAppInfo()
  const status = useDaemonStatus()
  const connected = status.state === 'connected'
  const { fleet, refresh } = useFleet(connected)
  const now = useNow()
  const [route, setRouteNow] = useState<Route>({ kind: 'overview' })
  /**
   * Where you have been, and where you came back from.
   *
   * ⚠️ Kept here rather than in the URL because there is no URL: this is an Electron window with a
   * single renderer, so Back has to mean "the last thing this pane showed" or it means nothing. Tab
   * changes inside a project push too - a person who opened Cost from Tasks expects Back to return
   * to Tasks, not to leave the project entirely.
   */
  const [past, setPast] = useState<Route[]>([])
  const [future, setFuture] = useState<Route[]>([])

  const setRoute = useCallback(
    (next: Route) => {
      setPast((p) => [...p.slice(-49), route])
      // A new destination ends the forward story, the way every browser has always worked.
      setFuture([])
      setRouteNow(next)
    },
    [route]
  )

  const goBack = useCallback(() => {
    setPast((p) => {
      const prev = p[p.length - 1]
      if (!prev) return p
      setFuture((f) => [route, ...f])
      setRouteNow(prev)
      return p.slice(0, -1)
    })
  }, [route])

  const goForward = useCallback(() => {
    setFuture((f) => {
      const next = f[0]
      if (!next) return f
      setPast((p) => [...p, route])
      setRouteNow(next)
      return f.slice(1)
    })
  }, [route])
  const [openSession, setOpenSession] = useState<string | null>(null)
  const [keyboard, setKeyboard] = useState(false)
  const [projects, setProjects] = useState<Project[]>([])
  const [resources, setResources] = useState<ResourceAvailability[]>([])
  const [orphanTasks, setOrphanTasks] = useState(0)

  const refreshProjects = useCallback(async () => {
    if (!connected) return
    setProjects(await rpc('project.list'))
    setResources(await rpc('resource.list'))
    const all = await rpc('task.list', {})
    setOrphanTasks(all.filter((t) => t.projectId === null).length)
  }, [connected])

  useEffect(() => {
    void refreshProjects()
  }, [refreshProjects])

  useDaemonEvents((event) => {
    if (
      event.type === 'project.changed' ||
      event.type === 'resource.changed' ||
      event.type === 'task.changed'
    ) {
      void refreshProjects()
    }
  })

  /**
   * ⛔ Re-reads the data, never reloads the window. A reload would drop every open terminal's
   * scrollback and the route you were standing on, to fix a problem that is only ever a stale fetch.
   */
  const [refreshing, setRefreshing] = useState(false)
  const reload = useCallback(async () => {
    setRefreshing(true)
    try {
      await Promise.all([refresh(), refreshProjects()])
    } finally {
      setRefreshing(false)
    }
  }, [refresh, refreshProjects])

  const sessions = fleet.flatMap((f) => f.sessions)

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <h1 title={`Multi Agent Controller v${info?.version ?? '—'}`}>Multi Agent Controller</h1>
          {/* ⚠️ One row, by request. At 252px there is not room for the version text as well, so it
              moved into the title above rather than pushing these onto a line of their own. */}
          <div className="brand-nav">
            <IconButton label="Back" disabled={past.length === 0} onClick={goBack}>
              <path d="M10 3 L5 8 L10 13" />
            </IconButton>
            <IconButton label="Forward" disabled={future.length === 0} onClick={goForward}>
              <path d="M6 3 L11 8 L6 13" />
            </IconButton>
            <IconButton
              label="Refresh"
              disabled={!connected || refreshing}
              onClick={() => void reload()}
            >
              <path d="M13 8a5 5 0 1 1-1.6-3.7" />
              <path d="M13 2.5 L13 5.2 L10.3 5.2" />
            </IconButton>
          </div>
        </div>

        <nav className="nav-group">
          <NavItem
            active={route.kind === 'overview'}
            onClick={() => setRoute({ kind: 'overview' })}
          >
            Overview
          </NavItem>
        </nav>

        <nav className="nav-group">
          <h2>Projects</h2>
          {projects.length === 0 ? (
            // ⛔ Not a bare heading. A stranger's first launch has no projects, and a group label
            // with nothing under it reads as something that failed to load.
            <button
              className="nav-item nav-item--ghost"
              onClick={() => setRoute({ kind: 'settings', page: 'global' })}
            >
              No projects yet
            </button>
          ) : (
            projects.map((project) => (
              <NavItem
                key={project.id}
                active={route.kind === 'project' && route.id === project.id}
                onClick={() => setRoute({ kind: 'project', id: project.id, tab: 'tasks' })}
              >
                {project.name}
              </NavItem>
            ))
          )}
          {orphanTasks > 0 && (
            <NavItem
              active={route.kind === 'unassigned'}
              onClick={() => setRoute({ kind: 'unassigned' })}
            >
              Unassigned
              <span className="nav-count num">{orphanTasks}</span>
            </NavItem>
          )}
        </nav>

        <nav className="nav-group">
          <h2>Settings</h2>
          <NavItem
            active={route.kind === 'settings' && route.page === 'workers'}
            onClick={() => setRoute({ kind: 'settings', page: 'workers' })}
          >
            Workers
            <span className="nav-count num">{fleet.length}</span>
          </NavItem>
          {/* ⚠️ Directly under Workers, because a conversation belongs to an account and this is the
              second question somebody asks after "which accounts do I have" — namely what each one
              has been talking about, and whether two tasks ended up in the same thread. */}
          <NavItem
            active={route.kind === 'settings' && route.page === 'conversations'}
            onClick={() => setRoute({ kind: 'settings', page: 'conversations' })}
          >
            Conversations
          </NavItem>
          {/* ⚠️ Between Workers and Global on purpose. It is the answer to "why did it do that?",
              which is asked about the fleet above it far more often than about the app below it. */}
          <NavItem
            active={route.kind === 'settings' && route.page === 'logs'}
            onClick={() => setRoute({ kind: 'settings', page: 'logs' })}
          >
            Logs
          </NavItem>
          <NavItem
            active={route.kind === 'settings' && route.page === 'global'}
            onClick={() => setRoute({ kind: 'settings', page: 'global' })}
          >
            Global
          </NavItem>
        </nav>
      </aside>

      <SidebarResizer />

      <main className="main">
        <FleetStrip fleet={fleet} now={now} />
        {connected && <Approvals now={now} />}

        <div className="content">
          {!connected ? (
            <DaemonNotice status={status} />
          ) : route.kind === 'overview' ? (
            <Overview now={now} />
          ) : route.kind === 'unassigned' ? (
            <div className="stack">
              <div className="notice">
                These tasks belong to no project, so they get no workspace and no branch. Give each
                one a project — this list disappears when the last of them has a home.
              </div>
              <Tasks projects={projects} fleet={fleet} />
            </div>
          ) : route.kind === 'settings' && route.page === 'workers' ? (
            <Workers fleet={fleet} refresh={refresh} />
          ) : route.kind === 'settings' && route.page === 'conversations' ? (
            <Conversations />
          ) : route.kind === 'settings' && route.page === 'logs' ? (
            <Logs now={now} />
          ) : route.kind === 'settings' ? (
            <>
              <Doctor now={now} />
              {/* ⚠️ Above the app's own preferences: this one governs the *fleet*, and the tray
                  switch below it governs this window. Two different scopes, in scope order. */}
              <div className="panel">
                <header className="panel-head">
                  <div>
                    <h2>Fleet settings</h2>
                    <p className="panel-sub">
                      Fleet-wide defaults and automation policies that govern running sessions.
                    </p>
                  </div>
                </header>
                <FleetSettings />
              </div>
              <AppSettings />
              <Projects projects={projects} resources={resources} refresh={refreshProjects} />
            </>
          ) : (
            <ProjectRoute
              route={route}
              setRoute={setRoute}
              projects={projects}
              resources={resources}
              refreshProjects={refreshProjects}
              fleet={fleet}
              keyboard={keyboard}
              setKeyboard={setKeyboard}
              openSession={openSession}
              setOpenSession={setOpenSession}
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

/** A 20px square of chrome. Labelled for screen readers, because an icon alone names nothing. */
function IconButton({
  label,
  disabled,
  onClick,
  children
}: {
  label: string
  disabled: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button className="icon-btn" title={label} aria-label={label} disabled={disabled} onClick={onClick}>
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </button>
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

/**
 * A project route, resolved.
 *
 * ⚠️ The id in the route can outlive the project it names — another window can archive or remove one
 * while this one is looking at it. Saying so and offering the way back is the whole handling; a
 * blank pane would leave somebody wondering which of the two of them was broken.
 */
function ProjectRoute({
  route,
  setRoute,
  projects,
  resources,
  refreshProjects,
  fleet,
  keyboard,
  setKeyboard,
  openSession,
  setOpenSession
}: {
  route: { kind: 'project'; id: string; tab: ProjectTab }
  setRoute: (route: Route) => void
  projects: Project[]
  resources: ResourceAvailability[]
  refreshProjects: () => Promise<void>
  fleet: ReturnType<typeof useFleet>['fleet']
  keyboard: boolean
  setKeyboard: (v: boolean) => void
  openSession: string | null
  setOpenSession: (id: string | null) => void
}): React.JSX.Element {
  const project = projects.find((p) => p.id === route.id)

  if (!project) {
    return (
      <div className="empty-inline">
        <p>That project is no longer here.</p>
        <p className="dim">It may have been archived or removed since this pane was opened.</p>
        <button className="btn" onClick={() => setRoute({ kind: 'overview' })}>
          Back to Overview
        </button>
      </div>
    )
  }

  return (
    <ProjectView
      project={project}
      tab={route.tab}
      setTab={(tab) => setRoute({ kind: 'project', id: route.id, tab })}
      projects={projects}
      resources={resources}
      refreshProjects={refreshProjects}
      fleet={fleet}
      keyboard={keyboard}
      setKeyboard={setKeyboard}
      openSession={openSession}
      setOpenSession={setOpenSession}
    />
  )
}
