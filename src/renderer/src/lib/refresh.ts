import type { DaemonEvent } from '@shared/protocol'
import type { Task } from '@shared/tasks'
import { currentTargetId } from './target'

/** One active read and one follow-up, using the latest callback. Every caller can await settlement. */
export function refreshGate() {
  let running: Promise<void> | null = null
  let next: (() => Promise<void>) | null = null
  return {
    run(work: () => Promise<void>): Promise<void> {
      if (running) { next = work; return running }
      running = (async () => {
        let job: (() => Promise<void>) | null = work
        while (job) {
          await job()
          job = next
          next = null
        }
      })().finally(() => { running = null; next = null })
      return running
    }
  }
}

export function patchTask(tasks: Task[], task: Task): Task[] {
  if (task.deletedAt !== null) return tasks.filter((t) => t.id !== task.id)
  const index = tasks.findIndex((t) => t.id === task.id)
  if (index < 0) return [...tasks, task]
  const patched = [...tasks]
  patched[index] = task
  return patched
}

// Routing metadata only, scoped to the displayed computer. No task bodies are retained here.
let target = ''
const projects = new Map<string, string | null>()
const movedFrom = new Map<string, string | null>()
export function rememberTaskProjects(tasks: readonly Pick<Task, 'id' | 'projectId'>[], replace = false, requestedTarget = currentTargetId()): void {
  if (requestedTarget !== currentTargetId()) return
  if (target !== currentTargetId() || replace) { projects.clear(); movedFrom.clear(); target = currentTargetId() }
  for (const t of tasks) {
    const previous = projects.get(t.id)
    if (previous !== undefined && previous !== t.projectId) movedFrom.set(t.id, previous)
    projects.set(t.id, t.projectId)
  }
}

export function taskPageChanged(event: DaemonEvent, projectId: string | undefined, visible: readonly Pick<Task, 'id'>[]): boolean {
  if (event.type === 'task.changed') {
    rememberTaskProjects([event.task])
    const previous = movedFrom.get(event.task.id)
    movedFrom.delete(event.task.id)
    return !projectId || event.task.projectId === projectId || previous === projectId || visible.some((t) => t.id === event.task.id)
  }
  if (event.type !== 'run.changed' || !event.run.taskId) return false
  const known = target === currentTargetId() ? projects.get(event.run.taskId) : undefined
  return !projectId || known === undefined || known === projectId
}
