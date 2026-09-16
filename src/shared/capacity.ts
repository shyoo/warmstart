/**
 * What an account's parallelism limit says, in the one wording every side of it uses.
 *
 * ⛔ **"at capacity" on its own answered none of the three questions it raises** — what is full,
 * what would empty it, and what it costs to make it bigger. It read as a fact about the provider
 * rather than as a setting somebody chose (t22, 2026-08-29 made the neighbouring point about *where*
 * it is shown). The limit is called **Max parallel instances** in Workers, raising it dispatches the
 * held task on the next scheduler tick with nothing else to press, and the cost of raising it is
 * real — so the sentence names all three.
 *
 * ⚠️ Shared rather than written twice: the scheduler's hold reason and the spawn refusal are read by
 * the same person, minutes apart, about the same number. The long form of the tradeoff belongs
 * beside the control itself (`MAX_HELP` in `Workers.tsx`), which is where somebody about to change
 * the number is looking; here it stays to one clause each, because this lands on a task row.
 */

/** `1 of 1 parallel instances` — the count, with the noun agreeing with the limit. */
export function parallelUse(inUse: number, maxConcurrent: number): string {
  return `${inUse} of ${maxConcurrent} parallel ${maxConcurrent === 1 ? 'instance' : 'instances'}`
}

/** What running more at once costs. One clause each; `MAX_HELP` carries the full version. */
export const PARALLEL_TRADEOFF =
  'running more at once spends quota faster, makes the quota reading less reliable, and reuses warm sessions less often'

/**
 * The hold an operator reads when an account has no slot left for a task.
 *
 * ⛔ The prefix `<label> at capacity` is load-bearing: the scheduler's own suites match hold reasons
 * on it, and so does anything reading a row back. Extend the sentence, never the opening.
 */
export function capacityHoldReason(label: string, inUse: number, maxConcurrent: number): string {
  return (
    `${label} at capacity — ${parallelUse(inUse, maxConcurrent)} in use. ` +
    `Raise Max parallel instances for ${label} in Workers and this starts on the next tick; ` +
    `${PARALLEL_TRADEOFF}.`
  )
}

/**
 * The same limit refusing a spawn that was asked for directly, where there is no tick to wait for.
 *
 * ⚠️ A thrown error, not a hold: the caller asked for a process right now and is not getting one.
 * It says what to change for the same reason the hold does.
 */
export function capacitySpawnError(label: string, inUse: number, maxConcurrent: number): string {
  return (
    `worker '${label}' is at its concurrency limit (${parallelUse(inUse, maxConcurrent)} in use). ` +
    `Raise Max parallel instances for ${label} in Workers to run another alongside; ` +
    `${PARALLEL_TRADEOFF}.`
  )
}
