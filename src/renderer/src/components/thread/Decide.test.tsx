import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Task } from '@shared/tasks'
import type { FleetEntry } from '../../lib/daemon'
import { QuotaDecide } from './Decide'
import type { ReassignChoice } from './Reassign'

const fleet = [
  { worker: { id: 'second', label: 'ClaudeSecond', adapterId: 'claude-code', enabled: true, role: 'worker' } },
  { worker: { id: 'first', label: 'ClaudeFirst', adapterId: 'claude-code', enabled: true, role: 'worker' } }
] as FleetEntry[]

function task(reassignWorkerId?: string | null): Task {
  return {
    id: 'task', status: 'running', assignee: 'second', constraints: { workerId: 'second' },
    quotaOverrideUntil: null, holdReason: null,
    quotaPreemptWarning: {
      trigger: 'window', reason: '92% of 5h window used', preemptAt: Date.now() + 60_000,
      resumeAt: Date.now() + 3_600_000, action: 'handoff', canCompact: true,
      reassignWorkerId
    }
  } as Task
}

const choice = (changed = false): ReassignChoice => ({ changed } as ReassignChoice)

function handoffButton(markup: string): string {
  return markup.match(/<button[^>]*>Hand off &amp; reassign<\/button>/)?.[0] ?? ''
}

describe('quota handoff destination', () => {
  const render = (destination?: string | null) => renderToStaticMarkup(
    <QuotaDecide task={task(destination)} fleet={fleet} modelOptions={[]} now={Date.now()}
      choice={choice()} onRefresh={async () => {}} />
  )

  const pauseButton = (markup: string): string =>
    markup.match(/<button[^>]*>Hand off &amp; pause<\/button>/)?.[0] ?? ''

  it('asks for a destination without drawing Hand off & reassign as a dead button', () => {
    const markup = render()
    expect(markup).toContain('Choose destination…')
    expect(handoffButton(markup)).not.toContain('disabled')
    expect(handoffButton(markup)).toContain('aria-pressed="false"')
  })

  it('marks the saved choice as pressed instead of disabling it', () => {
    // No redirect saved: pause is the standing choice, reassign is not.
    const paused = render()
    expect(pauseButton(paused)).toContain('aria-pressed="true"')
    expect(pauseButton(paused)).not.toContain('disabled')
  })

  it('distinguishes a saved Auto redirect from an unset destination', () => {
    const markup = render(null)
    expect(markup).toContain('Auto (scheduler decides)')
    expect(markup).not.toContain('Choose destination…')
    expect(handoffButton(markup)).toContain('aria-pressed="true"')
    expect(handoffButton(markup)).not.toContain('disabled')
    expect(pauseButton(markup)).toContain('aria-pressed="false"')
    expect(pauseButton(markup)).not.toContain('disabled')
  })

  it('shows the named worker when a redirect was saved', () => {
    const markup = render('first')
    expect(markup).toContain('ClaudeFirst (claude-code)')
    expect(handoffButton(markup)).toContain('aria-pressed="true"')
    expect(handoffButton(markup)).not.toContain('disabled')
  })
})

describe('quota hold: reassigning is the composer job', () => {
  const held = (status: Task['status'], holdReason: string | null): Task => ({
    id: 'task', status, assignee: 'second', constraints: { workerId: 'second' },
    quotaOverrideUntil: null, holdReason, quotaPreemptWarning: null
  } as Task)
  const gate = 'ClaudeSecond at 93% of its Claude 5h window (read 16m ago)'
  const render = (t: Task, changed = false) => renderToStaticMarkup(
    <QuotaDecide task={t} fleet={fleet} modelOptions={[]} now={Date.now()}
      choice={choice(changed)} onRefresh={async () => {}} />
  )

  it.each([['held', held('ready', gate)], ['preempted', held('paused_quota', null)]])(
    'a %s task draws no second message box or reassign pickers', (_name, t) => {
      const markup = render(t)
      expect(markup).not.toContain('<textarea')
      expect(markup).not.toContain('aria-label="Reassign worker"')
      expect(markup).toContain('pills below the box')
      expect(markup).not.toContain('data-armed')
    }
  )

  it('keeps the gate override beside the pointer', () => {
    expect(render(held('ready', gate))).toContain('Run now anyway')
  })

  it('says Reassign is ready once the composer pills differ from the pin', () => {
    const markup = render(held('ready', gate), true)
    expect(markup).toContain('data-armed="true"')
    expect(markup).toContain('Reassign is ready')
  })
})
