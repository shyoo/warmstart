import { useEffect, useRef, useState } from 'react'

/**
 * Whether an element has scrolled *above* the top of its scroll container — not merely out of view.
 *
 * ⛔ Above, not "not visible". A box below the fold has not been read yet, and a peek that stands in
 * for something the person has not seen would be announcing facts they have no row to check against.
 * The peek exists for the case where the row *was* at the top of the page and the thread pushed it
 * off; that is the only case this answers `true` for.
 *
 * ⛔ **Measured on every scroll, not an `IntersectionObserver`.** The first version observed the
 * box and answered from the *transition*: not intersecting, and below the root's top. A box that
 * starts below the fold and is scrolled past in one jump — End, a `scrollTo`, a long wheel flick —
 * goes from not-intersecting to not-intersecting, crosses no threshold, and is never reported; the
 * timeline box did exactly that on the L3 harness (2026-09-16), so the peek named the task and
 * never the run. Geometry read on the scroll event has no transition to miss.
 *
 * ⚠️ **And re-measured after every render of the caller**, because a box moves without anybody
 * scrolling: the thread grows under a running agent, a disclosure opens, the window is resized. The
 * scroll event is what makes the answer immediate; the render is what makes it *eventually right*
 * with nothing to listen for — the task page renders once a second on `useNow`, so the peek is never
 * more than a tick stale. Two `getBoundingClientRect` calls a second is what that costs. It is also
 * what lets the L3 harness see the peek at all: a hidden window is not reliably handed its scroll
 * events (`test/ui.test.mjs`, 2026-09-16), and a hook that only listened stayed silent there.
 *
 * ⚠️ Takes the element, not a ref, because the box it watches is rendered conditionally — the
 * timeline box exists only once there is a run — and a ref's `.current` changing does not re-run an
 * effect. Pass a `useState` setter as the `ref` callback and this re-measures when the node arrives.
 *
 * ⚠️ The root is the nearest `.content`, which is the one scroll container a task page lives in
 * (`app.css`). With no such ancestor — a test rendering the component bare — the window stands in.
 */
export function useScrolledPast(el: HTMLElement | null): boolean {
  const [past, setPast] = useState(false)
  const remeasure = useRef<() => void>(() => undefined)
  useEffect(() => {
    if (!el) {
      remeasure.current = () => undefined
      setPast(false)
      return
    }
    const root = el.closest('.content')
    const scroller = root instanceof HTMLElement ? root : null
    const measure = (): void => {
      setPast(
        scrolledPast(el.getBoundingClientRect().bottom, scroller ? scroller.getBoundingClientRect().top : 0)
      )
    }
    remeasure.current = measure
    measure()
    const target: EventTarget = scroller ?? window
    target.addEventListener('scroll', measure, { passive: true })
    window.addEventListener('resize', measure)
    return () => {
      target.removeEventListener('scroll', measure)
      window.removeEventListener('resize', measure)
    }
  }, [el])
  // No dependency list, on purpose: after every render. `setPast` with the value it already holds
  // is a bail-out, not a re-render, so this cannot loop.
  useEffect(() => {
    remeasure.current()
  })
  return past
}

/**
 * The decision, on its own so a suite can reach it: the box's bottom edge is at or above the top
 * edge of what the scroll container shows, so no part of it is drawn and it went out upwards.
 */
export function scrolledPast(elementBottom: number, rootTop: number): boolean {
  return elementBottom <= rootTop
}
