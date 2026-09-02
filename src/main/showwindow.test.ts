import { describe, expect, it, vi } from 'vitest'
import { showWhenItCan, type Showable } from './showwindow.js'

/**
 * The bug this guards: a window shown only from `ready-to-show`, on a compositor that never paints
 * an unshown window, is an app you cannot see. Measured on Windows 11 / Electron 44 — see the
 * module doc. None of that is reproducible in a unit test, and none of it needs to be: what is
 * testable, and what actually broke, is that **no single event is load-bearing**.
 */
interface Fake {
  win: Showable
  readyToShow: () => void
  didFinishLoad: () => void
  didFailLoad: (isMainFrame: boolean) => void
  shown: () => number
}

function fake(): Fake {
  const ready: (() => void)[] = []
  const load: (() => void)[] = []
  const fail: ((isMainFrame: boolean) => void)[] = []
  let shows = 0
  const win: Showable = {
    show: () => {
      shows += 1
    },
    isDestroyed: () => false,
    onReadyToShow: (fn) => void ready.push(fn),
    onDidFinishLoad: (fn) => void load.push(fn),
    onDidFailLoad: (fn) => void fail.push(fn),
    onClosed: () => {}
  }
  return {
    win,
    readyToShow: () => ready.forEach((fn) => fn()),
    didFinishLoad: () => load.forEach((fn) => fn()),
    didFailLoad: (isMainFrame) => fail.forEach((fn) => fn(isMainFrame)),
    shown: () => shows
  }
}

describe('a window that has to reach the screen', () => {
  it('shows on ready-to-show, which is the ordinary path', () => {
    const f = fake()
    showWhenItCan(f.win)
    expect(f.shown()).toBe(0)
    f.readyToShow()
    expect(f.shown()).toBe(1)
  })

  it('shows on did-finish-load when ready-to-show never comes', () => {
    // ⛔ This is the measured failure, not a hypothetical: `did-finish-load` at 72ms and
    // `ready-to-show` never, on the GPU path this machine uses by default.
    const f = fake()
    showWhenItCan(f.win)
    f.didFinishLoad()
    expect(f.shown()).toBe(1)
  })

  it('shows once, not twice, when both events arrive', () => {
    const f = fake()
    showWhenItCan(f.win)
    f.didFinishLoad()
    f.readyToShow()
    expect(f.shown()).toBe(1)
  })

  it('shows when the main frame fails to load, so the error is visible', () => {
    const f = fake()
    showWhenItCan(f.win)
    f.didFailLoad(true)
    expect(f.shown()).toBe(1)
  })

  it('ignores a subframe that failed — a broken image is not a reason to show early', () => {
    const f = fake()
    showWhenItCan(f.win)
    f.didFailLoad(false)
    expect(f.shown()).toBe(0)
    f.readyToShow()
    expect(f.shown()).toBe(1)
  })

  it('shows on the timer when the load neither finishes nor fails', () => {
    vi.useFakeTimers()
    try {
      const f = fake()
      showWhenItCan(f.win, 5_000)
      vi.advanceTimersByTime(4_999)
      expect(f.shown()).toBe(0)
      vi.advanceTimersByTime(1)
      expect(f.shown()).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not fire the timer once the window is up', () => {
    vi.useFakeTimers()
    try {
      const f = fake()
      showWhenItCan(f.win, 5_000)
      f.readyToShow()
      vi.advanceTimersByTime(60_000)
      expect(f.shown()).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not touch a window that was closed before anything painted', () => {
    vi.useFakeTimers()
    try {
      const handlers: (() => void)[] = []
      let shows = 0
      let destroyed = false
      const win: Showable = {
        show: () => {
          shows += 1
        },
        isDestroyed: () => destroyed,
        onReadyToShow: (fn) => handlers.push(fn),
        onDidFinishLoad: () => {},
        onDidFailLoad: () => {},
        onClosed: () => {}
      }
      showWhenItCan(win, 5_000)
      destroyed = true
      for (const fn of handlers) fn()
      vi.advanceTimersByTime(60_000)
      expect(shows).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
