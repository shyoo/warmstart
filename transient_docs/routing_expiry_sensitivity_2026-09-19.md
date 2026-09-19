# Routing Model v1.2 — prepaid-expiry sensitivity plan (2026-09-19)

Design and implementation plan for t552. Status remains in `HANDOFF.md`; the maintained description
of the model that actually runs remains `docs/routing.md` until this plan is implemented.

Measured against `9d16abc` (Routing Model v1.1) on 2026-09-19.

---

## 1. Finding: v1.1 does not preserve expiry urgency

The requested invariant is:

> With the same dollar value left, a window resetting in one hour carries 24 times the expiry
> pressure of one resetting in 24 hours. All else equal, the one-hour candidate must win.

v1.1 knows that both allowances are likely to expire, but not *how fast the remaining money must be
spent*. Its subscription value is:

```
projectedSpend = timeLeftFraction * usedFraction / elapsedFraction
forfeitShare   = max(0, unspentFraction - projectedSpend) / unspentFraction
prepaid        = 0.25 + 0.75 * forfeitShare
```

For a Claude Pro weekly window, the cost model prices the whole window at **$4.5996**. Interpreting
"80% left" literally gives **$3.6797** left. Running v1.1's formula for otherwise identical workers
produces:

| Worker | Used | Left | Reset | `forfeitShare` | `prepaid` | Balanced contribution |
|---|---:|---:|---:|---:|---:|---:|
| A | 20% | $3.6797 | 24h | 0.958333 | 0.968750 | +1.162500 |
| B | 20% | $3.6797 | 1h | 0.998503 | 0.998877 | +1.198653 |

The `prepaid` signal is only **1.031×** larger for B. It saturates as soon as almost all the
remainder is projected to expire. If "80%" meant used rather than left, the verdict is unchanged:
the values are 0.500000 and 0.982036, only 1.964× apart. The current model therefore fails the
requested 24× sensitivity under either reading.

The numbers above were reproduced with the exported `forfeitShare` arithmetic at this commit; they
are not live-account observations. The $4.5996 weekly value comes from the checked-in Claude Pro
plan via `CostModel.priceOfWindowUsage`, whose derivation is maintained in `docs/cost-model.md`.

## 2. v1.2 definition

Keep the term name and its objective weight (`prepaid = 0.6 + 2.0×cost`), but replace the
subscription-side value. `prepaid` becomes a signed measure of *prepaid expiry pressure*:

- `−1`: this dispatch spends marginal money now (usage credits or a priced API rate), unchanged.
- `0`: local/free, unknown billing, or no trustworthy priced reset evidence.
- `0 .. 1`: subscription allowance, normalized from remaining prepaid dollars per hour.

For each trusted billing window `w` offered by candidate `i`:

```
remainingUsd(i,w) = costModel.priceOfWindowUsage(plan, 100 - percentUsed)
hoursLeft(i,w)    = (resetsAt - now) / 1 hour
pressure(i,w)     = remainingUsd(i,w) / hoursLeft(i,w)
steady(i,w)       = fullWindowUsd(i,w) / (billingWindowDays * 24)

rawPressure(i)    = sum pressure(i,w)
steadyPressure(i) = sum steady(i,w)
D                 = max(all rawPressure, all steadyPressure)
prepaid(i)        = rawPressure(i) / D
```

`D` is one denominator shared by the whole candidate field. The steady-pressure floor anchors the
scale to the ordinary rate required to use a full allowance across its whole window; the field's
largest actual pressure raises that denominator when expiry is more urgent. Therefore values remain
bounded at 1 without destroying ratios between candidates.

For the motivating pair:

```
rawPressure(A) = $3.6797 / 24h = $0.1533/h
rawPressure(B) = $3.6797 /  1h = $3.6797/h
D              = $3.6797/h
prepaid(A)     = 1/24
prepaid(B)     = 1
```

The expiry term and its balanced contribution are exactly **24×** larger for B, and B wins when all
other terms are equal. The *total score* is not required to be 24×: cache, held context, fitness,
pace, and the other independently measured facts must still be allowed to matter.

### Rules that keep the evidence honest

1. **No pricing arithmetic in scoring.** It asks `CostModel.priceOfWindowUsage` for both remaining
   and full-window dollars, preserving plan resolution and pooled subscription shares.
2. **No trusted reset, no pressure.** A null/past reset, stale ordinary probe, unpriced plan, or
   unresolved billing window contributes 0 and says why. No 0.25 standing guess remains.
3. **Vendor-silent fresh windows still count.** `inferredFreshWindows` remains the one narrow source
   of inferred 0%-used windows; their basis must continue to say that the reset was projected.
4. **Pay-now candidates do not enter `D`.** Their value remains −1; including them in a positive
   subscription normalizer would mix a bill with a sunk allowance.
5. **Pool shares remain real.** On a pooled plan, each matching window's dollar pressure is priced
   with its `BillingWindowRef.share`, then distinct windows are summed. A window is never counted
   twice through two aliases.
6. **The hard gate is unchanged.** A trusted window at the 92% high-water mark is still ineligible
   unless the existing override/credits rules apply. A preference never widens authority.

### Interaction with `quotaRisk`

The two terms must not reward and punish the same billing fact. A billing window is *behind its
spend schedule* when `pressure(i,w) > steady(i,w)`. Only such windows are omitted from the
`windowRisk` loop and eligible for the existing non-session `allowed_warning` suppression.
`rejected`, session-window warnings, and an `at_risk` reserve still saturate `quotaRisk`, unchanged.

This replaces v1.1's `forfeit > 0` predicate with the equivalent question in the new unit. An
on-schedule or ahead-of-schedule billing window remains subject to ordinary quota-risk scoring.

## 3. Implementation sequence

### A. Compute field-wide evidence before scoring

1. Extract v1.1's subscription classification from `scoring.ts` into
   `src/daemon/prepaid.ts`. The module exposes a raw evidence function and a field normalizer; it
   receives all state as arguments and reads no scheduler binding at module evaluation time.
2. After `chooseTarget` has collected `rawCandidates` (the same point where it already calculates
   the field-wide cheapest price), compute one raw prepaid record per candidate and `D` once.
3. Pass the finalized `PrepaidTerm` into `scoreCandidate`; do not recompute it there. Keep its
   priced remainder, reset age, raw `$ / h`, denominator, normalized value, plan-resolution source,
   and inferred/observed status in the term basis.
4. Replace singular `forfeitWindow` with the set of behind-schedule billing-window ids used by
   `quotaRisk`. Delete `forfeitShare` and its minimum-elapsed guard: dollars per remaining hour needs
   no pace extrapolation and is defined as soon as a trusted window/reset exists.

### B. Version and operator surface

1. Set `ROUTING_MODEL_VERSION` to `1.2` and change its comment to name the new value derivation.
   The weight formula itself does not change; the meaning of `prepaid.value` does.
2. Update `scoreLegend` and `RoutingOverview.TERM_NOTES`. The latter must say the value is normalized
   remaining prepaid dollars/hour and that 0 can mean unmeasurable, not "safe."
3. Keep each stored routing decision self-explaining through its term basis and published formula.
   No database migration is needed: candidate terms are stored as JSON and old v1.1 rows retain the
   exact values/bases/formulas that actually selected them.

### C. Tests

Add pure tests for the evidence and normalizer, then integration tests through `chooseTarget`:

- Same priced remainder, 24h versus 1h: normalized values are `1/24` and `1`, balanced contributions
  have a 24× ratio, B is chosen with `basis: 'score'`, and no controller consult is queued.
- Repeat with 80% used (rather than 80% left) to pin the ratio independently of that wording.
- A plan 10× dearer at the same percentage/time has 10× raw pressure; equal dollars/time across
  different plans remain equal.
- A pooled plan uses the cost model's pool share exactly once.
- Null/past reset, stale ordinary probe, unknown billing, and unpriced plan each score 0 with a
  distinct basis; a vendor-silent inferred fresh window continues to score.
- Usage-credit/API pay-now remains −1 and cannot change the field denominator.
- A behind-schedule billing window is skipped by `quotaRisk`; an on-schedule one, a 5h/session
  warning, `rejected`, and `at_risk` are not.
- Stored decision JSON includes the dollar remainder, hours remaining, raw pressure, denominator,
  and normalized value used to choose the winner.

Delete or rewrite the v1.1 `forfeitShare` reference tests; leaving them green beside a new algorithm
would preserve two competing definitions of `prepaid`.

## 4. Documentation owed by the implementation

- `docs/routing.md`: v1.2 in the weights section; replace §3.3a's pace/forfeit formula, reference
  table, worked example, and `quotaRisk` skip rule with the field-normalized pressure definition.
- `docs/cost-model.md`: state that routing reuses `priceOfWindowUsage` to value remaining prepaid
  allowance; do not duplicate its dollar formula.
- `src/renderer/src/components/RoutingOverview.tsx`: update the displayed term definition and add
  the 24h/1h worked arithmetic to the paper.
- `docs/ui.md`: replace the stale literal "Routing Model v1.0" example with the version constant's
  current output or version-neutral wording.
- `README.md`: make the routing summary name expiration pressure only if the concise public claim
  remains accurate after the tests above.
- `HANDOFF.md`: record v1.2 as implemented only after the behavior and full required checks pass;
  remove this plan from the next-work statement then.

`docs/data-model.md` is not owed unless implementation chooses to add a first-class model-version
column. The plan deliberately does not: the existing JSON ledger already preserves the arithmetic
that ran, and a migration would not reconstruct an honest version for old rows.

## 5. Acceptance gate

Implementation is complete only when all of these are true:

1. The exact A/B test records `prepaid(B) / prepaid(A) = 24` within floating-point tolerance and B
   wins with all other terms equal.
2. Every positive `prepaid` basis names remaining dollars, remaining time, raw dollars/hour, the
   common denominator, and whether each quota window was observed or inferred.
3. Unknown evidence stays 0; the 92% gate and pay-now −1 behavior are unchanged.
4. Analytics and `docs/routing.md` describe the same formula the scorer runs, and the model title
   reads **Routing Model v1.2**.
5. `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build` pass after the implementation.
