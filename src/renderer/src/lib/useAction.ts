import { useCallback, useState } from 'react'
import { errorMessage } from '@shared/errors.js'

/** The shared renderer action lifecycle: disable while pending, clear stale feedback, report errors. */
export function useAction<Args extends unknown[], Result>(
  action: (...args: Args) => Promise<Result>,
  options: {
    successNote?: (result: Result) => string | null
    onSuccess?: (result: Result) => Promise<void> | void
  } = {}
): { busy: boolean; note: string | null; run: (...args: Args) => Promise<void> } {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const run = useCallback(
    async (...args: Args): Promise<void> => {
      setBusy(true)
      setNote(null)
      try {
        const result = await action(...args)
        setNote(options.successNote?.(result) ?? null)
        await options.onSuccess?.(result)
      } catch (err) {
        setNote(errorMessage(err))
      } finally {
        setBusy(false)
      }
    },
    [action, options]
  )
  return { busy, note, run }
}
