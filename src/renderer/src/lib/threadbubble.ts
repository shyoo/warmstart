import type { MessageRole, TaskMessage } from '@shared/tasks'

/** Which edge a chat entry occupies. Kept pure so the thread's reading order stays testable. */
export function bubbleSide(role: MessageRole): 'left' | 'right' {
  return role === 'human' ? 'right' : 'left'
}

/** The prompt belongs with the answer it produced, falling back to its system dispatch entry. */
export function promptMessageId(messages: TaskMessage[], runId: string): number | null {
  const forRun = messages.filter((m) => m.runId === runId)
  return forRun.filter((m) => m.role === 'agent').at(-1)?.id ??
    forRun.find((m) => m.role === 'system')?.id ?? null
}

export type ThreadItem =
  | { kind: 'message'; message: TaskMessage }
  | {
      kind: 'activity'
      id: string
      lines: Array<{ text: string; ts: number }>
      isLiveTail: boolean
    }

/**
 * Interleaves durable thread messages with in-progress agent thinking activity.
 *
 * ⛔ **A consecutive activity blob must break around human responses.** When an agent is
 * actively thinking/streaming lines and the user responds mid-flight, putting the user's
 * message above the entire activity blob makes earlier lines appear to have happened *after*
 * the user's reply.
 *
 * This function preserves the causal order:
 * 1. Activity lines that arrived before a message are grouped and placed before that message.
 * 2. The message is placed next (e.g. human prompt).
 * 3. Activity lines arriving after that message continue in subsequent chunks or the live tail.
 */
export function buildThreadItems(
  messages: TaskMessage[],
  activity: Array<{ text: string; ts: number }>,
  showLive: boolean
): ThreadItem[] {
  if (!showLive) {
    return messages.map((m) => ({ kind: 'message', message: m }))
  }

  if (activity.length === 0) {
    const items: ThreadItem[] = messages.map((m) => ({ kind: 'message', message: m }))
    items.push({ kind: 'activity', id: 'activity-live-tail', lines: [], isLiveTail: true })
    return items
  }

  const items: ThreadItem[] = []
  let activityIdx = 0
  let chunkIdx = 0

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (!m) continue
    // ⛔ Do not emit activity before the first message of the thread — a task cannot have
    // activity before its opening prompt. For subsequent messages, emit any activity that
    // arrived before or at the message timestamp.
    if (i > 0) {
      const chunkLines: Array<{ text: string; ts: number }> = []
      while (activityIdx < activity.length) {
        const line = activity[activityIdx]
        if (!line || line.ts > m.ts) break
        chunkLines.push(line)
        activityIdx++
      }
      if (chunkLines.length > 0) {
        items.push({
          kind: 'activity',
          id: `activity-chunk-${chunkIdx++}`,
          lines: chunkLines,
          isLiveTail: false
        })
      }
    }
    items.push({ kind: 'message', message: m })
  }

  // Any activity arriving after the last message forms the live tail
  const remainingLines = activity.slice(activityIdx)
  items.push({
    kind: 'activity',
    id: `activity-live-${chunkIdx}`,
    lines: remainingLines,
    isLiveTail: true
  })

  return items
}
