import type { QuitConfirmationRequest } from '@shared/ipc.js'

/** Only the window asked can answer; lost renderers dismiss rather than authorize a shutdown. */
export class QuitConfirmation {
  private readyOwners = new Set<number>()
  private sequence = 0
  private pending: { owner: number; request: QuitConfirmationRequest; send: () => void; resolve: (choice: number) => void } | null = null

  ready(owner: number): void {
    if (this.readyOwners.has(owner)) return
    this.readyOwners.add(owner)
    if (this.pending?.owner === owner) this.pending.send()
  }
  ask(owner: number, working: number, send: (request: QuitConfirmationRequest) => void): Promise<number> {
    if (this.pending) return Promise.resolve(0)
    return new Promise((resolve) => {
      const request: QuitConfirmationRequest = {
        id: ++this.sequence,
        options: {
          title: `${working} agent ${working === 1 ? 'session is' : 'sessions are'} still running.`,
          message: 'Quitting stops orchestratord, which ends them. Their work so far is saved, but the ' +
            'context each one is holding is not — a stopped session starts cold next time.\n\n' +
            'Leave them running to quit the window only. Turn the tray on if you want that to be the normal behaviour.',
          actions: [{ label: 'Cancel' }, { label: 'Leave them running' }, { label: 'Stop them and quit', danger: true }]
        }
      }
      this.pending = { owner, request, send: () => send(request), resolve }
      if (this.readyOwners.has(owner)) this.pending.send()
    })
  }
  answer(owner: number, id: unknown, choice: unknown): boolean {
    const pending = this.pending
    if (!pending || pending.owner !== owner || pending.request.id !== id ||
      typeof choice !== 'number' || !Number.isInteger(choice) || choice < 0 || choice > 2) return false
    this.pending = null
    pending.resolve(choice)
    return true
  }
  forget(owner: number): void {
    this.readyOwners.delete(owner)
    if (this.pending?.owner === owner) this.answer(owner, this.pending.request.id, 0)
  }
}
