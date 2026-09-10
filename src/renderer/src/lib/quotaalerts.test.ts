import { afterEach, describe, expect, it } from 'vitest'
import type { Task } from '@shared/tasks'
import {
  isQuotaAlertDismissed,
  prunedQuotaAlerts,
  quotaAlertSignature,
  readQuotaAlertDismissals,
  withQuotaAlertDismissed,
  writeQuotaAlertDismissals
} from './quotaalerts.js'

const KEY = 'warmstart.dismissedQuotaAlerts'

type Gated = Pick<Task, 'id' | 'status' | 'notBefore' | 'quotaPreemptWarning'>

/** A task parked on its window, as `paused_quota` writes it: `not_before` = the reset. */
function parked(over: Partial<Gated> = {}): Gated {
  return {
    id: 't286',
    status: 'paused_quota',
    notBefore: 1_788_000_000_000,
    quotaPreemptWarning: null,
    ...over
  }
}

const stub = (store: Record<string, string> | null, throws = false): void => {
  const storage = {
    getItem: (k: string) => {
      if (throws) throw new Error('site data disabled')
      return store?.[k] ?? null
    },
    setItem: (k: string, v: string) => {
      if (throws) throw new Error('site data disabled')
      if (store) store[k] = v
    }
  }
  ;(globalThis as { window?: unknown }).window = { localStorage: store === null ? null : storage }
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window
})

/**
 * ⛔ The point of the whole file: a five-hour park outlives the window it was dismissed in. t288
 * reported closing the app and reopening it to the same banner with the same clock on it, so a
 * dismissal that did not survive a restart would have been no answer at all.
 */
describe('a dismissal outlives the app', () => {
  it('is still dismissed after everything in memory is gone', () => {
    const store: Record<string, string> = {}
    stub(store)
    const task = parked()

    writeQuotaAlertDismissals(withQuotaAlertDismissed(readQuotaAlertDismissals(), task))
    expect(store[KEY]).toBeDefined()

    // A fresh renderer: nothing but the stored bytes.
    stub(store)
    expect(isQuotaAlertDismissed(task, readQuotaAlertDismissals())).toBe(true)
  })

  it('silences that task and no other', () => {
    const dismissals = withQuotaAlertDismissed({}, parked())
    expect(isQuotaAlertDismissed(parked(), dismissals)).toBe(true)
    expect(isQuotaAlertDismissed(parked({ id: 't287' }), dismissals)).toBe(false)
  })
})

describe('what a dismissal is scoped to', () => {
  /**
   * ⛔ The regression this signature exists to prevent. `holdReason` carries a live percentage and
   * the quota poller rewrites it every reading — keyed on that, a dismissal would last minutes.
   */
  it('ignores the churn a quota reading writes', () => {
    const before = { ...parked(), holdReason: 'at 61% of its 5h window' } as Gated
    const after = { ...parked(), holdReason: 'at 91% of its 5h window' } as Gated
    expect(quotaAlertSignature(after)).toBe(quotaAlertSignature(before))
    expect(isQuotaAlertDismissed(after, withQuotaAlertDismissed({}, before))).toBe(true)
  })

  it('does not carry over to the next window', () => {
    // `not_before` is written once, to the reset of the window that parked the task. A later park
    // is a different wall and deserves its own interruption.
    const first = parked()
    const second = parked({ notBefore: 1_788_018_000_000 })
    expect(isQuotaAlertDismissed(second, withQuotaAlertDismissed({}, first))).toBe(false)
  })

  it('does not carry over when the task moves to a different kind of gate', () => {
    const held = parked({ status: 'ready', notBefore: null })
    const dismissals = withQuotaAlertDismissed({}, held)
    expect(isQuotaAlertDismissed(held, dismissals)).toBe(true)
    // It got dispatched and is now being warned that it will be preempted — new information.
    const warned = parked({
      status: 'running',
      notBefore: null,
      quotaPreemptWarning: {
        trigger: 'window',
        reason: '91% of 5h window used',
        preemptAt: 1_788_000_060_000,
        resumeAt: 1_788_018_000_000
      }
    })
    expect(isQuotaAlertDismissed(warned, dismissals)).toBe(false)
  })

  it('raises a second preemption warning even at the same status', () => {
    const warning = (preemptAt: number): Gated =>
      parked({
        status: 'running',
        notBefore: null,
        quotaPreemptWarning: {
          trigger: 'window',
          reason: 'a reason that will be rewritten',
          preemptAt,
          resumeAt: 1_788_018_000_000
        }
      })
    const dismissals = withQuotaAlertDismissed({}, warning(1_788_000_060_000))
    expect(isQuotaAlertDismissed(warning(1_788_000_060_000), dismissals)).toBe(true)
    expect(isQuotaAlertDismissed(warning(1_788_003_600_000), dismissals)).toBe(false)
  })
})

describe('dismissals are pruned to what is still gated', () => {
  it('forgets a task whose window has released it', () => {
    const dismissals = { t286: 'paused_quota:1788000000000:', t287: 'ready::' }
    expect(prunedQuotaAlerts(dismissals, [{ id: 't287' }])).toEqual({ t287: 'ready::' })
  })

  it('so the next wall that task hits interrupts again', () => {
    const task = parked()
    const kept = prunedQuotaAlerts(withQuotaAlertDismissed({}, task), [])
    expect(isQuotaAlertDismissed(task, kept)).toBe(false)
  })

  it('keeps everything when everything is still gated', () => {
    const dismissals = withQuotaAlertDismissed(withQuotaAlertDismissed({}, parked()), parked({ id: 't290' }))
    expect(prunedQuotaAlerts(dismissals, [{ id: 't286' }, { id: 't290' }])).toEqual(dismissals)
  })
})

describe('the store is never worth a blank screen', () => {
  it('reads nothing out of an empty profile', () => {
    stub({})
    expect(readQuotaAlertDismissals()).toEqual({})
  })

  it('drops the rows it cannot read rather than the whole preference', () => {
    // ⛔ One bad row must not un-silence every alert somebody had already dealt with.
    stub({ [KEY]: JSON.stringify({ t286: 'paused_quota::', t287: 42, t288: null }) })
    expect(readQuotaAlertDismissals()).toEqual({ t286: 'paused_quota::' })
  })

  it('reads a non-object, a corrupt value and an array as nothing', () => {
    stub({ [KEY]: '["t286"]' })
    expect(readQuotaAlertDismissals()).toEqual({})
    stub({ [KEY]: 'not json at all' })
    expect(readQuotaAlertDismissals()).toEqual({})
    stub({ [KEY]: '"t286"' })
    expect(readQuotaAlertDismissals()).toEqual({})
  })

  it('survives a localStorage that throws, in both directions', () => {
    stub({}, true)
    expect(readQuotaAlertDismissals()).toEqual({})
    expect(() => writeQuotaAlertDismissals({ t286: 'paused_quota::' })).not.toThrow()
  })

  it('and a renderer with no window at all', () => {
    expect(readQuotaAlertDismissals()).toEqual({})
    expect(() => writeQuotaAlertDismissals({ t286: 'paused_quota::' })).not.toThrow()
  })
})
