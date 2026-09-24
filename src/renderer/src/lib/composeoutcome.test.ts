import { describe, expect, it } from 'vitest'
import { outcomeHintStale } from './composeoutcome.js'

describe('outcomeHintStale', () => {
  it('is not stale before anything was recorded', () => {
    expect(outcomeHintStale('running', null)).toBe(false)
  })

  it('is not stale while the task still sits on the status the hint was recorded at', () => {
    expect(outcomeHintStale('ready', 'ready')).toBe(false)
  })

  // t673: a requeued send parks the task at whatever resting status it was at ("Queued — same
  // thread…"), then a later scheduler tick moves it to running — the exact transition the old code
  // never watched for, leaving the hint claiming "queued" over a task that was plainly running.
  it('goes stale once a requeued task starts running', () => {
    expect(outcomeHintStale('running', 'ready')).toBe(true)
  })

  it('goes stale once a delivered task finishes its run', () => {
    expect(outcomeHintStale('awaiting_human', 'running')).toBe(true)
  })
})
