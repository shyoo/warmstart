import { describe, expect, it } from 'vitest'
import { AUTO_COMPACT_LABELS, FINISH_LABELS, FINISH_ORDER, SHARING_LABELS } from '@shared/tasks'
import type { Objective, Task } from '@shared/tasks'
import type { FleetEntry } from './daemon'
import {
  compactionChoice,
  completionChoice,
  workspaceChoice,
  finishChoice,
  inheritedLabel,
  objectiveChoice,
  outcomeClass,
  paceNote,
  priorityChoice,
  ranOnLabel,
  sharingChoice,
  tieredChoice,
  workerChoice
} from './threadview'

/**
 * The task thread's seven settings, now that they are one component reading these.
 *
 * ⛔ **None of this was reachable by a suite before.** The seven pickers were seven copies inside
 * `TaskThread.tsx`, which L1 does not load and `test/ui.test.mjs` never opens a project to reach —
 * so what an operator was *offered* had no test at all, in a pane where the wrong offer means the
 * wrong account, the wrong finish or a compaction that never happens. Moving the arithmetic here is
 * the whole point of the split; these are the checks that make it worth having done.
 */

const task = (over: Partial<Task> = {}): Task =>
  ({
    id: 't1',
    seq: 1,
    priority: 'P2',
    finishPolicy: 'inherit',
    sessionSharing: 'inherit',
    completionMode: 'inherit',
    workspaceMode: 'inherit',
    autoCompact: 'inherit',
    objective: null,
    ranOn: null,
    constraints: {},
    ...over
  }) as unknown as Task

const fleet = (...workers: { id: string; label: string; enabled?: boolean; role?: string }[]): FleetEntry[] =>
  workers.map((w) => ({
    worker: { enabled: true, role: 'worker', ...w },
    quota: null,
    sessions: []
  })) as unknown as FleetEntry[]

describe('the tone a run’s row wears', () => {
  it('reads a run with no outcome yet as running, not as failed', () => {
    // ⛔ The distinction the class carries: `null` is *still going*, and painting it as a failure
    // would report every live run as broken for as long as it ran.
    expect(outcomeClass(null)).toBe('state-running')
    expect(outcomeClass('completed')).toBe('ok')
    expect(outcomeClass('blocked')).toBe('state-human')
    expect(outcomeClass('failed')).toBe('warn')
  })
})

describe('how long a review takes here', () => {
  it('says it does not know rather than printing a zero', () => {
    // ⚠️ Every belief carries its basis. A fleet that has never finished a review here has no
    // median, and `about 0s` would be a measurement nobody made.
    expect(paceNote(null)).toContain('not yet known')
    expect(paceNote(90_000)).toContain('about')
  })
})

describe('what `inherit` resolves to', () => {
  it('names the value in the menu and shows it alone on the button', () => {
    const choice = tieredChoice('inherit', 'await human', [{ value: 'on', label: 'on' }])
    expect(choice.options[0]).toEqual({ value: 'inherit', label: 'inherit (await human)' })
    // ⛔ The asymmetry is the feature: the menu explains the choice, the button reports what is in
    // effect. A button reading "inherit" answers a question nobody asked.
    expect(choice.displayLabel).toBe('await human')
  })

  it('leaves the button alone once a value has been chosen explicitly', () => {
    const choice = tieredChoice('on', 'off', [{ value: 'on', label: 'on' }])
    expect(choice.displayLabel).toBeUndefined()
    expect(choice.value).toBe('on')
  })

  it('shows an unlabelled value raw rather than falling back to the default', () => {
    // ⚠️ The one wrong answer here is printing *the default* for a setting that is not on it.
    expect(inheritedLabel({ on: 'kept' }, 'off' as 'on', 'fallback')).toBe('off')
    expect(inheritedLabel({ on: 'kept' }, undefined, 'fallback')).toBe('fallback')
  })
})

describe('the four three-tier settings', () => {
  it('offers every finish rung the fleet has, under the inherited one', () => {
    // ⛔ Derived from `FINISH_ORDER` rather than listed, so a rung added or renamed there cannot
    // leave this menu behind.
    const choice = finishChoice(task(), { policy: 'commit-and-merge', source: 'project', instruction: null })
    expect(choice.options.map((o) => o.value)).toEqual(['inherit', ...FINISH_ORDER])
    expect(choice.options[0]?.label).toBe(`inherit (${FINISH_LABELS['commit-and-merge']})`)
  })

  it('falls back to what the daemon actually does when it sends no inherited answer', () => {
    expect(finishChoice(task(), undefined).displayLabel).toBe('agent lands it')
    expect(sharingChoice(task(), undefined).displayLabel).toBe('always start a new one')
    expect(completionChoice(task(), undefined).displayLabel).toBe('run to the end')
    expect(compactionChoice(task(), undefined).displayLabel).toBe(AUTO_COMPACT_LABELS.on)
  })

  it('names the inherited sharing answer in the fleet’s own words', () => {
    const choice = sharingChoice(task(), { sharing: 'on', source: 'fleet' })
    expect(choice.options[0]?.label).toBe(`inherit (${SHARING_LABELS.on})`)
  })

  it('keeps a task’s own answer selected', () => {
    expect(finishChoice(task({ finishPolicy: 'await-human' }), undefined).value).toBe('await-human')
    expect(compactionChoice(task({ autoCompact: 'off' }), undefined).value).toBe('off')
  })
})

describe('the objective, which has three shapes and one control', () => {
  const weights = (cost: number, velocity: number, quality: number): Objective => ({
    cost,
    velocity,
    quality
  })

  it('reads a preset name straight off the task', () => {
    expect(objectiveChoice('economy', undefined).value).toBe('economy')
  })

  it('names a weight vector by its preset when it is one', () => {
    const balanced = objectiveChoice(null, weights(0.3, 0.3, 0.4))
    expect(balanced.displayLabel).toBe('balanced')
  })

  it('calls a vector that matches nothing custom, and offers custom only then', () => {
    // ⛔ `custom` is not something an operator can pick here — the weights come from the composer —
    // so it appears as an option exactly while it is the answer, and never as an invitation.
    const odd = objectiveChoice(weights(0.7, 0.2, 0.1), undefined)
    expect(odd.value).toBe('custom')
    expect(odd.options.map((o) => o.value)).toContain('custom')
    expect(objectiveChoice('economy', undefined).options.map((o) => o.value)).not.toContain('custom')
  })

  it('shows an inherited vector as percentages when no preset fits it', () => {
    const choice = objectiveChoice(null, weights(0.7, 0.2, 0.1))
    expect(choice.displayLabel).toBe('70%/20%/10%')
  })

  it('says balanced when nothing above has an objective either', () => {
    expect(objectiveChoice(null, undefined).displayLabel).toBe('balanced')
  })
})

describe('which accounts a task may be pinned to', () => {
  it('offers only accounts that are enabled and hold the work role', () => {
    // ⛔ A judgment-only or disabled account can never be handed this task, so offering it would be
    // offering a pin the scheduler will not honour.
    const choice = workerChoice(
      task(),
      fleet(
        { id: 'w1', label: 'ClaudeFirst' },
        { id: 'w2', label: 'Disabled', enabled: false },
        { id: 'w3', label: 'JudgeOnly', role: 'controller' }
      )
    )
    expect(choice.options.map((o) => o.label)).toEqual(['Auto — scheduler choice', 'ClaudeFirst'])
  })

  it('reads the empty value as auto, not as inherit', () => {
    // ⚠️ There is no tier above a task here — only the scheduler's own choice — so this setting has
    // no `inherit` entry and no `displayLabel`.
    const choice = workerChoice(task(), fleet({ id: 'w1', label: 'ClaudeFirst' }))
    expect(choice.value).toBe('')
    expect(choice.options[0]?.value).toBe('')
    expect(choice.displayLabel).toBeUndefined()
  })

  it('selects the pinned account when there is one', () => {
    const pinned = task({ constraints: { workerId: 'w1' } })
    expect(workerChoice(pinned, fleet({ id: 'w1', label: 'ClaudeFirst' })).value).toBe('w1')
  })
})

describe('which account last ran this task', () => {
  it('names it, and abbreviates an id the fleet no longer lists', () => {
    const ran = task({ ranOn: 'w1' })
    expect(ranOnLabel(ran, fleet({ id: 'w1', label: 'ClaudeFirst' }))).toBe('ClaudeFirst')
    // ⚠️ An account can be removed while its runs stay in the ledger. The id is still an answer;
    // silence is not.
    expect(ranOnLabel(task({ ranOn: 'deleted-worker-id' }), fleet())).toBe('deleted-')
    expect(ranOnLabel(task(), fleet())).toBeNull()
  })
})

describe('priority', () => {
  it('offers the four rungs and no inherit', () => {
    const choice = priorityChoice(task({ priority: 'P0' }))
    expect(choice.value).toBe('P0')
    expect(choice.options.map((o) => o.value)).toEqual(['P0', 'P1', 'P2', 'P3'])
  })
})

describe('where a task works, as the pane offers it', () => {
  it('names the project default on inherit and offers both modes', () => {
    const task = { workspaceMode: 'inherit' } as Parameters<typeof workspaceChoice>[0]
    expect(workspaceChoice(task, 'trunk').displayLabel).toBe('trunk')
    expect(workspaceChoice(task, undefined).displayLabel).toBe('worktree')
    expect(workspaceChoice(task, 'worktree').options.map((o) => o.value)).toEqual(['inherit', 'worktree', 'trunk'])
    expect(workspaceChoice({ ...task, workspaceMode: 'trunk' }, 'worktree').displayLabel).toBeUndefined()
  })
})
