import { sessionEnded } from '@shared/protocol'
import type { Project as ProjectRecord, ResourceAvailability } from '@shared/tasks'
import type { FleetEntry } from '../lib/daemon'
import { Tasks } from './Tasks'
import { TaskThread } from './TaskThread'
import { ProjectSettings } from './ProjectSettings'
import { Conversations } from './Conversations'
import { TerminalPane } from './Terminal'
import { Flow } from './Flow'

export type ProjectTab = 'flow' | 'tasks' | 'thread' | 'conversations' | 'sessionTui' | 'settings'

/**
 * ⛔ **Thread**, not Conversation. A conversation in this app is the agent session you resume with
 * `--resume` or `--conversation` — it has an id, it outlives the task that opened it, and Settings
 * has a page listing them. A task's messages are a different thing entirely, and giving both the
 * same name would make "which conversation is this task in?" ambiguous on the one screen that
 * answers it. See docs/glossary.md.
 */
/**
 * ⛔ **Session TUI**, not Sessions. That tab shows one thing and only one: the *raw terminal* of a
 * live agent process, keystrokes and all. Called "Sessions" it read as a list of this project's
 * sessions — which is a real and different thing, is now called **Conversations**, and is the tab
 * beside it. Two tabs, two nouns; the pane that draws a TTY says so in its name.
 */
export const PROJECT_TABS: Array<{ id: ProjectTab; label: string }> = [
  { id: 'flow', label: 'Flow' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'thread', label: 'Thread' },
  { id: 'conversations', label: 'Conversations' },
  { id: 'sessionTui', label: 'Session TUI' },
  { id: 'settings', label: 'Settings' }
]

/**
 * One project, which is the unit of work.
 *
 * ⛔ The project is the context here, so nothing inside offers to change it. A task filed from this
 * page belongs to this project by construction rather than by a picker that can disagree with the
 * page it is sitting on.
 */
export function Project({
  project,
  tab,
  setTab,
  taskId,
  openTask,
  projects,
  resources,
  refreshProjects,
  fleet,
  keyboard,
  setKeyboard,
  openSession,
  setOpenSession
}: {
  project: ProjectRecord
  tab: ProjectTab
  setTab: (tab: ProjectTab) => void
  /** The task the Thread tab is showing, if one has been opened. */
  taskId: string | null
  openTask: (taskId: string) => void
  projects: ProjectRecord[]
  resources: ResourceAvailability[]
  refreshProjects: () => Promise<void>
  fleet: FleetEntry[]
  keyboard: boolean
  setKeyboard: (v: boolean) => void
  openSession: string | null
  setOpenSession: (id: string | null) => void
}): React.JSX.Element {
  return (
    <div className="stack">
      <header className="project-head">
        <div>
          <h2>{project.name}</h2>
          <div className="tbl-path mono" title={project.root}>
            {project.root}
          </div>
        </div>
        <span className="tag">{project.vcs}</span>
      </header>

      <div className="tabs">
        {PROJECT_TABS.map((t) => (
          <button
            key={t.id}
            className={`tab${tab === t.id ? ' tab--active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'flow' ? (
        <Flow projectId={project.id} fleet={fleet} onOpenTask={openTask} />
      ) : tab === 'tasks' ? (
        <Tasks
          projects={projects}
          projectId={project.id}
          fleet={fleet}
          selected={taskId}
          onOpenTask={openTask}
        />
      ) : tab === 'thread' ? (
        taskId ? (
          <TaskThread
            taskId={taskId}
            fleet={fleet}
            onBack={() => setTab('tasks')}
            onOpenTask={openTask}
          />
        ) : (
          // ⚠️ An empty state rather than a hidden tab. A tab that appeared and disappeared as you
          // clicked around would move the four beside it, and this one is a destination you can
          // arrive at from Back with nothing selected.
          <div className="empty-inline">
            <p>No task open.</p>
            <p className="dim">
              Pick one from Tasks and it opens here — its thread, what it is spending, and which
              conversation each run was served by.
            </p>
            <button className="btn" onClick={() => setTab('tasks')}>
              Go to Tasks
            </button>
          </div>
        )
      ) : tab === 'conversations' ? (
        // ⛔ The same component History renders, given a project. See Conversations.tsx: the two
        // views answer the same question at two scopes, and a second table would drift.
        <Conversations projectId={project.id} projectName={project.name} onOpenTask={openTask} />
      ) : tab === 'sessionTui' ? (
        <ProjectSessions
          project={project}
          fleet={fleet}
          keyboard={keyboard}
          setKeyboard={setKeyboard}
          openSession={openSession}
          setOpenSession={setOpenSession}
        />
      ) : (
        <ProjectSettings
          project={project}
          resources={resources}
          refreshProjects={refreshProjects}
        />
      )}
    </div>
  )
}

/**
 * The raw terminal of a live agent process, for this project.
 *
 * ⛔ Live only, and that is not a limitation to apologise for: a TTY needs a process on the other
 * end of it. What a *finished* session did is the Conversations tab, which is why the empty state
 * points there rather than explaining an absence.
 *
 * ⚠️ The note that used to be here said sessions were never stamped with a project and the filter
 * would always be empty. That stopped being true when dispatch began passing `projectId` to
 * `spawnSession` (scheduler.ts) — every work session on this install carries one — so the filter is
 * real and the fallback below is for rows that predate it.
 */
function ProjectSessions({
  project,
  fleet,
  keyboard,
  setKeyboard,
  openSession,
  setOpenSession
}: {
  project: ProjectRecord
  fleet: FleetEntry[]
  keyboard: boolean
  setKeyboard: (v: boolean) => void
  openSession: string | null
  setOpenSession: (id: string | null) => void
}): React.JSX.Element {
  const all = fleet.flatMap((f) =>
    f.sessions
      .filter((s) => !sessionEnded(s.state))
      .map((s) => ({ session: s, worker: f.worker }))
  )
  const mine = all.filter((s) => s.session.projectId === project.id)
  const unattributed = all.filter((s) => s.session.projectId === null)
  const shown = mine.length > 0 ? mine : unattributed
  const selected =
    openSession && shown.some((s) => s.session.id === openSession)
      ? openSession
      : (shown[0]?.session.id ?? null)

  if (shown.length === 0) {
    return (
      <div className="empty-inline">
        <p>No live session to watch.</p>
        <p className="dim">
          This tab is a terminal, so it needs a process on the other end of it. Scheduled work runs
          on a pipe transport and appears here as it streams; a session you open yourself gets a
          real TTY. What earlier sessions did is on <strong>Conversations</strong>.
        </p>
      </div>
    )
  }

  return (
    <div className="panel">
      <header className="panel-head">
        <div>
          <h2>Session TUI</h2>
          <p className="panel-sub">
            The real agent terminal, exactly as the CLI is drawing it. Read-only until you take the
            keyboard — a stray keystroke into a running agent is a real edit to a real repository.
          </p>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={keyboard}
            onChange={(e) => setKeyboard(e.target.checked)}
          />
          take the keyboard
        </label>
      </header>

      {mine.length === 0 && (
        <div className="notice">
          Showing every live session, not just this project&rsquo;s. Nothing running right now
          records this project, so filtering would leave the tab empty on a fleet that is visibly
          busy — which reads as a broken screen rather than as an honest nothing.
        </div>
      )}

      <div className="tabs">
        {shown.map(({ session, worker }) => (
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
