# Per-agent, per-model cost scale in the estimator (2026-08-30)

## The complaint

> Each agent and model eats up tokens in a different scale. Antigravity uses way more token than
> Claude, and Claude Sonnet 5 ate more than Opus 5. A median across agents and models yields a
> suboptimal decision.

## What is actually true here — measured, not asserted

Source: this install's `multi_agent_controller.db`, snapshot 2026-08-30T20:05, 92 runs (73 completed).
Grouped by the run's session `(adapter_id, model)`. "priced" = `input + 5·output + 0.1·cache_read +
1.25·cache_write`, the §1/§3 multipliers, shown only to test whether pricing explains the spread.

| adapter / model | completed runs | median total | median priced | warm starts |
|---|---:|---:|---:|---:|
| antigravity-cli / gemini-3.7-flash-medium | 35 | 12,477,352 | 2,033,366 | 7 |
| antigravity-cli / (model unrecorded) | 17 | 8,630,903 | 1,431,917 | 3 |
| antigravity-cli / claude-sonnet-4-6 | 1 | 7,656,282 | 1,078,598 | 0 |
| claude-code / claude-opus-5 | 3 | 2,672,121 | 305,605 | 1 |
| openai-compatible / (unrecorded) | 3 | 322,805 | 61,490 | 0 |
| claude-code / claude-sonnet-5 | 14 | 153,091 | 21,948 | 8 |

⛔ **The spread is 81× between the two keys with the most runs** (agy/gemini vs claude-code/sonnet-5),
and pricing does not explain it — priced, the same pair is 93×. One median over all of them is not a
central tendency of anything. The user's first claim is confirmed, larger than stated.

⚠️ **The second claim is not confirmed by this install's data.** Sonnet 5's median run is *smaller*
than Opus 5's (153k vs 2.67M). Two reasons visible in the same query: Opus has n=3 completed runs,
and 8 of Sonnet's 14 were warm starts against 1 of Opus's 3. Per *turn* the two are nearly equal
(sonnet 61.8k cache read, opus 67.7k, n=300/296 turns) — so at model level the difference is turn
count, not per-turn appetite. This is why warm/cold has to be a dimension and not noise.

⛔ **Zero tasks have ever run on two different keys** (0 of 54 tasks with runs). There is no paired
data, so a matched-pairs estimator has nothing to fit and the confounder — *does agy cost more, or
does agy get the bigger tasks?* — cannot be measured away today. The factor must therefore be a
marginal median, shrunk by sample count, clamped, and always reported with its basis.

⛔ **The `calibration` table is empty** (0 rows). `remainingTokens()` returns null on every worker, so
"share of this worker's own quota window" — the unit that would be most honest for subscription
accounts — is not computable yet. It is a later level, not this change.

⚠️ Antigravity's metering has a different shape: 36 turn rows for 35 runs (one aggregate usage record
per run, against ~21 per run for claude-code), `cache_write` always 0, `input` averaging 616k/turn.
Cross-provider token totals are therefore *approximately* comparable at best. Documented, not hidden.

## Design

`estimateTask` becomes two factors instead of one number:

```
expected(task, key) = size(task) × factor(key)
```

- `key` = `(adapter_id, model)` of the candidate that would run it.
- `factor(key)` = `median(key) / median(all)` over completed runs, **shrunk** toward 1 by sample
  count — `1 + (ratio − 1)·n/(n + K)` — and clamped, so one run cannot mint a 90× multiplier.
- `size(task)` = median over completed runs of `total / factor(that run's key)`, i.e. the same
  history de-scaled into agent-neutral units. With no key supplied this is what `estimateTask`
  returns, so every existing caller keeps a working, unchanged-in-shape answer.
- Warm/cold is a second learned factor from `runs.started_warm`, applied when the candidate's warmth
  is known — otherwise the estimate would keep confusing "cheap agent" with "reused conversation".
- Every returned estimate carries `basis`, `samples` and `confidence` as it does today; the factor
  and its sample count go into the basis string, because a 12× multiplier from 3 runs and one from
  35 are different objects.

## Work

1. **Schema (migration v22).** `runs.adapter_id`, `runs.model` written at run start; backfill from
   `sessions`. Sessions are deleted and rewritten; the record of what a run cost must not depend on
   the conversation still existing. (17 antigravity runs already have no model for this reason.)
2. **`estimator.ts`.** `costFactors()`, `estimateFor(task, key)`, `estimateTask(task)` unchanged in
   signature. New `estimator.test.ts` — there is none today.
3. **`overrunFactor`.** Divide a live run by the estimate *for its own key*, not the fleet median.
   This is the change that most directly stops the watchdog being wrong: on today's data an agy run
   is 81× the fleet median before it has done anything unusual.
4. **Consumers.** `judgment.riskOf` (parent-budget gate), `api.task.estimate` (accepts an optional
   worker), `scheduler`'s route-consult floor.
5. **Routing** — gated on the decision below.
6. **UI.** The learned factors, with sample counts, on the Cost screen; per-worker expected cost in
   the task pane.
7. **Docs.** `docs/cost-model.md` §10 gains this measurement; `HANDOFF.md` and
   `transient_docs/changes_history.md` updated.

## What landed, and what it does to the numbers

Shipped 2026-08-30. Decisions taken with the operator: priced input-token-equivalents as the unit;
estimator and gates only, **no routing change**; keyed on `(adapter, model)` with an adapter-only
fallback level and warmth as a separate factor; shrinkage by sample count with a wide clamp.

Two pieces of the arithmetic changed shape once they met the real data:

- **Shrinkage is in log space** (`ratio^(n/(n+5))`). The linear form flattened the measured 80x
  spread to 5x — it pulls ×0.02 almost all the way to 1 while barely touching ×2 — and on a
  two-agent fleet it inverted which agent looked dearer.
- **Factors are measured against the fleet's geometric mean, not its median.** Run counts are
  lopsided (35 Antigravity against 14 Sonnet) and a pooled median of a two-humped distribution lands
  inside the busier hump, so every factor would have been measured against the busiest agent.

Run over a snapshot of the live install (73 completed runs, 2026-08-30):

| key | n | factor | estimate for one task, raw / priced |
|---|---:|---:|---|
| antigravity-cli / gemini-3.7-flash-medium | 35 | ×2.96 | 8,651,360 / 1,403,769 |
| antigravity-cli / (model unrecorded) | 53 | ×2.94 | — |
| claude-code / claude-opus-5 | 3 | ×0.79 | 2,316,886 / 375,938 |
| openai-compatible / (unrecorded) | 3 | ×0.43 | — |
| claude-code / claude-sonnet-5 | 14 | ×0.10 | 286,153 / 46,431 |
| *fleet-neutral — what all of them used to get* | 73 | ×1 | 2,921,371 / 474,022 |

Warmth, measured after the agent factor is divided out: ×0.92 warm (19 runs), ×1.21 cold (47).

⚠️ **On the Sonnet-versus-Opus claim, the data still disagrees with the impression.** Opus lands at
×0.79 against Sonnet's ×0.10 — Opus runs cost about eight times a Sonnet run here — on 3 completed
Opus runs against 14, with 8 of Sonnet's warm against 1 of Opus's. Per *turn* the two are within 10%
of each other, so what the factor is really measuring is turn count. It will move as Opus accumulates
runs; that is what the sample count on the Cost screen is for.

⛔ **The migration collision predicted here happened, and was resolved on the rebase.** The live
install's database was already at `user_version = 22` without `runs.adapter_id`, because
`consults.detail` had taken that number on another branch. Both are kept: `consults.detail` stays 22
and this one is **23**. An install carrying the other 22 picks up 23 on the next open, which is what
numbered migrations are for.
