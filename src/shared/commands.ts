/**
 * The composer's slash commands (t704).
 *
 * ⛔ **A command is structure captured at compose time, never parsed back out of stored text.** A
 * person's own typed message is never reinterpreted (`docs/ui.md`), so the composer turns `/delegate`
 * into a chip while the person types, sends the command as its own field, and the thread draws the
 * chip from the message's `event`. The text stored is what they typed after the command.
 *
 * ⚠️ A registry of one, on purpose: the next command is a row here and a wrapper in the daemon's
 * prompt, not a new parser.
 */
export type ThreadCommandId = 'delegate'

export interface ThreadCommand {
  id: ThreadCommandId
  /** What is typed, including the slash. */
  slash: string
  /** The chip's label. */
  label: string
  /** One line for the command menu and the chip's hover. */
  detail: string
  /** The message event a message sent with this command is stored under. */
  event: 'command.delegate'
}

export const THREAD_COMMANDS: readonly ThreadCommand[] = [
  {
    id: 'delegate',
    slash: '/delegate',
    label: 'Delegate',
    detail: 'Ask the agent to hand what follows to other agents rather than doing it itself',
    event: 'command.delegate'
  }
]

export function commandById(id: string | null | undefined): ThreadCommand | null {
  return THREAD_COMMANDS.find((c) => c.id === id) ?? null
}

export function commandForEvent(event: string | null | undefined): ThreadCommand | null {
  return THREAD_COMMANDS.find((c) => c.event === event) ?? null
}

/**
 * The command a composer's text has just become, if any: `/delegate` followed by a space (or the
 * whole command alone, when it is picked from the menu) at the very start of the box.
 *
 * ⚠️ Only at the start, and only once the command word is finished — `/delegates` or a path such as
 * `/usr/bin` is text, and a slash in the middle of a sentence is punctuation.
 */
export function leadingCommand(text: string): { command: ThreadCommand; rest: string } | null {
  for (const command of THREAD_COMMANDS) {
    if (text.toLowerCase().startsWith(`${command.slash} `)) {
      return { command, rest: text.slice(command.slash.length + 1) }
    }
  }
  return null
}

/** The commands a partly typed `/…` at the start of an otherwise empty box could still become. */
export function commandMatches(text: string): ThreadCommand[] {
  if (!text.startsWith('/') || /\s/.test(text)) return []
  const typed = text.toLowerCase()
  return THREAD_COMMANDS.filter((c) => c.slash.startsWith(typed))
}
