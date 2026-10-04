import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Task } from '@shared/tasks'
import type { FleetEntry } from '../../lib/daemon'
import { QuotaDecide } from './Decide'

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

function handoffButton(markup: string): string {
  return markup.match(/<button[^>]*>Hand off &amp; reassign<\/button>/)?.[0] ?? ''
}

describe('quota handoff destination', () => {
  const render = (destination?: string | null) => renderToStaticMarkup(
    <QuotaDecide task={task(destination)} fleet={fleet} modelOptions={[]} now={Date.now()}
      onRefresh={async () => {}} />
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
