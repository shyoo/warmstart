/**
 * What to show a person when something threw.
 *
 * ⛔ **One spelling, because there were 91.** The ternary this replaces — test for `Error`, take
 * `.message`, else `String()` — was written out by hand at 91 call sites across the daemon, the
 * renderer, the MCP server and the Electron main process. Ninety-one copies is not a style problem:
 * it is 91 chances to put the wrong branch first, and no single place to change what this app does
 * when a thrown value is not an `Error` at all.
 *
 * ⚠️ **A non-Error still has to say something.** A rejected promise carrying a string, an object or
 * `undefined` is ordinary — a spawned CLI's own error channel, a JSON-RPC fault, an aborted fetch —
 * and this is frequently the last thing between that value and a person reading it. The old ternary
 * answered `[object Object]` for the object case, which in a toast tells the reader nothing at all
 * and cannot be searched for. Here an object that has not said how it wants to be printed is
 * rendered as JSON instead.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  if (typeof err === 'object' && err !== null) {
    // ⚠️ Only where the default would have given up. A class carrying its own `toString` has said
    // what it wants to be called, and this must not overrule it with a field dump.
    const own = (err as { toString?: unknown }).toString
    if (typeof own === 'function' && own !== Object.prototype.toString) {
      return (err as { toString: () => string }).toString()
    }
    try {
      // ⚠️ `JSON.stringify` answers `undefined` rather than throwing for some inputs, so the
      // fallback is not decoration.
      return JSON.stringify(err) ?? '[object Object]'
    } catch {
      // ⚠️ Circular, or holding a BigInt. A poor answer, but the alternative is throwing from the
      // one function whose job is to describe a throw.
      return '[object Object]'
    }
  }
  return String(err)
}
