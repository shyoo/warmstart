import type { Task } from '@shared/tasks'

type CompletionTask = Pick<Task, 'id' | 'projectId' | 'status' | 'deletedAt'>

/** Window-local notifications: the first snapshot is history, later completions are news. */
export class ProjectCompletions {
  private statuses = new Map<string, Task['status']>()
  private pending = new Map<string, string>()

  observe(tasks: readonly CompletionTask[], initialSnapshot = false): Set<string> {
    for (const task of tasks) {
      const previous = this.statuses.get(task.id)
      if (task.deletedAt || task.status !== 'completed' || task.projectId === null) {
        this.pending.delete(task.id)
      } else if (previous !== 'completed' && (!initialSnapshot || previous !== undefined)) {
        this.pending.set(task.id, task.projectId)
      } else if (this.pending.has(task.id)) {
        this.pending.set(task.id, task.projectId)
      }
      this.statuses.set(task.id, task.status)
    }
    return new Set(this.pending.values())
  }

  acknowledge(projectId: string): Set<string> {
    for (const [taskId, project] of this.pending) {
      if (project === projectId) this.pending.delete(taskId)
    }
    return new Set(this.pending.values())
  }
}
