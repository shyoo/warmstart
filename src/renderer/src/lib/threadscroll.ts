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
