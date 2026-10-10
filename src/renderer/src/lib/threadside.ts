import { appKey } from './storagekeys'

/**
 * Which pane the thread draws beside the conversation (t1011): the status ledger, the project's
 * scratchpad, or neither.
 *
 * ⛔ **One pane at a time.** The two share one column, so opening the scratchpad takes the ledger's
 * place rather than squeezing in beside it — the operator's choice, and the reason this is one value
 * and not two switches that could both be on.
 *
 * ⚠️ `localStorage`, guarded, on the precedent `prefs.ts` sets: which pane somebody wants beside a
 * thread is a property of the person sitting here, and it should survive opening another task.
 */
export type ThreadSide = 'status' | 'scratchpad' | 'none'

const KEY = appKey('threadSide')

const SIDES: readonly ThreadSide[] = ['status', 'scratchpad', 'none']

/** The status ledger is the default: it is what the thread has always had on the right. */
export function readThreadSide(): ThreadSide {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return 'status'
    const raw = window.localStorage.getItem(KEY)
    return SIDES.find((side) => side === raw) ?? 'status'
  } catch {
    return 'status'
  }
}

export function writeThreadSide(side: ThreadSide): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    window.localStorage.setItem(KEY, side)
  } catch {
    // A preference that cannot be saved is not an error worth showing anybody.
  }
}

/**
 * The pane to draw. ⚠️ A stored `scratchpad` where this thread has none to offer (a task that belongs
 * to no project) reads as the ledger, not as an empty column — the stored choice is left alone.
 */
export function effectiveSide(stored: ThreadSide, hasScratchpad: boolean): ThreadSide {
  return stored === 'scratchpad' && !hasScratchpad ? 'status' : stored
}

/**
 * What a click on one of the two buttons does: it closes its own pane when that is the one showing,
 * and otherwise swaps to it — so the two buttons are a radio pair that can also be turned all the way off.
 */
export function toggleSide(current: ThreadSide, clicked: 'status' | 'scratchpad'): ThreadSide {
  return current === clicked ? 'none' : clicked
}
