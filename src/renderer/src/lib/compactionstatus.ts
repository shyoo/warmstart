import type { Compaction } from '@shared/tasks'

/**
 * Which unlanded asks a later compaction on the same session already answered.
 *
 * ⛔ **Asked-for order, by session.** t446: preemption asked at 17:14:37, the agent answered with
 * prose instead of compacting, and the clock asked again at 17:18:37 — which landed at 17:21:31.
 * The first ask never landed and never will, but "failed" alone reads as though the session was
 * never compacted. An ask a newer landed sibling supersedes says so, by id, so the row can say
 * *superseded* instead. Pure and in `lib/` so it is pinned without a DOM.
 */
export function supersededAskIds(compactions: Compaction[]): Set<number> {
  const at = (c: Compaction): number => c.askedAt ?? c.ts
  const out = new Set<number>()
  for (const c of compactions) {
    if (c.landedAt !== null) continue
    if (
      compactions.some(
        (o) =>
          o.id !== c.id &&
          o.sessionId === c.sessionId &&
          o.landedAt !== null &&
          at(o) > at(c)
      )
    ) {
      out.add(c.id)
    }
  }
  return out
}
