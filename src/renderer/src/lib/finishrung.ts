import {
  DEFAULT_FLEET_FINISH,
  FINISH_ORDER,
  policyLands,
  policyOfferedInTrunk,
  type FinishPolicy,
  type FinishPolicyChoice,
  type WorkspaceMode,
  type WorkspaceModeChoice
} from '@shared/tasks'

/**
 * The rungs the Commit button offers, and the two it does not.
 *
 * ⛔ **Derived from `FINISH_ORDER`, never hand-written**, for the reason the composer's own list
 * carries: three dropdowns each kept their own copy of these and all three still offered
 * `agent-lands` a week after the rename. ⚠️ `await-human` is dropped because it is what the
 * conversation is already doing — offering it under a button called Commit would be a button that
 * does nothing — and `custom` because it is an instruction the project wrote for its *own* finish,
 * which is a different question from what this one commit should do.
 *
 * ⛔ `report-only` for the first reason again, and more strongly: it is the rung that says *nothing
 * was ever going to be committed*, so under a button called Commit it is the one option guaranteed
 * to do nothing at all. Excluding it here is why it is safe for it to sit in `FINISH_ORDER`.
 */
export const COMMIT_RUNGS: FinishPolicy[] = FINISH_ORDER.filter(
  (policy) => policy !== 'await-human' && policy !== 'custom' && policy !== 'report-only'
)

/**
 * The rungs the Land button offers: the ones the **tool** acts on.
 *
 * ⛔ Derived from `policyLands`, for the reason above and one more of its own. Landing a branch under
 * `commit-only` or `commit-and-verify` is a button that does nothing — those rungs leave the branch
 * exactly where the agent put it — and the whole point of this control is that the tool does the last
 * part. ⚠️ `commit·verify·merge` is the one an operator means by "merge it into main".
 */
export const LAND_RUNGS: FinishPolicy[] = FINISH_ORDER.filter(policyLands)

/**
 * The rungs a settle-it menu offers when the task holds the trunk lease.
 *
 * ⛔ The work is already on the landing target, so `commit-and-merge` would promise a merge that
 * cannot happen (t583) and `pull-request` needs a branch the task does not have — the daemon
 * refuses that combination outright (`trunkPolicyConflict`). Everything else is honest in both
 * modes, so worktree menus are the full lists unchanged.
 */
export function commitRungsForMode(mode: WorkspaceMode): FinishPolicy[] {
  return mode === 'trunk' ? COMMIT_RUNGS.filter(policyOfferedInTrunk) : COMMIT_RUNGS
}

export function landRungsForMode(mode: WorkspaceMode): FinishPolicy[] {
  return mode === 'trunk' ? LAND_RUNGS.filter(policyOfferedInTrunk) : LAND_RUNGS
}

/**
 * ⚠️ The fleet default merges, which a trunk menu cannot offer. A Land button whose fallback is
 * not on its own menu is a button whose ✓ is nowhere, so the trunk fallback is the one landing
 * rung left: pushing the target is still landing.
 */
export const TRUNK_LAND_FALLBACK: FinishPolicy = 'commit-and-push'

/**
 * Which workspace mode a task's menus answer to: the task's own pin, else the project's answer
 * the detail carries, else the default pool. Unknown reads as worktree, the mode every menu was
 * written for — hiding rungs on a guess would be worse than showing them.
 */
export function effectiveWorkspaceMode(
  taskMode: WorkspaceModeChoice | undefined,
  inherited: WorkspaceMode | undefined
): WorkspaceMode {
  if (taskMode && taskMode !== 'inherit') return taskMode
  return inherited ?? 'worktree'
}

/**
 * ⛔ **`commit-only`, and not the fleet default.** Where a project's own answer is one the Commit
 * menu cannot offer — `await-human`, or a `custom` instruction written for the agent — the honest
 * substitute is the rung that does the least: commit, and leave the branch where it is. Falling back
 * to `commit-and-merge` would take a project that deliberately asked for a person to decide and
 * merge its trunk on one press.
 */
export const COMMIT_FALLBACK: FinishPolicy = 'commit-only'

/**
 * ⚠️ The fleet default, which lands by construction. A Land button whose rung does not land is a
 * button that does nothing, so the fallback here has to be a landing rung rather than the quietest
 * one.
 */
export const LAND_FALLBACK: FinishPolicy = DEFAULT_FLEET_FINISH

/**
 * Which rung a settle-it button starts on: the task's own, else the project's, else the fleet's.
 *
 * ⭐ **The bug this closes (t283).** The Commit control was a picker with no value, so its menu
 * opened on the first rung in the ladder — `commit-only` — and an operator on a project configured
 * for `commit·verify·merge` was offered the one rung that leaves the work sitting on the branch,
 * every time, with nothing on screen saying that was not their project's answer.
 *
 * ⛔ **Not `resolveFinishPolicy`, and this is the whole subtlety.** That function answers
 * `await-human` for an open conversation *above* the project and the fleet — which is correct for
 * "what happens when this task finishes on its own" and useless here, because pressing Commit is
 * precisely the operator overriding that. So the conversation-kind override is stepped around and
 * the remaining tiers are read in their usual order: a rung the task already carries wins, because
 * the last press of this button wrote it and a control that forgot its own last answer is worse than
 * one that never had a default.
 *
 * ⚠️ `offered` is the list the menu actually shows, so the answer is always a rung that can be
 * picked. A default the menu does not contain is a button whose ✓ is nowhere.
 */
export function defaultRung(
  taskPolicy: FinishPolicyChoice,
  inherited: FinishPolicy | null | undefined,
  offered: FinishPolicy[],
  fallback: FinishPolicy
): FinishPolicy {
  const wanted = taskPolicy !== 'inherit' ? taskPolicy : inherited
  return wanted && offered.includes(wanted) ? wanted : fallback
}

/**
 * Where the rung on a settle-it button came from, as the half-sentence the card prints after it.
 *
 * ⛔ **A default whose origin is invisible is one nobody trusts and everybody overrides** — the
 * same rule the pills follow with `muted`. "Commit·Verify·Merge" on the card answers *what will
 * happen*; this answers *why that one*, which is the question an operator asks the first time the
 * button does something they did not expect.
 *
 * ⚠️ `source` is the tier the daemon resolved the inherited answer from, so a project that says
 * nothing correctly reads as the fleet's rather than as its own.
 */
export function rungOrigin(
  taskPolicy: FinishPolicyChoice,
  inherited: { policy: FinishPolicy; source: string } | null | undefined,
  chosen: FinishPolicy
): string {
  if (taskPolicy !== 'inherit' && taskPolicy === chosen) return 'the rung this task already carries'
  if (inherited && inherited.policy === chosen) {
    return inherited.source === 'project' ? 'this project’s default' : 'the fleet default'
  }
  // ⚠️ The fallback, said as one: the tier below asked for something this button cannot do, so
  // silence here would present the substitute as though it were the project's own answer.
  return 'the safe default here, because this project’s own answer is not one this button can do'
}
