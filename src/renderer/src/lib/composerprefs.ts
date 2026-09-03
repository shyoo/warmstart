import {
  PRIORITY_ORDER,
  readFinishPolicy,
  type FinishPolicyChoice,
  type Priority,
  type SessionSharingChoice
} from '@shared/tasks'

/**
 * What the new-task composer was left set to.
 *
 * ⛔ **Last-selected, not inherited.** The old form recomputed `inherit (commit, verify and merge
 * locally)` from the project on every open, so an operator who overrode the finish policy on one
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

const KEY = 'multi_agent_controller.composer'

/**
 * What the composer files, as far as the *shape* of the thing goes.
 *
 * ⚠️ `task` and `plan` only. Multi-task and conversation are coming and are deliberately not
 * stubbed in here — an option that files nothing is worse than a missing one, because somebody picks
 * it. `plan` is the existing goal-decomposition path (`task.plan`) wearing its real name.
 */
export type ComposerKind = 'task' | 'plan'

/** Model and effort, as last chosen for one account. Empty string means *whatever it inherits*. */
export interface ModelChoice {
  model: string
  effort: string
}

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
  byWorker: {}
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
    const { model, effort } = value as { model?: unknown; effort?: unknown }
    out[workerId] = {
      model: typeof model === 'string' ? model : '',
      effort: typeof effort === 'string' ? effort : ''
    }
  }
  return out
}

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
      kind: p.kind === 'plan' || p.kind === 'task' ? p.kind : DEFAULT_COMPOSER_PREFS.kind,
      // ⚠️ Through `readFinishPolicy`, so a config written before `agent-lands` was renamed still
      // comes back meaning what it meant when it was chosen.
      finishPolicy: readFinishPolicy(p.finishPolicy) ?? DEFAULT_COMPOSER_PREFS.finishPolicy,
      sessionSharing: isSharing(p.sessionSharing)
        ? p.sessionSharing
        : DEFAULT_COMPOSER_PREFS.sessionSharing,
      workerId: typeof p.workerId === 'string' ? p.workerId : '',
      byWorker: readByWorker(p.byWorker)
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

/** What this account was last run with. Absent is `{ model: '', effort: '' }` — inherit both. */
export function modelChoiceFor(prefs: ComposerPrefs, workerId: string): ModelChoice {
  return prefs.byWorker[workerId] ?? { model: '', effort: '' }
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
