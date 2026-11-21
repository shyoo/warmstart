import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ModelOptions } from '@shared/protocol'
import { ROOT_MANDATE, type Task } from '@shared/tasks'
import type { FleetEntry } from '../../lib/daemon'
import { PillOptions } from '../Pill'
import {
  AssignPills,
  availableAutoTags,
  initialSelectedModel,
  nextTagsForAutoTier,
  orderedAutoTierTags,
  pillLabels,
  reassignApplyPayload,
  ReassignModelMenu,
  unavailableAutoTags,
  useReassignChoice,
  type ReassignChoice
} from './Reassign'

vi.mock('../../lib/daemon', async (original) => ({
  ...(await original<typeof import('../../lib/daemon')>()),
  rpc: vi.fn()
}))

const base = {
  workerId: '',
  model: '',
  effort: '',
  changed: false,
  worker: null,
  inheritedLabel: 'CLI default model',
  current: null,
  currentWorkerLabel: null
}

describe('pillLabels (t674)', () => {
  it('says Auto before anything has run', () => {
    expect(pillLabels(base)).toMatchObject({
      workerLabel: 'Auto worker',
      modelLabel: 'Auto model',
      effortLabel: 'Auto effort',
      currentEffort: false,
      selectedWorkerId: ''
    })
  })

  it('names what the scheduler chose once a run has happened', () => {
    const labels = pillLabels({
      ...base,
      current: { workerId: 'w1', model: 'claude-opus-5-5', effort: 'high' },
      currentWorkerLabel: 'ClaudeFirst'
    })
    expect(labels.workerLabel).toBe('ClaudeFirst')
    expect(labels.selectedWorkerId).toBe('w1')
    expect(labels.modelLabel).not.toMatch(/auto/i)
    expect(labels.modelLabel).toMatch(/opus/i)
    expect(labels.effortLabel).toBe('High')
    expect(labels.currentEffort).toBe(true)
  })

  it('names the running model after a reassignment that left the model to the scheduler', () => {
    const labels = pillLabels({
      ...base,
      workerId: 'w2',
      model: '__auto__',
      worker: { label: 'CodexFirst', defaultEffort: 'medium' },
      current: { workerId: 'w2', model: 'gpt-6-sol', effort: 'xhigh' },
      currentWorkerLabel: 'CodexFirst'
    })
    expect(labels.workerLabel).toBe('CodexFirst')
    expect(labels.selectedWorkerId).toBe('w2')
    expect(labels.modelLabel).not.toMatch(/auto/i)
    expect(labels.effortLabel).not.toMatch(/auto/i)
  })

  it('keeps an explicit pin over what last ran', () => {
    const labels = pillLabels({
      ...base,
      workerId: 'w1',
      model: 'claude-sonnet-5',
      effort: 'low',
      worker: { label: 'ClaudeFirst' },
      current: { workerId: 'w1', model: 'claude-opus-5-5', effort: 'high' },
      currentWorkerLabel: 'ClaudeFirst'
    })
    expect(labels.workerLabel).toBe('ClaudeFirst')
    expect(labels.selectedWorkerId).toBe('w1')
    expect(labels.modelLabel).toMatch(/sonnet/i)
    expect(labels.effortLabel).toBe('Low')
  })

  it('does not borrow the previous account’s model for a reassignment that has not run yet', () => {
    const labels = pillLabels({
      ...base,
      workerId: 'w2',
      model: '__auto__',
      worker: { label: 'CodexFirst' },
      current: { workerId: 'w1', model: 'claude-opus-5-5', effort: 'high' },
      currentWorkerLabel: 'ClaudeFirst'
    })
    expect(labels.workerLabel).toBe('CodexFirst')
    expect(labels.selectedWorkerId).toBe('w2')
    expect(labels.modelLabel).toBe('Auto Model')
    expect(labels.currentEffort).toBe(false)
  })

  it('shows the operator’s pending pick, not the current run, once the selection changes', () => {
    const labels = pillLabels({
      ...base,
      changed: true,
      current: { workerId: 'w1', model: 'claude-opus-5-5', effort: 'high' },
      currentWorkerLabel: 'ClaudeFirst'
    })
    expect(labels.workerLabel).toBe('Auto worker')
    expect(labels.selectedWorkerId).toBe('')
    expect(labels.modelLabel).toBe('Auto model')
  })

  it('shows Auto worker when operator explicitly picks Auto worker on a task that ran on a worker', () => {
    const labels = pillLabels({
      ...base,
      workerId: '',
      changed: true,
      current: { workerId: 'w1', model: 'claude-opus-5-5', effort: 'high' },
      currentWorkerLabel: 'ClaudeThird'
    })
    expect(labels.workerLabel).toBe('Auto worker')
    expect(labels.selectedWorkerId).toBe('')
  })

  it('says Invalid model: <model> when invalidConcreteModel is true (t868)', () => {
    const labels = pillLabels({
      ...base,
      model: 'sol-6',
      invalidConcreteModel: true
    })
    expect(labels.modelLabel).toBe('Invalid model: Sol 6')
  })
})

describe('worker dropdown menu selection (t763)', () => {
  const options = [
    { value: '', label: 'Auto (scheduler decides)' },
    { value: 'w1', label: 'ClaudeFirst (claude-code)' },
    { value: 'w2', label: 'ClaudeSecond (claude-code)' },
    { value: 'w3', label: 'ClaudeThird (claude-code)' }
  ]

  it('shows the running worker as selected and Auto unselected when task ran under Auto worker', () => {
    // When a task ran under Auto worker on ClaudeThird (w3), pillLabels yields selectedWorkerId === 'w3'.
    const labels = pillLabels({
      ...base,
      workerId: '',
      changed: false,
      current: { workerId: 'w3', model: 'claude-opus-5-5', effort: 'high' },
      currentWorkerLabel: 'ClaudeThird'
    })
    expect(labels.workerLabel).toBe('ClaudeThird')
    expect(labels.selectedWorkerId).toBe('w3')

    const html = renderToStaticMarkup(
      <PillOptions
        options={options}
        value={labels.selectedWorkerId}
        ariaLabel="Reassign worker"
        onPick={() => {}}
      />
    )

    // ClaudeThird must be marked selected with the checkmark
    expect(html).toContain('data-value="w3"')
    expect(html).toMatch(/data-value="w3"[^>]*aria-selected="true"/)
    expect(html).toMatch(/data-value="w3"[^>]*pill-option--on/)

    // Auto (scheduler decides) must NOT be marked selected or checked
    expect(html).toMatch(/data-value=""[^>]*aria-selected="false"/)
    expect(html).not.toMatch(/data-value=""[^>]*pill-option--on/)
  })

  it('shows Auto as selected and running worker unselected once operator picks Auto worker', () => {
    // Once operator picks Auto, changed is true, and selectedWorkerId reverts to ''
    const labels = pillLabels({
      ...base,
      workerId: '',
      changed: true,
      current: { workerId: 'w3', model: 'claude-opus-5-5', effort: 'high' },
      currentWorkerLabel: 'ClaudeThird'
    })
    expect(labels.workerLabel).toBe('Auto worker')
    expect(labels.selectedWorkerId).toBe('')

    const html = renderToStaticMarkup(
      <PillOptions
        options={options}
        value={labels.selectedWorkerId}
        ariaLabel="Reassign worker"
        onPick={() => {}}
      />
    )

    // Auto (scheduler decides) must be marked selected with the checkmark
    expect(html).toMatch(/data-value=""[^>]*aria-selected="true"/)
    expect(html).toMatch(/data-value=""[^>]*pill-option--on/)

    // ClaudeThird must NOT be marked selected
    expect(html).toMatch(/data-value="w3"[^>]*aria-selected="false"/)
    expect(html).not.toMatch(/data-value="w3"[^>]*pill-option--on/)
  })
})

describe('initialSelectedModel', () => {
  it('reads tags filed without a policy as Auto, not the account default (t896)', () => {
    expect(initialSelectedModel(undefined, undefined, ['High'])).toBe('__auto__')
    expect(initialSelectedModel(undefined, 'auto', ['Med', 'ZDR'])).toBe('__auto__')
    expect(initialSelectedModel(undefined, 'auto')).toBe('__auto__')
    expect(initialSelectedModel(undefined, 'inherit', ['High'])).toBe('')
    expect(initialSelectedModel(undefined, undefined, [])).toBe('')
    expect(initialSelectedModel('claude-opus-5-5', undefined, ['High'])).toBe('claude-opus-5-5')
    expect(initialSelectedModel()).toBe('')
  })
})

describe('availableAutoTags (t764, tags t1042)', () => {
  it('offers only tags an account’s auto routes carry, never an unticked row’s', () => {
    expect(
      availableAutoTags(
        {
          modelRoutes: [
            { model: 'gemini-3.8-flash', effort: 'high', tags: ['Med', 'Audio'], auto: true },
            { model: 'gemini-3.1-pro', effort: 'high', tags: ['High', 'ZDR'], auto: false }
          ]
        },
        'gemini-3.8-flash'
      )
    ).toEqual(['Med', 'Audio'])
  })

  it('uses the default pair’s tags when this account has no Auto table', () => {
    expect(availableAutoTags({ modelRoutes: [] }, 'gemini-3.8-flash')).toEqual(['Med'])
  })
})

describe('unavailableAutoTags (t899, tags t1042)', () => {
  const worker = {
    modelRoutes: [
      { model: 'claude-opus-5-5', effort: 'high', tags: ['High'], auto: true },
      { model: 'claude-sonnet-5', effort: 'medium', tags: ['Med', 'Audio'], auto: true }
    ]
  }

  it('does not refuse tags when the scheduler still picks the account', () => {
    // No account selected is not "this account has no route".
    expect(availableAutoTags(null, null)).toEqual([])
    expect(unavailableAutoTags('__auto__', ['Med'], null, null)).toBeNull()
  })

  it('refuses a requirement no single pair holds, even when each tag is on the table', () => {
    expect(unavailableAutoTags('__auto__', ['High'], worker, null)).toBeNull()
    expect(unavailableAutoTags('__auto__', ['Med', 'Audio'], worker, null)).toBeNull()
    expect(unavailableAutoTags('__auto__', ['High', 'Audio'], worker, null)).toEqual(['High', 'Audio'])
    expect(unavailableAutoTags('__auto__', ['ZDR'], worker, null)).toEqual(['ZDR'])
  })

  it('says nothing for a pinned model, the account default, or no tags', () => {
    expect(unavailableAutoTags('claude-opus-5-5', ['ZDR'], worker, null)).toBeNull()
    expect(unavailableAutoTags('', ['ZDR'], worker, null)).toBeNull()
    expect(unavailableAutoTags('__auto__', [], worker, null)).toBeNull()
  })
})

function makeTask(constraints: Task['constraints'] = {}): Task {
  return {
    id: 'task-1',
    seq: 1,
    projectId: null,
    title: 'Fix composer pills',
    titleSummary: null,
    kind: 'work',
    status: 'awaiting_human',
    priority: 'P2',
    createdBy: { kind: 'human' },
    parentTaskId: null,
    lineageDepth: 0,
    assignee: null,
    assigneeHint: null,
    mandate: ROOT_MANDATE,
    budget: { grantedTokens: 100000, spentTokens: 0 },
    dependsOn: [],
    notBefore: null,
    deadline: null,
    requires: [],
    constraints,
    verification: 'auto',
    finishPolicy: 'inherit',
    sessionSharing: 'inherit',
    completionMode: 'inherit',
    workspaceMode: 'inherit',
    objective: 'inherit',
    autoCompact: 'inherit',
    finishAskedAt: null,
    conflictAskedAt: null,
    resolveRetryAskedAt: null,
    preemptible: true,
    estTokens: null,
    cancel: null,
    handoffNote: null,
    holdReason: null,
    holdUntil: null,
    quotaOverrideUntil: null,
    quotaPreemptWarning: null,
    branch: null,
    branchUnit: 1,
    landAfterTurn: null,
    landingTarget: null,
    childDefaults: null,
    debate: null,
    firstRunAt: null,
    lastRunEndedAt: null,
    activeMs: 0,
    activeSince: null,
    ranOn: null,
    ranModel: null,
    ranEffort: null,
    landedBaseSha: null,
    landedHeadSha: null,
    qualityReviewId: null,
    qualityScore: null,
    qualityReviewCount: 0,
    qualityReviewedAt: null,
    qualityReviewer: null,
    qualityManualCount: 0,
    excludedFromStats: false,
    nonGradable: false,
    deletedAt: null,
    createdAt: 1,
    updatedAt: 1
  }
}

function makeFleet(): FleetEntry[] {
  return [
    {
      worker: {
        id: 'w-agy',
        label: 'Antigravity',
        adapterId: 'antigravity-cli',
        enabled: true,
        role: 'worker',
        health: null,
        maxConcurrent: 1,
        defaultModel: 'gemini-4-neon',
        defaultEffort: 'high',
        modelRoutes: [
          { model: 'gemini-4-neon', effort: 'high', tags: ['High', 'ZDR'], auto: true },
          { model: 'gemini-4-hydrogen', effort: 'medium', tags: ['Med', 'Low'], auto: true },
          { model: 'gemini-3.8-flash', effort: 'low', tags: ['Tier:Ultra'], auto: true }
        ],
        createdAt: 1
      } as FleetEntry['worker'],
      sessions: [],
      quota: null
    },
    {
      worker: {
        id: 'w-codex',
        label: 'Codex',
        adapterId: 'codex-cli',
        enabled: true,
        role: 'worker',
        health: null,
        maxConcurrent: 1,
        defaultModel: 'gpt-6-sol',
        defaultEffort: 'medium',
        modelRoutes: [{ model: 'gpt-6-sol', effort: 'medium', tags: ['Med'], auto: true }],
        createdAt: 2
      } as FleetEntry['worker'],
      sessions: [],
      quota: null
    }
  ]
}

const sampleOptions: ModelOptions[] = [
  {
    adapterId: 'antigravity-cli',
    costModelId: 'google.antigravity.2026-08',
    selectableEffort: true,
    models: [
      { id: 'gemini-4-neon', contextWindow: null, effortLevels: ['low', 'medium', 'high'] },
      { id: 'gemini-4-hydrogen', contextWindow: null, effortLevels: ['low', 'medium', 'high', 'xhigh'] }
    ]
  },
  {
    adapterId: 'codex-cli',
    costModelId: 'openai.codex.2026-08',
    selectableEffort: true,
    models: [{ id: 'gpt-6-sol', contextWindow: 400000, effortLevels: ['low', 'medium', 'high'] }]
  }
]

function Harness({
  task,
  fleet,
  options,
  current,
  onChoice
}: {
  task: Task
  fleet: FleetEntry[]
  options: ModelOptions[]
  current: { workerId: string; model: string | null; effort: string | null } | null
  onChoice: (choice: ReassignChoice) => void
}): React.JSX.Element {
  const choice = useReassignChoice(task, fleet, options, current)
  onChoice(choice)
  return <AssignPills choice={choice} disabled={false} />
}

describe('AssignPills and ReassignModelMenu (P3)', () => {
  it('renders current model and effort with no separate tier pill when Auto Model + [tier:high] has run', () => {
    let captured!: ReassignChoice
    const html = renderToStaticMarkup(
      <Harness
        task={makeTask({ modelPolicy: 'auto', modelTags: ['High'] })}
        fleet={makeFleet()}
        options={sampleOptions}
        current={{ workerId: 'w-agy', model: 'gemini-4-neon', effort: 'high' }}
        onChoice={(choice) => {
          captured = choice
        }}
      />
    )

    expect(captured.workerLabel).toBe('Antigravity')
    expect(captured.modelLabel).toBe('Gemini 4 Neon')
    expect(captured.effortLabel).toBe('High')

    // Exactly three closed pills: worker, model, effort — never a separate TagsPill.
    expect(html).not.toContain('aria-label="Reassign tags')
    expect(html).toContain('aria-label="Reassign worker"')
    expect(html).toContain('aria-label="Reassign model"')
    expect(html).toContain('aria-label="Reassign effort"')

    // Model pill is clickable even on Auto worker (workerId === '').
    const modelBtn = html.match(/<button[^>]*aria-label="Reassign model"[^>]*>/)?.[0]
    expect(modelBtn).toBeTruthy()
    expect(modelBtn).not.toContain('disabled')
  })

  it('shows Auto Model · High on the model pill when no run is active (!onCurrent)', () => {
    const labelsAutoWorker = pillLabels({
      ...base,
      model: '__auto__',
      tags: ['High']
    })
    expect(labelsAutoWorker.modelLabel).toBe('Auto Model · High')

    const html = renderToStaticMarkup(
      <Harness
        task={makeTask({ modelPolicy: 'auto', modelTags: ['High'] })}
        fleet={makeFleet()}
        options={sampleOptions}
        current={null}
        onChoice={() => undefined}
      />
    )
    expect(html).toContain('Auto Model · High')
    expect(html).not.toContain('>High<')
  })

  it('orders Auto Model tiers High, Med, Low before custom tiers and offers feature tags and fleet models on Auto worker', () => {
    expect(orderedAutoTierTags(['Low', 'Tier:Ultra', 'High', 'Med', 'ZDR'])).toEqual([
      'High',
      'Med',
      'Low',
      'Tier:Ultra'
    ])

    let captured!: ReassignChoice
    renderToStaticMarkup(
      <Harness
        task={makeTask({ modelPolicy: 'auto', modelTags: ['High'] })}
        fleet={makeFleet()}
        options={sampleOptions}
        current={null}
        onChoice={(c) => {
          captured = c
        }}
      />
    )

    const menuHtml = renderToStaticMarkup(<ReassignModelMenu choice={captured} close={() => undefined} />)
    expect(menuHtml).toContain('Auto Model (by tier)')
    expect(menuHtml).toContain('Auto Model (Any)')
    expect(menuHtml).toContain('Auto Model · High')
    expect(menuHtml).toContain('Auto Model · Med')
    expect(menuHtml).toContain('Auto Model · Low')
    expect(menuHtml).toContain('Auto Model · Ultra')
    expect(menuHtml).toContain('Feature tags')
    expect(menuHtml).toContain('ZDR')
    expect(menuHtml).toContain('Models')
    expect(menuHtml).toContain('Gemini 4 Neon')
    expect(menuHtml).toContain('Antigravity')
    expect(menuHtml).toContain('GPT 6 Sol')
    expect(menuHtml).toContain('Codex')
    expect(menuHtml).not.toContain('Account default')
  })

  it('shows Account default and that account’s concrete models when a worker is pinned', () => {
    let captured!: ReassignChoice
    renderToStaticMarkup(
      <Harness
        task={makeTask({ workerId: 'w-codex', modelPolicy: 'auto', modelTags: ['Med'] })}
        fleet={makeFleet()}
        options={sampleOptions}
        current={null}
        onChoice={(c) => {
          captured = c
        }}
      />
    )

    const menuHtml = renderToStaticMarkup(<ReassignModelMenu choice={captured} close={() => undefined} />)
    expect(menuHtml).toContain('Account default (GPT 6 Sol)')
    expect(menuHtml).toContain('Auto Model · Med')
    expect(menuHtml).not.toContain('Gemini 4 Neon')
  })

  it('switches Auto Model tier while preserving feature tags and builds exact task.setWorker payloads', async () => {
    const { rpc } = await import('../../lib/daemon')
    vi.mocked(rpc).mockReset().mockResolvedValue(undefined as never)

    // Exclusive tier replacement preserves orthogonal feature tags.
    expect(nextTagsForAutoTier(['High', 'ZDR'], 'Med')).toEqual(['Med', 'ZDR'])
    expect(nextTagsForAutoTier(['Med', 'ZDR'], null)).toEqual(['ZDR'])

    // Changed tier changes the Auto Model label and marks changed.
    expect(
      pillLabels({
        ...base,
        model: '__auto__',
        tags: ['Med', 'ZDR'],
        changed: true,
        current: { workerId: 'w-agy', model: 'gemini-4-neon', effort: 'high' },
        currentWorkerLabel: 'Antigravity'
      }).modelLabel
    ).toBe('Auto Model · Med + ZDR')

    // Auto worker + tier payload
    expect(
      reassignApplyPayload({
        taskId: 'task-1',
        workerId: '',
        model: '__auto__',
        tags: ['Med'],
        filedEffort: null
      })
    ).toEqual({
      id: 'task-1',
      workerId: null,
      modelTags: ['Med']
    })

    // Pinned worker + tier payload
    expect(
      reassignApplyPayload({
        taskId: 'task-1',
        workerId: 'w-agy',
        model: '__auto__',
        tags: ['Med'],
        filedEffort: null
      })
    ).toEqual({
      id: 'task-1',
      workerId: 'w-agy',
      model: null,
      modelPolicy: 'auto',
      modelTags: ['Med'],
      effort: null
    })

    // Auto worker + picking concrete fleet model sets worker + model cleanly
    expect(
      reassignApplyPayload({
        taskId: 'task-1',
        workerId: 'w-codex',
        model: 'gpt-6-sol',
        tags: [],
        filedEffort: null
      })
    ).toEqual({
      id: 'task-1',
      workerId: 'w-codex',
      model: 'gpt-6-sol',
      modelPolicy: null,
      modelTags: [],
      effort: null
    })

    // Verify useReassignChoice's apply() invokes task.setWorker through rpc and pickAutoTier/pickWorkerModel wire cleanly.
    let captured!: ReassignChoice
    renderToStaticMarkup(
      <Harness
        task={makeTask({ modelPolicy: 'auto', modelTags: ['High'] })}
        fleet={makeFleet()}
        options={sampleOptions}
        current={null}
        onChoice={(c) => {
          captured = c
        }}
      />
    )
    await captured.apply()
    expect(rpc).toHaveBeenCalledWith('task.setWorker', {
      id: 'task-1',
      workerId: null,
      modelTags: ['High']
    })

    // Invoking menu option callbacks calls pickAutoTier / pickWorkerModel and closes menu.
    const spyPickTier = vi.fn()
    const spyPickWorkerModel = vi.fn()
    const spyClose = vi.fn()
    let menuTree: React.ReactElement | null = null
    function MenuProbe(): React.JSX.Element {
      menuTree = ReassignModelMenu({
        choice: {
          ...captured,
          pickAutoTier: spyPickTier,
          pickWorkerModel: spyPickWorkerModel
        },
        close: spyClose
      })
      return menuTree
    }
    renderToStaticMarkup(<MenuProbe />)
    const buttons: Array<{ props: { onClick?: () => void; children?: unknown } }> = []
    const collect = (node: unknown): void => {
      if (!node || typeof node !== 'object') return
      if (Array.isArray(node)) {
        node.forEach(collect)
        return
      }
      const el = node as { type?: unknown; props?: { children?: unknown; onClick?: () => void } }
      if (el.type === 'button' && el.props) buttons.push(el as { props: { onClick?: () => void; children?: unknown } })
      if (el.props?.children) collect(el.props.children)
    }
    collect(menuTree)
    const medBtn = buttons.find((b) => JSON.stringify(b.props.children).includes('Auto Model · Med'))
    expect(medBtn).toBeTruthy()
    medBtn!.props.onClick!()
    expect(spyPickTier).toHaveBeenCalledWith('Med')
    expect(spyClose).toHaveBeenCalledTimes(1)

    const solBtn = buttons.find((b) => JSON.stringify(b.props.children).includes('GPT 6 Sol'))
    expect(solBtn).toBeTruthy()
    solBtn!.props.onClick!()
    expect(spyPickWorkerModel).toHaveBeenCalledWith('w-codex', 'gpt-6-sol')
    expect(spyClose).toHaveBeenCalledTimes(2)
  })
})
