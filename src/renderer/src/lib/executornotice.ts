import { modelLabel } from './modelname'

/**
 * The two notices under the composer's **Plan & Execute** rows, and both carry their basis.
 *
 * ⛔ **Advisory, never a gate** — the rule `debatenotice.ts` already keeps, for the same reason: a
 * one-account fleet has one model, and a control that cannot be satisfied there is a feature that
 * cannot be used. So this says what the pairing *is* and what it trades, and files whatever the
 * operator chose.
 *
 * ⛔ **It never claims one model is better than another.** This module can see two ids and nothing
 * else — not the fitness prior, not the price, not this fleet's own history — so "same model" and "a
 * different model" is the whole of what it is entitled to say. A sentence ranking them would be a
 * confident unsourced claim, which `AGENTS.md` rates worse than none.
 *
 * ⚠️ The measurement quoted is somebody else's, on somebody else's workload, and the wording says so:
 * a compact executor at **42.5%** pass against a strong one's **64.2%**, at roughly a sixth of the
 * cost (arXiv 2607.03048, recorded in `transient_docs/plan_and_execute_2026-09-15.md` §1). Nothing
 * here has been reproduced on this fleet.
 */

export type NoticeTone = 'neutral' | 'caution'

export interface ExecutorNotice {
  id: 'pairing' | 'shape'
  tone: NoticeTone
  text: string
}

export interface ExecutorPairing {
  /** The planner's pinned model id, or `''` where the pill is on Auto or Inherit. */
  plannerModel: string
  /** The accounts named on the Executor row. Empty means *whichever the scheduler picks*. */
  executorWorkerIds: string[]
  /** The model chosen per executor account, as the Executor row's picker writes it. */
  executorModels: Record<string, string>
}

/** ⚠️ Deduplicated and in the row's own order, so two accounts on one model read as one model. */
function executorModelsOf(p: ExecutorPairing): string[] {
  const named = p.executorWorkerIds.map((id) => p.executorModels[id] ?? '').filter((m) => !!m)
  return [...new Set(named)]
}

/**
 * What this planner/executor pairing is, and what it is trading.
 *
 * ⛔ **Four states, and the one that matters most is "nobody said".** An Executor row left on
 * inherit does not mean "cheap" — it hands the choice to the router, which may pick the account that
 * just planned, and then the saving is the review turn alone. That is a real outcome and it has to be
 * said out loud rather than left to be discovered in the ledger afterwards.
 */
export function pairingNotice(p: ExecutorPairing): ExecutorNotice {
  const executors = executorModelsOf(p)
  const planner = p.plannerModel

  if (executors.length === 0) {
    return {
      id: 'pairing',
      tone: 'caution',
      text:
        p.executorWorkerIds.length > 0
          ? 'The executor’s accounts are named but its model is not, so each one runs its own default ' +
            '— which may be the same model that plans. Name a model to make the execution cheaper ' +
            'than the planning.'
          : 'No executor named, so the scheduler picks — possibly the account that just planned. ' +
            'Left like this, what this saves is the review turn, not the execution.'
    }
  }

  const named = executors.map((m) => modelLabel(m) ?? m).join(', ')
  if (planner && executors.length === 1 && executors[0] === planner) {
    return {
      id: 'pairing',
      tone: 'caution',
      text:
        `Executor is ${named} — the same model that plans. That still saves the review turn; it ` +
        'saves nothing on the execution, which is where most of the tokens go.'
    }
  }

  return {
    id: 'pairing',
    tone: 'neutral',
    text:
      `Executor: ${named}${planner ? `, planner: ${modelLabel(planner) ?? planner}` : ''}. Published ` +
      'measurement puts a compact executor near 42% task pass rate against a strong one’s 64%, at ' +
      'roughly a sixth of the cost — not measured on this fleet. The planner having already done the ' +
      'reading is what is meant to buy that back, so make the instruction concrete.'
  }
}

/**
 * What the shape itself costs and buys — true whatever models are named.
 *
 * ⛔ **The approval is named here because it is the only look anybody gets.** Plan & Split's operator
 * sees the pieces *and* gets a planner turn that reviews what came back; this shape has the first and
 * not the second, and somebody choosing it should know that before they choose it rather than after.
 */
export function shapeNotice(): ExecutorNotice {
  return {
    id: 'shape',
    tone: 'neutral',
    text:
      'Two turns instead of three: nothing comes back to review the executor’s work, so approving ' +
      'the handoff is your look at the instruction. The executor lands on the project’s own target.'
  }
}

export function executorNotices(p: ExecutorPairing): ExecutorNotice[] {
  return [pairingNotice(p), shapeNotice()]
}
