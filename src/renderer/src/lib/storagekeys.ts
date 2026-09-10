/**
 * `localStorage` key names, and the one-time adoption of the names used before the rename.
 *
 * ⛔ **A rename must not silently reset somebody's screen.** Eleven preferences live under this
 * prefix — which task views were showing, which columns, sidebar width, zoom, an unsent composer
 * draft, dismissed quota alerts. Changing the prefix without moving what is stored would clear every
 * one of them on first launch after an update, and the operator would have no way to tell that from
 * the app having forgotten. Same rule as `paths.ts`'s data-directory chain, one storey down.
 *
 * ⚠️ **Copy, never move.** The legacy keys are left in place, so a build from before the rename
 * still finds its own preferences if somebody rolls back. They cost a few hundred bytes and nothing
 * reads them once the copy exists.
 *
 * ⚠️ **Every access is guarded**, on the same rule as `prefs.ts`: `localStorage` *throws* rather
 * than returning null in real configurations — a Chromium profile with site data disabled, private
 * windows on some platforms — and a preference is never worth a blank screen.
 */

const PREFIX = 'warmstart.'
const LEGACY_PREFIX = 'multi_agent_controller.'

let adopted = false

/**
 * Copy every pre-rename key to its new name, once per session.
 *
 * ⛔ Reads are collected before any write. `Storage.key(i)` is index-based and writing during the
 * scan reorders what is left, which would skip keys — the classic mutate-while-iterating bug, and
 * here it would silently drop whichever preferences happened to shift.
 *
 * ⛔ An existing new-name value always wins: a stale legacy copy must never overwrite a preference
 * the operator has already changed since updating.
 */
function adoptLegacyKeys(): void {
  if (adopted) return
  adopted = true
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    const store = window.localStorage
    const moves: Array<[string, string]> = []
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i)
      if (!key || !key.startsWith(LEGACY_PREFIX)) continue
      const renamed = PREFIX + key.slice(LEGACY_PREFIX.length)
      if (store.getItem(renamed) === null) moves.push([key, renamed])
    }
    for (const [from, to] of moves) {
      const value = store.getItem(from)
      if (value !== null) store.setItem(to, value)
    }
  } catch {
    // Storage unavailable. The app runs on defaults, which is what it would have done anyway.
  }
}

/**
 * The storage key for one preference, e.g. `appKey('taskViews')`.
 *
 * ⚠️ Adoption runs on the first call rather than at module load, so it happens whichever module
 * reads a preference first and does not depend on import order.
 */
export function appKey(name: string): string {
  adoptLegacyKeys()
  return PREFIX + name
}
