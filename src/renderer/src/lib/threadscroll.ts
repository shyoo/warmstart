/**
 * Opening a task lands at the bottom of its thread.
 *
 * The recent conversation sits at the bottom, above the reply box — so a task opened from the
 * board jumps straight there instead of showing the top of a long thread. The decision is one
 * per navigation, not per render: a thread that grows under a running agent must not yank a
 * person who has scrolled up to read, so only a *different* task earns a second jump.
 */
export function shouldJumpToThreadBottom(
  jumpedTaskId: string | null,
  openTaskId: string
): boolean {
  return jumpedTaskId !== openTaskId
}

/**
 * Whether the reader is close enough to the bottom of the thread that arriving content should
 * keep them there — an agent's reply landing while the composer sits under it, exactly like the
 * live tail `SessionStream` pins.
 *
 * ⚠️ Not an exact match. A few pixels of slack survive a `scrollIntoView` and a fractional layout
 * round-trip, and requiring one would drop stickiness on the very frame it was established.
 */
export function isNearThreadBottom(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  threshold = 32
): boolean {
  return scrollHeight - scrollTop - clientHeight < threshold
}
