import { describe, expect, it } from 'vitest'
import type { PendingWork, Task } from '@shared/tasks'
import { settleControls } from '@renderer/lib/finishrung'
import { REMOTE_METHODS } from '../../../daemon/remote/policy.js'
import { commitRungFor, decisionsFor, type TaskDecision } from './question.js'

/**
 * The phone must not drift from the desktop thread: when the desktop's settle card changes what
 * Commit means, or the remote allowlist stops permitting an action the phone offers, this file
 * goes red by name. It pins literals, not re-derivations — recomputing through the same
 * functions would pass while disagreeing with the desktop about everything.
 */

const NOW = 1_700_000_000_000

function task(over: Partial<Task> = {}): Task {
  return {
    id: 't1', seq: 7, title: 'sweep the porch', titleSummary: null, status: 'awaiting_human',
    kind: 'conversation', updatedAt: NOW - 1000, holdReason: null, holdUntil: null,
    quotaPreemptWarning: null, quotaOverrideUntil: null, deletedAt: null, projectId: 'p1',
    branch: 'warmstart/t7-sweep', constraints: {}, finishPolicy: 'inherit', workspaceMode: 'inherit',
    ...over
  } as Task
}

const DIRTY: PendingWork = {
  supported: true, reason: '', branch: 'warmstart/t7-sweep', unclaimed: false,
  dirtyFiles: 2, untrackedFiles: 0, unlandedCommits: 0, hasDiff: true
}
const CLEAN: PendingWork = { ...DIRTY, dirtyFiles: 0, hasDiff: false }
const UNREADABLE: PendingWork = { ...CLEAN, supported: false, reason: 'no workspace has the branch' }

describe('phone Commit agrees with the desktop settle card', () => {
  it('offers Commit exactly when the desktop would draw it', () => {
    // Literals on both sides: the desktop contract, then the phone's answer to the same state.
    expect(settleControls(true, DIRTY).commit).toBe(true)
    expect(settleControls(true, UNREADABLE).commit).toBe(true)
    expect(settleControls(true, CLEAN).commit).toBe(false)
    expect(settleControls(true, null).commit).toBe(false)
    expect(settleControls(false, DIRTY).commit).toBe(false)
    for (const pending of [DIRTY, UNREADABLE, CLEAN, null] as const) {
      const desktop = settleControls(true, pending).commit
      expect(decisionsFor(task(), NOW, pending).includes('commit')).toBe(desktop)
    }
    expect(decisionsFor(task({ kind: 'work' }), NOW, DIRTY).includes('commit')).toBe(false)
    expect(decisionsFor(task({ status: 'completed' }), NOW, DIRTY).includes('commit')).toBe(false)
  })

  it('sends the rung the desktop menu opens on', () => {
    // The task's own rung wins; the project's answers next; otherwise the quiet fallback.
    expect(commitRungFor(task({ finishPolicy: 'commit-and-verify' }), { policy: 'commit-and-merge' }, 'worktree')).toBe('commit-and-verify')
    expect(commitRungFor(task(), { policy: 'commit-and-merge' }, 'worktree')).toBe('commit-and-merge')
    expect(commitRungFor(task(), null, 'worktree')).toBe('commit-only')
    // A rung Commit cannot offer is never sent, even when the project answers with it.
    expect(commitRungFor(task(), { policy: 'await-human' }, 'worktree')).toBe('commit-only')
  })
})

/**
 * Every RPC a phone decision can press, and what the remote allowlist says about it. A new
 * phone action calling a denied method — or an allowlist change pulling one out from under the
 * phone — fails here with the method's name, not as a 403 on somebody's phone.
 */
const DECISION_RPCS: Record<TaskDecision, string[]> = {
  override: ['task.overrideQuota'],
  retry: ['task.resolveRetry'],
  reland: ['task.land'],
  resume: ['task.resume'],
  reassign: ['task.setWorker', 'task.setModel', 'task.message'],
  resolve: ['task.resolve'],
  commit: ['task.commitConversation']
}

describe('phone decisions stay inside the remote allowlist', () => {
  it.each(Object.entries(DECISION_RPCS))('%s calls only permitted methods', (_decision, methods) => {
    for (const method of methods) {
      expect(REMOTE_METHODS[method as keyof typeof REMOTE_METHODS], method).not.toBe('deny')
      expect(REMOTE_METHODS[method as keyof typeof REMOTE_METHODS], method).toBeDefined()
    }
  })
})
