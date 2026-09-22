import { beforeEach, describe, expect, it } from 'vitest'
import type { Compaction, Project, Run, Task, TaskStatus } from '@shared/tasks'
import { ROOT_MANDATE } from '@shared/tasks'
import type { ModelOptions, Worker } from '@shared/protocol'
import type { QualityReview } from '@shared/review'
import type { FleetEntry } from './daemon'
import {
  FINISH_LABELS,
  SHARING_LABELS,
} from '@shared/tasks'
import { resolveFinishPolicy, resolveSessionSharing } from '@shared/policy'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  activeTime,
  activeTimeTitle,
  canRelandTask,
  chronologicalRuns,
  chronologicalTimeline,
  effortLookupModel,
  elapsed,
  hasQuotaGate,
  holdLine,
  isChecksFailedTask,
  isConflictedTask,
  isQuotaGated,
  isTrunkMovedTask,
  isUncommittedTask,
  isWorking,
  kindLabel,
  latestRunEntry,
  modelFacts,
  modelLine,
  pieceSettings,
  plannedAssignment,
  statusToneFor,
  reassignmentModel,
  resolveRetryCauses,
  projectWorkState,
  STATUS_TONE,
  statusLabel,
  STOPPABLE,
  CANCELLABLE,
  taskLabel,
  taskLabelShort,
  WORKING_STATUSES,
  workspacePathFor,
  type Routed
} from './taskview.js'
import {
  DEFAULT_PAGE_SIZE,
  readFleetCollapsed,
  readTaskPageSize,
  writeFleetCollapsed,
  writeTaskPageSize
} from './prefs.js'

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

  // ⛔ t353: Flow said landing while the table and the thread said `running` — or `completed`,
  // before the merge had happened. The landing wins over whatever the row says underneath it.
  it('calls a landing task landing, whatever its status, in the running colour', () => {
    for (const status of ['running', 'completed', 'awaiting_human'] as TaskStatus[]) {
      const landing = { ...task({ status }), gradingWorkerId: null, landing: true }
      expect(statusLabel(landing), status).toBe('landing')
      expect(statusToneFor(landing), status).toBe('state-running')
    }
    const done = { ...task({ status: 'completed' }), gradingWorkerId: null, landing: false }
    expect(statusLabel(done)).toBe('completed')
    expect(statusToneFor(done)).toBe('state-ok')
  })
})

/**
 * ⛔ Reported 2026-09-01, on t71: held with *"ClaudeThird at 92% of its Claude 5h window"* and no
 * way to tell whether that meant five minutes or the 2h29m it actually meant. Those are different
 * situations with different answers — one is worth waiting out, the other is worth overriding or
 * going to bed over — and the sentence read identically for both.
 */
/**
 * ⛔ The Stop button beside the composer is only as good as this set. Everything below is about one
 * failure: a button that is drawn where the daemon will not act. `cancelTask` returns the task
 * untouched for any status outside its own list, so an over-wide `STOPPABLE` produces a control
 * that refreshes the pane, changes nothing, and gives no reason — the worst outcome available,
 * because the operator concludes the stop went through.
 */
describe('where the composer offers to stop the work', () => {
  it('never offers a stop the daemon would refuse', () => {
    for (const status of STOPPABLE) {
      expect(CANCELLABLE.has(status), status).toBe(true)
    }
  })

  it('agrees with the daemon about what may be cancelled at all', () => {
    // ⚠️ Read out of `cancel.ts` rather than imported from it: importing reaches the database on the
    // way in. The list is duplicated in two files and always has been; until now nothing noticed if
    // one of them moved, and the renderer silently offering — or withholding — a stop is exactly
    // what that drift looks like from the outside.
    const source = readFileSync(
      fileURLToPath(new URL('../../../daemon/cancel.ts', import.meta.url)),
      'utf8'
    )
    const literal = /const CANCELLABLE = new Set\(\[([^\]]*)\]\)/.exec(source)
    expect(literal, 'the CANCELLABLE set could not be found in cancel.ts').toBeTruthy()
    const daemon = [...literal![1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!)
    expect(daemon.length).toBeGreaterThan(0)
    expect([...CANCELLABLE].sort()).toEqual([...daemon].sort())
  })

  it('offers it on every status where something is being done to the task', () => {
    // The list the button was asked for: running, dispatching, queued, ready, blocked.
    for (const status of ['running', 'assigned', 'ready', 'blocked', 'scheduled']) {
      expect(STOPPABLE.has(status), status).toBe(true)
    }
  })

  it('withholds it where nothing is happening to stop', () => {
    // ⛔ `awaiting_human` is waiting on the operator and already draws `Decide` with its own "Stop
    // here" directly above the composer; a second one an inch below reads as a more final action
    // than the first. `paused_quota` is already stopped. `cancelling` is stopping. The rest are
    // over, and a draft has never started.
    const at_rest = [
      'awaiting_human',
      'paused_quota',
      'paused_user',
      'cancelling',
      'cancelled',
      'completed',
      'failed',
      'draft'
    ]
    for (const status of at_rest) {
      expect(STOPPABLE.has(status), status).toBe(false)
    }
  })
})

describe('the clock beside the hold', () => {
  const NOW = 1_700_000_000_000
  const held = (
    over: Partial<Pick<Task, 'status' | 'holdReason' | 'holdUntil'>> = {}
  ): Pick<Task, 'status' | 'holdReason' | 'holdUntil'> => ({
    status: 'ready',
    holdReason: 'ClaudeThird at 92% of its Claude 5h window',
    holdUntil: null,
    ...over
  })

  it('says how long the window has left to run', () => {
    const line = holdLine(held({ holdUntil: NOW + 149 * 60 * 1000 }), NOW)
    expect(line).toBe('ClaudeThird at 92% of its Claude 5h window — earliest retry in 2h 29m')
  })

  it('adds nothing where the hold has no clock behind it', () => {
    // ⚠️ "At capacity" ends when a run ends, which is not a time anybody can name. A countdown
    // invented for it would be worse than the silence.
    expect(holdLine(held({ holdReason: 'Antigravity at capacity' }), NOW)).toBe(
      'Antigravity at capacity'
    )
  })

  it('drops a deadline that has already passed rather than counting down from zero', () => {
    expect(holdLine(held({ holdUntil: NOW - 1000 }), NOW)).toBe(
      'ClaudeThird at 92% of its Claude 5h window'
    )
  })

  it('has nothing to say about a task nobody is holding', () => {
    expect(holdLine({ status: 'ready', holdReason: null, holdUntil: NOW + 60_000 }, NOW)).toBeNull()
  })

  it('does not present a completed task as still waiting on its last landing failure', () => {
    expect(
      holdLine(
        held({
          status: 'completed',
          holdReason:
            'Retry landing failed: 1 commit(s) on `warmstart/t191-cost-model`'
        }),
        NOW
      )
    ).toBeNull()
  })

  it('keeps the reason that explains how an unsuccessful task ended', () => {
    for (const status of ['failed', 'cancelled'] as const) {
      expect(holdLine(held({ status, holdReason: 'agent stopped before completion' }), NOW)).toBe(
        'agent stopped before completion'
      )
    }
  })
})

describe('task status tone mapping', () => {
  it('maps ready and queued to blue (state-running)', () => {
    expect(STATUS_TONE.ready).toBe('state-running')
    expect(STATUS_TONE.queued).toBe('state-running')
  })

  it('maps only completed to green (state-ok)', () => {
    expect(STATUS_TONE.completed).toBe('state-ok')
    const okStatuses = Object.entries(STATUS_TONE)
      .filter(([, tone]) => tone === 'state-ok')
      .map(([status]) => status)
    expect(okStatuses).toEqual(['completed'])
  })
})

describe('isWorking', () => {
  it('returns true only for running tasks', () => {
    expect(isWorking({ status: 'running' })).toBe(true)
    expect(WORKING_STATUSES.has('running')).toBe(true)
  })

  it('returns false for queued, ready, scheduled, and resting tasks', () => {
    const nonWorking: TaskStatus[] = [
      'ready',
      'scheduled',
      'assigned',
      'cancelling',
      'blocked',
      'draft',
      'awaiting_human',
      'paused_user',
      'paused_quota',
      'completed',
      'failed',
      'cancelled'
    ]
    for (const status of nonWorking) {
      expect(isWorking({ status }), status).toBe(false)
      expect(WORKING_STATUSES.has(status), status).toBe(false)
    }
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

  it('defaults to 25 for task page size when unset', () => {
    expect(readTaskPageSize()).toBe(DEFAULT_PAGE_SIZE)
    expect(readTaskPageSize()).toBe(25)
  })

  it('persists and restores task page size', () => {
    writeTaskPageSize(50)
    expect(readTaskPageSize()).toBe(50)

    writeTaskPageSize(100)
    expect(readTaskPageSize()).toBe(100)
  })

  it('falls back to default for invalid or unknown stored page size', () => {
    store.set('warmstart.taskPageSize', 'not-a-number')
    expect(readTaskPageSize()).toBe(DEFAULT_PAGE_SIZE)

    store.set('warmstart.taskPageSize', '999')
    expect(readTaskPageSize()).toBe(DEFAULT_PAGE_SIZE)
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

  /**
   * ⛔ Reported from the app on 2026-08-31. A project whose only task was `paused_quota` drew the
   * same hollow ring as a project with nothing in it — so the sidebar's one-glance answer for a
   * stopped account was "nothing going on here".
   */
  it('returns paused when a task is held on quota', () => {
    expect(projectWorkState([{ status: 'paused_quota' }])).toBe('paused')
  })

  it('still returns paused when everything else has come to rest', () => {
    const tasks: Array<{ status: TaskStatus }> = [
      { status: 'completed' },
      { status: 'cancelled' },
      { status: 'paused_quota' }
    ]
    expect(projectWorkState(tasks)).toBe('paused')
  })

  it('prefers working over paused — something is actually moving', () => {
    // ⚠️ The dot has one thing to say, and a run in flight is the more useful of the two.
    const tasks: Array<{ status: TaskStatus }> = [{ status: 'running' }, { status: 'paused_quota' }]
    expect(projectWorkState(tasks)).toBe('working')
  })

  it('prefers needs_attention over paused — a person is being waited on', () => {
    const tasks: Array<{ status: TaskStatus }> = [
      { status: 'paused_quota' },
      { status: 'awaiting_human' }
    ]
    expect(projectWorkState(tasks)).toBe('needs_attention')
  })

  it('prioritizes needs_attention over working when tasks in both states exist', () => {
    const tasks: Array<{ status: TaskStatus }> = [
      { status: 'running' },
      { status: 'awaiting_human' }
    ]
    expect(projectWorkState(tasks)).toBe('needs_attention')
  })

  it('returns pending_pr when a project has a pending pull request', () => {
    expect(projectWorkState([], true)).toBe('pending_pr')
    expect(projectWorkState([{ status: 'completed' }], true)).toBe('pending_pr')
    expect(projectWorkState([{ status: 'paused_quota' }], true)).toBe('pending_pr')
    expect(projectWorkState([{ status: 'running' }], true)).toBe('pending_pr')
  })

  it('prioritizes needs_attention over pending_pr when a person is being waited on', () => {
    const tasks: Array<{ status: TaskStatus }> = [{ status: 'awaiting_human' }]
    expect(projectWorkState(tasks, true)).toBe('needs_attention')
  })
})

/**
 * What a task is called on screen.
 *
 * ⛔ **The fallback is the feature, not a safety net.** `title` is the prompt — the scheduler sends it
 * to the agent verbatim — so most tasks have no label and never will, and drawing the prompt for them
 * is the correct answer rather than a degraded one. These check that the summary wins where there is
 * one, that the prompt wins where there is not, and that neither is ever rewritten on the way.
 */
describe('what a task is called on screen', () => {
  it('prefers the label, and falls back to the prompt', () => {
    expect(taskLabel({ title: 'a long prompt', titleSummary: 'a short label' })).toBe('a short label')
    expect(taskLabel({ title: 'a long prompt', titleSummary: null })).toBe('a long prompt')
  })

  it('leaves a short prompt exactly as typed', () => {
    // ⚠️ An unlabelled task under the truncation limit must come through untouched — no ellipsis, no
    // trimming. This is the common case on every board that has never asked the controller anything.
    expect(taskLabelShort({ title: 'Fix the router', titleSummary: null })).toBe('Fix the router')
  })

  it('cuts an unlabelled prompt to fit the row, and marks that it did', () => {
    const long = 'x'.repeat(200)
    const short = taskLabelShort({ title: long, titleSummary: null })
    expect(short).toHaveLength(71)
    expect(short.endsWith('…')).toBe(true)
  })

  it('does not truncate a label, because a label already fits', () => {
    // ⚠️ `MAX_TITLE_SUMMARY` is 80 and the default allows 70, so this is the one case where
    // truncation could still bite. It bites the *label*, not the prompt, which is the right thing
    // to shorten.
    const label = 'y'.repeat(40)
    expect(taskLabelShort({ title: 'x'.repeat(500), titleSummary: label })).toBe(label)
  })

  it('cuts at the width the caller asked for, which the task table sets past its own column', () => {
    // ⛔ The bug the explicit width fixes: the cell ellipsises at the column's real edge, so a cut
    //    made *here* first shows an `…` with empty space after it. The table now passes a bound on
    //    the payload rather than a guess at the column, and this is what makes that a caller's
    //    decision rather than a constant nobody can see from the component.
    const long = 'x'.repeat(400)
    expect(taskLabelShort({ title: long, titleSummary: null }, 240)).toHaveLength(241)
    expect(taskLabelShort({ title: 'x'.repeat(120), titleSummary: null }, 240)).toHaveLength(120)
  })
})

/**
 * ⛔ **"Took" is agent time now, and the two readings are not close.** The column used to be
 * `lastRunEnded - firstRun`, which counts every minute a task spent queued, parked on a quota
 * window, or waiting for a person to answer — so the number an operator used to compare agents and
 * models was mostly a measure of when they went to bed. These pin the arithmetic at the last step,
 * where the live stretch is added; the daemon's half is pinned in daemon/activetime.test.ts.
 */
const T = 1_700_000_000_000
const MIN = 60_000

type Timed = Pick<Task, 'firstRunAt' | 'lastRunEndedAt' | 'activeMs' | 'activeSince'>

const timed = (over: Partial<Timed> = {}): Timed => ({
  firstRunAt: T,
  lastRunEndedAt: null,
  activeMs: 0,
  activeSince: null,
  ...over
})

describe('the duration beside a task', () => {
  it('reports a finished task from its settled total alone', () => {
    expect(activeTime(timed({ lastRunEndedAt: T + 90 * MIN, activeMs: 7 * MIN }), T + 600 * MIN)).toBe(
      '7m 0s'
    )
  })

  it('adds the live stretch while something is running', () => {
    expect(activeTime(timed({ activeMs: 2 * MIN, activeSince: T + 10 * MIN }), T + 13 * MIN)).toBe(
      '5m 0s'
    )
  })

  it('stops moving while a person is being waited on', () => {
    // ⛔ `activeSince: null` on an *open* run is the daemon saying "blocked right now". The reading
    // must be identical an hour later, which is the whole reason this is not one number.
    const task = timed({ activeMs: 4 * MIN, activeSince: null })
    expect(activeTime(task, T + 5 * MIN)).toBe(activeTime(task, T + 400 * MIN))
  })

  it('says nothing rather than zero for a task that has never run', () => {
    expect(activeTime(timed({ firstRunAt: null }), T)).toBe('—')
    expect(elapsed(timed({ firstRunAt: null }), T)).toBe('—')
  })

  it('keeps the wall-clock span available, and it is the larger of the two', () => {
    const task = timed({ lastRunEndedAt: T + 480 * MIN, activeMs: 6 * MIN })
    expect(elapsed(task, T + 600 * MIN)).toBe('8h 0m')
    expect(activeTime(task, T + 600 * MIN)).toBe('6m 0s')
  })

  it('names the idle time in the tooltip, so a small number does not read as a bug', () => {
    const title = activeTimeTitle(timed({ lastRunEndedAt: T + 480 * MIN, activeMs: 6 * MIN }), T)
    expect(title).toContain('6m 0s')
    expect(title).toContain('8h 0m')
    expect(title).toMatch(/7h 54m.*queued/s)
  })
})

describe('runs ordering for thread display', () => {
  it('orders runs from oldest to newest (old top, new bottom)', () => {
    const run1 = { id: 'run-1', startedAt: 1000, endedAt: 1500 }
    const run2 = { id: 'run-2', startedAt: 2000, endedAt: 2500 }
    const run3 = { id: 'run-3', startedAt: 3000, endedAt: 3500 }
    // Backend returns newest first
    const newestFirst = [run3, run2, run1]
    expect(chronologicalRuns(newestFirst)).toEqual([run1, run2, run3])
  })

  it('handles empty or single-run arrays', () => {
    expect(chronologicalRuns([])).toEqual([])
    const single = [{ id: 'r1', startedAt: 1000, endedAt: null }]
    expect(chronologicalRuns(single)).toEqual(single)
  })
})

/**
 * ⛔ The Worker column carries two facts in one cell, and the second one is only ever *this*
 * account's model. The pairing is the point: a model id belongs to one CLI, so an operator reads
 * the two together or reads neither usefully.
 */
describe('the model under the account, in the Worker column', () => {
  const worker = (over: Partial<Worker> = {}): Worker =>
    ({
      id: 'w1',
      label: 'ClaudeSecond',
      adapterId: 'claude-code',
      defaultModel: 'claude-sonnet-5',
      defaultEffort: 'medium',
      defaultModels: null,
      enabled: true,
      ...over
    }) as Worker

  const fleet = (w: Worker = worker()): FleetEntry[] => [{ worker: w, quota: null, sessions: [] }]

  const options: ModelOptions[] = [
    {
      adapterId: 'claude-code',
      costModelId: 'anthropic.subscription.2026-08',
      selectableEffort: true,
      models: []
    },
    {
      adapterId: 'antigravity-cli',
      costModelId: 'google.antigravity.2026-08',
      selectableEffort: false,
      models: []
    }
  ]

  const routed = (over: Partial<Routed> = {}): Routed => ({
    ranOn: null,
    ranModel: null,
    assignee: 'w1',
    constraints: {},
    ...over
  })

  it('names the model the account would be asked for, before anything has run', () => {
    expect(modelLine(routed(), fleet(), options)).toMatchObject({
      label: 'Sonnet 5 Med',
      id: 'claude-sonnet-5',
      ran: false
    })
  })

  it('⛔ reports what actually ran once something has, not what would run now', () => {
    // The account default has since been changed. A finished task must keep saying what spent its
    // tokens — re-resolving here would relabel last week's work with this week's default.
    const line = modelLine(
      routed({ ranOn: 'w1', ranModel: 'claude-opus-5' }),
      fleet(worker({ defaultModel: 'claude-haiku-4-5' })),
      options
    )
    expect(line).toMatchObject({ label: 'Opus 5 Med', id: 'claude-opus-5', ran: true })
  })

  it('prefers a pin on the task over the account default', () => {
    expect(modelLine(routed({ constraints: { model: 'claude-opus-5' } }), fleet(), options)?.label).toBe(
      'Opus 5 Med'
    )
  })

  it('shows no effort where the CLI has no flag to be told one', () => {
    // ⛔ Antigravity refuses the flag, so the scheduler drops it. A level rendered here would
    // describe something that is never sent.
    const agy = worker({ adapterId: 'antigravity-cli', defaultModel: 'gemini-3.7-flash-medium' })
    expect(modelLine(routed(), fleet(agy), options)?.label).toBe('Gemini 3.7 Flash Med')
  })

  it('⛔ shows no effort beside a model the cost model gives no levels', () => {
    // `claude-haiku-4-5` declares `effort_levels: []` — claude-code takes the flag, and this model
    // takes no level at all. The account's default effort is still `medium` and still inherited for
    // every other model, so the cell used to read *Haiku 4.5 Med* for a flag nothing sends.
    const priced: ModelOptions[] = [
      {
        adapterId: 'claude-code',
        costModelId: 'anthropic.subscription.2026-08',
        selectableEffort: true,
        models: [
          { id: 'claude-haiku-4-5', contextWindow: 200000, effortLevels: [] },
          { id: 'claude-sonnet-5', contextWindow: 1000000, effortLevels: ['low', 'medium', 'high'] }
        ]
      }
    ]
    expect(modelLine(routed(), fleet(worker({ defaultModel: 'claude-haiku-4-5' })), priced)?.label).toBe(
      'Haiku 4.5'
    )
    // ⚠️ The other half of the claim: a model that *does* have levels still shows the inherited one.
    expect(modelLine(routed(), fleet(), priced)?.label).toBe('Sonnet 5 Med')
  })

  it('says nothing where no model has been chosen and none has run', () => {
    // ⚠️ Not a placeholder. "The CLI picks" is the true answer, and the cell shows the account alone.
    expect(modelLine(routed(), fleet(worker({ defaultModel: null })), options)).toBeNull()
    expect(modelLine(routed({ assignee: null }), fleet(), options)).toBeNull()
  })

  it('still names a model when the adapter options have not arrived yet', () => {
    // A fleet whose cost models failed to load still runs work, and the column still says what on.
    expect(modelLine(routed(), fleet(), [])?.label).toBe('Sonnet 5')
  })

  /**
   * ⛔ The reported symptom was a model that *changed by itself*: a task sitting in `assigned` read
   * `GPT 5.6 Sol` — the account default — and the moment its first run was recorded the same cell
   * read `GPT 5.6 Terra`. Nothing switched. The account default was never the answer, because
   * `chooseTarget` scores every routable model as its own candidate and does not decide until the
   * tick that dispatches; the cell was reporting a prediction it had no right to make.
   */
  describe('⛔ an account whose models the router chooses between', () => {
    const routable = worker({
      id: 'w1',
      label: 'CodexFirst',
      defaultModel: 'gpt-5.6-sol',
      routableModels: ['gpt-5.6-sol', 'gpt-5.6-terra']
    })

    it('does not name the account default while the choice is still pending', () => {
      const line = modelLine(routed(), fleet(routable), options)
      expect(line).toMatchObject({ label: 'router picks', id: null, ran: false, undecided: true })
      expect(line?.routable).toBe(2)
    })

    it('names what ran the instant a run records one', () => {
      // ⚠️ Half the claim: the cell must not simply go quiet forever on a routable account.
      const line = modelLine(routed({ ranOn: 'w1', ranModel: 'gpt-5.6-terra' }), fleet(routable), options)
      expect(line).toMatchObject({ id: 'gpt-5.6-terra', ran: true, undecided: false })
    })

    it('names a task-level pin, which the router does not touch', () => {
      const line = modelLine(routed({ constraints: { model: 'gpt-5.6-sol' } }), fleet(routable), options)
      expect(line).toMatchObject({ id: 'gpt-5.6-sol', undecided: false })
    })

    it('names the account default under `modelPolicy: inherit`, which scores nothing', () => {
      const line = modelLine(routed({ constraints: { modelPolicy: 'inherit' } }), fleet(routable), options)
      expect(line).toMatchObject({ id: 'gpt-5.6-sol', undecided: false })
    })

    it('leaves an account with no allowlist naming its default as before', () => {
      expect(modelLine(routed(), fleet(worker({ routableModels: [] })), options)).toMatchObject({
        id: 'claude-sonnet-5',
        undecided: false
      })
    })
  })
})

/**
 * ⛔ The bug this describes is a *disagreement between two rows of the same pane*: the model row said
 * `Gemini 3.7 Flash Med` while the run beneath it, and every turn in it, was answered by 3.8. Neither
 * number was wrong on its own — one was a measurement and the other a prediction, and the pane led
 * with the prediction under a tooltip claiming it was what launched.
 */
describe('the model row in the thread', () => {
  const requested = (over: Partial<{ model: string | null; effort: string | null; source: string }> = {}) => ({
    model: 'gemini-3.7-flash-medium',
    effort: null,
    source: 'this account’s default (Antigravity)',
    ...over
  })

  it('⛔ leads with what the transcript says answered, not with what would be asked for now', () => {
    const { headline, note } = modelFacts({
      observed: { model: 'gemini-3.8-flash-medium', effort: null },
      ran: null,
      requested: requested()
    })
    expect(headline.text).toBe('Gemini 3.8 Flash Med')
    expect(headline.title).toContain('gemini-3.8-flash-medium')
    // ⚠️ The prediction survives, worded as one. "running X" under a headline of Y read as a
    // contradiction; "next run asks for Y" under a headline of X is two facts.
    expect(note).toMatchObject({ tone: 'warn', text: 'next run asks for Gemini 3.7 Flash Med' })
  })

  it('reports the last run’s model once the session that ran it has closed', () => {
    const { headline } = modelFacts({
      observed: null,
      ran: 'gemini-3.8-flash-medium',
      requested: requested()
    })
    expect(headline.text).toBe('Gemini 3.8 Flash Med')
  })

  it('does not repeat a confirmation when the model agrees', () => {
    const { headline, note } = modelFacts({
      observed: { model: 'claude-sonnet-5', effort: 'medium' },
      ran: null,
      requested: requested({ model: 'claude-sonnet-5', effort: 'medium' })
    })
    expect(headline.text).toBe('Sonnet 5 Med')
    expect(note).toBeNull()
  })

  it('⚠️ shows the resolution alone, and no note, until a turn has been metered', () => {
    const { headline, note } = modelFacts({ observed: null, ran: null, requested: requested() })
    expect(headline.text).toBe('Gemini 3.7 Flash Med')
    expect(headline.title).toContain('what the next run asks for')
    expect(note).toBeNull()
  })

  it('words an unchosen model as the CLI’s own answer', () => {
    const { headline } = modelFacts({
      observed: null,
      ran: null,
      requested: requested({ model: null, source: 'no model chosen — the CLI picks' })
    })
    expect(headline.text).toBe('CLI default')
  })

  it('notices a level that drifted even when the model held', () => {
    const { note } = modelFacts({
      observed: { model: 'claude-sonnet-5', effort: 'high' },
      ran: null,
      requested: requested({ model: 'claude-sonnet-5', effort: 'medium' })
    })
    expect(note).toMatchObject({ tone: 'warn', text: 'next run asks for Sonnet 5 Med' })
  })
})

describe('model reassignment', () => {
  it('clears an incompatible pin so a multi-pool worker resolves its own configured default', () => {
    expect(
      reassignmentModel('claude-sonnet-5', [
        { id: 'gemini-3.8-medium' },
        { id: 'gemini-3.7-flash-medium' }
      ])
    ).toBe('')
  })

  it('keeps a model pin that the target worker offers', () => {
    expect(reassignmentModel('gemini-3.8-medium', [{ id: 'gemini-3.8-medium' }])).toBe(
      'gemini-3.8-medium'
    )
  })
})

describe('effortLookupModel', () => {
  it('reads Auto Model’s effort levels off the inherited model, not the sentinel', () => {
    expect(effortLookupModel('__auto__', 'claude-opus-5')).toBe('claude-opus-5')
  })

  it('reads the account-default (blank) choice’s effort levels off the inherited model too', () => {
    expect(effortLookupModel('', 'claude-opus-5')).toBe('claude-opus-5')
  })

  it('reads the explicit inherit sentinel the same way as blank', () => {
    expect(effortLookupModel('__inherit__', 'claude-opus-5')).toBe('claude-opus-5')
  })

  it('uses the named model once one is actually pinned', () => {
    expect(effortLookupModel('claude-sonnet-5', 'claude-opus-5')).toBe('claude-sonnet-5')
  })

  it('falls back to empty when nothing is inherited either, rather than a sentinel string', () => {
    expect(effortLookupModel('__auto__', null)).toBe('')
  })
})

describe('timeline ordering for runs and compactions', () => {
  it('merges and sorts runs and compactions chronologically, by when each one ended', () => {
    const run1 = { id: 'r1', startedAt: 1000, endedAt: 1500, kind: 'work' } as unknown as Run
    const run2 = { id: 'r2', startedAt: 3000, endedAt: 3500, kind: 'work' } as unknown as Run
    const c1 = { id: 'c1', ts: 2000, askedAt: 2000, landedAt: 2500 } as unknown as Compaction
    const c2 = { id: 'c2', ts: 4000, askedAt: 4000, landedAt: 4500 } as unknown as Compaction

    const timeline = chronologicalTimeline([run2, run1], [c2, c1])
    expect(timeline).toEqual([
      { kind: 'run', run: run1, ts: 1000, endTs: 1500 },
      { kind: 'compaction', compaction: c1, ts: 2000, endTs: 2500 },
      { kind: 'run', run: run2, ts: 3000, endTs: 3500 },
      { kind: 'compaction', compaction: c2, ts: 4000, endTs: 4500 }
    ])
  })

  /**
   * ⭐ **The t231 shape, in the real numbers the operator read.** Run 2 ran 16:44:24–16:55:19 and
   * the compaction it triggered ran 16:44:26–16:47:06 — wholly inside it. Sorted on `startedAt` the
   * run won by two seconds, so the thread printed a compaction that had finished at 16:47 *below* a
   * run that was still going at 16:55.
   *
   * ⛔ This is not a tie-break preference. Nesting is the normal case here — a compaction always
   * happens inside the run that asked for it — so start-time ordering is wrong for this pairing
   * every single time it occurs, not occasionally.
   */
  it('⭐ puts a compaction above the longer run it happened inside, which start times invert', () => {
    const at = (h: number, m: number, sec: number): number => Date.UTC(2026, 8, 5, h, m, sec)
    const run = {
      id: 'run-2',
      startedAt: at(16, 44, 24),
      endedAt: at(16, 55, 19),
      kind: 'work'
    } as unknown as Run
    const compaction = {
      id: 58,
      ts: at(16, 44, 26),
      askedAt: at(16, 44, 26),
      landedAt: at(16, 47, 6)
    } as unknown as Compaction

    const timeline = chronologicalTimeline([run], [compaction])
    expect(timeline.map((i) => i.kind)).toEqual(['compaction', 'run'])
    // ⚠️ And the start times really are the other way round, so the check is not vacuous.
    expect(compaction.askedAt as number).toBeGreaterThan(run.startedAt)
  })

  it('⚠️ puts what has not finished last, because it has not finished', () => {
    const done = { id: 'r1', startedAt: 1000, endedAt: 9000, kind: 'work' } as unknown as Run
    const running = { id: 'r2', startedAt: 2000, endedAt: null, kind: 'work' } as unknown as Run
    const asked = { id: 'c1', ts: 500, askedAt: 500, landedAt: null } as unknown as Compaction

    const timeline = chronologicalTimeline([running, done], [asked])
    // The finished run first; then the two open entries, ordered among themselves by when they began.
    expect(timeline.map((i) => i.kind)).toEqual(['run', 'compaction', 'run'])
    expect(timeline[1]).toMatchObject({ kind: 'compaction', endTs: null })
    expect(timeline[2]).toMatchObject({ kind: 'run', endTs: null })
  })

  it('⛔ orders two open entries rather than returning NaN from Infinity minus Infinity', () => {
    // A comparator that returns NaN leaves the array in whatever order it arrived in, which reads
    // as "sometimes right". Both of these are open; the start time has to decide.
    const later = { id: 'r1', startedAt: 5000, endedAt: null, kind: 'work' } as unknown as Run
    const earlier = { id: 'r2', startedAt: 1000, endedAt: null, kind: 'work' } as unknown as Run
    const timeline = chronologicalTimeline([later, earlier])
    expect(timeline.map((i) => (i.kind === 'run' ? i.run.id : ''))).toEqual(['r2', 'r1'])
  })

  it('falls back to the start when two entries ended in the same millisecond', () => {
    const first = { id: 'r1', startedAt: 1000, endedAt: 5000, kind: 'work' } as unknown as Run
    const second = { id: 'r2', startedAt: 2000, endedAt: 5000, kind: 'work' } as unknown as Run
    const timeline = chronologicalTimeline([second, first])
    expect(timeline.map((i) => (i.kind === 'run' ? i.run.id : ''))).toEqual(['r1', 'r2'])
  })

  it('holds the same rule for a review, whose end is when it was graded', () => {
    const run = { id: 'r1', startedAt: 1000, endedAt: 8000, kind: 'work' } as unknown as Run
    const review = { id: 'q1', runId: 'rq', createdAt: 2000, completedAt: 3000 } as unknown as QualityReview
    const timeline = chronologicalTimeline([run], [], [review])
    expect(timeline.map((i) => i.kind)).toEqual(['review', 'run'])
  })

  describe('latestRunEntry — the run the ledger peek names', () => {
    it('names the last run in the timeline with the #N the timeline printed on it', () => {
      const run1 = { id: 'r1', startedAt: 1000, endedAt: 1500, kind: 'work' } as unknown as Run
      const run2 = { id: 'r2', startedAt: 3000, endedAt: 3500, kind: 'work' } as unknown as Run
      const c1 = { id: 'c1', ts: 2000, askedAt: 2000, landedAt: 2500 } as unknown as Compaction
      const review = { id: 'q1', runId: 'rq', createdAt: 4000, completedAt: 4500 } as unknown as QualityReview
      const timeline = chronologicalTimeline([run2, run1], [c1], [review])
      // run1 #1, compaction #2, run2 #3, review #4 — the peek says "#3 Run", as the row does.
      expect(latestRunEntry(timeline)).toEqual({ index: 3, run: run2 })
    })

    it('⛔ follows the timeline order, not runs[0], while an attempt is open', () => {
      // Started later, ended earlier: `runs[0]` by start is r2, the timeline's last run is r1.
      const r1 = { id: 'r1', startedAt: 1000, endedAt: null, kind: 'work' } as unknown as Run
      const r2 = { id: 'r2', startedAt: 2000, endedAt: 2500, kind: 'work' } as unknown as Run
      expect(latestRunEntry(chronologicalTimeline([r2, r1]))?.run.id).toBe('r1')
    })

    it('has nothing to name for a task that has never run', () => {
      expect(latestRunEntry([])).toBeNull()
      const review = { id: 'q1', runId: 'rq', createdAt: 1, completedAt: 2 } as unknown as QualityReview
      expect(latestRunEntry(chronologicalTimeline([], [], [review]))).toBeNull()
    })
  })

  it('handles empty runs and compactions', () => {
    expect(chronologicalTimeline([], [])).toEqual([])
  })

  /**
   * ⛔ A review is a `runs` row *and* a `quality_reviews` row — that is how its tokens get metered
   * and how it earns a number in this list. Drawing both halves would put a `#N Run` on the task
   * carrying the reviewer's model, which is exactly the lie the `kind = 'work'` filters exist to
   * prevent one layer down.
   */
  it('draws a review once, from the review and never from its run', () => {
    const work = { id: 'r1', startedAt: 1000, endedAt: 1500, kind: 'work' } as unknown as Run
    const reviewRun = { id: 'r2', startedAt: 2000, endedAt: 2500, kind: 'quality_review' } as unknown as Run
    const review = { id: 'q1', runId: 'r2', createdAt: 2000, completedAt: 2500 } as unknown as QualityReview

    const timeline = chronologicalTimeline([work, reviewRun], [], [review])
    expect(timeline).toEqual([
      { kind: 'run', run: work, ts: 1000, endTs: 1500 },
      { kind: 'review', review, ts: 2000, endTs: 2500 }
    ])
  })
})

describe('landing recovery actions and canRelandTask', () => {
  it('does not offer canReland when the trunk tripwire fired and the branch is empty', () => {
    // ⛔ Measured on t157 (2026-09-03): the agent committed directly to the trunk, leaving the task
    // branch empty. Offering "Retry landing" ran relandTask, which failed immediately with "carries
    // no commits... No work landed".
    const t = {
      branch: 'warmstart/t157-debug',
      holdReason: 'the trunk moved during this run and this branch is empty — check where the work went'
    }
    expect(canRelandTask(t)).toBe(false)
    expect(isTrunkMovedTask(t)).toBe(true)
  })

  it('does not offer canReland when Retry landing previously failed due to no commits', () => {
    const t = {
      branch: 'warmstart/t157-debug',
      holdReason:
        'Retry landing failed: warmstart/t157-debug carries no commits that origin/main does not already have. No work landed — check if the agent answered as a question instead of making changes.'
    }
    expect(canRelandTask(t)).toBe(false)
  })

  it('does not offer canReland when there is no branch', () => {
    expect(canRelandTask({ branch: null, holdReason: 'landing failed: the trunk was busy' })).toBe(false)
  })

  it('does not offer canReland for an idle turn timeout, which offers Land via unlandedNow instead', () => {
    const t = {
      branch: 'warmstart/t451',
      holdReason:
        'The agent finished its turn without calling `task_complete`, `await_human` or `ask_human`, and has done nothing for 3 minutes since. Nothing has been landed, committed or discarded — the work is exactly as the agent left it.'
    }
    expect(canRelandTask(t)).toBe(false)
  })

  it('returns every matching retry cause so one button can carry them all (t289)', () => {
    // ⛔ Each cause used to draw its own identical "Resolve & retry" button calling the same RPC,
    // so a landing that failed two ways asked the same question twice. The card draws one button
    // and stacks these beneath it.
    expect(resolveRetryCauses({ holdReason: 'landing failed: conflict' })).toEqual(['conflicted'])
    expect(
      resolveRetryCauses({
        holdReason: 'landing failed: rebase conflict, and the project checks failed after rebase'
      })
    ).toEqual(['conflicted', 'checksFailed'])
    expect(resolveRetryCauses({ holdReason: 'all clear' })).toEqual([])
    // ⛔ "after rebase" is not a rebase conflict. The reason a red check writes names the rebase
    // that preceded it, and the daemon's own copy of this rule matched `rebase` — so the agent was
    // sent to resolve a conflict that did not exist (t344/t347). This is the one shared rule now.
    expect(resolveRetryCauses({ holdReason: 'landing failed: the project checks failed after rebase' })).toEqual([
      'checksFailed'
    ])
  })

  it('does not offer canReland for conflicts, failing checks, or workspace uncommitted files', () => {
    expect(canRelandTask({ branch: 'b', holdReason: 'landing failed: conflict' })).toBe(false)
    expect(isConflictedTask({ holdReason: 'landing failed: conflict' })).toBe(true)

    expect(canRelandTask({ branch: 'b', holdReason: 'landing failed: the project checks failed after rebase' })).toBe(false)
    expect(isChecksFailedTask({ holdReason: 'landing failed: the project checks failed after rebase' })).toBe(true)

    expect(canRelandTask({ branch: 'b', holdReason: 'landing failed: the workspace has uncommitted changes' })).toBe(false)
    expect(isUncommittedTask({ holdReason: 'landing failed: the workspace has uncommitted changes' })).toBe(true)
  })

  it('distinguishes trunk uncommitted changes from workspace uncommitted files', () => {
    // A dirty operator trunk is a trunk blockage, so the branch is committed and can be relanded once trunk is clean.
    const trunkBlocked = {
      branch: 'warmstart/t80',
      holdReason:
        'landing failed: committed and verified on `warmstart/t80`, but not merged: the trunk has uncommitted changes. The branch is intact — merge it when the trunk is free.'
    }
    expect(isUncommittedTask(trunkBlocked)).toBe(false)
    expect(canRelandTask(trunkBlocked)).toBe(true)
  })

  it('offers canReland when landing was blocked by a busy trunk or queue timeout', () => {
    expect(canRelandTask({ branch: 'b', holdReason: 'landing failed: the trunk was busy' })).toBe(true)
    expect(canRelandTask({ branch: 'b', holdReason: 'another task is still landing after 60s of waiting for a turn' })).toBe(true)
    expect(canRelandTask({ branch: 'b', holdReason: 'committed and verified, waiting for a clean trunk' })).toBe(true)
    expect(canRelandTask({ branch: 'b', holdReason: 'committed and verified on `b`, but the trunk would not fast-forward: rejected' })).toBe(true)
  })

  it('still offers canReland after one retry already failed, unless the cause is unfixable (t509)', () => {
    // ⛔ Regression: a blanket `/Retry landing failed/` exclusion used to hide "Retry landing" for
    // good the instant one retry did not land — including a `pull-request` push rejected because a
    // later run's squash rewrote history already on the open PR. That push is fixable (the daemon
    // now retries it with `--force-with-lease`), but the button that would trigger the retry was
    // gone after the first failure, so pressing "Land" again did nothing visible.
    expect(
      canRelandTask({
        branch: 'warmstart/t509-fix',
        holdReason:
          'Retry landing failed: git push failed (rejected, non-fast-forward) (the branch ' +
          '`warmstart/t509-fix` may already be pushed - check the remote before redoing work)'
      })
    ).toBe(true)
    expect(
      canRelandTask({
        branch: 'warmstart/t509-fix',
        holdReason: 'Retry landing failed: every workspace is busy; try again in a moment'
      })
    ).toBe(true)
    // The one genuinely unfixable retry failure - no commits - still hides the button.
    expect(
      canRelandTask({
        branch: 'warmstart/t157-debug',
        holdReason:
          'Retry landing failed: warmstart/t157-debug carries no commits that origin/main does not already have.'
      })
    ).toBe(false)
  })
})

/**
 * What a Plan & Split task's page says about itself.
 *
 * ⛔ **Both of these are facts the thread simply did not have.** A plan task rendered exactly like an
 * ordinary one — same header, same ledger — while behaving nothing like it, and the accounts its
 * pieces were meant to run on were set on the composer and then visible nowhere. That is how a split
 * ran on an account nobody chose without anybody being able to see that it had.
 */
describe('a plan task, as its own page describes it', () => {
  const planner = (over: Partial<Task> = {}): Task =>
    ({
      kind: 'plan',
      priority: 'P2',
      // ⚠️ The mandate is not decoration in this fixture: `planModeOf` reads the child cap off it to
      //    tell a Plan & Split from a Plan & Execute, so a planner with no mandate would have no shape.
      mandate: { ...ROOT_MANDATE },
      childDefaults: null,
      constraints: {},
      ...over
    }) as Task

  /** ⛔ What makes a plan an execute is the cap, on both fields — see `planModeOf`. */
  const handoff = (over: Partial<Task> = {}): Task =>
    planner({
      mandate: { ...ROOT_MANDATE, maxChildren: 1 },
      childDefaults: { maxChildren: 1 },
      ...over
    })

  /** ⚠️ Anything that is not a plan still has to answer, so it gets the ordinary root mandate. */
  const plain = (over: Partial<Task>): Task =>
    ({ kind: 'work', priority: 'P2', mandate: { ...ROOT_MANDATE }, childDefaults: null, constraints: {}, ...over }) as Task

  const fleet: FleetEntry[] = [
    { worker: { id: 'w-agy', label: 'Antigravity', adapterId: 'antigravity-cli' }, quota: null, sessions: [] },
    { worker: { id: 'w-cx', label: 'CodexFirst', adapterId: 'openai-compatible' }, quota: null, sessions: [] }
  ] as unknown as FleetEntry[]

  it('says which kind of task it is, in the composer’s own words', () => {
    expect(kindLabel(planner())).toBe('Plan & Split')
    // ⛔ The same kind, a different shape, and the label has to say which: one of these is run
    //    twice and lands its pieces' work itself, and the other is finished at the handoff.
    expect(kindLabel(handoff())).toBe('Plan & Execute')
    expect(kindLabel(plain({}))).toBe('Task')
    // ⛔ Its own name, not "Task". A conversation's thread behaves differently at the end of every
    // turn — it rests instead of landing, and its finish policy is not the project's — and a header
    // that called it a Task would be telling somebody the opposite of what the buttons do.
    expect(kindLabel(plain({ kind: 'conversation' }))).toBe('Conversation')
    // ⛔ And a debate's, for the same reason and more strongly: this page's task is the *organizer*
    // of several other tasks, and calling it a Task hides every one of them.
    expect(kindLabel(plain({ kind: 'debate' }))).toBe('Debate')
  })

  it('names every account the pieces may run on, with the model each was given', () => {
    const rows = pieceSettings(
      planner({
        childDefaults: {
          workerIds: ['w-agy', 'w-cx'],
          modelsByWorker: { 'w-agy': 'gemini-3-flash', 'w-cx': 'gpt-5.6-terra' },
          priority: 'P3',
          maxChildren: 4
        }
      }),
      fleet
    )
    const workers = rows.find((r) => r.label === 'workers')?.value ?? ''
    expect(workers).toContain('Antigravity')
    expect(workers).toContain('CodexFirst')
    // ⛔ The account and its model together. Read apart, a routing mistake is invisible.
    expect(workers).toMatch(/Antigravity · .+, CodexFirst · .+/)
    expect(rows.find((r) => r.label === 'priority')?.value).toBe('P3')
    expect(rows.find((r) => r.label === 'fan-out')?.value).toBe('up to 4 pieces')
  })

  // ⚠️ "up to 1 piece" is not a fan-out somebody chose; it is the shape of the task, which the
  //    type row above already names. A row saying it twice invites somebody to try to change it.
  it('says nothing about fan-out for a Plan & Execute', () => {
    const rows = pieceSettings(handoff({ childDefaults: { maxChildren: 1, workerIds: ['w-cx'] } }), fleet)
    expect(rows.find((r) => r.label === 'fan-out')).toBeUndefined()
    expect(rows.find((r) => r.label === 'workers')?.value).toContain('CodexFirst')
  })

  it('reads the planner’s own pieceConstraints when childDefaults has no accounts', () => {
    const rows = pieceSettings(
      planner({ constraints: { pieceConstraints: { workerIds: ['w-cx'] } } }),
      fleet
    )
    expect(rows.find((r) => r.label === 'workers')?.value).toContain('CodexFirst')
  })

  it('says plainly that nobody was chosen rather than leaving the row empty', () => {
    const rows = pieceSettings(planner(), fleet)
    expect(rows.find((r) => r.label === 'workers')?.value).toBe('any account the scheduler picks')
  })

  it('says nothing at all about pieces for an ordinary task', () => {
    expect(
      pieceSettings(plain({}), fleet)
    ).toEqual([])
  })

  // ⛔ t353: a child's worker picker shows what it runs on now, and moving the child rewrites it.
  // What the plan chose has to be readable beside it — the worker and model, and nothing else.
  it('tells a child which worker and model its plan filed it with', () => {
    const one = plannedAssignment(
      planner({ childDefaults: { workerIds: ['w-cx'], model: 'gpt-5.6-terra', priority: 'P3', maxChildren: 4 } }),
      fleet
    )
    expect(one.map((r) => r.label)).toEqual(['workers', 'model'])
    expect(one[0]?.value).toContain('CodexFirst')
    expect(one[1]?.value).toBeTruthy()
    expect(plannedAssignment(planner(), fleet)).toEqual([
      { label: 'workers', value: 'any account the scheduler picks' }
    ])
  })

  it('has nothing to say for a task with no plan above it', () => {
    expect(plannedAssignment(null, fleet)).toEqual([])
    expect(
      plannedAssignment(plain({}), fleet)
    ).toEqual([])
  })
})

describe('isQuotaGated and hasQuotaGate', () => {
  const now = 1_000_000

  it('detects a task paused on quota as gated and having quota gate', () => {
    const task = {
      status: 'paused_quota' as TaskStatus,
      holdReason: 'ClaudeFirst at 95% of its 5h window',
      quotaPreemptWarning: null,
      quotaOverrideUntil: null,
      deletedAt: null
    }
    expect(isQuotaGated(task, now)).toBe(true)
    expect(hasQuotaGate(task, now)).toBe(true)
  })

  it('detects a ready task held by a quota window', () => {
    const task = {
      status: 'ready' as TaskStatus,
      holdReason: 'ClaudeFirst is at 94% of its 5h window',
      quotaPreemptWarning: null,
      quotaOverrideUntil: null,
      deletedAt: null
    }
    expect(isQuotaGated(task, now)).toBe(true)
    expect(hasQuotaGate(task, now)).toBe(true)
  })

  it('detects a ready task held by a weekly window', () => {
    const task = {
      status: 'ready' as TaskStatus,
      holdReason: 'ClaudeSecond at 97% of its weekly window',
      quotaPreemptWarning: null,
      quotaOverrideUntil: null,
      deletedAt: null
    }
    expect(isQuotaGated(task, now)).toBe(true)
    expect(hasQuotaGate(task, now)).toBe(true)
  })

  it('detects a running task with active quota preemption warning', () => {
    const task = {
      status: 'running' as TaskStatus,
      holdReason: null,
      quotaPreemptWarning: {
        trigger: 'window' as const,
        reason: '92% of Claude 5h window reached',
        preemptAt: now + 50_000,
        resumeAt: now + 300_000
      },
      quotaOverrideUntil: null,
      deletedAt: null
    }
    expect(isQuotaGated(task, now)).toBe(true)
    expect(hasQuotaGate(task, now)).toBe(true)
  })

  it('excludes an active quota override from isQuotaGated while keeping hasQuotaGate true', () => {
    const task = {
      status: 'ready' as TaskStatus,
      holdReason: 'ClaudeFirst is at 94% of its 5h window',
      quotaPreemptWarning: null,
      quotaOverrideUntil: now + 60_000,
      deletedAt: null
    }
    // Gated alert is inactive because operator already overrode the gate
    expect(isQuotaGated(task, now)).toBe(false)
    // Thread prompt area still shows the active override with Withdraw control
    expect(hasQuotaGate(task, now)).toBe(true)
  })

  it('treats an expired override as gated again if still held on quota', () => {
    const task = {
      status: 'ready' as TaskStatus,
      holdReason: 'ClaudeFirst is at 94% of its 5h window',
      quotaPreemptWarning: null,
      quotaOverrideUntil: now - 1000,
      deletedAt: null
    }
    expect(isQuotaGated(task, now)).toBe(true)
    expect(hasQuotaGate(task, now)).toBe(true)
  })

  it('ignores completed, failed, cancelled, and deleted tasks', () => {
    for (const status of ['completed', 'failed', 'cancelled'] as TaskStatus[]) {
      const task = {
        status,
        holdReason: 'ClaudeFirst at 95% of its 5h window',
        quotaPreemptWarning: null,
        quotaOverrideUntil: null,
        deletedAt: null
      }
      expect(isQuotaGated(task, now)).toBe(false)
      expect(hasQuotaGate(task, now)).toBe(false)
    }

    const deletedTask = {
      status: 'paused_quota' as TaskStatus,
      holdReason: 'ClaudeFirst at 95% of its 5h window',
      quotaPreemptWarning: null,
      quotaOverrideUntil: null,
      deletedAt: now
    }
    expect(isQuotaGated(deletedTask, now)).toBe(false)
    expect(hasQuotaGate(deletedTask, now)).toBe(false)
  })

  it('ignores non-quota hold reasons', () => {
    const task = {
      status: 'ready' as TaskStatus,
      holdReason: 'waiting on 2 pieces of its own plan',
      quotaPreemptWarning: null,
      quotaOverrideUntil: null,
      deletedAt: null
    }
    expect(isQuotaGated(task, now)).toBe(false)
    expect(hasQuotaGate(task, now)).toBe(false)
  })
})
