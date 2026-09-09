import { useCallback, useEffect, useState } from 'react'
import { rpc } from '../api.js'
import { decodeVapidKey, notifyState, subscriptionFields, type NotifyState } from '../lib/notify.js'

/**
 * The one control that makes this app worth installing: being told when something needs you.
 *
 * ⛔ It says what it cannot do rather than offering a button that fails. Over a plain LAN address
 * there is no secure context, so `PushManager` does not exist and no amount of tapping will make
 * a notification arrive — the honest answer is the https:// Tailscale address, and that is what
 * this says. Once notifications are on, it takes up no room at all.
 */
export function Notifications(): React.JSX.Element | null {
  const [state, setState] = useState<NotifyState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const read = useCallback(async (): Promise<void> => {
    const hasServiceWorker = 'serviceWorker' in navigator
    const hasPushManager = 'PushManager' in window
    let subscribed = false
    if (hasServiceWorker && hasPushManager && window.isSecureContext) {
      const registration = await navigator.serviceWorker.ready
      subscribed = (await registration.pushManager.getSubscription()) !== null
    }
    setState(
      notifyState({
        isSecureContext: window.isSecureContext,
        hasServiceWorker,
        hasPushManager,
        permission: hasPushManager ? Notification.permission : 'default',
        subscribed
      })
    )
  }, [])

  useEffect(() => {
    void read()
  }, [read])

  const enable = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      if ((await Notification.requestPermission()) !== 'granted') return void (await read())
      const { publicKey } = await rpc('remote.pushKey', undefined)
      const registration = await navigator.serviceWorker.ready
      const subscription = await registration.pushManager.subscribe({
        // ⛔ Required by every browser that implements this: a subscription that could deliver a
        // silent push would be one this app could use to track the phone, so it is not allowed.
        userVisibleOnly: true,
        applicationServerKey: decodeVapidKey(publicKey)
      })
      await rpc('remote.subscribe', subscriptionFields(subscription))
      await read()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not turn notifications on.')
    } finally {
      setBusy(false)
    }
  }

  const disable = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const registration = await navigator.serviceWorker.ready
      const subscription = await registration.pushManager.getSubscription()
      if (subscription) {
        // ⚠️ Tell the daemon first: a subscription dropped locally but left in the database is one
        // the daemon keeps pushing to until the push service finally answers 410.
        await rpc('remote.unsubscribe', { endpoint: subscription.endpoint })
        await subscription.unsubscribe()
      }
      await read()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not turn notifications off.')
    } finally {
      setBusy(false)
    }
  }

  if (!state) return null

  // Once it is on this is one dim line, because the list underneath is what the screen is for.
  if (state.kind === 'on') {
    return (
      <p className="m-notice-quiet">
        Notifications on ·{' '}
        <button className="m-link" disabled={busy} onClick={() => void disable()}>
          turn off
        </button>
      </p>
    )
  }

  return (
    <div className="m-notice">
      {state.kind === 'off' ? (
        <>
          <p className="m-notice-body">Get told when something needs you, even with the app closed.</p>
          <button className="m-btn m-btn--primary" disabled={busy} onClick={() => void enable()}>
            {busy ? 'Turning on…' : 'Turn on notifications'}
          </button>
        </>
      ) : (
        <p className="m-notice-body">{state.reason}</p>
      )}
      {error && <p className="m-error">{error}</p>}
    </div>
  )
}
