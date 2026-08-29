import { describe, expect, it } from 'vitest'
import type { TaskStatus } from '@shared/tasks'
import { showsLiveOutput } from './live.js'

/**
 * ⛔ Tested here rather than in the UI suite, and for a measured reason: that suite's worker has no
 * credentials, so nothing it files ever dispatches. There is never a running task, never a line of
 * agent output, and a check written there for "no live bubble on a finished task" would pass on a
 * thread that had no bubble under any circumstances.
 *
 * ⚠️ Reported from the app on 2026-08-28: a task reading `completed` in its own ledger was still
 * drawing a live bubble that said it would be replaced when the run ended.
 */

const RESTING: TaskStatus[] = [
  'draft',
  'ready',
  'blocked',
  'scheduled',
  'awaiting_human',
  'paused_quota',
  'paused_user',
  'cancelling',
  'cancelled',
  'completed',
  'failed'
]

describe('when the thread shows a live bubble', () => {
  it('shows it while an agent is actually running', () => {
    expect(showsLiveOutput('running')).toBe(true)
  })

  it('shows it while the workspace is being claimed', () => {
    // ⚠️ `assigned` is the branch checkout and the prepare hook. The agent is about to speak, and an
    // empty bubble is the honest state — the alternative is a pane that stays blank and then jumps.
    expect(showsLiveOutput('assigned')).toBe(true)
  })

  it('hides it in every state where nothing is running', () => {
    // ⭐ The regression. `completed` is the one that was seen, but the bug was not about completion —
    // it was about reading the *tail* instead of the status, and the tail survives every one of
    // these. Asserting the whole set is what stops the fix being re-narrowed to `completed`.
    for (const status of RESTING) {
      expect(showsLiveOutput(status), status).toBe(false)
    }
  })
})
