import { sessionEnded } from '@shared/protocol'
import { useCallback, useEffect, useState } from 'react'
import type { Project, ResourceAvailability, Task } from '@shared/tasks'
import {
  fleetCounts,
  rpc,
  useAppInfo,
  useDaemonEvents,
  useDaemonStatus,
  useFleet,
  useNow
} from './lib/daemon'
import {
  clampZoom,
  readZoomFactor,
  writeZoomFactor,
  applyZoomFactor,
  MIN_ZOOM,
  MAX_ZOOM,
  DEFAULT_ZOOM,
  ZOOM_STEP
} from './lib/zoom'
import { FleetStrip } from './components/FleetStrip'
import { Workers } from './components/Workers'
import { Conversations } from './components/Conversations'
import { Logs } from './components/Logs'
import { FleetSettings } from './components/FleetSettings'
import { Doctor } from './components/Doctor'
import { Attention } from './components/Attention'
import { Projects } from './components/Projects'
import { Tasks } from './components/Tasks'
import { TaskThread } from './components/TaskThread'
import { Overview } from './components/Overview'
import { Controller } from './components/Controller'
import { Project as ProjectView, type ProjectTab } from './components/Project'
import { SidebarResizer } from './components/SidebarResizer'
import { AppSettings } from './components/AppSettings'
import { RoutingModel, type RoutingTab } from './components/RoutingModel'
import { Statistics, type StatisticsTab } from './components/Statistics'
import { ProjectDot, projectWorkState } from './lib/taskview'

/**
 * The shell.
 *
 * Two strips above the work, in the order an operator needs them: the fleet, so the cost of what is
 * running is never hidden, and the Attention bar, which is empty almost always and takes one
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
  | { kind: 'overview'; page: 'dashboard' | 'controller' }
  /**
   * ⚠️ `taskId` rides on the route rather than living in the Tasks list. The Thread tab is a
   * destination, so Back has to be able to return to a *task* and not merely to a tab that has
   * forgotten which one it was showing.
   */
  | { kind: 'project'; id: string; tab: ProjectTab; taskId?: string }
  /**
   * ⚠️ Temporary, and it removes itself. `tasks.project_id` is nullable, so a database can already
   * hold work that belongs to no project - and in a sidebar built out of projects, that work would
   * simply be unreachable. This entry appears only while such tasks exist and disappears the moment
   * the last one is given a home, which is what the require-a-project migration does.
   */
  | { kind: 'unassigned'; taskId?: string }
  /**
   * ⚠️ `tab` rides on the route for the same reason `taskId` does on a project: a tab is a
   * destination, so Back has to return to the one you were reading rather than to whichever the
   * page opens on. ⛔ Cost is no longer its own page — it is the cost axis of the routing model and
   * lives under it, which is where it was always being read from.
   */
  | { kind: 'analytics'; page: 'routing-model'; tab: RoutingTab }
  | { kind: 'analytics'; page: 'statistics'; tab: StatisticsTab }
  /**
   * ⚠️ `taskId` so a run in the fleet-wide conversation list has somewhere to go. It cannot route
   * into a project tab, because the conversation it came from may belong to a different project
   * than the one that is open — or to none. The thread renders here and Back returns to the list.
   */
  | { kind: 'history'; page: 'conversations' | 'logs'; taskId?: string }
  | { kind: 'settings'; page: 'workers' | 'global' }

export function App(): React.JSX.Element {
  const info = useAppInfo()
  const status = useDaemonStatus()
  const connected = status.state === 'connected'
  const { fleet, refresh } = useFleet(connected)
  const counts = fleetCounts(fleet)
  const now = useNow()
  const [route, setRouteNow] = useState<Route>({ kind: 'overview', page: 'dashboard' })
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
  const [tasks, setTasks] = useState<Task[]>([])
  const [orphanTasks, setOrphanTasks] = useState(0)

  const refreshProjects = useCallback(async () => {
    if (!connected) return
    setProjects(await rpc('project.list'))
    setResources(await rpc('resource.list'))
    const all = await rpc('task.list', {})
    setTasks(all)
    setOrphanTasks(all.filter((t) => t.projectId === null).length)
  }, [connected])

  useEffect(() => {
    void refreshProjects()
  }, [refreshProjects])

  useDaemonEvents((event) => {
    if (
      event.type === 'project.changed' ||
      event.type === 'resource.changed' ||
      event.type === 'task.changed' ||
      event.type === 'run.changed'
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

  const [zoom, setZoom] = useState(readZoomFactor)

  const changeZoom = useCallback((delta: number) => {
    setZoom((prev) => {
      const next = clampZoom(prev + delta)
      applyZoomFactor(next)
      writeZoomFactor(next)
      return next
    })
  }, [])

  const resetZoom = useCallback(() => {
    setZoom(() => {
      applyZoomFactor(DEFAULT_ZOOM)
      writeZoomFactor(DEFAULT_ZOOM)
      return DEFAULT_ZOOM
    })
  }, [])

  const zoomIn = useCallback(() => changeZoom(ZOOM_STEP), [changeZoom])
  const zoomOut = useCallback(() => changeZoom(-ZOOM_STEP), [changeZoom])

  useEffect(() => {
    applyZoomFactor(zoom)
  }, [zoom])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey) {
        if (e.key === '=' || e.key === '+') {
          e.preventDefault()
          zoomIn()
        } else if (e.key === '-' || e.key === '_') {
          e.preventDefault()
          zoomOut()
        } else if (e.key === '0') {
          e.preventDefault()
          resetZoom()
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [zoomIn, zoomOut, resetZoom])

  const liveSessions = fleet.flatMap((f) =>
    f.sessions.filter((s) => !sessionEnded(s.state))
  )

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
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
          <div className="brand-zoom">
            <IconButton
              label="Zoom out (Ctrl -)"
              disabled={zoom <= MIN_ZOOM}
              onClick={zoomOut}
            >
              <circle cx="6.5" cy="6.5" r="4" />
              <path d="M9.5 9.5 L13.5 13.5" />
              <path d="M4.5 6.5 L8.5 6.5" />
            </IconButton>
            {zoom !== DEFAULT_ZOOM && (
              <button
                className="zoom-badge"
                title="Reset zoom (Ctrl 0)"
                onClick={resetZoom}
              >
                {Math.round(zoom * 100)}%
              </button>
            )}
            <IconButton
              label="Zoom in (Ctrl +)"
              disabled={zoom >= MAX_ZOOM}
              onClick={zoomIn}
            >
              <circle cx="6.5" cy="6.5" r="4" />
              <path d="M9.5 9.5 L13.5 13.5" />
              <path d="M4.5 6.5 L8.5 6.5" />
              <path d="M6.5 4.5 L6.5 8.5" />
            </IconButton>
          </div>
        </div>

        <nav className="nav-group">
          <h2>Overview</h2>
          <NavItem
            active={route.kind === 'overview' && route.page === 'dashboard'}
            onClick={() => setRoute({ kind: 'overview', page: 'dashboard' })}
          >
            Dashboard
          </NavItem>
          <NavItem
            active={route.kind === 'overview' && route.page === 'controller'}
            onClick={() => setRoute({ kind: 'overview', page: 'controller' })}
          >
            Controller
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
            projects.map((project) => {
              const projectTasks = tasks.filter((t) => t.projectId === project.id)
              const state = projectWorkState(projectTasks)
              return (
                <NavItem
                  key={project.id}
                  active={route.kind === 'project' && route.id === project.id}
                  onClick={() => setRoute({ kind: 'project', id: project.id, tab: 'tasks' })}
                >
                  <ProjectDot state={state} />
                  <span>{project.name}</span>
                </NavItem>
              )
            })
          )}
          {orphanTasks > 0 && (
            <NavItem
              active={route.kind === 'unassigned'}
              onClick={() => setRoute({ kind: 'unassigned' })}
            >
              <ProjectDot state={projectWorkState(tasks.filter((t) => t.projectId === null))} />
              <span>Unassigned</span>
              <span className="nav-count num">{orphanTasks}</span>
            </NavItem>
          )}
        </nav>

        <nav className="nav-group">
          <h2>Analytics</h2>
          <NavItem
            active={route.kind === 'analytics' && route.page === 'routing-model'}
            onClick={() => setRoute({ kind: 'analytics', page: 'routing-model', tab: 'overview' })}
          >
            Routing Model
          </NavItem>
          <NavItem
            active={route.kind === 'analytics' && route.page === 'statistics'}
            onClick={() => setRoute({ kind: 'analytics', page: 'statistics', tab: 'price' })}
          >
            Statistics
          </NavItem>
        </nav>

        <nav className="nav-group">
          <h2>History</h2>
          <NavItem
            active={route.kind === 'history' && route.page === 'conversations'}
            onClick={() => setRoute({ kind: 'history', page: 'conversations' })}
          >
            Conversations
          </NavItem>
          <NavItem
            active={route.kind === 'history' && route.page === 'logs'}
            onClick={() => setRoute({ kind: 'history', page: 'logs' })}
          >
            Logs
          </NavItem>
        </nav>

        <nav className="nav-group">
          <h2>Settings</h2>
          <NavItem
            active={route.kind === 'settings' && route.page === 'workers'}
            onClick={() => setRoute({ kind: 'settings', page: 'workers' })}
          >
            Workers
            <span
              className="nav-count num"
              title={
                `${counts.running} running · ${counts.active} active · ${counts.total} total worker${counts.total === 1 ? '' : 's'}`
              }
            >
              {counts.running}/{counts.active}/{counts.total}
            </span>
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
        {/* ⛔ The strip stays presentation-only — it is drawn from `fleet` and a clock and nothing
            else — so the one call it can make is passed in rather than reached for. The reading
            comes back as a `quota.changed` event the fleet subscription already handles, which is
            why nothing here is done with the result. */}
        <FleetStrip fleet={fleet} now={now} onProbe={(id) => rpc('worker.probe', { id })} />
        {connected && <Attention now={now} onOpenTask={(taskId) => setRoute({ kind: 'unassigned', taskId })} />}

        <div className="content">
          {!connected ? (
            <DaemonNotice status={status} />
          ) : route.kind === 'overview' && route.page === 'dashboard' ? (
            <Overview />
          ) : route.kind === 'overview' && route.page === 'controller' ? (
            <Controller now={now} />
          ) : route.kind === 'analytics' && route.page === 'routing-model' ? (
            <RoutingModel
              tab={route.tab}
              // ⚠️ `setRouteNow`, not `setRoute`: switching tab inside a page is a move, and pushing
              // every one onto history would make Back walk the tabs instead of leaving the page.
              setTab={(tab) => setRouteNow({ kind: 'analytics', page: 'routing-model', tab })}
              now={now}
            />
          ) : route.kind === 'analytics' && route.page === 'statistics' ? (
            <Statistics
              tab={route.tab}
              // ⚠️ `setRouteNow`, exactly as Routing Model does: a tab is a move inside a page, and
              // pushing every one onto history would make Back walk the tabs instead of leaving.
              setTab={(tab) => setRouteNow({ kind: 'analytics', page: 'statistics', tab })}
            />
          ) : route.kind === 'unassigned' ? (
            route.taskId ? (
              <TaskThread
                taskId={route.taskId}
                fleet={fleet}
                onBack={() => setRoute({ kind: 'unassigned' })}
                backLabel="Unassigned"
                onOpenTask={(taskId) => setRoute({ kind: 'unassigned', taskId })}
              />
            ) : (
              <div className="stack">
                <div className="notice">
                  These tasks belong to no project, so they get no workspace and no branch. Give each
                  one a project — this list disappears when the last of them has a home.
                </div>
                <Tasks
                  projects={projects}
                  fleet={fleet}
                  onOpenTask={(taskId) => setRoute({ kind: 'unassigned', taskId })}
                />
              </div>
            )
          ) : route.kind === 'history' && route.page === 'conversations' ? (
            route.taskId ? (
              <TaskThread
                taskId={route.taskId}
                fleet={fleet}
                onBack={() => setRoute({ kind: 'history', page: 'conversations' })}
                backLabel="Conversations"
                onOpenTask={(taskId) => setRoute({ kind: 'history', page: 'conversations', taskId })}
              />
            ) : (
              // ⛔ The same component the project tab renders, with no project. See
              // Conversations.tsx: one table, two scopes.
              <Conversations
                onOpenTask={(taskId) => setRoute({ kind: 'history', page: 'conversations', taskId })}
              />
            )
          ) : route.kind === 'history' && route.page === 'logs' ? (
            <Logs now={now} />
          ) : route.kind === 'settings' && route.page === 'workers' ? (
            <Workers fleet={fleet} refresh={refresh} />
          ) : route.kind === 'settings' && route.page === 'global' ? (
            <>
              <Doctor now={now} />
              {/* ⚠️ Above the app's own preferences: this one governs the *fleet*, and the tray
                  switch below it governs this window. Two different scopes, in scope order. */}
              <div className="panel">
                <header className="panel-head">
                  <div>
                    <h2>Fleet settings</h2>
                    <p className="panel-sub">Defaults every project and session inherits.</p>
                  </div>
                </header>
                <FleetSettings />
              </div>
              <AppSettings />
              {/* ⛔ No fleet-wide Resources table any more. It listed the same pools and locks a
                  project's own Settings tab already shows, one screen away from the project they
                  belong to, and under a heading reading Settings it looked like a page of things
                  you could change when it was purely informational. Removed 2026-08-31 on the
                  operator's call — the free/capacity number survives as the Workspaces column on
                  each project's own row. */}
              <Projects projects={projects} resources={resources} refresh={refreshProjects} />
            </>
          ) : route.kind === 'project' ? (
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
          ) : null}
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
          <span
            className="num"
            title={`${counts.running} running · ${counts.active} active · ${counts.total} total worker${counts.total === 1 ? '' : 's'}`}
          >
            {counts.running}/{counts.active}/{counts.total} worker{counts.total === 1 ? '' : 's'} · {liveSessions.length} session
            {liveSessions.length === 1 ? '' : 's'}
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
  route: { kind: 'project'; id: string; tab: ProjectTab; taskId?: string }
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
        <button className="btn" onClick={() => setRoute({ kind: 'overview', page: 'dashboard' })}>
          Back to Overview
        </button>
      </div>
    )
  }

  return (
    <ProjectView
      project={project}
      tab={route.tab}
      // ⚠️ The open task survives a tab change. Somebody who steps out to Cost and back expects the
      // task they were reading to still be there, and re-picking it from the list is the cost of
      // forgetting it.
      setTab={(tab) => setRoute({ kind: 'project', id: route.id, tab, ...(route.taskId ? { taskId: route.taskId } : {}) })}
      taskId={route.taskId ?? null}
      openTask={(taskId) => setRoute({ kind: 'project', id: route.id, tab: 'thread', taskId })}
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
