import { readFileSync } from 'node:fs'
import type { ReactElement, ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Task } from '@shared/tasks'
import {
  DelegatePill,
  DelegateSplitPill,
  DelegateSplitPillView,
  DelegationMenu,
  delegationSummary
} from './DelegatePill'

function collectElements(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const item of node as readonly ReactNode[]) collectElements(item, out)
  } else if (node && typeof node === 'object' && 'type' in node && 'props' in node) {
    const el = node as ReactElement<{ children?: ReactNode }>
    out.push(el)
    if (el.props?.children !== undefined) collectElements(el.props.children, out)
  }
  return out
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    seq: 1,
    projectId: null,
    title: 'Test task',
    kind: 'conversation',
    status: 'ready',
    priority: 'P2',
    createdBy: { kind: 'human' },
    parentTaskId: null,
    lineageDepth: 0,
    assignee: null,
    assigneeHint: null,
    mandate: {
      allowed: ['read', 'write', 'spawn_tasks'],
      projectIds: 'creator',
      maxLineageDepth: 3,
      maxChildren: 5
    },
    budget: { grantedTokens: 0, spentTokens: 0 },
    dependsOn: [],
    notBefore: null,
    deadline: null,
    requires: [],
    constraints: {},
    verification: 'auto',
    finishPolicy: 'inherit',
    sessionSharing: 'inherit',
    completionMode: 'inherit',
    objective: 'inherit',
    autoCompact: 'inherit',
    preemptible: true,
    estTokens: null,
    branch: null,
    branchUnit: null,
    landingTarget: null,
    childDefaults: null,
    debate: null,
    nonGradable: false,
    workspaceMode: 'inherit',
    holdReason: null,
    quotaPreemptWarning: null,
    quotaOverrideUntil: null,
    statsExcluded: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  } as Task
}

describe('DelegateSplitPill', () => {
  it('renders unified split pill with ON/OFF toggle and Delegate trigger', () => {
    const onHtml = renderToStaticMarkup(
      <DelegateSplitPill
        on
        allowedTiers={[]}
        allowedModels={[]}
        availableTiers={['Low', 'Med', 'High']}
        availableModels={['gemini-4-hydrogen']}
        modelTiers={{ 'gemini-4-hydrogen': ['Low'] }}
        onChange={() => {}}
      />
    )
    expect(onHtml).toContain('class="split-pill split-pill--on"')
    expect(onHtml).toContain('class="split-pill-toggle split-pill-toggle--on"')
    expect(onHtml).toContain('aria-label="Toggle delegation"')
    expect(onHtml).toContain('aria-pressed="true"')
    expect(onHtml).toContain('>ON</button>')
    expect(onHtml).toContain('split-pill-menu-trigger')
    expect(onHtml).toContain('Delegate <span aria-hidden="true">▼</span>')

    const offHtml = renderToStaticMarkup(
      <DelegateSplitPill
        on={false}
        allowedTiers={['Low']}
        allowedModels={['gemini-4-hydrogen']}
        availableTiers={['Low', 'Med', 'High']}
        availableModels={['gemini-4-hydrogen']}
        modelTiers={{ 'gemini-4-hydrogen': ['Low'] }}
        onChange={() => {}}
      />
    )
    expect(offHtml).toContain('class="split-pill split-pill--off"')
    expect(offHtml).toContain('aria-pressed="false"')
    expect(offHtml).toContain('>OFF</button>')
    expect(offHtml).toContain('pill--muted')
    expect(offHtml).not.toContain('Low')
  })

  it('shows concise restriction summary on the Delegate trigger when ON', () => {
    expect(delegationSummary(true, ['Low'], [])).toBe(' (Low)')
    expect(delegationSummary(true, [], ['m1', 'm2'])).toBe(' (2 models)')
    expect(delegationSummary(true, ['Low'], ['m1'])).toBe(' (Low · 1 model)')
    expect(delegationSummary(false, ['Low'], ['m1'])).toBe('')

    const html = renderToStaticMarkup(
      <DelegateSplitPill
        on
        allowedTiers={['tier:low']}
        allowedModels={['gemini-4-hydrogen']}
        availableTiers={['Low', 'Med', 'High']}
        availableModels={['gemini-4-hydrogen']}
        modelTiers={{ 'gemini-4-hydrogen': ['Low'] }}
        onChange={() => {}}
      />
    )
    expect(html).toContain('Delegate (Low · 1 model)')
  })

  it('toggles ON/OFF and selects allowed tiers and allowed models via popover callbacks', () => {
    const onChange = vi.fn()
    const view = DelegateSplitPillView({
      on: true,
      allowedTiers: ['Low'],
      allowedModels: ['gemini-4-hydrogen'],
      availableTiers: ['Low', 'Med', 'High'],
      availableModels: ['gemini-4-hydrogen', 'claude-opus-5-5'],
      modelTiers: { 'gemini-4-hydrogen': ['Low'], 'claude-opus-5-5': ['High'] },
      onChange
    })
    const elements = collectElements(view)
    const toggleBtn = elements.find(
      (el) => el.type === 'button' && (el.props as { 'aria-label'?: string })['aria-label'] === 'Toggle delegation'
    )
    expect(toggleBtn).toBeDefined()
    ;(toggleBtn!.props as { onClick: () => void }).onClick()
    expect(onChange).toHaveBeenCalledWith({
      on: false,
      allowedTiers: ['Low'],
      allowedModels: ['gemini-4-hydrogen']
    })

    // Render and interact with the popover menu
    const menuHtml = renderToStaticMarkup(
      <DelegationMenu
        on
        allowedTiers={['Low']}
        allowedModels={['gemini-4-hydrogen']}
        availableTiers={['Low', 'Med', 'High']}
        availableModels={['gemini-4-hydrogen', 'claude-opus-5-5']}
        modelTiers={{ 'gemini-4-hydrogen': ['Low'], 'claude-opus-5-5': ['High'] }}
        onChange={() => {}}
      />
    )
    expect(menuHtml).toContain('Allowed tiers')
    expect(menuHtml).toContain('Allowed models')
    expect(menuHtml).toContain('delegation-picker-tiers">Low</span>')
    expect(menuHtml).toContain('delegation-picker-tiers">High</span>')

    onChange.mockClear()
    const menuEl = DelegationMenu({
      on: true,
      allowedTiers: ['Low'],
      allowedModels: ['gemini-4-hydrogen'],
      availableTiers: ['Low', 'Med', 'High'],
      availableModels: ['gemini-4-hydrogen', 'claude-opus-5-5'],
      modelTiers: { 'gemini-4-hydrogen': ['Low'], 'claude-opus-5-5': ['High'] },
      onChange
    })
    const checkboxes = collectElements(menuEl).filter(
      (el) => el.type === 'input' && (el.props as { type?: string }).type === 'checkbox'
    )
    // 3 tiers (Low checked, Med unchecked, High unchecked) + 2 models (gemini checked, claude unchecked)
    expect(checkboxes).toHaveLength(5)

    // Check Med tier
    ;(checkboxes[1]!.props as { onChange: () => void }).onChange()
    expect(onChange).toHaveBeenLastCalledWith({
      on: true,
      allowedTiers: ['Low', 'Med'],
      allowedModels: ['gemini-4-hydrogen']
    })

    // Uncheck Low tier
    ;(checkboxes[0]!.props as { onChange: () => void }).onChange()
    expect(onChange).toHaveBeenLastCalledWith({
      on: true,
      allowedTiers: [],
      allowedModels: ['gemini-4-hydrogen']
    })

    // Check claude-opus-5-5 model
    ;(checkboxes[4]!.props as { onChange: () => void }).onChange()
    expect(onChange).toHaveBeenLastCalledWith({
      on: true,
      allowedTiers: ['Low'],
      allowedModels: ['gemini-4-hydrogen', 'claude-opus-5-5']
    })

    // Uncheck gemini-4-hydrogen model
    ;(checkboxes[3]!.props as { onChange: () => void }).onChange()
    expect(onChange).toHaveBeenLastCalledWith({
      on: true,
      allowedTiers: ['Low'],
      allowedModels: []
    })
  })
})

describe('DelegatePill', () => {
  it('renders split pill for work and conversation tasks and hides for plan/debate', () => {
    const convHtml = renderToStaticMarkup(
      <DelegatePill task={makeTask({ kind: 'conversation' })} refresh={async () => {}} canToolSplit={false} />
    )
    expect(convHtml).toContain('split-pill')
    expect(convHtml).toContain('has no MCP or CLI tools')

    const planHtml = renderToStaticMarkup(
      <DelegatePill task={makeTask({ kind: 'plan' })} refresh={async () => {}} />
    )
    expect(planHtml).toBe('')
  })
})

describe('NewTask split-pill wiring (source level)', () => {
  const newTaskSrc = readFileSync(new URL('../NewTask.tsx', import.meta.url), 'utf8')

  it('renders DelegateSplitPill only in the Single Task / Conversation branch and submits delegationPolicy', () => {
    const nonPlanStart = newTaskSrc.indexOf(') : !isPlan ? (')
    const planStart = newTaskSrc.indexOf(') : (', nonPlanStart)
    const pillPos = newTaskSrc.indexOf('<DelegateSplitPill', nonPlanStart)
    expect(nonPlanStart).toBeGreaterThan(-1)
    expect(planStart).toBeGreaterThan(nonPlanStart)
    expect(pillPos).toBeGreaterThan(nonPlanStart)
    expect(pillPos).toBeLessThan(planStart)
    expect(newTaskSrc.indexOf('<DelegateSplitPill', planStart)).toBe(-1)

    const createStart = newTaskSrc.indexOf("rpc('task.create'")
    const createEnd = newTaskSrc.indexOf('\n        })', createStart)
    expect(createStart).toBeGreaterThan(-1)
    expect(createEnd).toBeGreaterThan(createStart)
    expect(newTaskSrc.slice(createStart, createEnd)).toContain('delegationPolicy:')
  })
})
