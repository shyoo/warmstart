# What a run cost in money — implementation plan (2026-09-02)

Status: **implemented 2026-09-02.** All four questions in §9 are decided and §1–§8 are built and
checked (`typecheck` · `lint` · `test` 1,519 · `build` · `test:ui` 231). ⚠️ Nothing here has been
read against a real invoice, and none of it has run in flight. The permanent record is
`docs/cost-model.md` §13 — this file is the reasoning, not the status.

Goal: a dollar figure per run, and an accumulated dollar figure per task, derived from the fraction
of a subscription's *weekly* window the run consumed. Shown in the Tasks table and the task thread,
stacked over the token count that is there today.

---

## 1. What is already in the database (measured, not assumed)

Read on 2026-09-02 from a copy of this install's `multi_agent_controller.db` (236 runs).

| fact | number |
|---|---|
| runs total | 236 |
| runs carrying **both** `quota_before_json` and `quota_after_json` | 158 (67%) |
| runs overlapping another run **on the same worker** | 49 of 234 ended runs (21%) |
| weekly-window readings where `after < before` (a reset crossed the run) | 4 |

Window ids actually written, per adapter — ⛔ **these are not the ids in `costmodels/*.json`**, which
is why the plan below matches windows by a declared list rather than by equality:

| adapter | window ids seen on runs |
|---|---|
| `claude-code` | `session`, `weekly_all` |
| `antigravity-cli` | `5h`, `weekly:gemini`, `5h:claude-and-gpt`, `weekly:claude-and-gpt` |
| `openai-compatible` (free) | `30d` — **one window, and it is monthly, not weekly** |
| `openai-compatible` (paid) | `5h`, `7d` |
| `local-llm` | none |

⭐ **The Codex free→paid switch does not need to be guessed from the model.** The window *shape* is
the signature: every codex run up to 2026-09-01 21:28Z reports a single `30d` window (the `plan_type:
"free"` shape documented in `openai-compatible.ts`), and every run from 2026-09-02 03:46Z reports
`5h` + `7d`. 8 runs on the free side, 16 on the paid side, no overlap and no ambiguity. This is a
*measurement of this install's own rows*, so the backfill is exact rather than inferred.

⚠️ **`resets_at` is not a reset detector here.** Over 1,263 consecutive weekly-window samples,
`resets_at` moved forward **384** times while the percentage dropped only **6** times — a rolling
window re-reports its horizon constantly. The percentage falling is the honest signal, and it is what
§4 uses.

⚠️ `ClaudeFirst`'s 404 quota samples all predate migration 26 and carry `window_id = ''`, so they are
unusable for attribution. Its runs fall back to their own before/after snapshots.

---

## 2. Plans become data, next to the prices that are already data

`AGENTS.md`: *"No pricing arithmetic inline. Ask the cost-model object."* and *"Never branch on an
adapter or mode name."* Both apply here, so the plan catalogue is a new `plans` block in each
`costmodels/*.json`, and every provider difference is expressed as a value in it.

```jsonc
// costmodels/anthropic.subscription.2026-08.json
"plans": {
  "billing_window": {
    "days": 7,
    // In priority order, matched against the window ids the ADAPTER emits (§1), by equality
    // then by containment. Never against the ids in this file's own `quota.windows`.
    "match": ["weekly_all", "7d", "weekly"],
    // When the provider meters more than one pool, disambiguate with the run model's `pool`.
    "pooled": false
  },
  "default_plan": "pro",
  "catalog": [
    { "id": "pro",     "label": "Claude Pro",     "monthly_usd": 20,  "match": ["pro"] },
    { "id": "max_5x",  "label": "Claude Max 5×",  "monthly_usd": 100, "match": ["max_5x", "max"] },
    { "id": "max_20x", "label": "Claude Max 20×", "monthly_usd": 200, "match": ["max_20x"] },
    { "id": "free",    "label": "Claude Free",    "monthly_usd": 0, "priced": false, "match": ["free"] }
  ]
}
```

- `match` is matched, case-folded, against the vendor's own `WorkerIdentity.subscriptionType`
  string — which this fleet already records verbatim (`pro`, `Plus`, `Google AI Pro`).
- `priced: false` is the **n/a** state, and it is not `monthly_usd: 0`. A free plan has no price per
  percent, so it renders `n/a`, per the ask. `local.llm.*` gets `"plans": { "priced": false }` whole.
- Codex additionally needs a **shape** discriminator, because the identity string says `Plus` today
  and said nothing useful when the account was free:

```jsonc
// costmodels/openai.codex.2026-08.json
"catalog": [
  { "id": "free", "label": "Codex Free", "monthly_usd": 0, "priced": false,
    "match": ["free"], "detect": { "windows_all_of": ["30d"], "windows_none_of": ["7d"] } },
  { "id": "plus", "label": "ChatGPT Plus", "monthly_usd": 20,
    "match": ["plus"], "detect": { "windows_all_of": ["7d"] } },
  { "id": "pro",  "label": "ChatGPT Pro",  "monthly_usd": 200, "match": ["pro"] }
]
```

`detect` beats `match` when a run carries its own reading, because the shape is evidence from the run
itself and the identity string is a belief about *now*. Antigravity gets
`"billing_window": { "days": 7, "match": ["weekly"], "pooled": true }` so `weekly:gemini` and
`weekly:claude-and-gpt` are told apart by the run model's declared `pool` (§9 Q2 decides how the one
$20 is charged across the two).

**New `CostModel` methods** (all arithmetic stays inside the class):

```ts
resolvePlan(input: { subscriptionType?: string|null; windowIds?: string[] }): PlanRef | null
billingWindowFor(windowIds: string[], pool?: string|null): { id: string; days: number } | null
priceOfWindowPercent(planId: string, percent: number, pool?: string|null): { usd: number; basis: string } | null
```

`priceOfWindowPercent` is the whole formula, in one place:

```
usd = monthly_usd × pool_share × (billing_window.days / 30.4375) × (percent / 100)
```

30.4375 = 365.25/12. $20/month over a 7-day window = **$4.5996 per full window**, so 5% = **$0.230**
— the user's "$5 or slightly less" made exact. A 30-day window on the same $20 would be $19.71 per
full window; that path only exists for free Codex, which is `priced: false` anyway.

---

## 3. Schema: migration 35

```sql
alter table runs add column plan_id     text;  -- resolved catalogue id, e.g. 'pro' / 'plus'
alter table runs add column plan_raw    text;  -- the vendor's own string, verbatim, unparsed
alter table runs add column plan_source text;  -- 'identity' | 'window_shape' | 'neighbour' | 'default'
```

Three columns rather than one JSON blob: they are queried (`group by plan_id`) and `plan_source` is
the *basis* that AGENTS.md requires every cost belief to carry.

Written at `startRun()` from the chosen worker's identity, and **re-resolved once** when
`setRunQuota(run, 'after')` lands, because that is the first moment the window shape is known. The
re-resolution only ever upgrades `plan_source` toward `window_shape`; it never overwrites a plan a
person pinned (§9 Q4).

**The backfill is inside the same migration**, replay-safe (`hasColumn` guard, and an
`update … where plan_id is null` body so a rerun is a no-op):

1. If the run's own `quota_before_json`/`quota_after_json` window ids satisfy a catalogue entry's
   `detect` → that plan, source `window_shape`. *(This is what correctly splits the 8 free Codex runs
   from the 16 paid ones.)*
2. Else the nearest run in time on the same worker that resolved by shape → source `neighbour`.
3. Else the worker's `identity_json.subscriptionType` through `match` → source `identity`.
4. Else the provider's `default_plan` → source `default`. ⚠️ Per the ask: when Codex is unsure,
   assume the **paid** account, never free — guessing free would silently print `n/a` over real money.

---

## 4. `src/daemon/price.ts` — the attribution

A pure module. No database handle, no clock of its own: it takes rows and returns verdicts, so every
branch in §5 is reachable from a unit test with a literal fixture.

```ts
export type PriceReason =
  | 'measured'        // one run held the window for its whole life
  | 'shared_window'   // parallel runs; the split is an estimate → renders with '*'
  | 'no_reading'      // missing before or after → n/a
  | 'window_reset'    // the window rolled over mid-run → n/a
  | 'no_window'       // the provider reports no weekly window → n/a
  | 'unpriced_plan'   // free / local → n/a
  | 'no_plan'         // plan could not be resolved at all → n/a

export interface RunPrice {
  usd: number | null          // null ⇒ n/a, and `reason` says which n/a
  percent: number | null      // the share of the weekly window attributed to this run
  estimated: boolean          // the '*'
  reason: PriceReason
  basis: string               // one sentence, straight into the tooltip
  planId: string | null
  planLabel: string | null
  windowId: string | null
  parallelRunIds: string[]
}
```

**Algorithm**, per `(worker, billing window)`:

1. **Timeline.** Every reading of that worker+window: `quota_samples` rows (`percent`, `sampled_at`)
   ∪ the `quotaBefore`/`quotaAfter` snapshots carried by the worker's runs. Deduped by timestamp,
   sorted. The samples are what make this better than a per-run subtraction — there are hundreds of
   them, so a segment boundary usually falls *inside* a long run rather than only at its ends.
2. **Anchors.** A run needs a reading at or before `startedAt` and one at or after `endedAt`, both
   inside a staleness bound. Missing either → `no_reading`, n/a. A still-running run is priced up to
   the newest reading and always carries `estimated`.
3. **Reset.** Any consecutive pair inside a run's span where the percentage *falls* by more than a
   rounding epsilon is a rollover. Every run overlapping that pair → `window_reset`, n/a. ⛔ This is
   the 98% → 2% case in the ask, and it is deliberately n/a rather than clamped: the run's real cost
   is unknowable once the baseline has moved.
4. **Segments.** For each consecutive pair `(t₁,p₁) → (t₂,p₂)`, `delta = p₂ − p₁`. Active runs are
   those whose `[startedAt, endedAt]` intersects `(t₁, t₂]`. Each active run takes
   `delta × overlapₘₛ / Σ overlapₘₛ`. A segment with **no** active run is *unattributed* — that is
   the operator's own interactive use of the account, and charging it to a task would be a lie.
5. **Sum.** `run.percent = Σ shares`. `estimated = true` if any segment had more than one active run,
   or any reading involved was `stale`, or the run is still in flight. `parallelRunIds` collects who
   it shared with, for the hover message.
6. **Price.** `costModel.priceOfWindowPercent(planId, percent)`.

Reproducing the worked example from the ask exactly — task1 `[t1,t3]`, task2 `[t2,t4]`, readings
0 / 5 / 15 / 17%:

| segment | delta | active | task1 | task2 |
|---|---|---|---|---|
| t1→t2 | 5 | task1 | +5 | |
| t2→t3 | 10 | both | +5 | +5 |
| t3→t4 | 2 | task2 | | +2 |
| | | | **10%** | **7%** |

⚠️ Duration-weighting inside a segment is a strict generalisation of the ask's equal split: when both
runs span the whole segment the weights are equal, and it only differs where a run boundary falls
*inside* a segment, which is exactly the case an equal split gets wrong.

This install has a real instance to test against: runs `70d7e9` (23:03:28–23:11:13) and `c01c7d`
(23:05:28–23:11:20) on ClaudeSecond, weekly `62% → 64%` and `62% → 62%`.

**Caching.** `priceAll()` walks every run and sample once (236 and ~2,000 rows today —
sub-millisecond) and memoises. A `bumpPricingEpoch()` called from `startRun`, `endRun`, `setRunQuota`
and the quota store invalidates it. ⛔ Not stored in a column: the answer for a run changes when a
*later* run's overlap is discovered, and a stored number would be stale the moment a parallel run
ended.

---

## 5. Wiring

| file | change |
|---|---|
| `src/shared/tasks.ts` | `RunPrice` type; `Run.price: RunPrice \| null`; `Budget.spentUsd: number \| null`, `spentUsdEstimated: boolean`, `spentUsdPartial: boolean` |
| `src/daemon/tasks.ts` | `toRun`/`toRuns` attach `price`; task budget mapping attaches the three `spentUsd*` fields, summed over the task's runs |
| `src/daemon/costmodel.ts` | `plans` in `CostModelFile`; the three methods in §2 |
| `src/daemon/db.ts` | migration 35 + backfill |
| `src/daemon/scheduler.ts` | stamp `plan_*` at dispatch; re-resolve after the closing reading |
| `costmodels/*.json` (4 files) | the `plans` block |

`spentUsdPartial` is true when any of the task's runs is n/a — the total is then a **lower bound**,
and the tooltip says so rather than presenting a short number as a complete one.

---

## 6. UI

A new `money()` in `src/renderer/src/lib/format.ts`: `null → 'n/a'`, `0 → '$0.00'`,
`0 < x < 0.01 → '<$0.01'`, else `$X.XX`.

**Tasks table** — `Tokens` header becomes `Price`, the cell stacks, and the token count takes the
small faint treatment `.tbl-model` already uses for the model line:

```
Price
$0.10*
4.8M
```

**Task thread**, two places:

- the task summary `Fact`, today `tokens: 4.8M spent in total`, becomes `price: $0.10*` with
  `4.8M tokens` faint beneath;
- each `RunRow`'s `token spent:` fact becomes `price:` with the same stack.

The `*` is rendered by the same helper everywhere and always carries a `title`:

> This run shared its account with N other runs, so its share of the window is an estimate, not a
> measurement. Overlapped: t121 run 2, t124 run 1.

and each n/a its own reason, e.g. *"the account's weekly window reset while this run was in flight,
so the difference either side of it is not a cost"*, *"Codex Free has no subscription price to divide"*.

⚠️ The existing `usage:` row showing `weekly 62% → 64%` **stays**. Per §5 of `docs/cost-model.md` the
window delta and the transcript token count are never reconciled; the price is derived from the first
and shown beside the second, and hiding the percentages would remove the reader's only check on it.

---

## 7. Tests

`src/daemon/price.test.ts` (new, the bulk):

- the ask's worked example, asserting **10%** and **7%** exactly;
- three-way overlap; partial overlap where a run boundary falls inside a segment (duration weighting
  differs from an equal split, and that is asserted);
- reset mid-run (98% → 2%) → n/a `window_reset`, for **both** runs sharing the window;
- missing before / missing after / neither → n/a `no_reading`;
- a segment with no active run is dropped, not redistributed;
- stale readings set `estimated` without changing the number;
- a run in flight is priced and always `estimated`;
- zero delta → `$0.00`, not n/a.

`src/daemon/costmodel.test.ts` / `adapters.test.ts`:

- $20 / 7d / 5% = **$0.230**; $20 / 7d full window = **$4.5996**;
- every window id §1 records as actually emitted is matched by its provider's `billing_window`;
- free and local plans answer `priced: false`, and their runs render n/a rather than $0.00;
- Codex `detect` splits `["30d"]` from `["5h","7d"]`, and the two entries cannot both match.

`src/daemon/db.test.ts` (migration): rewind `user_version` to 34 and replay — asserting the codex
free/paid split lands on the shape rather than the identity string, that a second replay changes
nothing, and that a run with no evidence at all lands on the **paid** default.

`src/renderer/src/lib/format.test.ts`: `money()` across null / 0 / 0.004 / 0.23 / 12.5.

Plus `test/ui.test.mjs` coverage that the Tasks header reads `Price` and the cell carries both lines.

---

## 8. Docs

- `docs/cost-model.md` new §13, with the formula, the measured Codex shape split, the
  parallel-attribution rule and the five n/a states — each with the date it was measured.
- `HANDOFF.md`: one ⭐ entry, and the ⚠️ that none of it has run in flight yet.
- `AGENTS.md`: no new rule. This lives under the existing *"pricing is data, ask the cost model"*.

---

## 9. Open questions

**Q1 — Codex plan and price. ✅ ANSWERED 2026-09-02: Plus @ $20/month, and the free→paid split is
backfilled from the measured window shape (§1), not from the model name.** `auth.json` reports
`subscriptionType: "Plus"` for CodexFirst; ChatGPT **Plus** is $20/month and ChatGPT **Pro** is
$200/month, so the ask's "$20 … Codex Pro" is read as *the paid plan, at $20*.

**Q2 — ✅ ANSWERED 2026-09-02: (b), an 80:20 split of the one $20.** The user's words: *"let me take it
back to use heuristics, which is 80:20 for Antigravity. Claude/GPT model draws much faster, so let me
use heuristics. Go with 80:20. (That means, Gemini is $16 while Claude/GPT is $4.)"* So
`pool_shares: { gemini: 0.8, claude: 0.2, gpt: 0.2 }`, and the shares sum to 1 so a week that fills
both pools reports exactly one $4.60 week. Antigravity meters two pools against one $20 subscription (`weekly:gemini` and
`weekly:claude-and-gpt`). Options: (a) charge each run the full $20-per-month basis against whichever
pool its model drew on — simple, but a week that fills both pools reports ~$9.20 of spend against a
$4.60 week; (b) split the $20 across the pools; (c) charge against whichever pool moved most.

**Q3 — ✅ ANSWERED 2026-09-02: the full `quota_samples` timeline.** Use the full `quota_samples` timeline (hundreds of readings, so segment
boundaries land inside long runs and the split is much closer to the truth), or only the per-run
before/after snapshots (exactly the ask's sketch, coarser)? I recommend the samples.

**Q4 — ✅ ANSWERED 2026-09-02: no override; auto-resolve only.** Auto-resolution covers every account on this
install today. An override matters the day a vendor string changes or somebody upgrades to Max, and
costs a settings field plus a `plan_source: 'pinned'`.
