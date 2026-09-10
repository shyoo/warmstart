import type { Task } from '@shared/tasks'
import { appKey } from './storagekeys'

/**
 * Quota alerts the operator has read and told to stop interrupting.
 *
 * ⛔ **Dismissing is not overriding, and it must not be read as one.** `task.overrideQuota` spends
 * the operator's caution — it buys the task a dispatch past this fleet's own high-water mark. This
 * buys nothing at all: the task stays exactly as gated as it was, the Tasks list still shows it, the
 * thread still carries its Quota Gate card, and the fleet will still release it by itself when the
 * window resets. The only thing that changes is that the Attention bar stops putting it in front of
 * somebody who has already decided to wait.
 *
 * ⚠️ **It has to survive a restart, because that is the complaint** (t288, 2026-09-07): a task
 * parked on a five-hour window is parked for hours, and closing the app and reopening it brought the
 * same banner back with the same 2h57m on it. A dismissal held in component state would have been
 * silently useless for the one case that motivated it.
 *
 * ⛔ `localStorage`, on the precedent `prefs.ts` and the sidebar width set, and for the same reason:
 * *I have seen this one* is a fact about the person sitting here, not about the work. In the daemon
 * it would be fleet state — one operator's dismissal hiding the alert on somebody else's screen —
 * and it would need a migration, an RPC and a field on `Task` to express something no scheduling
 * code will ever read.
 *
 * ⚠️ Every access is guarded. `localStorage` throws rather than returning null in real
 * configurations, and a silenced banner is never worth a blank screen.
 */

const KEY = appKey('dismissedQuotaAlerts')

/** taskId → the gate state that was dismissed. */
export type QuotaAlertDismissals = Record<string, string>

/**
 * The gate state a dismissal is scoped to.
 *
 * ⛔ **Coarse on purpose, and `holdReason` is deliberately not in it.** That string carries a live
 * percentage — *at 91% of its 5h window* — and the quota poller rewrites it on every reading. A
 * signature that included it would re-raise the banner every few minutes, which is the bug this is
 * fixing wearing a different hat. The same goes for `quotaPreemptWarning.reason`, which the daemon
 * documents as changing without buying another minute; `preemptAt` is the part that means something
 * new has happened.
 *
 * ⚠️ What *does* re-raise it: the task moving between gated statuses (held → preempted → warned), a
 * fresh preemption deadline, and a new park — `notBefore` is written once when the task is parked,
 * to the reset of the window that parked it, so the next window is a different signature and gets
 * its own interruption.
 */
export function quotaAlertSignature(
  task: Pick<Task, 'status' | 'notBefore' | 'quotaPreemptWarning'>
): string {
  return [task.status, task.notBefore ?? '', task.quotaPreemptWarning?.preemptAt ?? ''].join(':')
}

export function isQuotaAlertDismissed(
  task: Pick<Task, 'id' | 'status' | 'notBefore' | 'quotaPreemptWarning'>,
  dismissals: QuotaAlertDismissals
): boolean {
  return dismissals[task.id] === quotaAlertSignature(task)
}

/** The dismissals plus this one. Pure — the caller decides when to persist. */
export function withQuotaAlertDismissed(
  dismissals: QuotaAlertDismissals,
  task: Pick<Task, 'id' | 'status' | 'notBefore' | 'quotaPreemptWarning'>
): QuotaAlertDismissals {
  return { ...dismissals, [task.id]: quotaAlertSignature(task) }
}

/**
 * The dismissals that still describe something.
 *
 * ⛔ **An entry for a task that is no longer gated is dropped, not kept.** A task released by its
 * window reset, finished, or cancelled has had its say; keeping the row would mean the *next* time
 * that task hits a quota wall it would be silenced by a decision made about a different wall. It
 * also stops this key growing without bound over the life of a fleet.
 */
export function prunedQuotaAlerts(
  dismissals: QuotaAlertDismissals,
  gated: Array<Pick<Task, 'id'>>
): QuotaAlertDismissals {
  const live = new Set(gated.map((t) => t.id))
  const kept: QuotaAlertDismissals = {}
  for (const [id, signature] of Object.entries(dismissals)) {
    if (live.has(id)) kept[id] = signature
  }
  return kept
}

export function readQuotaAlertDismissals(): QuotaAlertDismissals {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return {}
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: QuotaAlertDismissals = {}
    // ⚠️ Entries that are not strings are dropped rather than the whole preference being thrown
    // away: one bad row must not un-silence every other alert somebody had dealt with.
    for (const [id, signature] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof signature === 'string') out[id] = signature
    }
    return out
  } catch {
    return {}
  }
}

export function writeQuotaAlertDismissals(dismissals: QuotaAlertDismissals): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    window.localStorage.setItem(KEY, JSON.stringify(dismissals))
  } catch {
    // A preference that cannot be saved is not an error worth showing anybody.
  }
}
