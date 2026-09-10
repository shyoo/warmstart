import {
  PRIORITY_ORDER,
  readFinishPolicy,
  type FinishPolicyChoice,
  type Priority,
  type SessionSharingChoice
} from '@shared/tasks'
import { appKey } from './storagekeys'

/**
 * What the new-task composer was left set to.
 *
 * ⛔ **Last-selected, not inherited.** The old form recomputed `inherit (commit, verify and merge
 * into main)` from the project on every open, so an operator who overrode the finish policy on one
 * task had to override it again on the next one, and again on the one after that — the fleet's
 * answer to *what do you usually want* was "whatever the project says", which is the one answer that
 * is never about the person typing. Inheritance still supplies the **first** value each control
 * shows, and the moment somebody picks something the pick is what comes back.
 *
 * ⚠️ `inherit` is therefore a real remembered value, not an absence: a composer left on it keeps
 * following its project as the project changes, and one moved off it stops. That difference is why
 * the pill draws the inherited answer in a dimmer colour rather than writing "(inherited)" beside it
 * — the state is worth showing, the word is not worth the width.
 *
 * ⛔ `localStorage`, on the precedent every other per-display preference here sets (`prefs.ts`), and
 * every access is guarded: it throws rather than returning null in real configurations, and a
 * preference is never worth a blank screen.
 */

const KEY = appKey('composer')

/**
 * What the composer files, as far as the *shape* of the thing goes.
 *
 * ⚠️ Three. `plan` is the existing goal-decomposition path (`task.plan`) wearing its real name, and
 * `conversation` files an ordinary task of kind `conversation` — the same dispatch, with the
 * single-turn closing contract removed. Multi-task is still deliberately not stubbed in here: an
 * option that files nothing is worse than a missing one, because somebody picks it.
 */
export type ComposerKind = 'task' | 'plan' | 'conversation'

/** Model and effort, as last chosen for one account. Empty string means *whatever it inherits*. */
export interface ModelChoice {
  model: string
  effort: string
  /**
   * What to do when no model is named, said out loud rather than inferred from the empty string.
   *
   * ⛔ **`auto` and `inherit` were the same blank before, and they are not the same instruction.**
   * With a routable-model allowlist on the account, filing with no model hands the choice to the
   * router — which is what an operator who picked *the account's default* off this pill did not ask
   * for, and the thread then reported a model they had never seen. `auto` is the default because it
   * is what every previously filed task did.
   *
   * ⚠️ Ignored while `model` is set: a pin is a mandate, and there is nothing left to police.
   */
  policy: ModelPolicy
}

/** `auto` — the scheduler scores the routable models. `inherit` — the account's own default. */
export type ModelPolicy = 'auto' | 'inherit'

export interface ComposerPrefs {
  priority: Priority
  kind: ComposerKind
  finishPolicy: FinishPolicyChoice
  sessionSharing: SessionSharingChoice
  /** `''` is Auto — the scheduler picks. It is a choice, and it is remembered like any other. */
  workerId: string
  /**
   * The model and effort last chosen **per account**, keyed by worker id (`''` for Auto).
   *
   * ⛔ Not one remembered model. A model id belongs to exactly one CLI — `opus` means nothing to
   * Antigravity — so a single slot would hand the next account an id its adapter would fail to start
   * on, which is the same bug the old form avoided by clearing the field on every worker change.
   * Clearing loses the choice; keying by worker keeps it and still never crosses adapters.
   */
  byWorker: Record<string, ModelChoice>
  /**
   * What the **pieces** of a Plan & Split are set to, kept separately from the planner's own row.
   *
   * ⛔ **Decision D5, and the case that motivated Plan & Split at all: plan with one model, build
   * with another.** The planning turn wants a model that reads a repository well and asks good
   * questions; the pieces want whatever is cheapest that can follow a concrete instruction. One row
   * of settings would have forced them to be the same, which is the choice nobody wanted to make.
   *
   * ⚠️ Remembered on the same last-selected rule as the planner's row, and defaulted to inherit.
   */
  pieces: PiecePrefs
}

export interface PiecePrefs {
  priority: Priority
  finishPolicy: FinishPolicyChoice
  sessionSharing: SessionSharingChoice
  workerId: string
  byWorker: Record<string, ModelChoice>
  /**
   * How many pieces the planner may file.
   *
   * ⛔ **One cap, and it is the one the operator sees.** `ROOT_MANDATE.maxChildren` was 5 while the
   * decomposition path capped at 8, so a split of six was refused with a message about a fan-out cap
   * nobody had set. This number is written into the task's mandate, so the number on the pill is the
   * number enforced.
   */
  maxChildren: number
}

/**
 * ⚠️ Every default is the *inherit* end of its control, because a fresh install has nothing to
 * remember and the resolved project answer is the honest thing to show. Only `priority` has a value
 * of its own — P2 is what `task.create` defaults to, and starting anywhere else would file a
 * different task than the one the daemon would have.
 */
export const DEFAULT_COMPOSER_PREFS: ComposerPrefs = {
  priority: 'P2',
  kind: 'task',
  finishPolicy: 'inherit',
  sessionSharing: 'inherit',
  workerId: '',
  byWorker: {},
  pieces: {
    priority: 'P2',
    finishPolicy: 'inherit',
    sessionSharing: 'inherit',
    workerId: '',
    byWorker: {},
    maxChildren: 5
  }
}

function isPriority(v: unknown): v is Priority {
  return typeof v === 'string' && v in PRIORITY_ORDER
}

function isSharing(v: unknown): v is SessionSharingChoice {
  return v === 'on' || v === 'off' || v === 'inherit'
}

function readByWorker(raw: unknown): Record<string, ModelChoice> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, ModelChoice> = {}
  for (const [workerId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue
    const { model, effort, policy } = value as { model?: unknown; effort?: unknown; policy?: unknown }
    out[workerId] = {
      model: typeof model === 'string' ? model : '',
      effort: typeof effort === 'string' ? effort : '',
      // ⚠️ Anything unreadable — including every choice stored before this field existed — is `auto`,
      // which is what those choices did.
      policy: policy === 'inherit' ? 'inherit' : 'auto'
    }
  }
  return out
}

/** ⚠️ Field by field, like the row above it: an unreadable piece setting must not reset the rest. */
function readPieces(raw: unknown): PiecePrefs {
  const d = DEFAULT_COMPOSER_PREFS.pieces
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...d, byWorker: {} }
  const p = raw as Record<string, unknown>
  const cap = typeof p.maxChildren === 'number' ? Math.round(p.maxChildren) : d.maxChildren
  return {
    priority: isPriority(p.priority) ? p.priority : d.priority,
    finishPolicy: readFinishPolicy(p.finishPolicy) ?? d.finishPolicy,
    sessionSharing: isSharing(p.sessionSharing) ? p.sessionSharing : d.sessionSharing,
    workerId: typeof p.workerId === 'string' ? p.workerId : '',
    byWorker: readByWorker(p.byWorker),
    // ⚠️ Clamped rather than rejected. A stored 40 is a setting from a build that allowed one, and
    // the honest repair is the nearest legal value, not a silent reset to the default.
    maxChildren: Math.min(MAX_PIECES, Math.max(MIN_PIECES, Number.isFinite(cap) ? cap : d.maxChildren))
  }
}

/** The bounds the fan-out pill offers. ⛔ `MIN` is 2: a split of one is refused by the daemon. */
export const MIN_PIECES = 2
export const MAX_PIECES = 8

/**
 * What the composer was left set to, with anything unreadable replaced field by field.
 *
 * ⛔ **Per field, never the whole record.** A stored finish policy that has since been renamed must
 * not throw away the worker, the priority and every remembered model beside it — that would reset a
 * composer somebody had tuned, with nothing in the UI to say why. This is the same rule `readViews`
 * follows for a bucket that aged out.
 */
export function readComposerPrefs(): ComposerPrefs {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return { ...DEFAULT_COMPOSER_PREFS }
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULT_COMPOSER_PREFS }
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ...DEFAULT_COMPOSER_PREFS }
    }
    const p = parsed as Record<string, unknown>
    return {
      priority: isPriority(p.priority) ? p.priority : DEFAULT_COMPOSER_PREFS.priority,
      kind:
        p.kind === 'plan' || p.kind === 'task' || p.kind === 'conversation'
          ? p.kind
          : DEFAULT_COMPOSER_PREFS.kind,
      // ⚠️ Through `readFinishPolicy`, so a config written before `agent-lands` was renamed still
      // comes back meaning what it meant when it was chosen.
      finishPolicy: readFinishPolicy(p.finishPolicy) ?? DEFAULT_COMPOSER_PREFS.finishPolicy,
      sessionSharing: isSharing(p.sessionSharing)
        ? p.sessionSharing
        : DEFAULT_COMPOSER_PREFS.sessionSharing,
      workerId: typeof p.workerId === 'string' ? p.workerId : '',
      byWorker: readByWorker(p.byWorker),
      pieces: readPieces(p.pieces)
    }
  } catch {
    return { ...DEFAULT_COMPOSER_PREFS }
  }
}

export function writeComposerPrefs(prefs: ComposerPrefs): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    window.localStorage.setItem(KEY, JSON.stringify(prefs))
  } catch {
    // A preference that cannot be saved is not an error worth showing anybody.
  }
}

/** What this account was last run with. Absent is no model, no effort, and the router's choice. */
export function modelChoiceFor(
  prefs: Pick<ComposerPrefs, 'byWorker'>,
  workerId: string
): ModelChoice {
  return prefs.byWorker[workerId] ?? { model: '', effort: '', policy: 'auto' }
}

/** The pieces row's own per-account model memory. ⚠️ Same rule, separate store — see `PiecePrefs`. */
export function rememberPieceModelChoice(
  prefs: ComposerPrefs,
  workerId: string,
  choice: ModelChoice
): ComposerPrefs {
  return {
    ...prefs,
    pieces: { ...prefs.pieces, byWorker: { ...prefs.pieces.byWorker, [workerId]: { ...choice } } }
  }
}

/**
 * Record a model/effort pick against the account it was made for.
 *
 * ⚠️ Pure, and returns a new record: the composer holds its prefs in React state and writes them
 * through one place, so mutating the object it is rendering from would leave the pill showing the
 * old value until something unrelated re-rendered it.
 */
export function rememberModelChoice(
  prefs: ComposerPrefs,
  workerId: string,
  choice: ModelChoice
): ComposerPrefs {
  return { ...prefs, byWorker: { ...prefs.byWorker, [workerId]: { ...choice } } }
}
