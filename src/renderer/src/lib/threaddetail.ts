/**
 * What the task thread holds for the task the route names — and never for any other.
 *
 * ⛔ **A thread that shows task A under a route for task B sends every word and every button to A.**
 * t936's question (a different project) landed on t948 twice, with `task.message`'s `id` taken from
 * the pane's own `detail.task.id`. The daemon did what it was told; the pane was drawing the wrong
 * task. Cause, from the code: `TaskThread` kept one `detail` and `setDetail(got)`-ed whatever
 * `task.get` answered *last*, for whichever task asked. A slow fetch for the task you had just left
 * (every `task.changed` on a busy task starts one) resolved after the navigation and put the old
 * task's thread, its composer and its Stop/Complete buttons back under the new route. On the first
 * render after the route changed the old detail was also still the thing being drawn.
 *
 * ⚠️ Inferred from the code, not reproduced against the live app: the daemon log cannot say which
 * fetch lost the race. What the tests pin is the invariant that makes the race harmless.
 *
 * ⭐ **Three rules, each a way the pane lied:**
 *  1. A response is applied only if it was asked for the task the store is open on.
 *  2. A response older than one already applied is dropped — it is a stale read of the same task.
 *  3. `viewFor` answers *loading* for any state that is not about the route's task, so the render
 *     between a route change and the effect that re-opens the store draws nothing of the old task.
 *
 * Plain TypeScript with no React in it so the ordering — the part that went wrong — is testable
 * without a DOM; `useTaskDetail` (in `TaskThread.tsx`) is the thin binding.
 */

export interface DetailLike {
  task: { id: string }
}

export interface DetailState<T extends DetailLike> {
  /** The task this state is *about*. Whatever `detail` holds belongs to it or is null. */
  taskId: string
  detail: T | null
  missing: boolean
}

export class TaskDetailStore<T extends DetailLike> {
  private state: DetailState<T>
  private readonly listeners = new Set<() => void>()
  /** Requests are numbered as they start; a response keeps the number it started with. */
  private issued = 0
  private applied = 0

  constructor(
    private readonly fetchDetail: (taskId: string) => Promise<T | null>,
    taskId: string
  ) {
    this.state = { taskId, detail: null, missing: false }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): DetailState<T> => this.state

  /** Switch to another task. Anything still in flight for the previous one is discarded on arrival (rule 1). */
  open(taskId: string): void {
    // The same task keeps what it has; the caller refreshes if it wants newer.
    if (taskId === this.state.taskId) return
    this.set({ taskId, detail: null, missing: false })
  }

  /**
   * Read the open task again. Resolves once this request is settled, whether or not it was applied;
   * a rejection (the daemon unreachable) propagates to the caller exactly as the bare `rpc` did.
   */
  async refresh(): Promise<void> {
    const taskId = this.state.taskId
    const ticket = ++this.issued
    const got = await this.fetchDetail(taskId)
    // ⛔ Rule 1: the store moved to another task while this was in flight.
    if (taskId !== this.state.taskId) return
    // ⛔ Rule 2: a newer read of this task has already been applied.
    if (ticket < this.applied) return
    // ⛔ And never a body that names another task, whatever it was asked for.
    if (got !== null && got.task.id !== taskId) return
    this.applied = ticket
    this.set(got ? { taskId, detail: got, missing: false } : { taskId, detail: null, missing: true })
  }

  private set(next: DetailState<T>): void {
    this.state = next
    for (const listener of [...this.listeners]) listener()
  }
}

/**
 * Rule 3. What to draw for the route's task: the held detail only if it is that task's.
 *
 * ⚠️ A fresh object for the loading case would defeat `useSyncExternalStore`'s identity check, so the
 * loading view is one shared constant.
 */
const LOADING = { detail: null, missing: false } as const

export function viewFor<T extends DetailLike>(
  state: DetailState<T>,
  routeTaskId: string
): { detail: T | null; missing: boolean } {
  if (state.taskId !== routeTaskId) return LOADING
  if (state.detail !== null && state.detail.task.id !== routeTaskId) return LOADING
  return state
}
