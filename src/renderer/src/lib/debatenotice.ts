import type { DebatePreview } from '@shared/protocol'
import { MAX_DEBATE_ROUNDS } from '@shared/tasks'
import { money, tokens } from './format'

/**
 * The three notices under the composer's Debate row, and every one of them carries its basis.
 *
 * ⛔ **Advisory, never a gate.** Not every operator has a second provider, and a gate that cannot
 * be satisfied on a one-account fleet is a feature that cannot be used. Each of these says what was
 * found, where the finding came from, and — where it applies — that it was **not** measured here.
 *
 * ⛔ **The renderer does not compute money.** Every figure printed below arrives from
 * `task.estimatePreview`; what this module does is choose the words. That split is why the
 * arithmetic has its own L1 tests in `debatecost.test.ts` and the wording has its own here.
 *
 * ⚠️ Every claim about what debate buys is **inferred** from published work and none of it was
 * measured on this fleet. §2 of `transient_docs/debate_mode_2026-09-12.md` has the citations.
 */

export type NoticeTone = 'neutral' | 'caution'

export interface Notice {
  id: 'heterogeneity' | 'cost' | 'returns' | 'serial' | 'organizer_mcp'
  tone: NoticeTone
  text: string
}

/**
 * How many model **families** the roster spans.
 *
 * ⛔ Counted on the adapter, not the model name: published work finds cross-family pairs carry
 * debate's gain and same-family pairs show minimal gains, so two Claude models are one family. The
 * count itself is made in the daemon, which is the only place that can resolve an account to its
 * adapter.
 */
export function heterogeneityNotice(preview: DebatePreview): Notice {
  const { adapterSpread, seatCount } = preview
  if (seatCount === 0) return { id: 'heterogeneity', tone: 'neutral', text: 'No seats yet.' }
  if (adapterSpread >= 2) {
    return {
      id: 'heterogeneity',
      tone: 'neutral',
      text:
        `${seatCount} seats across ${adapterSpread} model families. Published work finds most of ` +
        'debate’s gain comes from different families under a judge — which is what the organizer is.'
    }
  }
  return {
    id: 'heterogeneity',
    tone: 'caution',
    text:
      `All ${seatCount} seats are the same model family. Published work finds most of debate’s gain ` +
      'comes from different families, and same-family pairs show minimal gains. Adding an account on ' +
      'another CLI is the change that would help — this is a notice, not a refusal.'
  }
}

/**
 * What it costs, as a **multiple of the same question asked once**.
 *
 * ⛔ Money is `n/a` rather than `$0.00` where nothing behind it could be priced, and the confidence
 * travels with it — `usdConfidence: 'none'` is exactly the case where there is no money answer.
 */
export function costNotice(preview: DebatePreview): Notice {
  const head =
    preview.multiple !== null
      ? `About ${preview.multiple.toFixed(1)}× the cost of asking this question once`
      : 'Cost unknown — nothing behind this estimate has been measured yet'
  const figures =
    `${tokens(preview.totalTokens)} tokens total (${tokens(preview.perSeatTokens)} per seat per round)` +
    (preview.totalUsd !== null
      ? `, about ${money(preview.totalUsd)} — confidence ${preview.usdConfidence}`
      : `, money n/a: ${preview.usdConfidence === 'none' ? 'nothing here could be priced' : 'partially priced'}`)
  return {
    id: 'cost',
    tone: 'neutral',
    text: `${head}. ${figures}. ${preview.basis}${preview.assumed ? ' Some factors are assumed rather than measured.' : ''}`
  }
}

/**
 * The diminishing-return notice, and the caveat that makes this feature trustworthy.
 *
 * ⛔ **The honest caveat is not optional.** Several published results find multi-agent debate does
 * not beat one good agent at a matched token budget, and one finds it underperforms plain
 * self-consistency. It is a sentence, on the screen where the money is committed, and a tool built
 * on *every belief carries its basis* does not get to omit it.
 *
 * ⚠️ The seat and round halves appear only past 3, where the published curve flattens.
 */
export function returnsNotice(seatCount: number, rounds: number): Notice {
  const past: string[] = []
  if (seatCount > 3) past.push(`${seatCount} seats`)
  if (rounds > 3) past.push(`${rounds} rounds`)
  const flattening =
    past.length > 0
      ? `${past.join(' and ')}: published gains flatten past about 3–4 of each, and rounds alone diminish ` +
        `fastest — diversity and argument confidence matter more. Nothing above ${MAX_DEBATE_ROUNDS} is offered. `
      : ''
  return {
    id: 'returns',
    tone: past.length > 0 ? 'caution' : 'neutral',
    text:
      flattening +
      '⚠️ None of this was measured on this fleet, and several published results find debate does not ' +
      'beat one strong agent at the same token budget. This is the screen where that is worth knowing.'
  }
}

/**
 * How much of this debate actually runs in parallel.
 *
 * ⛔ **Said out loud, never silently corrected**, in the same voice the composer already uses for a
 * narrow workspace pool. `maxConcurrent` commissions at 1 per account and the workspace pool
 * defaults to 3, so on the commonest install a three-seat debate is three serial runs.
 *
 * ⚠️ Blindness survives serialisation — each seat is its own session with its own context, and
 * every seat is filed `sessionSharing: 'off'` — so this is about the clock, never about the answer.
 */
export function serialNotice(preview: DebatePreview): Notice | null {
  if (preview.seatCount < 2 || preview.parallelSeats >= preview.seatCount) return null
  return {
    id: 'serial',
    tone: 'caution',
    text:
      `Only ${preview.parallelSeats} of ${preview.seatCount} seats can run at once on this fleet, so a ` +
      'round takes longer than one turn. Raise an account’s concurrency or the project’s workspace pool ' +
      'to change that. It does not affect the answer: each seat has its own session either way.'
  }
}

/**
 * How the organizer arbitrates based on its MCP capability.
 *
 * ⛔ **Advisory, never a gate.** MCP agents arbitrate natively via `debate_round` tool;
 * non-MCP agents arbitrate via terminal fallback (`DEBATE ROUND CONTINUE:` / `DEBATE ROUND CONVERGED:`).
 */
export function organizerCapabilityNotice(organizerLabel: string, hasMcp: boolean | null): Notice {
  if (hasMcp === null) {
    return {
      id: 'organizer_mcp',
      tone: 'neutral',
      text: 'Organizer: auto-routed. Native MCP agents arbitrate via debate tools; non-MCP agents arbitrate via terminal fallback.'
    }
  }
  if (hasMcp) {
    return {
      id: 'organizer_mcp',
      tone: 'neutral',
      text: `Organizer (${organizerLabel}): native MCP enabled. Arbitrates rounds and files verdict via MCP tools.`
    }
  }
  return {
    id: 'organizer_mcp',
    tone: 'neutral',
    text: `Organizer (${organizerLabel}): non-MCP agent. Arbitrates rounds via terminal fallback contract and parks verdict for operator.`
  }
}

/** The notices, in the order the composer draws them. ⚠️ The serial one only when it applies. */
export function debateNotices(
  preview: DebatePreview,
  rounds: number,
  organizerMcp?: { label: string; hasMcp: boolean | null }
): Notice[] {
  return [
    ...(organizerMcp ? [organizerCapabilityNotice(organizerMcp.label, organizerMcp.hasMcp)] : []),
    heterogeneityNotice(preview),
    costNotice(preview),
    ...(serialNotice(preview) ? [serialNotice(preview)!] : []),
    returnsNotice(preview.seatCount, rounds)
  ]
}
