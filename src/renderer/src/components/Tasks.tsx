import { Fragment, useCallback, useDeferredValue, useEffect, useRef, useState } from 'react'
import type { Project, Task, TaskSort, TaskView } from '@shared/tasks'
import { TASK_VIEW_ORDER, TASK_VIEWS } from '@shared/tasks'
import type { ModelOptions } from '@shared/protocol'
import { rpc, useActivity, useDaemonEvents, useNow, type FleetEntry } from '../lib/daemon'
import { NewTask } from './NewTask'
import { clearComposerScratch, hasComposerScratch } from '../lib/composerscratch'
import { showsLiveOutput } from '../lib/live'
import { tokens, when } from '../lib/format'
import { Money, taskPriceTitle } from './Price'
import {
  PAGE_SIZE_OPTIONS,
  readTaskPage,
  readTaskPageSize,
  readViews,
  taskListSignature,
  writeTaskPage,
  writeTaskPageSize,
  writeViews
} from '../lib/prefs'
import {
  activeTime,
  activeTimeTitle,
  assigneeLabel,
  CANCELLABLE,
  dependencyTooltip,
  holdLine,
  isWorking,
  modelLine,
  statusLabel,
  STATUS_TONE,
  taskLabelShort,
  Working
} from '../lib/taskview'
import { errorMessage } from '@shared/errors.js'

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
  numeric,
  title
}: {
  label: string
  column: TaskSort
  sort: TaskSort
  asc: boolean
  onSort: (column: TaskSort) => void
  numeric?: boolean
  /** ⚠️ The column's own explanation, which several of these carry and none of them may lose. */
  title?: string
}): React.JSX.Element {
  const on = sort === column
  return (
    <th className={numeric ? 'tbl-num' : undefined}>
      <button
        className={`sort-head${on ? ' sort-head--on' : ''}`}
        onClick={() => onSort(column)}
        aria-sort={on ? (asc ? 'ascending' : 'descending') : 'none'}
        title={title}
      >
        {label}
        {on && <span aria-hidden>{asc ? ' ↑' : ' ↓'}</span>}
      </button>
    </th>
  )
}

/**
 * Which way a column opens when it is first clicked.
 *
 * ⛔ **A name opens A→Z and a measurement opens biggest-first**, because those are the ends people
 * are looking for. One rule for all of them would make either *Title* start at Z or *Took* start at
 * the fastest task in the fleet, and a second click is a poor answer to a default that is wrong for
 * half the table.
 */
const OPENS_ASCENDING: ReadonlySet<TaskSort> = new Set<TaskSort>(['title', 'from', 'worker', 'status'])

/**
 * How much of a title reaches the DOM, in characters.
 *
 * ⛔ **A bound on the payload, not the display.** `Task.title` *is* the prompt — routinely a
 * paragraph, occasionally pages — and fifty of them per page is a real cost for text nobody will
 * see. The column's own `max-width` decides where the line ends and draws the `…`, so this only has
 * to stay comfortably past the widest that column can ever be (`min(120ch, 46vw)` in `app.css`).
 * ⚠️ Anything at or below that width puts an ellipsis on screen while the column still has room,
 * which is the bug this number replaced: it was **70**.
 */
const TITLE_CHARS = 240

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
  /** When set, this list is one project's and the composer draws no project pill — the page says it. */
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
  /**
   * ⭐ Open already, when there is something half-written to come back to. The composer is behind a
   * button, so a remembered prompt that stayed hidden would be the same as no memory at all — the
   * operator would press *New task* on an empty-looking form and find their paragraph in it, or
   * more likely never press it and lose the paragraph.
   */
  const composerScope = projectId ?? ''
  const [adding, setAdding] = useState(() => hasComposerScratch(composerScope))
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
  /**
   * ⭐ Seeded from disk, like the view filter above it, and for a sharper reason: opening a task
   * unmounts this table, so without this every `← Tasks` landed on page 1 and somebody reading the
   * back of a long list had to walk there again after each task they opened. The offset is only
   * restored onto the list it was taken from — see `taskListSignature`.
   *
   * ⚠️ `search` is `''` here because it is state that starts empty and is never restored; the
   * signature has to be built from the values this render actually has, not from what it will have.
   */
  const [page, setPage] = useState(() =>
    readTaskPage(taskListSignature({ projectId, views, sort, asc, pageSize, search: '' }))
  )
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search)
  const [menuTaskId, setMenuTaskId] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<Task | null>(null)
  /**
   * The models each CLI offers. ⛔ Fetched, not compiled in — same reasoning as the pin pill in
   * `NewTask`: the renderer holds no model catalogue of its own.
   *
   * ⚠️ Once for the table, not per row: all the Worker column needs from it is whether the adapter
   * takes an effort flag at all, and one that does not must never be shown a level it would not be
   * sent. An empty answer costs the column nothing — the model still renders, without an effort.
   */
  const [modelOptions, setModelOptions] = useState<ModelOptions[]>([])
  const menuRef = useRef<HTMLDivElement | null>(null)
  const declineDeleteRef = useRef<HTMLButtonElement | null>(null)
  // The latest live line per running row. The thread keeps its own copy of the same broadcast.
  const { activity } = useActivity()
  const now = useNow(1000)

  useEffect(() => {
    void rpc('model.options')
      .then(setModelOptions)
      .catch(() => setModelOptions([]))
  }, [])

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

  useEffect(() => {
    if (!pendingDelete) return
    declineDeleteRef.current?.focus()
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPendingDelete(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [pendingDelete])

  const refresh = useCallback(async () => {
    const got = await rpc('task.page', {
      ...(projectId ? { projectId } : {}),
      views,
      sort,
      asc,
      limit: pageSize,
      offset: page * pageSize,
      ...(deferredSearch.trim() ? { query: deferredSearch.trim() } : {})
    })
    if (page > 0 && page * pageSize >= got.total) {
      setPage(Math.max(0, Math.ceil(got.total / pageSize) - 1))
      return
    }
    setTasks(got.tasks)
    setTotal(got.total)
    setCounts(got.counts)
  }, [projectId, views, sort, asc, page, pageSize, deferredSearch])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // ⛔ Back to the first page whenever what is being listed changes. Staying on page 4 of a filter
  // that now has one page renders an empty table over a chip reading `Done 3`, which reads as a
  // broken screen rather than as a stale offset.
  //
  // ⚠️ Not on the first run. An effect fires once on mount with nothing changed, and that pass would
  // undo the offset the initial state just restored — the reset is for a filter somebody *changed*,
  // which cannot have happened before the table has been drawn once.
  const listed = useRef(false)
  useEffect(() => {
    if (listed.current) setPage(0)
    listed.current = true
    setMenuTaskId(null)
  }, [views, sort, asc, projectId, pageSize, deferredSearch])

  // ⛔ Written on every change, not on unmount: a cleanup does not run when the window is closed,
  // and the page you were on has to survive that too.
  const signature = taskListSignature({ projectId, views, sort, asc, pageSize, search: deferredSearch })
  useEffect(() => {
    writeTaskPage(signature, page)
  }, [signature, page])

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
    setAsc(OPENS_ASCENDING.has(column))
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
      setError(errorMessage(err))
    }
    await refresh()
  }

  const requestDelete = async (task: Task) => {
    setError(null)
    try {
      const blockers = await rpc('task.deleteCheck', { id: task.id })
      if (!blockers.ok) {
        setError(`Cannot delete t${task.seq}:\n${blockers.reasons.map((r) => `• ${r}`).join('\n')}`)
        return
      }
      setPendingDelete(task)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  // ⛔ Wide, like the flow board and the thread it sits between. A task row is a table of columns
  // being compared across rows — worker, model, price, age — and the 1100px measure that keeps prose
  // readable squeezes exactly those columns while the rest of the window goes unused.
  return (
    <div className="panel panel--wide">
      <header className="panel-head">
        <div>
          <h2>Tasks</h2>
          <p className="panel-sub">
            Each task can be a question or something to implement, left for the AI agents — it is
            effectively a prompt. Anyone can file one: you, the controller, or an agent mid-run.
          </p>
        </div>
        <button
          className="btn btn--primary"
          onClick={() =>
            setAdding((v) => {
              // ⛔ Cancel throws the scratch away. Otherwise what was typed is unclosable: the form
              // would reopen on the next visit, and the button that looks like it dismisses it
              // would do nothing lasting.
              if (v) clearComposerScratch(composerScope)
              return !v
            })
          }
        >
          {adding ? 'Cancel' : 'New task'}
        </button>
      </header>

      {error && <div className="alert">{error}</div>}
      {pendingDelete && (
        <div className="confirm-shade" role="presentation">
          <div
            className="confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-task-title"
            aria-describedby="delete-task-copy"
          >
            <h3 id="delete-task-title">Delete t{pendingDelete.seq}?</h3>
            <p id="delete-task-copy">
              Are you sure you want to delete &ldquo;{taskLabelShort(pendingDelete)}&rdquo;? Its runs
              will be kept, but the task will be removed from your task list.
            </p>
            <div className="confirm-actions">
              <button
                ref={declineDeleteRef}
                type="button"
                className="btn"
                onClick={() => setPendingDelete(null)}
              >
                No
              </button>
              <button
                type="button"
                className="btn btn--danger"
                onClick={() => {
                  const task = pendingDelete
                  setPendingDelete(null)
                  void act(() => rpc('task.delete', { id: task.id }))
                }}
              >
                Yes, delete
              </button>
            </div>
          </div>
        </div>
      )}
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
      <div className="tasks-bar">
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
        <div className="tasks-search">
          <input
            type="search"
            aria-label="Search tasks"
            placeholder="Search tasks…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {tasks.length === 0 ? (
        <div className="empty-inline">
          {/* ⚠️ Three different nothings. A project with no tasks needs telling what to do; a search
              that matches none of them needs telling that the query returned nothing; a filter
              that matches none of them needs telling that the tasks still exist — offering the same
              "file one and the scheduler will route it" to somebody who has forty tasks and one chip
              selected reads as the app having lost them. */}
          {search.trim() ? (
            <>
              <p>No tasks match &ldquo;{search.trim()}&rdquo;.</p>
              <p className="dim">
                The search query is filtering the list — clear it to see all tasks.
              </p>
              <button
                className="btn"
                onClick={() => setSearch('')}
              >
                Clear search
              </button>
            </>
          ) : views.length > 0 ? (
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
        <table className="tbl tbl--tasks">
          {/* ⛔ `tbl--tasks` exists for one rule: **the title column takes the slack.**
              `.tbl-title-cell` is shared with three narrower tables and caps the title at 48ch, and
              an automatic table layout hands out spare width in proportion to what each column
              *asked* for — so a title that had stopped asking at 48ch was given an even share of a
              stretched window alongside `Dep` and `From`, which need none of it. The rule, and the
              two bounds on it, are in `app.css`. */}
          <thead>
            <tr>
              <SortHead label="#" column="seq" sort={sort} asc={asc} onSort={sortBy} numeric />
              <SortHead label="Title" column="title" sort={sort} asc={asc} onSort={sortBy} />
              <SortHead
                label="From"
                column="from"
                sort={sort}
                asc={asc}
                onSort={sortBy}
                title="Who filed the task: you, the controller, or an agent."
              />
              {/* ⛔ On the table, not only in the detail pane. Which account is spending on a task is
                  the first thing an operator checks and the last thing that should need a click —
                  and a routing mistake is invisible until it is shown here.
                  ⛔ **The model is stacked in this same cell, not given a column of its own.** A
                  model id belongs to exactly one CLI, so the account and the model are one fact read
                  together — `Sonnet 5` under *Antigravity* is a misroute and under *ClaudeSecond* is
                  ordinary. Two columns apart, that pairing is a join the reader has to do by eye on
                  every row; stacked, the wrong one stands out — and the row stays one line of text
                  wide, which a table of a hundred tasks needs more than it needs a header. */}
              <SortHead
                label="Worker"
                column="worker"
                sort={sort}
                asc={asc}
                onSort={sortBy}
                title="The account this task last ran on. ⚠️ Sorted by the account's id rather than the label printed here, which groups one account's tasks together without the daemon having to carry display names."
              />
              <SortHead
                label="Dep"
                column="dep"
                sort={sort}
                asc={asc}
                onSort={sortBy}
                title="How many other tasks this one waits on."
              />
              {/* ⛔ How long, beside how much. A task showing only a token count answers "what did
                  this cost" and not "is this taking too long", and the second is the question
                  somebody watching a run actually has.
                  ⛔ **Agent time, not wall-clock.** This column used to be last-stop minus
                  first-dispatch, which counts queueing, quota parks and every minute a question sat
                  waiting on a person — so a four-minute task filed before dinner reported nine
                  hours. The gap is in the tooltip, where it belongs. */}
              <SortHead
                label="Took"
                column="took"
                sort={sort}
                asc={asc}
                onSort={sortBy}
                numeric
                title="Time an agent was actually working, excluding time queued, held, or waiting on you."
              />
              {/* ⛔ Money over tokens, stacked, because they answer the same question at two
                  different altitudes: what this task cost, and how much conversation it took to get
                  there. The header used to read "Tokens" only because a column headed "Spent" was
                  read as money by everybody who saw it — now it *is* money, with the tokens kept
                  underneath in the same quiet treatment the model line uses. */}
              <SortHead
                label="Price"
                column="price"
                sort={sort}
                asc={asc}
                onSort={sortBy}
                numeric
                title="What this task has cost. ⚠️ A task nobody could price sorts last in both directions — unpriced is not free."
              />
              {/* ⛔ A grade, and nothing gates on it. It sits beside Price because both are
                  after-the-fact measurements of one attempt — what it cost, and whether it was any
                  good — and because the comparison this column exists for is between agents, which
                  is a query over these rows rather than a screen of its own. */}
              <SortHead
                label="Quality"
                column="quality"
                sort={sort}
                asc={asc}
                onSort={sortBy}
                numeric
                title="Peer quality review: a different agent's weighted score out of 10, against the published rubric. Nothing in the fleet gates on it. ⚠️ Ungraded tasks sort last in both directions."
              />
              {/* ⛔ Both dates, not one. When a task was filed and when it last moved answer
                  different questions — "how long has this been sitting here" and "is anything still
                  happening" — and a task filed weeks ago that ran an hour ago looks identical to a
                  fresh one under either column alone. */}
              <SortHead label="Created" column="created" sort={sort} asc={asc} onSort={sortBy} />
              <SortHead label="Updated" column="updated" sort={sort} asc={asc} onSort={sortBy} />
              <SortHead label="Status" column="status" sort={sort} asc={asc} onSort={sortBy} />
              <th className="tbl-num tbl-col-action">Action</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => {
              const liveText =
                showsLiveOutput(task.status) && activity[task.id]?.length
                  ? activity[task.id]![activity[task.id]!.length - 1]?.text
                  : null

              // ⛔ One line, in one place, for the whole time a task is being worked on. What the
              // scheduler is doing before dispatch ("reading ClaudeThird's quota first…") and what
              // the agent says once it runs are the same question — *what is happening to this
              // task right now* — and answering it in two different spots meant the answer moved:
              // it appeared as small print inside the Status cell, then jumped below the row the
              // instant the run started. The reason outlives the wait, so `liveText` wins the
              // moment there is one.
              const belowLine = liveText ?? holdLine(task, now) ?? null

              // ⚠️ Once per row, not once per read: the resolution walks the fleet and the adapter's
              // model options, and the cell reads it more than once.
              const model = modelLine(task, fleet, modelOptions)

              const hasPriorActions =
                CANCELLABLE.has(task.status) ||
                task.status === 'paused_user' ||
                task.status === 'cancelled' ||
                task.status === 'awaiting_human' ||
                task.status === 'draft'

              return (
                <Fragment key={task.id}>
                  <tr
                    className={`${selected === task.id ? 'tbl-row--selected' : ''}${belowLine ? ' tbl-row--has-live' : ''}`}
                    onClick={() => onOpenTask(task.id)}
                  >
                    <td className="num tbl-num">{task.seq}</td>
                    <td className="tbl-title-cell">
                      <div className="tbl-title" title={task.title}>
                        <span className="tbl-strong">
                          {/* ⛔ A glyph that means *this belongs to something else*, not a box-drawing
                              corner. `└` claims to join the row above it, and this table is sorted
                              by whatever column the operator picked — one click on Updated and the
                              corner points at an unrelated task. A marker that says "child" says the
                              same thing in every sort order, which is the only thing the row
                              actually knows. */}
                          {task.lineageDepth > 0 && (
                            <span
                              className="tbl-subtask"
                              title="A piece of a larger task — open it to see its parent"
                              aria-label="subtask"
                            >
                              ➥{' '}
                            </span>
                          )}
                          {/* ⛔ **Two truncations were fighting, and the wrong one won.** The cell
                              already ellipsises at whatever width the column actually has; this call
                              cut the string at 70 characters *first*, so a wide window showed `…`
                              with empty space after it — a truncation mark that was not telling the
                              truth about the space available. The cap stays, because `title` is the
                              whole prompt and can be paragraphs, but it is now well past what the
                              widest column can draw, which leaves CSS to decide where the text ends
                              and the `…` to mean what it says. */}
                          {taskLabelShort(task, TITLE_CHARS)}
                        </span>
                      </div>
                      {task.branch && <div className="tbl-path mono">{task.branch}</div>}
                    </td>
                    <td className="dim">
                      {task.createdBy.kind === 'human'
                        ? 'you'
                        : task.createdBy.kind === 'controller'
                          ? 'ctrl'
                          : 'agent'}
                    </td>
                    <td className={task.ranOn || task.assignee ? '' : 'dim'}>
                      {assigneeLabel(task, fleet)}
                      {/* ⚠️ The id in the tooltip, always. The label is written for reading at a
                          glance; the operator chasing a routing mistake needs the exact string that
                          was dispatched, and it must never be more than a hover away. */}
                      {model && (
                        <div
                          className="tbl-model"
                          title={
                            model.ran
                              ? `${model.id} — the model the last run was dispatched with`
                              : `${model.id} — what the next dispatch would ask for`
                          }
                        >
                          {model.label}
                        </div>
                      )}
                    </td>
                    <td className="num dim" title={dependencyTooltip(task, tasks)}>
                      {task.dependsOn.length ? `←${task.dependsOn.length}` : '—'}
                    </td>
                    <td className="num tbl-num dim" title={activeTimeTitle(task, now)}>
                      {activeTime(task, now)}
                    </td>
                    <td className="num tbl-num">
                      <Money
                        usd={task.budget.spentUsd}
                        estimated={task.budget.spentUsdEstimated}
                        partial={task.budget.spentUsdPartial}
                        title={taskPriceTitle(task.budget)}
                      />
                      <div
                        className="tbl-model"
                        title="Input, output and cache, summed from every run's own transcript. A different measurement from the price above, and deliberately shown beside it."
                      >
                        {tokens(task.budget.spentTokens || null)}
                      </div>
                    </td>
                    <td className="num tbl-num">
                      {task.qualityScore === null ? (
                        <span className="dim">—</span>
                      ) : (
                        <span
                          title={
                            `${task.qualityReviewCount > 1 ? `Average of ${task.qualityReviewCount} completed reviews` : `Scored by ${task.qualityReviewer ?? 'another agent'}`}: ${task.qualityScore.toFixed(1)}/10` +
                            (task.qualityReviewedAt
                              ? ` on ${new Date(task.qualityReviewedAt).toLocaleString()}`
                              : '')
                          }
                        >
                          {task.qualityScore.toFixed(1)}
                        </span>
                      )}
                    </td>
                    <td className="tbl-when dim" title={new Date(task.createdAt).toLocaleString()}>
                      {when(task.createdAt)}
                    </td>
                    <td className="tbl-when dim" title={new Date(task.updatedAt).toLocaleString()}>
                      {when(task.updatedAt)}
                    </td>
                    <td>
                      <span className={`status ${STATUS_TONE[task.gradingWorkerId ? 'grading' : task.status] ?? ''}`}>
                        {statusLabel(task)}
                        {isWorking(task) && <Working />}
                      </span>
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
                            {task.gradingWorkerId ? (
                              <button
                                type="button"
                                role="menuitem"
                                className="action-menu-item"
                                title="Stop the quality review. The task remains in its finished state."
                                onClick={() => {
                                  setMenuTaskId(null)
                                  void act(() => rpc('review.cancel', { taskId: task.id }))
                                }}
                              >
                                Stop grading
                              </button>
                            ) : (
                              CANCELLABLE.has(task.status) && (
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
                                  Stop
                                </button>
                              )
                            )}
                            {/* ⛔ `paused_quota` included. It resumes itself on the reset now, but an
                                operator looking at a window that has visibly rolled over should not
                                have to wait for a clock they can already see has passed. */}
                            {(task.status === 'paused_user' ||
                              task.status === 'cancelled' ||
                              task.status === 'paused_quota') && (
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
                            {task.status === 'paused_quota' && (
                              <button
                                type="button"
                                role="menuitem"
                                className="action-menu-item"
                                title="Override the quota gate and resume immediately to continue"
                                onClick={() => {
                                  setMenuTaskId(null)
                                  void act(() => rpc('task.overrideQuota', { id: task.id }))
                                }}
                              >
                                Override &amp; continue
                              </button>
                            )}
                            {task.status === 'ready' && /% of its .* window/.test(task.holdReason ?? '') && (
                              <button
                                type="button"
                                role="menuitem"
                                className="action-menu-item"
                                title="Dispatch this task even though the account is at or past 92% of its window."
                                onClick={() => {
                                  setMenuTaskId(null)
                                  void act(() => rpc('task.overrideQuota', { id: task.id }))
                                }}
                              >
                                Run now anyway
                              </button>
                            )}
                            {/* ⛔ `paused_user` included. Stopping a task and judging it
                                finished are two different decisions, and an operator who stopped
                                one and then changed their mind had only Resume or Delete — so a
                                task whose work was already good enough sat parked, and nothing
                                waiting on it was ever released. `resolveTask` completes from any
                                status, so the only thing missing was somewhere to press. */}
                            {(task.status === 'awaiting_human' || task.status === 'paused_user') && (
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
                                void requestDelete(task)
                              }}
                            >
                              Delete
                            </button>
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                  {/* ⚠️ The same row, the same prefix, whichever of the two is speaking. Marking
                      the scheduler's reason differently from the agent's output would be honest
                      about the source and wrong about the question: an operator scanning the table
                      is asking what is happening to this task, and a line that changes shape
                      halfway through the answer is read as a new event rather than the same one
                      continuing. `belowLine` is null once nothing is in flight, so a finished task
                      draws no row at all. */}
                  {belowLine && (
                    <tr
                      className={`tbl-row--live${selected === task.id ? ' tbl-row--selected' : ''}`}
                      onClick={() => onOpenTask(task.id)}
                    >
                      <td colSpan={12} className="tbl-live-cell">
                        <div className="tbl-live-line" title={belowLine}>
                          <span className="tbl-live-prefix" aria-hidden>&gt;</span>
                          <span className="tbl-live-text">
                            {belowLine.length > 100 ? `${belowLine.slice(0, 100)}…` : belowLine}
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
              <>
                <button
                  className="btn btn--ghost"
                  disabled={page === 0}
                  onClick={() => setPage(0)}
                  title="First page"
                >
                  ⇤ First
                </button>
                <button
                  className="btn btn--ghost"
                  disabled={page === 0}
                  onClick={() => setPage((p) => p - 1)}
                  title="Newer tasks"
                >
                  ← Newer
                </button>
              </>
            )}
            <span className="dim">
              {pages > 1
                ? `page ${page + 1} of ${pages} · ${total} task${total === 1 ? '' : 's'}`
                : `${total} task${total === 1 ? '' : 's'}`}
            </span>
            {pages > 1 && (
              <>
                <button
                  className="btn btn--ghost"
                  disabled={page >= pages - 1}
                  onClick={() => setPage((p) => p + 1)}
                  title="Older tasks"
                >
                  Older →
                </button>
                <button
                  className="btn btn--ghost"
                  disabled={page >= pages - 1}
                  onClick={() => setPage(pages - 1)}
                  title="Last page"
                >
                  End ⇥
                </button>
              </>
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
