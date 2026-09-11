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
