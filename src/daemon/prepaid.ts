import type { QuotaWindow } from '@shared/protocol.js'
import type { BillingWindowRef, CostModel, PlanRef } from './costmodel.js'

/**
 * Routing Model v1.2 — prepaid expiry pressure (`docs/routing.md` §3.3a).
 *
 * v1.1 asked how much of a billing window's remainder its own pace projects to forfeit. That
 * saturates as soon as almost everything is projected to expire, so a window resetting in one
 * hour scored barely above the same dollars resetting in 24 (1.03×, measured 2026-09-19). v1.2
 * asks how fast the remaining money must be spent instead: remaining prepaid dollars per hour
 * to reset, field-normalized so the most urgent candidate scores 1.
 *
 * ⛔ Pure evidence plus a field normalizer, and nothing else. It receives all state as arguments
 * and reads no scheduler binding, so the arithmetic below is unit-testable without a database —
 * and so `scoreCandidate` cannot recompute it into a second, drifting definition.
 */

const MS_PER_HOUR = 3600 * 1000

/** One billing window's priced evidence, or the reason it contributes nothing. */
export interface PrepaidWindowEvidence {
  ref: BillingWindowRef
  window: QuotaWindow | null
  remainingUsd: number
  hoursLeft: number
  /** Remaining dollars per hour to reset — the pressure this window exerts. */
  pressure: number
  /** Full-window dollars per billing hour — the ordinary rate pressure is behind or ahead of. */
  steady: number
  /** False for a vendor-silent inferred window, whose reset was projected, not read. */
  observed: boolean
  /** Empty when counted; the reason this window contributes nothing when not. */
  skipped: string
}

/** One candidate's raw prepaid evidence, before the field denominator is known. */
export interface PrepaidRawRecord {
  kind: 'pay-now' | 'subscription' | 'none'
  /** Final for `pay-now`/`none`; the classification half for `subscription` (normalizer appends). */
  basis: string
  plan: PlanRef | null
  windows: PrepaidWindowEvidence[]
  rawPressure: number
  steadyPressure: number
  /** The probe reading behind empty `windows` is stale rather than absent. */
  staleEvidence: boolean
}

/** A finalized `prepaid` term: the value, its basis, and what `quotaRisk` should skip. */
export interface PrepaidTerm {
  value: number
  basis: string
  /** Billing-window ids behind their spend schedule, which `quotaRisk` omits from its loop. */
  behindScheduleWindowIds: string[]
  /** What `quotaRisk` should say about the skip. Empty unless anything is behind schedule. */
  skipNote: string
}

export interface PrepaidEvidenceInput {
  /** Null where the worker's cost model cannot be loaded — billing is unknown, never guessed. */
  costModel: CostModel | null
  subscriptionType: string | null
  /** The quota pool this (worker, model) pair draws on. See `poolFor`. */
  pool: string | null
  /** The windows the gate evaluated, or empty when there was nothing trustworthy to read. */
  trustedWindows: QuotaWindow[]
  /** Ids among `trustedWindows` synthesized by `inferredFreshWindows` — projected, not read. */
  inferredIds: ReadonlySet<string>
  /** The probe reading behind empty `trustedWindows` is stale rather than absent. */
  staleEvidence: boolean
  /** Is this candidate dispatching past a blocking window on usage credits? Real money, spent now. */
  payNowBlocking: boolean
  now: number
}

function none(basis: string): PrepaidRawRecord {
  return {
    kind: 'none',
    basis,
    plan: null,
    windows: [],
    rawPressure: 0,
    steadyPressure: 0,
    staleEvidence: false
  }
}

/**
 * The subscription-side value: priced remainder per billing window, with the honest exclusions.
 *
 * The classification mirrors the old term — unknown, local/free, pay-now — because those are
 * facts about the billing class, not about expiry. What changed is only what a subscription
 * scores: no trusted reset, no pressure, and no 0.25 standing guess remains.
 */
export function prepaidEvidence(input: PrepaidEvidenceInput): PrepaidRawRecord {
  const {
    costModel: cm,
    subscriptionType,
    pool,
    trustedWindows,
    inferredIds,
    staleEvidence,
    payNowBlocking,
    now
  } = input
  if (payNowBlocking) {
    return {
      kind: 'pay-now',
      basis: 'dispatching past a blocking window on usage credits — real money, spent now',
      plan: null,
      windows: [],
      rawPressure: 0,
      steadyPressure: 0,
      staleEvidence: false
    }
  }
  if (!cm) return none('billing is unknown, so this scores 0')
  if (!cm.hasPlans()) return none('billing is unknown (no plans declared), so this scores 0')
  if (cm.plansPriced() === false) return none('no prepaid allowance (local / free plan)')
  const plan = cm.resolvePlan({
    subscriptionType,
    windowIds: trustedWindows.map((w) => w.id)
  })
  if (plan && (plan.priced === false || plan.monthlyUsd === 0)) {
    return none('no prepaid allowance (local / free plan)')
  }
  if (!cm.hasBillingWindow()) {
    return {
      kind: 'pay-now',
      basis: 'money paid now (priced, no subscription window)',
      plan,
      windows: [],
      rawPressure: 0,
      steadyPressure: 0,
      staleEvidence: false
    }
  }
  if (!plan) return none('billing is unknown (no plan resolves), so this scores 0')

  // Several billing windows can match (a pooled provider); each window is priced with its
  // `BillingWindowRef.share` and counted once — `billingWindowsFor` dedups by id at the largest
  // share, so two pool keys over one window never double-count it.
  const billing = cm.billingWindowsFor(
    trustedWindows.map((w) => w.id),
    pool
  )
  const basisHead = `${plan.label} (${plan.source})`
  const windows = billing.map((ref) => priceWindow(cm, plan, ref, trustedWindows, inferredIds, now))
  const rawPressure = windows.reduce((sum, w) => sum + w.pressure, 0)
  const steadyPressure = windows.reduce((sum, w) => sum + w.steady, 0)
  return {
    kind: 'subscription',
    basis: basisHead,
    plan,
    windows,
    rawPressure,
    steadyPressure,
    staleEvidence
  }
}

function skippedWindow(
  ref: BillingWindowRef,
  window: QuotaWindow | null,
  reason: string
): PrepaidWindowEvidence {
  return {
    ref,
    window,
    remainingUsd: 0,
    hoursLeft: 0,
    pressure: 0,
    steady: 0,
    observed: true,
    skipped: reason
  }
}

/**
 * Price one billing window's remainder. No pricing arithmetic lives here — `priceOfWindowUsage`
 * holds the only formula, preserving plan resolution and pooled subscription shares.
 */
function priceWindow(
  cm: CostModel,
  plan: PlanRef,
  ref: BillingWindowRef,
  trustedWindows: QuotaWindow[],
  inferredIds: ReadonlySet<string>,
  now: number
): PrepaidWindowEvidence {
  const win = trustedWindows.find((w) => w.id === ref.id) ?? null
  if (!win) return skippedWindow(ref, null, 'no trusted reading of this billing window')
  if (!win.resetsAt || win.resetsAt <= now) {
    return skippedWindow(ref, win, 'no trusted reset time on this billing window')
  }
  // ⛔ Clamped: a window read past full has no remainder to price, not a negative one.
  const remaining = cm.priceOfWindowUsage(plan.id, [
    { window: ref, percent: Math.max(0, 100 - win.percent) }
  ])
  const full = cm.priceOfWindowUsage(plan.id, [{ window: ref, percent: 100 }])
  if (!remaining || !full) {
    return skippedWindow(ref, win, 'plan has no price to divide')
  }
  const hoursLeft = (win.resetsAt - now) / MS_PER_HOUR
  return {
    ref,
    window: win,
    remainingUsd: remaining.usd,
    hoursLeft,
    pressure: remaining.usd / hoursLeft,
    steady: full.usd / (ref.days * 24),
    observed: !inferredIds.has(win.id),
    skipped: ''
  }
}

/** One denominator shared by the whole candidate field. Pay-now candidates do not enter it. */
export function prepaidDenominator(records: PrepaidRawRecord[]): number {
  let d = 0
  for (const r of records) {
    if (r.kind !== 'subscription') continue
    d = Math.max(d, r.rawPressure, r.steadyPressure)
  }
  return d
}

/**
 * Finalize every candidate's term against the field denominator.
 *
 * The steady-pressure floor anchors the scale to the ordinary rate required to use a full
 * allowance across its whole window; the field's largest actual pressure raises that
 * denominator when expiry is more urgent. Values stay bounded at 1 without destroying ratios
 * between candidates.
 */
export function normalizePrepaidField(records: PrepaidRawRecord[]): PrepaidTerm[] {
  const d = prepaidDenominator(records)
  return records.map((r) => finalizePrepaid(r, d))
}

function usd(n: number): string {
  return `$${n.toFixed(3)}`
}

function finalizePrepaid(r: PrepaidRawRecord, denominator: number): PrepaidTerm {
  if (r.kind === 'pay-now') return { value: -1, basis: r.basis, behindScheduleWindowIds: [], skipNote: '' }
  if (r.kind === 'none') return { value: 0, basis: r.basis, behindScheduleWindowIds: [], skipNote: '' }
  const counted = r.windows.filter((w) => !w.skipped)
  const skipped = r.windows.filter((w) => w.skipped)
  const behind = counted.filter((w) => w.pressure > w.steady)
  const behindScheduleWindowIds = behind.map((w) => w.window?.id ?? w.ref.id)
  const skipNote =
    behind.length > 0
      ? `behind its spend schedule: ` +
        behind
          .map(
            (w) =>
              `${w.window?.label ?? w.ref.id} at ${usd(w.pressure)}/h against ${usd(w.steady)}/h steady`
          )
          .join('; ')
      : ''
  const parts = counted.map((w) => {
    const label = w.window?.label ?? w.ref.id
    const pct = Math.round(w.window?.percent ?? 0)
    return (
      `${label} ${pct}% used — ${usd(w.remainingUsd)} left, ${w.hoursLeft.toFixed(1)}h to reset ` +
      `(${usd(w.pressure)}/h, ${w.observed ? 'observed' : 'inferred, reset projected'})`
    )
  })
  for (const w of skipped) {
    parts.push(`${w.window?.label ?? w.ref.id} skipped: ${w.skipped}`)
  }
  if (counted.length === 0) {
    const missing = r.staleEvidence
      ? 'its probe reading is stale'
      : 'no trusted billing-window reading to price'
    return {
      value: 0,
      basis:
        `${r.basis} but ${missing}` +
        (parts.length ? `: ${parts.join('; ')}` : '') +
        ' — unknown scores 0, never a guess',
      behindScheduleWindowIds,
      skipNote
    }
  }
  if (!(denominator > 0)) {
    return {
      value: 0,
      basis: `${r.basis}: ${parts.join('; ')}; no measurable expiry pressure in this field`,
      behindScheduleWindowIds,
      skipNote
    }
  }
  const value = r.rawPressure / denominator
  return {
    value,
    basis:
      `${r.basis}: ${parts.join('; ')}; field denominator ${usd(denominator)}/h; ` +
      `prepaid ${value.toFixed(2)}`,
    behindScheduleWindowIds,
    skipNote
  }
}
