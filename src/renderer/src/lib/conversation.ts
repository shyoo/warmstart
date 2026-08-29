import type { Session } from '@shared/protocol'
import type { Run } from '@shared/tasks'

/**
 * Which conversation served a run, as the string somebody would actually type.
 *
 * ⛔ **The vendor's id where the CLI named its own conversation, ours where it took ours.** Claude
 * Code is given a `--session-id` we mint and keeps it; Antigravity names its own and reports it back,
 * and that is the one `--conversation` accepts. So the row is filed under our id and the *usable* id
 * may be a different string — an id that looks right and resumes nothing is worse than showing none.
 *
 * ⚠️ `null` for a run that never got a session. Dispatch can fail while claiming a workspace or
 * running a project's prepare hook, and that run genuinely was not served by any conversation.
 * Drawing a dash with a tooltip there would invite somebody to go looking for it.
 *
 * ⚠️ A session row that has since been removed falls back to the run's own session id, which is what
 * `--session-id` was given — still the right answer, just without the vendor's confirmation of it.
 */
export function conversationIdFor(
  run: Pick<Run, 'sessionId'>,
  sessions: Array<Pick<Session, 'id' | 'vendorSessionId'>>
): string | null {
  if (!run.sessionId) return null
  const session = sessions.find((s) => s.id === run.sessionId)
  return session?.vendorSessionId ?? run.sessionId
}
