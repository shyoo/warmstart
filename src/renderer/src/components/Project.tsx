import { useEffect, useState } from 'react'
import type { Project as ProjectRecord, ResourceAvailability } from '@shared/tasks'
import { rpc, type FleetEntry } from '../lib/daemon'
import { Tasks } from './Tasks'
import { TaskThread } from './TaskThread'
import { Projects } from './Projects'
import { TerminalPane } from './Terminal'

export type ProjectTab = 'tasks' | 'thread' | 'sessions' | 'cost' | 'settings'

/**
 * ⛔ **Thread**, not Conversation. A conversation in this app is the agent session you resume with
 * `--resume` or `--conversation` — it has an id, it outlives the task that opened it, and Settings
 * has a page listing them. A task's messages are a different thing entirely, and giving both the
 * same name would make "which conversation is this task in?" ambiguous on the one screen that
 * answers it. See docs/glossary.md.
 */
export const PROJECT_TABS: Array<{ id: ProjectTab; label: string }> = [
  { id: 'tasks', label: 'Tasks' },
  { id: 'thread', label: 'Thread' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'cost', label: 'Cost' },
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

      {tab === 'tasks' ? (
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
      ) : tab === 'sessions' ? (
        <ProjectSessions
          project={project}
          fleet={fleet}
          keyboard={keyboard}
          setKeyboard={setKeyboard}
          openSession={openSession}
          setOpenSession={setOpenSession}
        />
      ) : tab === 'cost' ? (
        <div className="empty-inline">
          <p>Per-project cost is not built yet.</p>
          <p className="dim">
            `runs` already carries a project id, so the data exists — what is missing is the
            aggregation. Fleet-wide cost is on Overview in the meantime.
          </p>
        </div>
      ) : (
        <>
          <ChecksPanel project={project} />
          <Projects
            projects={projects}
            resources={resources}
            refresh={refreshProjects}
            only={project.id}
          />
        </>
      )}
    </div>
  )
}

/**
 * The commands that decide whether work is verified.
 *
 * ⛔ **This list is what the verifying finish policies are trusting.** `commit-and-verify` and
 * `commit-and-merge` say the work was checked; what they actually did was run these, in this order,
 * stopping at the first failure. An empty list means they verified nothing — which is every project
 * on its first day — so the emptiness is stated here rather than left to be discovered when a policy
 * called something verified.
 *
 * ⚠️ One command per line, because that is what it is: an ordered list of shell commands, and the
 * cheap ones belong first so a red one stops the run before the slow ones start.
 */
function ChecksPanel({ project }: { project: ProjectRecord }): React.JSX.Element {
  // ⚠️ Joined once and depended on as a string. The array identity changes on every refresh of an
  // unchanged project, so depending on the array would reset the box under somebody mid-edit.
  const declaredText = (project.config?.check ?? []).join('\n')
  const declared = declaredText ? declaredText.split('\n') : []
  const [text, setText] = useState(declaredText)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [suggested, setSuggested] = useState<string[]>([])

  useEffect(() => setText(declaredText), [declaredText])
  useEffect(() => {
    void rpc('project.proposeChecks', { id: project.id })
      .then((r) => setSuggested(r.checks))
      .catch(() => setSuggested([]))
  }, [project.id])

  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  const dirty = lines.join('\n') !== declared.join('\n')

  const save = async (): Promise<void> => {
    setBusy(true)
    setNote(null)
    try {
      await rpc('project.setChecks', { id: project.id, checks: lines })
      setNote(`Saved ${lines.length} command(s) to project.json.`)
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  // ⛔ A task, not an edit. An agent working out what a project's checks should be is ordinary work
  // with a reviewable diff; an agent quietly rewriting the gate that decides whether its own work is
  // verified is not. The button files the first and can never do the second.
  const fileTask = async (): Promise<void> => {
    setBusy(true)
    setNote(null)
    try {
      const task = await rpc('task.create', {
        title: `Work out the check commands for ${project.name}`,
        projectId: project.id,
        prompt:
          'Work out which commands should verify this project before work is landed, and write them ' +
          'into `.multi_agent_controller/project.json` under `check`, as an ordered array of shell ' +
          'commands. Cheap and fast ones first, so a failure stops the run early. They must exit ' +
          'non-zero on failure and must not need a network or an interactive terminal. ' +
          `Currently declared: ${declared.length > 0 ? declared.join(', ') : 'nothing'}. ` +
          'Do not weaken or remove an existing check without saying why in the commit message.'
      })
      setNote(`Filed as t${task.seq}.`)
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="panel checks-panel">
      <div className="panel-head">
        <h3>Verification</h3>
      </div>
      {declared.length === 0 && (
        <p className="warn">
          This project declares no check commands, so <strong>“commit, then verify”</strong> and{' '}
          <strong>“commit, verify and merge locally”</strong> will verify nothing here. They say so on
          the task rather than reporting a clean result.
        </p>
      )}
      <p className="dim">
        Run in the task’s workspace after the agent commits, in this order, stopping at the first
        failure. A failure rests the task with the output; nothing is merged.
      </p>
      <textarea
        className="ask-input checks-input"
        rows={Math.max(4, lines.length + 1)}
        value={text}
        disabled={busy}
        spellCheck={false}
        placeholder="npm run typecheck&#10;npm run lint&#10;npm test"
        onChange={(e) => setText(e.target.value)}
      />
      <div className="checks-actions">
        <button className="btn btn--primary" disabled={busy || !dirty} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save to project.json'}
        </button>
        {suggested.length > 0 && (
          <button
            className="btn btn--ghost"
            disabled={busy || suggested.join('\n') === lines.join('\n')}
            title={`Suggested from this project’s package.json: ${suggested.join(', ')}`}
            onClick={() => setText(suggested.join('\n'))}
          >
            Use suggested ({suggested.length})
          </button>
        )}
        <button
          className="btn btn--ghost"
          disabled={busy}
          title="Files an ordinary task. The agent proposes the list as a commit you review — it never edits this in place."
          onClick={() => void fileTask()}
        >
          File a task to work them out
        </button>
      </div>
      {note && <p className="note">{note}</p>}
    </div>
  )
}

/**
 * ⚠️ Sessions are not yet stamped with the project they are working for: `spawnSession` takes no
 * project and no insert sets the column, so every session row reads `project_id: null`. Filtering
 * by project would therefore show an empty tab on a fleet that is visibly busy, which reads as a
 * broken screen rather than as a missing field. Say what is actually true instead.
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
      .filter((s) => s.state !== 'closed' && s.state !== 'failed')
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
        <p>No live sessions.</p>
        <p className="dim">
          A session is one agent process. Scheduled work runs on a pipe transport and appears here as
          it streams; a session you open yourself gets a real terminal.
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
          Showing every live session, not just this project&rsquo;s. Sessions do not record which
          project they are working for yet, so there is nothing to filter on — the field exists and
          is never written.
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
