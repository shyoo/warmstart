import { beforeEach, describe, expect, it } from 'vitest'
import type { Project, Task, TaskStatus } from '@shared/tasks'
import {
  FINISH_LABELS,
  SHARING_LABELS,
  resolveFinishPolicy,
  resolveSessionSharing
} from '@shared/tasks'
import { projectWorkState, statusLabel, workspacePathFor } from './taskview.js'
import { readFleetCollapsed, writeFleetCollapsed } from './prefs.js'

/**
 * ⛔ Reported from the app on 2026-08-29, running one worker with `maxConcurrent: 1`. Two tasks were
 * filed; one ran and the other sat at **`ready`** for seven minutes. The scheduler knew exactly why
 * and had written it on the row — *"ClaudeFirst disabled; ClaudeSecond disabled; Antigravity at
 * capacity; ClaudeThird disabled"* — but the word beside it still said `ready`, which is the
 * scheduler's term for *eligible* and reads to a person as *waiting for you to press something*.
 *
 * ⚠️ The status itself is not the thing to change, and `setHoldReason` in tasks.ts already argues
 * why: the task really is `ready`, and a domain status for "ready but nothing free" would put a lie
 * in the DAG to fix a gap in the UI. So this is a rename at the last possible moment.
 */

const task = (
  over: Partial<Pick<Task, 'status' | 'holdReason'>> = {}
): Pick<Task, 'status' | 'holdReason'> => ({ status: 'ready', holdReason: null, ...over })

describe('the word a person reads beside a task', () => {
  it('calls a held task queued', () => {
    expect(statusLabel(task({ holdReason: 'Antigravity at capacity' }))).toBe('queued')
  })

  it('leaves a task the scheduler has not passed over as ready', () => {
    // ⚠️ The distinction being drawn. A freshly filed task is `ready` with no reason for up to one
    // tick, and it genuinely is about to start — calling *that* queued would be the same error in
    // the other direction.
    expect(statusLabel(task({ holdReason: null }))).toBe('ready')
  })

  it('renames nothing else, whatever reason is attached', () => {
    // ⛔ A hold reason is written on other statuses too — `awaiting_human` carries one, and so does
    // a cancelled task. Only `ready` is ambiguous, so only `ready` is renamed.
    const others: TaskStatus[] = ['awaiting_human', 'blocked', 'paused_quota', 'failed', 'completed']
    for (const status of others) {
      expect(statusLabel(task({ status, holdReason: 'some reason' })), status).toBe(status)
    }
  })

  it('still calls a dispatching task dispatching', () => {
    // The rename that was already here, which this must not have displaced.
    expect(statusLabel(task({ status: 'assigned' }))).toBe('dispatching')
  })
})

describe('the workspace directory a person reads in the task ledger', () => {
  it('returns null before anything has run', () => {
    expect(workspacePathFor([], [])).toBeNull()
  })

  it('reads cwd from the latest run’s session', () => {
    const runs = [{ sessionId: 's-2' }, { sessionId: 's-1' }]
    const sessions = [
      { id: 's-1', cwd: 'C:\\projects\\my-repo_workspaces\\ws1' },
      { id: 's-2', cwd: 'C:\\projects\\my-repo_workspaces\\ws2' }
    ]
    expect(workspacePathFor(runs, sessions)).toBe('C:\\projects\\my-repo_workspaces\\ws2')
  })

  it('falls back to the first available session when latest run has no session', () => {
    const runs = [{ sessionId: null }, { sessionId: 's-1' }]
    const sessions = [{ id: 's-1', cwd: 'C:\\projects\\my-repo_workspaces\\ws1' }]
    expect(workspacePathFor(runs, sessions)).toBe('C:\\projects\\my-repo_workspaces\\ws1')
  })
})

describe('inherited policy labels and resolution', () => {
  it('resolves finish policy from project when specified', () => {
    const proj = { config: { landing: { finish: 'await-human' } } } as unknown as Project
    const res = resolveFinishPolicy(null, proj)
    expect(res.policy).toBe('await-human')
    expect(FINISH_LABELS[res.policy]).toBe('await human')
  })

  it('falls back to fleet finish policy when project does not specify', () => {
    const proj = { config: {} } as unknown as Project
    const res = resolveFinishPolicy(null, proj, 'pull-request')
    expect(res.policy).toBe('pull-request')
    expect(FINISH_LABELS[res.policy]).toBe('open a pull request')
  })

  it('resolves session sharing from project when specified', () => {
    const proj = { config: { session: { share: 'on' } } } as unknown as Project
    const res = resolveSessionSharing(null, proj)
    expect(res.sharing).toBe('on')
    expect(SHARING_LABELS[res.sharing]).toBe('reuse one if possible')
  })

  it('falls back to fleet session sharing when project does not specify', () => {
    const proj = { config: {} } as unknown as Project
    const res = resolveSessionSharing(null, proj, 'off')
    expect(res.sharing).toBe('off')
    expect(SHARING_LABELS[res.sharing]).toBe('always start a new one')
  })

  it('resolves inherited model and effort from worker defaults', () => {
    const worker = { defaultModel: 'gemini-3.7-flash-high', defaultEffort: null }
    expect(worker.defaultModel ?? 'CLI default').toBe('gemini-3.7-flash-high')
    expect(worker.defaultEffort ?? 'CLI default').toBe('CLI default')

    const claudeWorker = { defaultModel: 'claude-sonnet-5', defaultEffort: 'high' }
    expect(claudeWorker.defaultModel ?? 'CLI default').toBe('claude-sonnet-5')
    expect(claudeWorker.defaultEffort ?? 'CLI default').toBe('high')
  })
})

describe('preferences persistence in localStorage', () => {
  const store = new Map<string, string>()
  const mockStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, val: string) => store.set(key, String(val)),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear()
  }

  beforeEach(() => {
    store.clear()
    Object.defineProperty(globalThis, 'window', {
      value: { localStorage: mockStorage },
      configurable: true,
      writable: true
    })
  })


  it('defaults to false for fleet collapsed when unset', () => {
    expect(readFleetCollapsed()).toBe(false)
  })

  it('persists and restores fleet collapsed state', () => {
    writeFleetCollapsed(true)
    expect(readFleetCollapsed()).toBe(true)

    writeFleetCollapsed(false)
    expect(readFleetCollapsed()).toBe(false)
  })
})

describe('project work state for left pane indicators', () => {
  it('returns idle when there are no tasks', () => {
    expect(projectWorkState([])).toBe('idle')
  })

  it('returns idle when all tasks are completed, failed, cancelled, draft, or blocked', () => {
    const tasks: Array<{ status: TaskStatus }> = [
      { status: 'completed' },
      { status: 'failed' },
      { status: 'cancelled' },
      { status: 'draft' },
      { status: 'blocked' }
    ]
    expect(projectWorkState(tasks)).toBe('idle')
  })

  it('returns working when a task is running', () => {
    const tasks: Array<{ status: TaskStatus }> = [{ status: 'completed' }, { status: 'running' }]
    expect(projectWorkState(tasks)).toBe('working')
  })

  it('returns working when a task is in flight (ready, scheduled, assigned, cancelling)', () => {
    expect(projectWorkState([{ status: 'ready' }])).toBe('working')
    expect(projectWorkState([{ status: 'scheduled' }])).toBe('working')
    expect(projectWorkState([{ status: 'assigned' }])).toBe('working')
    expect(projectWorkState([{ status: 'cancelling' }])).toBe('working')
  })

  it('returns needs_attention when a task is awaiting_human', () => {
    const tasks: Array<{ status: TaskStatus }> = [{ status: 'awaiting_human' }]
    expect(projectWorkState(tasks)).toBe('needs_attention')
  })

  it('returns needs_attention when a task is paused_user', () => {
    const tasks: Array<{ status: TaskStatus }> = [{ status: 'paused_user' }]
    expect(projectWorkState(tasks)).toBe('needs_attention')
  })

  it('prioritizes needs_attention over working when tasks in both states exist', () => {
    const tasks: Array<{ status: TaskStatus }> = [
      { status: 'running' },
      { status: 'awaiting_human' }
    ]
    expect(projectWorkState(tasks)).toBe('needs_attention')
  })
})


