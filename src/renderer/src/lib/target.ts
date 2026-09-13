import { createContext, useContext } from 'react'
import { LOCAL_TARGET, type TargetSummary, type TargetsState } from '@shared/ipc'

/**
 * Which computer this window is showing.
 *
 * ⛔ **The module-level id is what `rpc()` sends with every call**, so main can refuse a call that
 * arrives after a switch rather than delivering it to the other machine. It is set by `Root` before
 * the re-keyed `App` renders, and never by anything else.
 */
let activeTargetId: string = LOCAL_TARGET

export function currentTargetId(): string {
  return activeTargetId
}

export function setCurrentTargetId(id: string): void {
  activeTargetId = id
}

export interface TargetContextValue {
  state: TargetsState
  active: TargetSummary
}

const LOCAL_SUMMARY: TargetSummary = {
  id: LOCAL_TARGET,
  label: 'This computer',
  kind: 'local',
  url: null,
  state: 'connecting',
  message: null,
  remoteAppVersion: null,
  rpcVersion: null,
  remoteNeedsUpgrade: false,
  pairedAt: null
}

export const LOCAL_ONLY: TargetsState = { active: LOCAL_TARGET, targets: [LOCAL_SUMMARY], canStoreCredentials: false }

export function activeSummary(state: TargetsState): TargetSummary {
  return state.targets.find((t) => t.id === state.active) ?? state.targets[0] ?? LOCAL_SUMMARY
}

export const TargetContext = createContext<TargetContextValue>({ state: LOCAL_ONLY, active: LOCAL_SUMMARY })

export function useTarget(): TargetContextValue {
  return useContext(TargetContext)
}

/** Whether what is on screen is another computer's fleet — so a path means a path over there. */
export function useIsRemote(): boolean {
  return useTarget().active.kind === 'remote'
}

/** What the picker shows for one computer: its name, and a word when it is not simply reachable. */
export function targetOptionLabel(target: TargetSummary, active: boolean): string {
  if (target.kind === 'local') return target.label
  // ⚠️ Only the selected remote is connected, so an unselected one is not "offline" — it is idle.
  if (!active) return target.label
  const word =
    target.state === 'connected'
      ? target.remoteNeedsUpgrade ? 'needs upgrade' : null
      : target.state === 'connecting' ? 'connecting…' : target.state === 'refused' ? 'refused' : 'unreachable'
  return word ? `${target.label} (${word})` : target.label
}

/**
 * A notification's title, naming the computer whenever it might not be the one on screen.
 *
 * ⚠️ With nothing paired there is only one computer, and naming it would be noise on every alert.
 */
export function notificationTitle(title: string, source: { targetId: string; label: string }, state: TargetsState): string {
  if (state.targets.length <= 1) return title
  if (source.targetId === LOCAL_TARGET && state.active === LOCAL_TARGET) return title
  return `${title} · ${source.label}`
}
