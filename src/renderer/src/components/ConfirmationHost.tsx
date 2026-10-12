import { useEffect, useId, useRef, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { chooseConfirmation, confirmations, type PendingConfirmation } from '../lib/confirmation'

function ConfirmationDialog({ request }: { request: PendingConfirmation }): React.JSX.Element {
  const dialog = useRef<HTMLDivElement>(null)
  const title = useId()
  const copy = useId()
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const root = document.getElementById('root')
    const wasInert = root?.inert ?? false
    if (root) root.inert = true
    dialog.current?.querySelector('button')?.focus()
    const onKey = (event: KeyboardEvent): void => {
      // Capture Escape before menus or an underlying composer can interpret it too.
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        request.answer(0)
      } else if (event.key === 'Tab') {
        const buttons = [...(dialog.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const next = (current + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length
        event.preventDefault()
        buttons[next]?.focus()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      if (root) root.inert = wasInert
      if (previous?.isConnected) previous.focus()
    }
  }, [request])
  return createPortal(
    <div className="confirm-shade confirmation-shade" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) request.answer(0)
    }}>
      <div ref={dialog} className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby={title} aria-describedby={copy}>
        <h3 id={title}>{request.options.title}</h3>
        <p id={copy} style={{ whiteSpace: 'pre-wrap' }}>{request.options.message}</p>
        <div className="confirm-actions">
          {request.options.actions.map((action, index) => (
            <button key={index} type="button" className={`btn${action.danger ? ' btn--danger' : ''}`} onClick={() => request.answer(index)}>
              {action.label}
            </button>
          ))}
        </div>
      </div>
    </div>, document.body
  )
}

/** Window-owned, so sidebar menus can disappear while their confirmation stays open. */
export function ConfirmationHost(): React.JSX.Element | null {
  const request = useSyncExternalStore(confirmations.subscribe, confirmations.snapshot)
  useEffect(() => window.agentyard.onQuitConfirmation((quit) => {
    void chooseConfirmation(quit.options).then((choice) => window.agentyard.answerQuitConfirmation(quit.id, choice))
  }), [])
  return request ? <ConfirmationDialog request={request} /> : null
}
