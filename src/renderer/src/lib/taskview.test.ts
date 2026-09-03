import { beforeEach, describe, expect, it } from 'vitest'
import type { Compaction, Project, Run, Task, TaskStatus } from '@shared/tasks'
import type { ModelOptions, Worker } from '@shared/protocol'
import type { FleetEntry } from './daemon'
import {
  FINISH_LABELS,
  SHARING_LABELS,
  resolveFinishPolicy,
  resolveSessionSharing
} from '@shared/tasks'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  activeTime,
  activeTimeTitle,
  canRelandTask,
  chronologicalRuns,
  chronologicalTimeline,
  elapsed,
  holdLine,
  isChecksFailedTask,
  isConflictedTask,
  isTrunkMovedTask,
  isUncommittedTask,
  isWorking,
  modelLine,
  reassignmentModel,
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
    over: Partial<Pick<Task, 'holdReason' | 'holdUntil'>> = {}
  ): Pick<Task, 'holdReason' | 'holdUntil'> => ({
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
    expect(holdLine({ holdReason: null, holdUntil: NOW + 60_000 }, NOW)).toBeNull()
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
    store.set('multi_agent_controller.taskPageSize', 'not-a-number')
    expect(readTaskPageSize()).toBe(DEFAULT_PAGE_SIZE)

    store.set('multi_agent_controller.taskPageSize', '999')
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
    // ⚠️ `MAX_TITLE_SUMMARY` is 80 and the cell allows 70, so this is the one case where truncation
    // could still bite. It bites the *label*, not the prompt, which is the right thing to shorten.
    const label = 'y'.repeat(40)
    expect(taskLabelShort({ title: 'x'.repeat(500), titleSummary: label })).toBe(label)
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
    const run1 = { id: 'run-1', startedAt: 1000 }
    const run2 = { id: 'run-2', startedAt: 2000 }
    const run3 = { id: 'run-3', startedAt: 3000 }
    // Backend returns newest first
    const newestFirst = [run3, run2, run1]
    expect(chronologicalRuns(newestFirst)).toEqual([run1, run2, run3])
  })

  it('handles empty or single-run arrays', () => {
    expect(chronologicalRuns([])).toEqual([])
    const single = [{ id: 'r1', startedAt: 1000 }]
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

  it('says nothing where no model has been chosen and none has run', () => {
    // ⚠️ Not a placeholder. "The CLI picks" is the true answer, and the cell shows the account alone.
    expect(modelLine(routed(), fleet(worker({ defaultModel: null })), options)).toBeNull()
    expect(modelLine(routed({ assignee: null }), fleet(), options)).toBeNull()
  })

  it('still names a model when the adapter options have not arrived yet', () => {
    // A fleet whose cost models failed to load still runs work, and the column still says what on.
    expect(modelLine(routed(), fleet(), [])?.label).toBe('Sonnet 5')
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

describe('timeline ordering for runs and compactions', () => {
  it('merges and sorts runs and compactions chronologically by timestamp', () => {
    const run1 = { id: 'r1', startedAt: 1000 } as unknown as Run
    const run2 = { id: 'r2', startedAt: 3000 } as unknown as Run
    const c1 = { id: 'c1', ts: 2000, askedAt: 2000 } as unknown as Compaction
    const c2 = { id: 'c2', ts: 4000, askedAt: 4000 } as unknown as Compaction

    const timeline = chronologicalTimeline([run2, run1], [c2, c1])
    expect(timeline).toEqual([
      { kind: 'run', run: run1, ts: 1000 },
      { kind: 'compaction', compaction: c1, ts: 2000 },
      { kind: 'run', run: run2, ts: 3000 },
      { kind: 'compaction', compaction: c2, ts: 4000 }
    ])
  })

  it('handles empty runs and compactions', () => {
    expect(chronologicalTimeline([], [])).toEqual([])
  })
})

describe('landing recovery actions and canRelandTask', () => {
  it('does not offer canReland when the trunk tripwire fired and the branch is empty', () => {
    // ⛔ Measured on t157 (2026-09-03): the agent committed directly to the trunk, leaving the task
    // branch empty. Offering "Retry landing" ran relandTask, which failed immediately with "carries
    // no commits... No work landed".
    const t = {
      branch: 'multi-agent-controller/t157-debug',
      holdReason: 'the trunk moved during this run and this branch is empty — check where the work went'
    }
    expect(canRelandTask(t)).toBe(false)
    expect(isTrunkMovedTask(t)).toBe(true)
  })

  it('does not offer canReland when Retry landing previously failed due to no commits', () => {
    const t = {
      branch: 'multi-agent-controller/t157-debug',
      holdReason:
        'Retry landing failed: multi-agent-controller/t157-debug carries no commits that origin/main does not already have. No work landed — check if the agent answered as a question instead of making changes.'
    }
    expect(canRelandTask(t)).toBe(false)
  })

  it('does not offer canReland when there is no branch', () => {
    expect(canRelandTask({ branch: null, holdReason: 'landing failed: the trunk was busy' })).toBe(false)
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
      branch: 'multi-agent-controller/t80',
      holdReason:
        'landing failed: committed and verified on `multi-agent-controller/t80`, but not merged: the trunk has uncommitted changes. The branch is intact — merge it when the trunk is free.'
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
})

