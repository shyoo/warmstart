import { useState } from 'react'
import { RemoteError, pairDevice } from '../api.js'

/**
 * The landing route, reached by QR scan (`#/pair?code=…`) or by hand. Redeems the code once,
 * stores the token, and never shows it — there is nothing here to screenshot.
 */
export function pairCodeFromHash(hash: string): string | null {
  const question = hash.indexOf('?')
  if (question < 0) return null
  const code = new URLSearchParams(hash.slice(question + 1)).get('code')
  return code && code.length > 0 ? code : null
}

export function Pair({ initialCode, onPaired }: { initialCode: string | null; onPaired: () => void }): React.JSX.Element {
  const [code, setCode] = useState(initialCode ?? '')
  const [label, setLabel] = useState('Phone')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    if (code.trim().length === 0 || busy) return
    setBusy(true)
    setError(null)
    try {
      await pairDevice(code, label)
      onPaired()
    } catch (err) {
      setError(err instanceof RemoteError ? err.message : 'Pairing failed. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="m-screen m-screen--center">
      <h1 className="m-title">Warmstart</h1>
      <p className="m-lede">Pair this phone to answer agents from anywhere.</p>
      <label className="m-field">
        <span>Pairing code</span>
        <input
          className="m-input"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="From the desktop, remote access"
          autoCapitalize="characters"
          autoCorrect="off"
          inputMode="text"
        />
      </label>
      <label className="m-field">
        <span>This device is called</span>
        <input className="m-input" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={40} />
      </label>
      {error && <p className="m-error">{error}</p>}
      <button className="m-btn m-btn--primary" disabled={busy || code.trim().length === 0} onClick={() => void submit()}>
        {busy ? 'Pairing…' : 'Pair this phone'}
      </button>
      <p className="m-hint">Scan the QR code on the desktop, or type the address by hand — the code arrives in the link.</p>
    </div>
  )
}
