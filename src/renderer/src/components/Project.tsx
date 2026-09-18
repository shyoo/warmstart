import { useState } from 'react'
import { sessionEnded } from '@shared/protocol'
import type { Project as ProjectRecord, PullRequestDelivery, ResourceAvailability } from '@shared/tasks'
import type { FleetEntry } from '../lib/daemon'
import { rpc } from '../lib/daemon'
import { useAction } from '../lib/useAction'
import { Tasks } from './Tasks'
import { TaskThread } from './TaskThread'
import { ProjectSettings } from './ProjectSettings'
import { Conversations } from './Conversations'
import { TerminalPane } from './Terminal'
import { SessionStream } from './SessionStream'
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
  pendingDeliveries,
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
  pendingDeliveries?: PullRequestDelivery[]
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

      {!project.rootExists && (
        <RelocateBanner project={project} refreshProjects={refreshProjects} />
      )}

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
          pendingDeliveries={pendingDeliveries}
          onRefreshProjects={refreshProjects}
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
 * "Your directory moved" — the one thing a renamed or relocated project needs said out loud.
 *
 * ⛔ **Named here, not inferred from a task failure.** Before this, a project whose directory moved
 * outside Warmstart (a rename, a drive reorganisation) had no error of its own: dispatch just found
 * nothing at `root` and the operator was left reading a task failure to guess why. `rootExists` is
 * read fresh on every project list, so this banner is never stale once the directory reappears —
 * whether that is because the operator typed the new path here or restored the old one by hand.
 */
function RelocateBanner({
  project,
  refreshProjects
}: {
  project: ProjectRecord
  refreshProjects: () => Promise<void>
}): React.JSX.Element {
  const [path, setPath] = useState(project.root)

  const relocate = useAction(
    async (id: string, root: string) => rpc('project.relocate', { id, root }),
    {
      successNote: (p) => `Now pointing at ${p.root}.`,
      onSuccess: refreshProjects
    }
  )

  return (
    <div className="alert">
      <p>
        <strong>This project&rsquo;s directory could not be found</strong> at{' '}
        <span className="mono">{project.root}</span>. It may have been moved, renamed, or deleted
        outside Warmstart. If it moved, point Warmstart at the new location below — the project keeps
        its id, tasks, and history.
      </p>
      <div className="wizard-path">
        <input
          className="text-input mono"
          value={path}
          spellCheck={false}
          onChange={(e) => setPath(e.target.value)}
          placeholder="new directory path"
        />
        <button
          className="btn"
          disabled={relocate.busy || path.trim().length === 0}
          onClick={() => void relocate.run(project.id, path.trim())}
        >
          {relocate.busy ? 'Relocating…' : 'Relocate'}
        </button>
      </div>
      {relocate.note && <div className="notice">{relocate.note}</div>}
    </div>
  )
}

/**
 * What a live agent is doing, and a real terminal beside it.
 *
 * ⛔ **Two tiers, because a dispatched agent genuinely has no terminal.** Work runs on pipes —
 * `--print` refuses to start under a pseudo-terminal — so there is no screen to mirror and no
 * keyboard to take. What this pane draws for such a session is the decoded stream: tool calls,
 * thinking phases, the vendor's own rate-limit cautions, the turn ending. A session that *does* have
 * a TTY (one you opened yourself) gets the real thing, unchanged.
 *
 * ⛔ **The keyboard switch is gone from the pipe case, and that is a bug fix rather than a tidy-up.**
 * Measured 2026-09-13 on claude 2.1.270: its `--input-format stream-json` stdin takes whole JSON
 * messages, and raw keystrokes written ahead of the next one produced
 * `Error parsing streaming input line … SyntaxError` and **exit 1**. Offering *take the keyboard* on
 * a dispatched task meant one stray character ended the run. The daemon refuses it now too; this is
 * the half that stops anybody reaching for it.
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
  const current = shown.find((s) => s.session.id === selected)?.session ?? null
  const pipe = current?.transport === 'stream'

  const attach = useAction(
    async (id: string) => rpc('session.attach', { id }),
    { successNote: (s) => `Opened a terminal on ${s.id.slice(0, 6)}. Pick it from the tabs above.` }
  )

  if (shown.length === 0) {
    return (
      <div className="empty-inline">
        <p>No live session to watch.</p>
        <p className="dim">
          Scheduled work runs on a pipe and appears here as it streams, decoded; a session you open
          yourself gets a real TTY. What earlier sessions did is on <strong>Conversations</strong>.
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
            {pipe ? (
              <>
                This agent was dispatched, so it has no terminal: it runs on a pipe, and what you are
                reading is its own structured record of what it is doing — not a screen. To say
                something to it, reply on its task.
              </>
            ) : (
              <>
                The real agent terminal, exactly as the CLI is drawing it. Read-only until you take
                the keyboard — a stray keystroke into a running agent is a real edit to a real
                repository.
              </>
            )}
          </p>
        </div>
        {pipe ? (
          <button
            className="btn"
            disabled={attach.busy || !selected}
            onClick={() => selected && void attach.run(selected)}
          >
            {attach.busy ? 'Opening…' : 'Open a real terminal'}
          </button>
        ) : (
          <label className="check">
            <input
              type="checkbox"
              checked={keyboard}
              onChange={(e) => setKeyboard(e.target.checked)}
            />
            take the keyboard
          </label>
        )}
      </header>

      {attach.note && <div className="notice">{attach.note}</div>}

      {pipe && (
        <p className="dim">
          <strong>Open a real terminal</strong> starts the CLI itself in this workspace, holding a
          copy of this conversation. ⛔ A copy, always — a fork, never the conversation itself — so
          the run here carries on undisturbed and the scheduler can still resume the original. ⚠️ It
          stands in the same worktree and can edit the same files, so it is yours to be careful with.
        </p>
      )}

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
            {session.transport === 'stream' && <span className="dim">· piped</span>}
          </button>
        ))}
      </div>

      {selected &&
        (pipe ? (
          <SessionStream sessionId={selected} live />
        ) : (
          <TerminalPane sessionId={selected} interactive={keyboard} />
        ))}
    </div>
  )
}
