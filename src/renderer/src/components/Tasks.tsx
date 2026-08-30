import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  FinishPolicyChoice,
  Project,
  SessionSharingChoice,
  Task,
  TaskSort,
  TaskView
} from '@shared/tasks'
import {
  FINISH_LABELS,
  SHARING_LABELS,
  TASK_VIEW_ORDER,
  TASK_VIEWS,
  resolveFinishPolicy,
  resolveModelChoice,
  resolveSessionSharing
} from '@shared/tasks'
import type { ModelOptions, Settings } from '@shared/protocol'
import { rpc, useActivity, useDaemonEvents, useNow, type FleetEntry } from '../lib/daemon'
import { showsLiveOutput } from '../lib/live'
import { tokens, when } from '../lib/format'
import {
  PAGE_SIZE_OPTIONS,
  readTaskPageSize,
  readViews,
  writeTaskPageSize,
  writeViews
} from '../lib/prefs'
import {
  assigneeLabel,
  CANCELLABLE,
  elapsed,
  IN_FLIGHT,
  statusLabel,
  STATUS_TONE,
  Working
} from '../lib/taskview'

/**
 * A column header you can sort by.
 *
 * ⚠️ The arrow is on the sorted column only. An arrow on every header — the "sortable" hint some
 * tables draw — makes the one that is actually in force impossible to find at a glance, which is the
 * single question the marker exists to answer.
 */
function SortHead({
  label,
  column,
  sort,
  asc,
  onSort,
  numeric
}: {
  label: string
  column: TaskSort
  sort: TaskSort
  asc: boolean
  onSort: (column: TaskSort) => void
  numeric?: boolean
}): React.JSX.Element {
  const on = sort === column
  return (
    <th className={numeric ? 'tbl-num' : undefined}>
      <button
        className={`sort-head${on ? ' sort-head--on' : ''}`}
        onClick={() => onSort(column)}
        aria-sort={on ? (asc ? 'ascending' : 'descending') : 'none'}
      >
        {label}
        {on && <span aria-hidden>{asc ? ' ↑' : ' ↓'}</span>}
      </button>
    </th>
  )
}

/**
 * The task table.
 *
 * Tabular and dense on purpose — this is a control surface, not a board. The columns are what an
 * operator actually needs to decide something: who filed it, who is on it, what it is waiting for,
 * and what it has spent.
 *
 * ⛔ Cancel is not delete. Cancel is a row action that winds the work down into a resting state and
 * destroys nothing; delete sits behind the row menu, refuses while anything depends on the task, and
 * never removes the runs.
 */
export function Tasks({
  projects,
  projectId,
  fleet,
  selected,
  onOpenTask
}: {
  projects: Project[]
  /** When set, this list is one project's and the creation form does not offer to change it. */
  projectId?: string
  /** Only so a worker id can be drawn as the name of an account. */
  fleet: FleetEntry[]
  /** The task the thread is currently showing, so the row it came from stays marked. */
  selected?: string | null
  /**
   * Open a task.
   *
   * ⛔ A navigation, not a selection. The detail used to render below this table, which put the
   * thing you clicked on beneath every row of the thing you clicked it from — worse the more work a
   * project had. The list no longer knows or cares what happens next.
   */
  onOpenTask: (taskId: string) => void
}): React.JSX.Element {
  const [tasks, setTasks] = useState<Task[]>([])
  const [total, setTotal] = useState(0)
  const [counts, setCounts] = useState<Record<TaskView, number> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  /**
   * Which buckets are showing.
   *
   * ⚠️ Read from disk at first render, not in an effect. Seeded from an effect the table would draw
   * one frame of the wrong view — usually All — and somebody who left it on *Needs you* would watch
   * their filter apply itself a moment after the page appeared.
   */
  const [views, setViews] = useState<TaskView[]>(readViews)
  const [pageSize, setPageSize] = useState<number>(readTaskPageSize)
  const [sort, setSort] = useState<TaskSort>('updated')
  const [asc, setAsc] = useState(false)
  const [page, setPage] = useState(0)
  const [menuTaskId, setMenuTaskId] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  // The latest live line per running row. The thread keeps its own copy of the same broadcast.
  const { activity } = useActivity()
  const now = useNow(1000)

  useEffect(() => {
    if (!menuTaskId) return
    const onPointerDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuTaskId(null)
      }
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenuTaskId(null)
      }
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [menuTaskId])

  const refresh = useCallback(async () => {
    const got = await rpc('task.page', {
      ...(projectId ? { projectId } : {}),
      views,
      sort,
      asc,
      limit: pageSize,
      offset: page * pageSize
    })
    if (page > 0 && page * pageSize >= got.total) {
      setPage(Math.max(0, Math.ceil(got.total / pageSize) - 1))
      return
    }
    setTasks(got.tasks)
    setTotal(got.total)
    setCounts(got.counts)
  }, [projectId, views, sort, asc, page, pageSize])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // ⛔ Back to the first page whenever what is being listed changes. Staying on page 4 of a filter
  // that now has one page renders an empty table over a chip reading `Done 3`, which reads as a
  // broken screen rather than as a stale offset.
  useEffect(() => {
    setPage(0)
    setMenuTaskId(null)
  }, [views, sort, asc, projectId, pageSize])

  const toggleView = (view: TaskView): void => {
    const next = views.includes(view) ? views.filter((v) => v !== view) : [...views, view]
    // ⚠️ Selecting every bucket *is* All. Two selections that mean the same thing must not look
    // different, or the chip row ends up with a state that is "all of them" and a separate state
    // that is also "all of them" and neither is obviously the one you are in.
    const settled = next.length === TASK_VIEW_ORDER.length ? [] : next
    setViews(settled)
    writeViews(settled)
  }

  const sortBy = (column: TaskSort): void => {
    if (sort === column) {
      setAsc((v) => !v)
      return
    }
    setSort(column)
    // ⚠️ A fresh column starts newest-first. Every column here is a clock or a counter, and the
    // interesting end of all three is the recent one.
    setAsc(false)
  }

  const pages = Math.max(1, Math.ceil(total / pageSize))

  useDaemonEvents((event) => {
    if (event.type === 'task.changed' || event.type === 'run.changed') void refresh()
  })

  const act = async (fn: () => Promise<unknown>) => {
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
    await refresh()
  }

  const remove = async (task: Task) => {
    const blockers = await rpc('task.deleteCheck', { id: task.id })
    if (!blockers.ok) {
      setError(`Cannot delete t${task.seq}:\n${blockers.reasons.map((r) => `• ${r}`).join('\n')}`)
      return
    }
    await act(() => rpc('task.delete', { id: task.id }))
  }

  return (
    <div className="panel">
      <header className="panel-head">
        <div>
          <h2>Tasks</h2>
          <p className="panel-sub">
            A task is a thread of work with an assignee — not a prompt. Anyone can file one: you, the
            controller, or an agent mid-run.
          </p>
        </div>
        <button className="btn btn--primary" onClick={() => setAdding((v) => !v)}>
          {adding ? 'Cancel' : 'New task'}
        </button>
      </header>

      {error && <div className="alert">{error}</div>}
      {adding && (
        <NewTask
          projects={projects}
          fixedProjectId={projectId}
          fleet={fleet}
          onDone={async () => {
            setAdding(false)
            await refresh()
          }}
          onError={setError}
        />
      )}

      {/* ⛔ Counts on every chip, whatever is selected. The number is what makes the row worth
          having: it says what you would get *before* you click, and `Needs you 3` is the one an
          operator is actually scanning for. */}
      <div className="chips">
        <button
          className={`chip${views.length === 0 ? ' chip--on' : ''}`}
          onClick={() => {
            setViews([])
            writeViews([])
          }}
          title="Every task in this project, in whatever state"
        >
          All
          {counts && <span className="chip-n">{Object.values(counts).reduce((a, b) => a + b, 0)}</span>}
        </button>
        {TASK_VIEW_ORDER.map((v) => (
          <button
            key={v.id}
            className={`chip${views.includes(v.id) ? ' chip--on' : ''}`}
            onClick={() => toggleView(v.id)}
            title={TASK_VIEWS[v.id].join(', ')}
          >
            {v.label}
            {counts && <span className="chip-n">{counts[v.id]}</span>}
          </button>
        ))}
      </div>

      {tasks.length === 0 ? (
        <div className="empty-inline">
          {/* ⚠️ Two different nothings. A project with no tasks needs telling what to do; a filter
              that matches none of them needs telling that the tasks still exist — offering the same
              "file one and the scheduler will route it" to somebody who has forty tasks and one chip
              selected reads as the app having lost them. */}
          {views.length > 0 ? (
            <>
              <p>No tasks in {views.length === 1 ? 'that view' : 'those views'}.</p>
              <p className="dim">
                The filter is hiding the rest — the counts above say where they are.
              </p>
              <button
                className="btn"
                onClick={() => {
                  setViews([])
                  writeViews([])
                }}
              >
                Show all
              </button>
            </>
          ) : (
            <>
              <p>No tasks yet.</p>
              <p className="dim">
                File one and the scheduler will route it to a worker that can afford it, in a
                workspace of its own, on a branch named after the task.
              </p>
            </>
          )}
        </div>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <SortHead label="#" column="seq" sort={sort} asc={asc} onSort={sortBy} numeric />
              <th>Title</th>
              <th>From</th>
              {/* ⛔ On the table, not only in the detail pane. Which account is spending on a task is
                  the first thing an operator checks and the last thing that should need a click —
                  and a routing mistake is invisible until it is shown here. */}
              <th>Worker</th>
              <th>Dep</th>
              {/* ⛔ How long, beside how much. A task showing only a token count answers "what did
                  this cost" and not "is this taking too long", and the second is the question
                  somebody watching a run actually has. */}
              <th className="tbl-num">Took</th>
              {/* ⚠️ "Spent" was read as money by everybody who saw it. These are tokens. */}
              <th className="tbl-num">Tokens</th>
              {/* ⛔ Both dates, not one. When a task was filed and when it last moved answer
                  different questions — "how long has this been sitting here" and "is anything still
                  happening" — and a task filed weeks ago that ran an hour ago looks identical to a
                  fresh one under either column alone. */}
              <SortHead label="Created" column="created" sort={sort} asc={asc} onSort={sortBy} />
              <SortHead label="Updated" column="updated" sort={sort} asc={asc} onSort={sortBy} />
              <th>Status</th>
              <th className="tbl-num tbl-col-action">Action</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => {
              const liveText =
                showsLiveOutput(task.status) && activity[task.id]?.length
                  ? activity[task.id]![activity[task.id]!.length - 1]?.text
                  : null

              const hasPriorActions =
                CANCELLABLE.has(task.status) ||
                task.status === 'paused_user' ||
                task.status === 'cancelled' ||
                task.status === 'awaiting_human' ||
                task.status === 'draft'

              return (
                <Fragment key={task.id}>
                  <tr
                    className={`${selected === task.id ? 'tbl-row--selected' : ''}${liveText ? ' tbl-row--has-live' : ''}`}
                    onClick={() => onOpenTask(task.id)}
                  >
                    <td className="num tbl-num">{task.seq}</td>
                    <td>
                      <span className="tbl-strong">
                        {task.lineageDepth > 0 && <span className="dim">{'└ '}</span>}
                        {task.title.length > 70 ? `${task.title.slice(0, 70)}…` : task.title}
                      </span>
                      {task.branch && <div className="tbl-path mono">{task.branch}</div>}
                    </td>
                    <td className="dim">
                      {task.createdBy.kind === 'human'
                        ? 'you'
                        : task.createdBy.kind === 'controller'
                          ? 'ctrl'
                          : 'agent'}
                    </td>
                    <td className={task.ranOn || task.assignee ? '' : 'dim'}>{assigneeLabel(task, fleet)}</td>
                    <td className="num dim">{task.dependsOn.length ? `←${task.dependsOn.length}` : '—'}</td>
                    <td className="num tbl-num dim">{elapsed(task, now)}</td>
                    <td className="num tbl-num">{tokens(task.budget.spentTokens || null)}</td>
                    <td className="tbl-when dim" title={new Date(task.createdAt).toLocaleString()}>
                      {when(task.createdAt)}
                    </td>
                    <td className="tbl-when dim" title={new Date(task.updatedAt).toLocaleString()}>
                      {when(task.updatedAt)}
                    </td>
                    <td>
                      <span className={`status ${STATUS_TONE[task.status] ?? ''}`}>
                        {statusLabel(task)}
                        {IN_FLIGHT.has(task.status) && <Working />}
                      </span>
                      {/* The scheduler's own reason, refreshed every tick it passes this task over. */}
                      {task.holdReason && <div className="tbl-sub dim">{task.holdReason}</div>}
                    </td>
                    <td className="tbl-action-cell" onClick={(e) => e.stopPropagation()}>
                      <div
                        ref={menuTaskId === task.id ? menuRef : null}
                        className="action-menu-wrap"
                      >
                        <button
                          type="button"
                          className={`action-menu-btn${menuTaskId === task.id ? ' action-menu-btn--open' : ''}`}
                          aria-label={`Actions for t${task.seq}`}
                          aria-haspopup="true"
                          aria-expanded={menuTaskId === task.id}
                          title="Actions"
                          onClick={(e) => {
                            e.stopPropagation()
                            setMenuTaskId((cur) => (cur === task.id ? null : task.id))
                          }}
                        >
                          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
                            <circle cx="3" cy="8" r="1.5" />
                            <circle cx="8" cy="8" r="1.5" />
                            <circle cx="13" cy="8" r="1.5" />
                          </svg>
                        </button>
                        {menuTaskId === task.id && (
                          <div className="action-menu" role="menu" onClick={(e) => e.stopPropagation()}>
                            {CANCELLABLE.has(task.status) && (
                              <button
                                type="button"
                                role="menuitem"
                                className="action-menu-item"
                                title="Stop the work and return this task to a resting state. Destroys nothing."
                                onClick={() => {
                                  setMenuTaskId(null)
                                  void act(() => rpc('task.cancel', { id: task.id }))
                                }}
                              >
                                Cancel
                              </button>
                            )}
                            {(task.status === 'paused_user' || task.status === 'cancelled') && (
                              <button
                                type="button"
                                role="menuitem"
                                className="action-menu-item"
                                onClick={() => {
                                  setMenuTaskId(null)
                                  void act(() => rpc('task.resume', { id: task.id }))
                                }}
                              >
                                Resume
                              </button>
                            )}
                            {task.status === 'awaiting_human' && (
                              <button
                                type="button"
                                role="menuitem"
                                className="action-menu-item action-menu-item--ok"
                                title="Records that you are satisfied. Nothing is verified by this — it is your judgement."
                                onClick={() => {
                                  setMenuTaskId(null)
                                  void act(() => rpc('task.resolve', { id: task.id }))
                                }}
                              >
                                Mark done
                              </button>
                            )}
                            {task.status === 'draft' && (
                              <button
                                type="button"
                                role="menuitem"
                                className="action-menu-item"
                                onClick={() => {
                                  setMenuTaskId(null)
                                  void act(() => rpc('task.promote', { id: task.id }))
                                }}
                              >
                                Queue
                              </button>
                            )}
                            {hasPriorActions && <div className="action-menu-divider" />}
                            <button
                              type="button"
                              role="menuitem"
                              className="action-menu-item action-menu-item--danger"
                              title="Delete. Runs are kept either way — they are the record of what this cost."
                              onClick={() => {
                                setMenuTaskId(null)
                                void remove(task)
                              }}
                            >
                              Delete
                            </button>
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                  {liveText && (
                    <tr
                      className={`tbl-row--live${selected === task.id ? ' tbl-row--selected' : ''}`}
                      onClick={() => onOpenTask(task.id)}
                    >
                      <td colSpan={11} className="tbl-live-cell">
                        <div className="tbl-live-line" title={liveText}>
                          <span className="tbl-live-prefix" aria-hidden>&gt;</span>
                          <span className="tbl-live-text">
                            {liveText.length > 100 ? `${liveText.slice(0, 100)}…` : liveText}
                          </span>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      )}

      {total > 0 && (
        <div className="pager">
          <div className="pager-nav">
            {pages > 1 && (
              <button
                className="btn btn--ghost"
                disabled={page === 0}
                onClick={() => setPage((p) => p - 1)}
              >
                ← Newer
              </button>
            )}
            <span className="dim">
              {pages > 1
                ? `page ${page + 1} of ${pages} · ${total} task${total === 1 ? '' : 's'}`
                : `${total} task${total === 1 ? '' : 's'}`}
            </span>
            {pages > 1 && (
              <button
                className="btn btn--ghost"
                disabled={page >= pages - 1}
                onClick={() => setPage((p) => p + 1)}
              >
                Older →
              </button>
            )}
          </div>
          <label className="pager-size">
            <span className="dim">per page</span>
            <select
              aria-label="Tasks per page"
              value={pageSize}
              onChange={(e) => {
                const next = Number(e.target.value)
                setPageSize(next)
                writeTaskPageSize(next)
                setPage(0)
              }}
            >
              {PAGE_SIZE_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
    </div>
  )
}


/**
 * Filing a task, read top to bottom: **where** it runs, **how** it should be treated, **who and
 * what** may run it, and last of all **what to do**.
 *
 * ⛔ The prompt is at the bottom, and that is the whole point of the ordering. It used to be first,
 * with the settings underneath, which meant the field somebody was actually here to fill in was the
 * one they met before they had decided anything — and the three rows they had to read afterwards
 * looked like an afterthought attached to a message they had already written. Everything above the
 * prompt narrows what this task *is*; the prompt says what it is *for*, and it is the last thing
 * touched before filing, exactly as in the composer at the foot of every task thread.
 *
 * ⚠️ Worker sits above Model on purpose, against the sketch this was built from. A model list belongs
 * to one CLI — `costModel(adapter.policy.costModelId).modelIds()` — so until an account is pinned
 * there is no list to draw. Putting the choice that produces the list *below* the control that needs
 * it would have made the Model row point downwards at its own precondition.
 */
function NewTask({
  projects,
  fixedProjectId,
  fleet,
  onDone,
  onError
}: {
  projects: Project[]
  /** Set when filed from inside a project. The picker is replaced by the project's name. */
  fixedProjectId?: string
  /** The accounts that could take this, so one can be pinned and its CLI's models offered. */
  fleet: FleetEntry[]
  onDone: () => void | Promise<void>
  onError: (message: string) => void
}): React.JSX.Element {
  const [title, setTitle] = useState('')
  const [projectId, setProjectId] = useState(fixedProjectId ?? projects[0]?.id ?? '')
  const [priority, setPriority] = useState<'P0' | 'P1' | 'P2' | 'P3'>('P2')
  const [finishPolicy, setFinishPolicy] = useState<FinishPolicyChoice>('inherit')
  const [sessionSharing, setSessionSharing] = useState<SessionSharingChoice>('inherit')
  const [plan, setPlan] = useState(false)
  const [workerId, setWorkerId] = useState('')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [saving, setSaving] = useState<'draft' | 'ready' | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  /**
   * Auto-size the prompt textarea dynamically to fit its contents as text is entered or removed.
   */
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [title])
  /**
   * ⛔ Fetched, not compiled in. The renderer holds no cost models, and a second table of model facts
   * here would drift from the first the day a model was added to a file and not to this bundle.
   */
  const [options, setOptions] = useState<ModelOptions[]>([])
  const [settings, setSettings] = useState<Settings | null>(null)

  useEffect(() => {
    void rpc('model.options')
      .then(setOptions)
      // A fleet with no priceable model list is still a fleet that can run work. The form falls back
      // to whatever each CLI defaults to, which is what it did before there was a picker at all.
      .catch(() => setOptions([]))
    void rpc('settings.get')
      .then(setSettings)
      .catch(() => setSettings(null))
  }, [])

  const selectedProject = projectId ? (projects.find((p) => p.id === projectId) ?? null) : null
  const inheritedFinish = resolveFinishPolicy(null, selectedProject, settings?.finishPolicy)
  const inheritedSharing = resolveSessionSharing(null, selectedProject, settings?.sessionSharing)

  const inheritedFinishLabel = inheritedFinish.policy
    ? FINISH_LABELS[inheritedFinish.policy] ?? inheritedFinish.policy
    : 'agent lands it'

  const inheritedSharingLabel = inheritedSharing.sharing
    ? SHARING_LABELS[inheritedSharing.sharing] ?? inheritedSharing.sharing
    : 'always start a new one'

  // ⛔ Only accounts that could actually take work. Offering a switched-off worker as a pin produces
  // a task that waits forever on a candidate loop that will never match it.
  const pinnable = fleet.filter((e) => e.worker.enabled).map((e) => e.worker)
  const pinned = pinnable.find((w) => w.id === workerId) ?? null
  const forAdapter = pinned ? (options.find((o) => o.adapterId === pinned.adapterId) ?? null) : null
  const canSetEffort = forAdapter?.selectableEffort ?? false
  const resolved = resolveModelChoice(
    { model: model || undefined, effort: effort || undefined },
    pinned,
    canSetEffort
  )
  const hasMultiPoolDefaults =
    pinned?.defaultModels && Object.values(pinned.defaultModels).filter(Boolean).length > 1
  const inheritedModelLabel = hasMultiPoolDefaults
    ? 'Auto-balance across pools'
    : (pinned?.defaultModel ?? 'CLI default')
  const inheritedEffortLabel = pinned?.defaultEffort ?? 'CLI default'
  // Effort appears only where the CLI can be told one *and* the model in effect has levels to offer.
  const effectiveModel = forAdapter?.models.find((m) => m.id === (resolved.model ?? '')) ?? null
  const efforts = canSetEffort ? (effectiveModel?.effortLevels ?? []) : []

  const submit = async (targetStatus: 'draft' | 'ready' = 'ready') => {
    setSaving(targetStatus)
    try {
      if (plan) {
        // ⛔ A plan task is decomposed, not dispatched. Its children arrive as drafts and their
        // prompts are written at promotion, not now — which is also why it carries no worker and no
        // model: nothing here runs, and each draft answers those questions for itself.
        await rpc('task.plan', { title: title.trim(), projectId: projectId || null })
      } else {
        await rpc('task.create', {
          title: title.trim(),
          projectId: projectId || null,
          priority,
          finishPolicy,
          sessionSharing,
          status: targetStatus,
          // ⚠️ Absent, not empty. The daemon reads a *present* `constraints` as an instruction to
          // validate one, and an object of empty strings would be three constraints that name
          // nothing rather than three questions left to the scheduler.
          ...(workerId || model || effort
            ? {
                constraints: {
                  ...(workerId ? { workerId } : {}),
                  ...(model ? { model } : {}),
                  ...(effort ? { effort } : {})
                }
              }
            : {})
        })
      }
      setTitle('')
      await onDone()
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(null)
    }
  }

  return (
    <div className="form">
      <div className="form-row">
        <label>Project</label>
        {fixedProjectId ? (
          // ⛔ Not a disabled picker. A control that cannot be used is still a control, and this one
          // would sit there implying the project is a choice being made here. It is not: the page
          // you filed from decided it.
          <span className="form-fixed">
            {projects.find((p) => p.id === fixedProjectId)?.name ?? fixedProjectId}
          </span>
        ) : (
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">none — runs without a workspace</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <span className="form-hint">
          A git project gets a pooled worktree and a branch named after the task. Agents never work in
          the trunk.
        </span>
      </div>

      <div className="form-row">
        <label>Policy</label>
        <div>
          <div className="pickers" style={{ marginBottom: 'var(--sp-2)' }}>
            <select
              value={priority}
              style={{ width: '70px', flex: '0 0 auto', minWidth: 0 }}
              aria-label="Priority"
              onChange={(e) => setPriority(e.target.value as 'P0' | 'P1' | 'P2' | 'P3')}
            >
              {(['P0', 'P1', 'P2', 'P3'] as const).map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <select
              value={finishPolicy}
              aria-label="Finish policy"
              onChange={(e) => setFinishPolicy(e.target.value as FinishPolicyChoice)}
            >
              <option value="inherit">inherit ({inheritedFinishLabel})</option>
              <option value="await-human">await human</option>
              <option value="agent-lands">agent lands it</option>
              <option value="pull-request">open a pull request</option>
              <option value="custom">this project&rsquo;s own policy</option>
            </select>
            <select
              value={sessionSharing}
              aria-label="Conversation policy"
              title={
                'Whether this task may continue in a conversation another task in this project has ' +
                'already been having. Cheaper — a cold start rebuilt 41,542 tokens of prefix that a ' +
                'reused one read back for 65 — but the agent sees everything said in that conversation.'
              }
              onChange={(e) => setSessionSharing(e.target.value as SessionSharingChoice)}
            >
              <option value="inherit">inherit ({inheritedSharingLabel})</option>
              <option value="on">reuse conversation</option>
              <option value="off">fresh conversation</option>
            </select>
          </div>
          <label
            className="check"
            title="A goal too big for one task. It is decomposed rather than dispatched."
          >
            <input type="checkbox" checked={plan} onChange={(e) => setPlan(e.target.checked)} />
            this is a goal, not a task — break it up first
          </label>
        </div>
        <span className="form-hint">
          Priority orders the queue; finish and conversation policies decide landing and session reuse.
        </span>
      </div>

      {/* ⛔ Both rows vanish for a goal rather than greying out. A goal dispatches nothing, so an
          account and a model chosen here would apply to no run that will ever exist. */}
      {!plan && (
        <>
          <div className="form-row">
            <label>Worker</label>
            <select
              value={workerId}
              onChange={(e) => {
                setWorkerId(e.target.value)
                // ⛔ Cleared together. A model belongs to one CLI's cost model file, so a model
                // chosen for the account you just moved away from is not merely stale — it is an id
                // the new account's adapter would be handed and fail to start on.
                setModel('')
                setEffort('')
              }}
            >
              <option value="">Auto — the scheduler picks</option>
              {pinnable.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.label}
                </option>
              ))}
            </select>
            {/* ⚠️ Said plainly because the sketch called this "preferred" and it is not. The
                scheduler skips every other candidate outright; there is no soft form of it. */}
            <span className="form-hint">
              Auto weighs quota, cache warmth and what each account has proved. Choosing one
              <strong> pins</strong> the task: it waits for that account rather than routing around
              it.
            </span>
          </div>

          <div className="form-row">
            <label>{efforts.length > 0 ? 'Model / Effort' : 'Model'}</label>
            {forAdapter ? (
              <div className="pickers">
                <select
                  value={model}
                  onChange={(e) => {
                    setModel(e.target.value)
                    setEffort('')
                  }}
                >
                  <option value="">inherit ({inheritedModelLabel})</option>
                  {forAdapter.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id}
                    </option>
                  ))}
                </select>
                {efforts.length > 0 && (
                  <select value={effort} onChange={(e) => setEffort(e.target.value)}>
                    <option value="">inherit ({inheritedEffortLabel})</option>
                    {efforts.map((level) => (
                      <option key={level} value={level}>
                        {level}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            ) : (
              // ⛔ A sentence, not a greyed-out select. The list is genuinely not knowable yet, and a
              // dead control here would read as a choice being withheld rather than as one whose
              // precondition is sitting immediately above it.
              <span className="form-fixed">whatever the account that takes it runs by default</span>
            )}
            <span className="form-hint">
              {forAdapter
                ? 'Only models this account’s cost model can price are offered — one it cannot price ' +
                  'is one that cannot be gated, estimated for, or reasoned about the context window of.'
                : 'Pin a worker above to choose. A model list belongs to one CLI, so there is nothing ' +
                  'to offer until an account is chosen.'}
            </span>
          </div>
        </>
      )}

      {/*
        The ask itself, last and largest.

        ⚠️ A textarea, not the single-line input this used to be. What goes here is the prompt an
        agent receives verbatim, and a prompt worth writing usually has a second sentence in it; a
        field that swallowed Enter as "file this now" made the shape of the box a lie about what it
        would accept. Enter breaks the line, ⌘/Ctrl+Enter files — the same bargain every chat
        composer makes, and the same one the thread composer makes one screen away.
      */}
      <div className="ask">
        <textarea
          ref={textareaRef}
          className="ask-input"
          rows={3}
          wrap="soft"
          value={title}
          placeholder={
            plan
              ? 'Describe the outcome — the controller breaks it into drafts'
              : 'Describe the work as you would to a colleague'
          }
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && title.trim() && !saving) {
              void submit('ready')
            }
          }}
        />
        <div className="ask-foot">
          <span className="ask-hint">
            {plan
              ? 'Turned into a handful of draft tasks with dependencies between them. Drafts dispatch ' +
                'nothing — you promote them one at a time, and each prompt is written then.'
              : 'Sent to the agent as written, after any handoff from an earlier run.'}
          </span>
          {plan ? (
            <button
              className="btn btn--primary"
              disabled={!!saving || !title.trim()}
              onClick={() => void submit('ready')}
            >
              {saving ? 'Filing…' : 'File and decompose'}
            </button>
          ) : (
            <div className="ask-actions">
              <button
                className="btn"
                disabled={!!saving || !title.trim()}
                onClick={() => void submit('draft')}
              >
                {saving === 'draft' ? 'Saving…' : 'Save draft'}
              </button>
              <button
                className="btn btn--primary"
                disabled={!!saving || !title.trim()}
                onClick={() => void submit('ready')}
              >
                {saving === 'ready' ? 'Filing…' : 'File task'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

