import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Task } from '@shared/tasks'
import { rpc } from '../lib/daemon'
import { IN_FLIGHT, statusLabel, STATUS_TONE, Working } from '../lib/taskview'

/**
 * Prerequisites, drawn and edited in one place.
 *
 * ⛔ The DAG has been in the daemon since M2 — `task_deps`, the cycle check, `admit()` — and the only
 * way to put an edge in it was to be an agent calling `task_create` with `depends_on`. A person
 * filing "do X after Y" had to file X, wait, and remember. This module is the missing half: the same
 * edge, chosen by hand, at filing time and afterwards in the thread.
 *
 * ⚠️ The candidate list and the cycle filter live here rather than in either caller, because the two
 * callers differ only in where the answer goes — the new-task form holds ids until the task exists,
 * the thread posts each edge as it is chosen — and a second copy of "which tasks may I depend on"
 * would be a second chance to offer a cycle.
 */

/** Statuses that can never reach `completed`, so an edge to one would block its dependent for ever. */
const NEVER_COMPLETES = new Set<Task['status']>(['cancelled', 'failed'])

/**
 * Every task that could be a prerequisite, newest first, refreshed on demand.
 *
 * ⚠️ `task.list`, not `task.page`: the picker wants the whole fleet's tasks, not the bucket the
 * table beneath it happens to be filtered to. A dependency across projects is legal, so the list is
 * not narrowed to one either — the project each task belongs to is drawn on its row instead.
 */
export function useTaskCandidates(): { tasks: Task[]; reload: () => Promise<void> } {
  const [tasks, setTasks] = useState<Task[]>([])
  const reload = useCallback(async () => {
    try {
      const got = await rpc('task.list', {})
      setTasks([...got].sort((a, b) => b.seq - a.seq))
    } catch {
      // A picker with nothing in it is a picker that offers no dependency, which is the same thing
      // this screen did before it existed. It is not a reason to fail the form around it.
      setTasks([])
    }
  }, [])
  useEffect(() => {
    void reload()
  }, [reload])
  return { tasks, reload }
}

/**
 * Which of `all` may be added as a prerequisite of `taskId`, given the edges already chosen.
 *
 * ⛔ The cycle test is run here as well as in the daemon, and the daemon's is the one that decides.
 * This one exists so a person is not offered a choice that will be refused: `reaches` follows
 * `dependsOn` from each candidate, so anything that already waits on this task — directly or four
 * edges away — is not in the list.
 */
export function candidatesFor(all: Task[], taskId: string | null, chosen: string[]): Task[] {
  const byId = new Map(all.map((t) => [t.id, t]))
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set<string>()
    const stack = [from]
    while (stack.length) {
      const current = stack.pop()
      if (!current || seen.has(current)) continue
      seen.add(current)
      if (current === to) return true
      stack.push(...(byId.get(current)?.dependsOn ?? []))
    }
    return false
  }
  return all.filter((t) => {
    if (t.id === taskId) return false
    if (chosen.includes(t.id)) return false
    // ⚠️ A completed task is still offered. It is an edge that is satisfied the moment it is made,
    // which is a perfectly ordinary thing to want to record; a cancelled or failed one is not, and
    // would hold its dependent at `blocked` until somebody noticed.
    if (NEVER_COMPLETES.has(t.status)) return false
    return !(taskId && reaches(t.id, taskId))
  })
}

/** `t12 · title` — how a task reads in a list of one-line options. */
function optionLabel(task: Task, projectName?: string): string {
  const suffix = projectName ? ` — ${projectName}` : ''
  return `t${task.seq} · ${task.title}${suffix}`
}

/**
 * The list of prerequisites (or dependents), with a remove control where removing is offered.
 *
 * ⚠️ `fallbackIds` / `fallbackCount` draw a count when the rows themselves were not fetched — the
 * task list has ids on every row and titles for none of them.
 */
export function DependencyList({
  tasks,
  fallbackIds,
  fallbackCount,
  onOpenTask,
  onRemove,
  busy
}: {
  tasks: Task[]
  fallbackIds?: string[]
  fallbackCount?: number
  onOpenTask?: (taskId: string) => void
  /** Offered only where an edge may be dropped. Absent means the list is read-only. */
  onRemove?: (taskId: string) => void
  busy?: boolean
}): React.JSX.Element {
  if (tasks.length === 0) {
    if (fallbackIds && fallbackIds.length > 0) {
      return (
        <span className="dim">
          {fallbackIds.length} {fallbackIds.length === 1 ? 'task' : 'tasks'}
        </span>
      )
    }
    if (fallbackCount && fallbackCount > 0) {
      return (
        <span className="dim">
          {fallbackCount} {fallbackCount === 1 ? 'task' : 'tasks'}
        </span>
      )
    }
    return <span className="dim">none</span>
  }

  return (
    <div className="dep-list">
      {tasks.map((dep) => {
        const isDone = dep.status === 'completed'
        return (
          <div key={dep.id} className="dep-item">
            <button
              type="button"
              className={`dep-link ${isDone ? 'dep-link--done' : ''}`}
              onClick={() => onOpenTask?.(dep.id)}
              title={`Open t${dep.seq}: ${dep.title} (${statusLabel(dep)})`}
            >
              <span className="dep-seq">t{dep.seq}</span>
              <span className="dep-title">{dep.title}</span>
              <span className={`status ${STATUS_TONE[dep.status] ?? ''}`}>
                {statusLabel(dep)}
                {IN_FLIGHT.has(dep.status) && <Working />}
              </span>
            </button>
            {onRemove && (
              <button
                type="button"
                className="dep-remove"
                disabled={busy}
                aria-label={`Stop waiting on t${dep.seq}`}
                title={`Stop waiting on t${dep.seq}: ${dep.title}`}
                onClick={() => onRemove(dep.id)}
              >
                ×
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * The one control that adds an edge: pick a task, and it is added.
 *
 * ⛔ No second "Add" button. The select has exactly one effect and confirming it separately would be
 * a click that can only ever be yes — the way back out is the × on the row it just made.
 */
export function AddDependency({
  candidates,
  projectNames,
  onAdd,
  busy,
  placeholder = 'wait on a task…'
}: {
  candidates: Task[]
  projectNames?: Map<string, string>
  onAdd: (taskId: string) => void
  busy?: boolean
  placeholder?: string
}): React.JSX.Element | null {
  if (candidates.length === 0) return null
  return (
    <select
      className="dep-add"
      value=""
      disabled={busy}
      aria-label="Add a prerequisite"
      onChange={(e) => {
        const id = e.target.value
        // ⚠️ Reset before the handler, not after. The select is uncontrolled between renders while a
        // request is in flight, and leaving the chosen row showing would read as "this is the value"
        // rather than "this was just added to the list above".
        e.target.value = ''
        if (id) onAdd(id)
      }}
    >
      <option value="">{placeholder}</option>
      {candidates.map((t) => (
        <option key={t.id} value={t.id}>
          {optionLabel(t, t.projectId ? projectNames?.get(t.projectId) : undefined)}
        </option>
      ))}
    </select>
  )
}

/**
 * Prerequisites of a task that does not exist yet — the new-task form's half.
 *
 * ⛔ Ids held in the form, not edges written as they are chosen. Nothing is created until the task
 * is filed, so a form abandoned half-filled leaves the DAG exactly as it found it.
 */
export function DependencyChooser({
  all,
  chosen,
  onChange,
  projectNames
}: {
  all: Task[]
  chosen: string[]
  onChange: (next: string[]) => void
  projectNames?: Map<string, string>
}): React.JSX.Element {
  const byId = useMemo(() => new Map(all.map((t) => [t.id, t])), [all])
  const picked = chosen.map((id) => byId.get(id)).filter((t): t is Task => !!t)
  const candidates = useMemo(() => candidatesFor(all, null, chosen), [all, chosen])
  return (
    <div>
      {picked.length > 0 && (
        <DependencyList
          tasks={picked}
          onRemove={(id) => onChange(chosen.filter((c) => c !== id))}
        />
      )}
      <AddDependency
        candidates={candidates}
        projectNames={projectNames}
        onAdd={(id) => onChange([...chosen, id])}
        placeholder={picked.length > 0 ? 'wait on another task…' : 'wait on a task…'}
      />
    </div>
  )
}
