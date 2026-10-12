import type { ConfirmationOptions } from '@shared/ipc'

export interface PendingConfirmation {
  options: ConfirmationOptions
  answer: (choice: number) => void
}

/** Each caller waits for its own click; queued requests cannot overwrite one another. */
export class ConfirmationQueue {
  private pending: PendingConfirmation[] = []
  private listeners = new Set<() => void>()
  snapshot = (): PendingConfirmation | null => this.pending[0] ?? null
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private changed(): void { this.listeners.forEach((listener) => listener()) }
  ask(options: ConfirmationOptions): Promise<number> {
    return new Promise((resolve) => {
      const request: PendingConfirmation = {
        options,
        answer: (choice) => {
          if (this.snapshot() !== request || !Number.isInteger(choice) || !options.actions[choice]) return
          this.pending.shift()
          this.changed()
          resolve(choice)
        }
      }
      this.pending.push(request)
      this.changed()
    })
  }
}

export const confirmations = new ConfirmationQueue()
export const chooseConfirmation = (options: ConfirmationOptions): Promise<number> => confirmations.ask(options)

/** Index zero is always the safe dismissal. No action runs before an affirmative click. */
export async function confirmAction(message: string, action = 'Continue', danger = true): Promise<boolean> {
  return (await chooseConfirmation({ title: `${action}?`, message, actions: [{ label: 'Cancel' }, { label: action, danger }] })) === 1
}
