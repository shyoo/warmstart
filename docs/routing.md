# Task Routing & Judgment Decisions

How Multi Agent Controller decides which worker, session, and moment will run a task.

The scheduler's core loop runs every **10 seconds** and costs **zero tokens**. Every decision is
deterministic arithmetic over measured costs, cache lifetimes, and quota windows. The LLM
controller is consulted only on discrete judgment events when the arithmetic cannot separate two
close candidates on a large task.

> **Audience:** anyone changing how a task is scored, gated or dispatched.
> **Authority for:** the eligibility gates, every scoring weight and its formula, tie-breaking,
> and the controller consult.
> The numbers the weights are made of are [`cost-model.md`](cost-model.md); the loop that calls all
> of this is [`architecture.md`](architecture.md) §2.

---

## 1. Architectural Invariants & Decision Phases

Task routing executes in four sequential phases:

```
┌────────────────────────────────────────────────────────┐
│ Phase 1: Hard Eligibility & Capacity Gates             │
│ (Worker constraints, health, capabilities,             │
│  concurrency slots & session reuse)                    │
└───────────────────────────┬────────────────────────────┘
                            │ (Eligible workers, expanded to (worker, model) pairs)
┌───────────────────────────▼────────────────────────────┐
│ Phase 2: Deterministic Candidate Scoring               │
│ (Per pair: 92% quota cliff on that model's pool, then  │
│  Σ± weight×value — warm, cold, context rot, quota risk,│
│  fitness, price, across 5h/7d windows)                 │
└───────────────────────────┬────────────────────────────┘
                            │ (Ranked candidate pairs: Best & Second)
┌───────────────────────────▼────────────────────────────┐
│ Phase 3: Tie-Breaking & Judgment Consult               │
│ (Clear win / small task: arithmetic decides.           │
│  Near-tie on large task: probe baseline → LLM consult) │
└───────────────────────────┬────────────────────────────┘
                            │ (Selected WorkerChoice)
┌───────────────────────────▼────────────────────────────┐
│ Phase 4: Dispatch & Workspace Claim                    │
│ (Reuse warm session or spawn new session in workspace) │
└────────────────────────────────────────────────────────┘
```

1. **Phase 1 (Hard Gates):** Disqualifies unfit or unavailable *workers* immediately — the account-level gates (§2.1–2.2) know nothing about models yet. A task that cannot run on Worker A may run on Worker B right now.
2. **Phase 2 (Scoring):** ⛔ **The boundary moved here, not into Phase 1.** Each eligible worker is expanded into one candidate per routable model (§2.4) before anything is scored, and the 92% quota cliff is evaluated *inside that per-model loop* (§2.3) rather than once per worker — a multi-pool account (Antigravity) can have its Claude pool blocked at 95% while its Gemini pool sits at 20%, and only the Claude *pairs* are excluded. Every surviving pair then gets a continuous, linear, unitless score. **Higher score wins.**
3. **Phase 3 (Judgment & Tie-Breaking):** If one candidate pair clearly wins (gap > 0.10) or the task is small (< 150k tokens), the arithmetic decides with zero token cost. Only genuine near-ties on large tasks enqueue an LLM consult.
4. **Phase 4 (Dispatch):** Dispatches the task to the chosen session/worker/model or waits on held resources.

---

## 2. Phase 1: Hard Eligibility & Capacity Gates

Before scoring, every worker in the fleet is evaluated against hard admission rules in `src/daemon/scoring.ts`, `src/daemon/residency.ts` and `src/daemon/eligibility.ts`:

### 2.1 Task Constraints & Account Fitness
- **Target constraints:** If `task.constraints.workerId` or `task.constraints.adapterId` is set, only matching workers are considered. ⛔ `workerIds` is the same gate over a **list** — what the composer's Each piece row writes onto every piece of a Plan & Split — and a candidate outside it is *discarded*, never merely scored lower. `modelsByWorker` then gives each named account its own model, because a model id belongs to one CLI and a single `model` alongside a list of accounts from different CLIs would hand at least one of them an id it cannot start on.
- **Account fitness (`accountUnavailability`):** A worker is excluded if it is:
  - Switched off (`enabled: false`)
  - Human-occupied (`humanOccupied: true` — tracked for quota accounting, but never handed automated turns)
  - Not installed (`installed: false`)
  - Signed out (`identity.loggedIn === false`)
  - Quarantined (`health.state === 'suspect'` — failed a dispatch with zero metered turns; the refusal sentence names its own exits, because a hold that reads as permanent gets reported as a deadlock. Cleared by a metered turn, by a background usage probe that comes back with real windows in it, or by pressing Probe)
  - Retired (`health.state === 'retired'`)
- **Capability fit:** If a task requires specific features (`task.constraints.needs`, e.g. `mcp`, `edit`), workers lacking that adapter capability are excluded.

### 2.2 Concurrency & The 1-Slot Session Reuse Rule
Each worker defines `maxConcurrent` (default `1` parallel run):
- `atCapacity(sessions, maxConcurrent, reuse, retained)` counts active work sessions plus retained task reservations on that worker.
- ⛔ **The 1-Slot Continuation Rule:** Reusing an existing idle session (`reuse`) starts **no new process**. Therefore, `reuse` is explicitly **exempt** from the capacity count.
- ⛔ **Retained Task Reservations:** Closed sessions are absent from `sessionsForWorker`. However, tasks parked at `awaiting_human` or tasks still `running` (such as completing/landing work after a one-shot CLI like Codex has exited) still own a slot. `retainedReservations()` counts these uncounted tasks so the scheduler and `spawnSession` do not dispatch into an occupied worker.

```typescript
// src/daemon/residency.ts
export function atCapacity(
  sessions: Session[],
  maxConcurrent: number,
  reuse: Session | null,
  retained = 0
): boolean {
  const busy = sessions.filter((s) => s.purpose === 'work' && s.id !== reuse?.id).length
  return busy + retained >= maxConcurrent
}
```

#### What this means in practice:
- **Worker A has 1 slot, currently executing a turn for Task 1:** Task 2 arrives. Worker A is busy (`busy = 1 >= 1`). Worker A is rejected with `Worker A at capacity`.
- **Worker A has 1 slot, Task 1 is resting at `awaiting_human` with an idle warm session:** The operator replies to Task 1. Task 1 reuses its own warm session (`reuse = s1`). The session count excludes `s1`, so `busy = 0 < 1`. **Task 1 is NOT blocked by its own resting session** and continues immediately.
- **Worker A has 1 slot, Task 1 is resting at `awaiting_human`, and a new Task 2 arrives:** Task 2 cannot reuse Task 1's session (unless session sharing is explicitly enabled). For Task 2, `reuse` is null, so `busy = 1 >= 1`. Task 2 cannot start on Worker A until Task 1's session exits or is evicted.

### 2.3 Quota High-Water Gate (92%)
- **Pool-aware lookup:** Multi-pool workers (such as Google Antigravity, which meters Gemini separately from Claude/GPT) look up the specific quota pool matching each candidate model (`poolFor(worker, model)`).
- **Freshness & Expiry:** Quota readings that have passed their `resetsAt` time or are stale are marked `quotaUnverified: true` and are **not** blocked (allowing CLIs without usage probes to operate). A screen probe may hold a dispatch while its one refresh is in flight, but a provider answer with no windows (including Muse Code's `Currently unavailable`) ends that attempt; it is not a successful-probe gate. The next eligible tick dispatches blind and records the run as unverified rather than deadlocking the account behind its own meter.
- **The 92% Gate (`QUOTA_HIGH_WATER = 92`):** If a trusted pool reading is ≥ 92%, that specific `(worker, model)` pair is excluded with `${worker.label} (${model}) at X% of its window`, and `quotaHoldUntil` is set to the window's `resetsAt` timestamp.
- **The Timed Human Override (`task.overrideQuota`):** 92% and the early wrap-up before a known reset are cautions from this fleet, not vendor rejections. An avoidable mid-run quota preemption first writes a durable 60-second warning (`quota_preempt_json`), posts it to the thread, and exposes **Override preemption** with a live countdown. The watchdog re-reads the trigger after the minute; a changing percentage updates the reason without restarting the deadline. The override lasts until that window resets and lifts the dispatch cut, matching 95% cliff, and early boundary wrap-up, but **never** bypasses `windowRisk` scoring, vendor `rejected` rate-limits, or disabled account gates. A rejection is immediate because the turn has already been refused.

### 2.4 Candidate Expansion to (Worker, Model) Pairs
- **Candidate pairs:** Instead of scoring workers with a single predetermined model, `chooseTarget` evaluates `(worker, model)` pairs iterating `routableModelsFor(worker)`. With an empty allowlist, this returns exactly `[today's resolved model]`, maintaining full backward compatibility.
- **Model pinning:**
  - A warm or reopenable session pins the candidate model (`held.model`).
  - A task constraint (`constraints.model` or `constraints.modelsByWorker`) pins the candidate model.
  - `constraints.modelPolicy: 'inherit'` names no model and still yields exactly one pair: `inheritedModelFor(worker)`, the account's own default resolved against its live quota. ⛔ This is *not* the same as naming nothing — an absent policy (`auto`) is what expands across the allowlist. The New Task composer offers the two as separate answers because they were previously the same blank, and a worker with an allowlist dispatched a model the operator had never seen after picking *Inherit*.
- **Fan-out cap:** To bound scoring time and ledger storage, candidates are capped to 8 models per worker with an informational log.
- **Per-pair quota evaluation:** The quota pool gate evaluates inside the model loop per pair, so a multi-pool worker (e.g. Antigravity) with an exhausted Claude pool (95%) still offers its Gemini candidate pairs.

---

## 3. Phase 2: Candidate Scoring Arithmetic

Every candidate that clears Phase 1 is scored using the objective vector.

### 3.1 Objective Weights
Weights derive from the objective vector `(cost, velocity, quality)` configured globally or per-project/task:

| Term | Direction | Weight Formula (`objective.ts`) | Balanced (`cost 0.30, velocity 0.30, quality 0.40`) | Value Range | Meaning of Value = 1 |
|---|:---:|---|:---:|:---:|---|
| **`cacheWarmth`** | Bonus (+1) | `1.0 + 2.2×cost − 0.6×velocity` | `+1.480` | 0 .. 1 | A full TTL of prompt cache remaining — **the provider's own TTL**, 60m on Anthropic, 30m on Codex |
| **`contextHeld`** | Bonus (+1) | `0.8 + 1.0×cost + 0.4×quality` | `+1.260` | 0 or 1 | A conversation already holds this task's context — **live or reopenable** |
| **`contextRot`** | Penalty (−1) | `0.6 + 1.6×quality` | `−1.240` | 0 .. 1 | Context window is 100% full (starts at >50%) |
| **`projectSwitch`** | Penalty (−1) | `0.3 + 0.6×cost` | `−0.480` | 0 or 1 | Reusable session belongs to another project |
| **`quotaRisk`** | Penalty (−1) | `0.5 + 1.2×cost` | `−0.860` | 0 .. 1 | At 92% of window or vendor rate-limit warning |
| **`cold`** | Penalty (−1) | `0.8 + 2.0×cost − 0.7×velocity` | `−1.190` | 0 or 1 | No conversation to reuse, live or reopenable (pays full cache write) |
| **`capabilityFit`** | Bonus (+1) | `0.7 + 1.3×quality` | `+1.220` | 0 .. 1 | All required task capabilities are present |
| **`fitness`** | Bonus (+1) | `0.4 + 1.6×quality` | `+1.040` | 0 .. 1 | Model agentic coding fitness meeting task complexity bar (`low: 0.35, med: 0.55, high: 0.75`). 0 when unmeasured (`null`), and 0 fleet-wide while no worker has an allowlist (§3.6). |
| **`price`** | Penalty (−1) | `0.5 + 2.0×cost` | `−1.100` | 0 .. 1 | Log ratio of estimated cost relative to cheapest candidate: $\min(1, \max(0, \log(\text{cost}/\text{cheapest}) / \log(8)))$. 0 for cheapest, saturates at 8x; 0 fleet-wide while no worker has an allowlist (§3.6). |
| **`pace`** | Bonus (+1), **signed value** | `0.3 + 1.7×velocity` | `+0.810` | −1 .. +1 | Measured 4x **faster** than the fleet's median task. −1 is 4x slower; **0 is both "exactly average" and "nothing measured"** |
| **`unproven`** | Penalty (−1) | Fixed `0.35` | `−0.350` | 0 .. 1.5 | Account has never completed a metered turn |

⚠️ **`pace` is the only term whose value can be negative**, and deliberately. Every other term
measures a quantity with a floor — there is no such thing as less-than-no prompt cache — while pace
has a real middle: the fleet's own centre. A penalty-only reading would score the fleet's fastest
agent identically to its median one, which is precisely the discrimination the term exists to add.
Its value comes from `pace.ts`: a per-(agent, model) median of **active time** over finished tasks,
expressed as a ratio against the geometric mean of the fleet's task durations, shrunk in log space by
`ratio^(n/(n+4))`, then mapped through `−log(factor)/log(4)` and clamped to `[−1, +1]`.

- ⛔ **Active time, never wall-clock.** A task dispatched at 09:00, blocked on a question at 09:04 and
  answered at 17:00 took four minutes of agent work. `activetime.ts` is the only place that
  subtraction is done, and this reads it rather than repeating it.
- ⛔ An unmeasured key scores **0**, never a guess — the same rule an untrustworthy quota reading
  follows.
- ⛔ **A run reaped by a daemon restart is not a measurement, and is clamped at source.**
  `finishRun(run.id, 'terminated', 'orchestratord restarted')` writes `ended_at` at the moment
  orchestratord came *back*, so a run alive when the machine slept records the downtime as work.
  Measured on this install 2026-09-06: 8 such runs, **875 minutes** between them, one of them 635
  minutes alone — which is why t52 reported 639 minutes against a 9.8-minute median on the same
  model. `activetime.ts` stops the clock at the last turn observed inside the run's own span, and
  contributes **nothing** where no turn exists at all (an antigravity run leaves none by
  construction). ⚠️ That makes such a task read as *untimed*, not as fast.
- ⚠️ A task an operator has marked `stats_excluded` is out of this median as well as out of
  Statistics. See `Task.excludedFromStats`.
- ⛔ The measurement **cannot separate** *"that agent is slow"* from *"that agent gets the long
  tasks"*: no task on this fleet has been completed twice on two different keys. That is why the
  factor is shrunk, why the weight is modest, and why the basis is printed beside every number in
  Analytics › Routing Model › Velocity.

Total score:
$$\text{Score} = \sum (\text{sign} \times \text{weight} \times \text{value})$$

### 3.2 Deep Dive: Warm Cache Preference & Session Affinity
Prompt cache creation costs up to **2.0×** base input tokens, while a cache read costs only **0.1×** and refreshes the TTL for free.

⚠️ **`cacheWarmth` and `contextHeld` are two assets with different expiry dates, not one term said
twice.** `contextHeld` is binary — *does a conversation carrying this task's context exist at all*,
live or closed-and-reopenable. `cacheWarmth` is continuous — *how much of that conversation's
prompt-cache TTL is still unspent*. They diverge on exactly the case that motivated splitting them: a
reopenable conversation whose prefix has lapsed scores `contextHeld 1 · cacheWarmth 0`, because the
agent still remembers the task but the token discount is gone. Merging them would force that
conversation to be priced as either fully cold (rebuild the context from nothing) or fully warm
(claim a discount that does not exist), and both are wrong. ⛔ Neither term compares **models**: a
held conversation pins `candidateModels` to its own model in `chooseTarget`, so every candidate
scoring `contextHeld 1` is necessarily on that conversation's model as a consequence of candidate
enumeration, not because either term checks.

A candidate is scored against **the conversation it would actually work in**, which is one of two
things and used to be only the first:

1. `warmSessionFor(task)` — a conversation with a **live process**, idle and ready for another prompt:
   1. The task's own idle session from earlier runs.
   2. If none, a borrowable resident session within the same project (when session sharing is enabled).
2. `reopenableFor(task, worker)` — the task's own **closed** conversation on this account, which the
   dispatch would reopen with `resumableSession`. Asked only when there is no live one, and gated by
   the same `reopenable()` predicate the dispatch uses, so the score cannot promise a continuation the
   dispatch would decline to make. ⚠️ Deliberately **not** exempt from `maxConcurrent`: reopening starts
   a process, where sending a prompt into a live session does not.

Whichever is found:
  - `cacheWarmth` value = $\max(0, \min(1, \frac{\text{cacheExpiresAt} - \text{now}}{\text{TTL}}))$, where
    **TTL is the provider's own** (`CostModel.cacheTtlMs()`) — 60 min on Anthropic, 30 min on Codex.
  - `contextHeld` value = `1.0`
  - `cold` value = `0.0`
- If starting cold: `cacheWarmth` = `0.0`, `contextHeld` = `0.0`, `cold` = `1.0` (pays the cold start penalty).

⛔ **Why (2) exists — t123, 2026-09-02.** `codex exec` reads one prompt, runs one turn and exits, so a
codex conversation is *never* a live idle session. With only (1), every codex candidate scored
`contextHeld 0 · cacheWarmth 0 · cold 1` — identical to an account that had never heard of the task. t123 ran on
CodexFirst leaving 175,626 tokens of context in a closed conversation; the retry twenty minutes later
scored a cold ClaudeThird above it. Three separate things had to change: the adapter had to declare
`resumeSession`, the conversation had to carry a cache clock at all (`creditStreamTurn` wrote none —
see `docs/cost-model.md` §1c), and the score had to look past the live slot.

⚠️ **`cacheWarmth` is not filtered out of (2), and neither is `contextHeld` filtered by it.** A lapsed
conversation still remembers the task, which is most of why reopening beats starting over — so
`contextHeld` holds while `cacheWarmth` falls to 0. Scoring a cold prefix as warm would claim a
discount that is not there.
- Under cost-heavy objectives (`cost: 0.7`), the preference for warm cache rises steeply (`cacheWarmth` weight: `+2.48`, `cold` penalty: `−2.13`), strongly serializing tasks onto existing warm sessions. Under velocity-heavy objectives (`velocity: 0.7`), cold penalty drops to `−0.51`, encouraging parallel dispatch.

### 3.3 Deep Dive: 5-Hour and 7-Day Quota Window Scoring
Quota risk combines two inputs:
$$\text{quotaRisk} = \max(\text{evidence}, \text{windowRisk}(\text{trustedWindow.percent}))$$

```
   Window Risk (Slope)
   1.0 ┼                                    ╭─────── (Saturates at 1.0 at 92%)
       │                                   ╱
       │                                  ╱
   0.5 ┼                                 ╱
       │                                ╱
   0.0 ┼───────────────────────────────╯
       0%                             50%      92%   100%
       ◄──────── Safe Zone ───────────►◄────── Risk Slope ────►
```

1. **`windowRisk(percent)` (Continuous Slope):**
   - **Below 50% (`QUOTA_RISK_FLOOR`):** `windowRisk = 0`. Not a load balancer! Emptier accounts below 50% are not favored over accounts with warm cache.
   - **Between 50% and 92% (`QUOTA_HIGH_WATER`):** Linear slope:
     $$\text{windowRisk} = \frac{\text{percent} - 50}{92 - 50}$$
   - **At 92%:** Exactly `1.0`, smoothly handing over to the Phase 1 hard gate.
   - **Untrusted / Stale Quota:** Evaluates to `0` (never guesses; absence of data is 0 risk contribution).

2. **`evidence` (`quotaRiskOf(worker.id)`):**
   - Vendor CLIs emit streaming `rate_limit_event` records distinguishing `five_hour` and `seven_day` windows.
   - If the vendor emitted `status !== 'allowed'` (e.g. `allowed_warning` or `rejected`) on **any** window within fresh memory, `evidence = 1.0`.
   - **5h vs 7d distinction:** A 7-day advisory (`allowed_warning`) sets `quotaRisk = 1.0` in routing scoring (deprioritizing that account so other workers take new work), but does **not** terminate or preempt a healthy 5-hour run in flight.

---

### 3.4 Deep Dive: Fitness — a Benchmark Prior Blended with This Fleet's Own Reviews

`fitness.ts`. Each `(adapter, model)` pair starts from a **benchmark prior**: a checked-in, versioned
0..1 score from `benchmarks/coding-agents.2026-09.json`, resolved exact-id first, then the longest
matching family prefix, then honestly `null`. Every entry states its own `basis` — `published` (a
leaderboard scores this exact id, cited with a source and a retrieval date), `inferred` (mapped from a
neighbouring or predecessor model, with the mapping stated), or `unknown`. ⛔ **`null` is never
coerced to 0** — the same rule an untrustworthy quota reading follows.

This fleet's own **clean** peer reviews — single-author, blinded without a leak; see
[`glossary.md`](glossary.md) › *Blinding* — are blended in, shrunk toward the prior in log space:

$$\text{value} = \text{prior}^{K/(n+K)} \cdot \text{measured}^{n/(n+K)}, \quad K = 8,\ n = \text{clean reviews}$$

⛔ **Why the prior is the baseline and not the measurement.** Nothing calibrates a review composite
across providers, no task on this fleet has ever been run twice on two models, and a handful of lucky
reviews would otherwise mint a reputation. `K = 8` is deliberately **larger** than the estimator's
cost-factor shrinkage (`SHRINK_K = 5`, `estimator.ts`) or the pace factor's (`SHRINK_K = 4`, `pace.ts`):
a quality composite, graded by a peer LLM against an uncalibrated rubric, is the least measured of the
three quantities this fleet shrinks, so it should take more evidence to move it. One clean review
keeps the value within about 11% of the prior (`8/(1+8)`); it takes on the order of twenty before the
measured number dominates.

Three degenerate cases, each explicit rather than defaulted:

| Prior | Clean reviews | `value` | Why |
|---|---|---|---|
| known | none | `prior` | Nothing has been graded — the prior stands alone, unshrunk |
| unknown | ≥1 | `measured` | No prior to shrink toward — the reviews stand alone, unshrunk |
| unknown | none | `null` | ⛔ Never 0.5, never 0. `AGENTS.md`: "unknown is a verdict, not half as bad" |

**The routing term is a sufficiency bar, not the blended value itself.** Excellence beyond what a task
needs earns nothing further, so a dearer model that merely *also* clears the bar cannot out-earn a
cheap sufficient one — that is `price`'s job. The bar is set by the task's **complexity band** (§3.5):

| Band | Required fitness |
|---|---|
| `low` | 0.35 |
| `medium` | 0.55 |
| `high` | 0.75 |

```
shortfall = max(0, required − blended fitness)
value     = max(0, 1 − shortfall / 0.25)     — 0 at a quarter-point under the bar or worse
```

A pair with `value === null` (fitness unmeasured) scores **0** for the term — a missing input, never a
guess — which is exactly the feedback loop §4.8 (exploration) exists to break.

### 3.5 Deep Dive: Complexity — Reading a Prompt's Difficulty for Zero Tokens

`complexity.ts`. `AGENTS.md`: "The scheduler costs zero tokens" — so nothing here calls an LLM,
consults the controller, or reaches the network. Every signal is either already on the `Task` row or
one cheap indexed query away, computed once per routing decision and shared across every candidate.

⚠️ **`task.title` is the prompt.** `promptFor()` sends it verbatim and the composer files the whole
textarea into it, so word count and structure are measured against `title`, never `titleSummary` — a
display label the controller writes for the board and says nothing about what the agent was asked.

| Signal | What it reads | Weight (of 1.0) |
|---|---|---|
| `size` | Word count of the prompt (log-scaled, 5→0, 150→1), or a stated `task.estTokens` when present — which **outranks** the prose signals, boosting this weight to 0.7 and scaling the rest down to fit | 0.36 (0.7 with `estTokens`) |
| `structure` | Code fences, file paths, list items, explicit acceptance criteria (three or more list items, or the words themselves) — one quarter-point each | 0.24 |
| `verb` | A whole-word, case-folded lexicon: `refactor, migrate, redesign, architect, rewrite, investigate` raise the read; `typo, rename, bump, comment, tweak, revert` lower it; both or neither is neutral | 0.14 |
| `needs` | `task.constraints.needs.length`, capped at 3 | 0.08 |
| `attachments` | Attachment count (`attachmentCountFor`), capped at 5 | 0.05 |
| `fanOut` | How many other tasks depend on this one (`dependentsOf`), capped at 3 | 0.08 |
| `kind` | `1` for a `plan` task, `0` otherwise | 0.05 |

`score = Σ(weight × value)`, bands `< 0.34` low, `< 0.67` medium, else high. ⛔ **A `plan` task never
scores low.** Planning is a reading-and-judgment job however thin its prompt, so if the weighted total
would land under 0.34 the `kind` signal's own contribution absorbs the difference — `score` stays
exactly the sum of every signal's contribution, with no separate adjustment term. A `work` task's
ceiling is untouched by this: the floor is paid for out of `kind`'s own weight, never reserved from
the other six.

Every signal publishes its own basis; `Complexity.basis` names the two or three that actually moved
the score, matching `AGENTS.md`: "every belief carries its basis."

---

## 3.9 A Plan & Split task is dispatched, not decomposed

⛔ **`kind: 'plan'` used to be skipped by the dispatcher entirely** and handed to the unattended
controller, which has no tools, cannot read the repository and cannot ask a question — so it answered
once in JSON and its children arrived as draft rows with no prompts. Planning is a *reading* job: it
needs the repo in front of it and `ask_human` in its hand, which is what an ordinary dispatch provides.

A plan task therefore routes and dispatches like any other, and takes **two** turns:

1. **Planning.** The agent reads, asks, and calls `task_split` once. Its run then ends and the task
   parks at `blocked` on one `settled` edge per piece. ⭐ The wait bills nothing and **holds nothing** —
   `retainedReservations` counts a worker slot as held by `awaiting_human` and by `running`-with-a-closed
   -session, and by neither for `blocked`. Pieces with no edges are independent and may dispatch in
   parallel. If the planner describes any required execution or landing order, it must encode that
   order with `depends_on`; prose such as “sequentially” is not scheduler state.
2. **Resolution.** The last piece to settle re-admits the planner through `admitDependents`. It comes
   back with a table of how every piece turned out, reviews the integrated branch as a whole, and
   finishes the task normally.

⚠️ The controller `decompose` consult survives as the fallback for the one case that still cannot be
given an agent turn: a plan task with **no project**, which has no workspace to read and nothing to
split work across.

### 3.6 The opt-in gate: when `fitness` and `price` are live at all

`modelRoutingActive()` (`workers.ts`). Both model-aware terms are held at exactly **0**, with a basis
that says so, until **some** worker that could actually be handed a turn has a non-empty
`routableModels` allowlist — not retired, switched on, and `canWork` (a `controller` account is
reserved for judgment, and `none` is held out of both).

⛔ **This is the safety property the whole feature rests on, and it is not free.** An empty allowlist
does not mean "no model" — `routableModelsFor` resolves it to the single model that worker already
uses, which is a real id. Scoring that id was not harmless: `fitness` looked up its benchmark prior
and `price` estimated it, so two accounts whose defaults differed scored **0.549** apart on a
medium-complexity task and **1.040** apart on a high one, against a `ROUTE_EPSILON` of `0.10`. That
re-ranked existing fleets on upgrade, on the strength of a hand-curated benchmark file that has never
been validated against this fleet — close to the mistake §4.10 was written about. The gate is what
makes the sentence "inert until an operator opts a worker in" true rather than merely intended.

⚠️ **Fleet-global, not per-worker.** Zeroing the terms only for un-opted-in workers would place an
opted-in worker carrying a real `price` penalty in the same field as one scored as though its model
were free — and the free-looking one would win on a difference that measures nothing. Either the whole
field is compared on model, or none of it is. Retired, disabled and non-working accounts do not count:
decommissioning, switching off or reserving for judgment the one account somebody widened turns the
terms back off, because that account never enters a field for the widening to matter in.

⚠️ **Those three conditions and no more — durable configuration, never transient availability.** The
rest of `accountUnavailability` (human-occupied, CLI missing, signed out, quarantined by a dead run)
comes and goes within a tick. Gating on it would switch the terms on and off underneath the fleet and
make one tick's scores incomparable with the next one's, for reasons no operator asked for. An account
that is merely busy is still an account the operator asked to route on model.

⭐ **`price` needs run history even once the gate is open.** `usd` comes from *priced past runs*
(`estimator.ts`), and no cost model in this repo carries a per-mtok price to stand in for one. On a
database with no finished runs every pair estimates the same cold fallback, so the ratio is 1 and the
term is 0 for every candidate — the honest answer, not a term that failed to fire. `fitness` separates
candidates from the first tick because its prior is checked in; `price` earns its separation.

---

## 4. Phase 3: Tie-Breaking, Controller Judgment Consult & Fallback

Once candidates are scored, they are sorted descending: `best` (highest score) and `second`.

### 4.1 When Arithmetic Decides Immediately (Zero Tokens)
The scheduler selects `best` immediately without consulting the LLM controller if:
- There is only 1 eligible candidate worker.
- The task is a Plan & Split task (`task.kind === 'plan'`).
- The score difference between `best` and `second` exceeds `ROUTE_EPSILON` (`|best.score - second.score| > 0.10`).
- The estimated task size is below `ROUTE_CONSULT_FLOOR_TOKENS` (`estimate < 150,000` tokens). On small tasks, the cost of asking the controller exceeds any difference $\epsilon$ could recover.

### 4.2 When a Judgment Consult Fires
A routing consult enqueues only when **both** conditions are met:
1. `|best.score - second.score| <= 0.10` (a genuine near-tie).
2. `estimateTask(task) >= 150,000 tokens` (the task is large enough that optimal routing matters).

```
Candidate Scores Evaluated
          │
    Score Gap <= 0.10 & Est Tokens >= 150k?
   ┌──────┴──────┐
  Yes            No
   │             │
   │             └─► Arithmetic selects Top Candidate (0 tokens)
   ▼
Any tied candidate has stale quota?
   ┌──────┴──────┐
  Yes            No
   │             │
   │             └─► Enqueue Consult to Controller LLM
   ▼
Defer & Probe Baseline Quota
(Fresh numbers often break false ties for free!)
```

### 4.2a The Reuse Tie-Break (`reuseTieBreak`) — a tie is won by the conversation that already exists

⛔ **Before the consult, after the controller's own answer.** When the tied field splits into
candidates that already hold this task's conversation and candidates that do not, the highest-scoring
holder wins the tie outright and **no controller turn is spent** (`basis: 'reuse'`).

- **Why it is not double-counting.** `affinity` (+1.26 balanced) and `cold` (−1.19 balanced) already
  price reuse, but they are two terms among eleven; a tie means the rest cancelled them out. Within
  ε the scores say the two candidates are indistinguishable — and between two equals, the one that
  skips a full cache write and already remembers the work is strictly cheaper. Measured 2026-08-28: a
  continued turn read back **41,542** cached tokens and wrote 65, against a cold start that wrote all
  of it.
- ⛔ **`session ?? resumable`** — the same `held` every scoring term reads. A `streamPrompts: 'once'`
  adapter never has a live idle session, so reading `session` alone would hand every tie on that
  adapter to a cold start.
- ⛔ **Only when reuse separates the field.** If every tied candidate holds a conversation, or none
  does, the tie-break says nothing and the consult fires exactly as before.
- ⚠️ A controller answer already on file still wins: the turn was paid for, so it is used.

### 4.3 Stale Quota Pre-Check (`needsBaseline`)
Stale quota zeroes out `windowRisk`, which can manufacture artificial ties. Before spending tokens on a controller consult, the scheduler checks if any tied candidate has stale quota. If so, it defers the consult and triggers a background quota probe first (`reason: 'reading quota for tied candidates before asking the controller'`).

### 4.4 Consult Prompt vs Detailed Derivation
- **Shortlist deduplication:** Before constructing the consult shortlist, candidate pairs are deduped to 1 candidate pair per worker (keeping that worker's top-scoring model). If only 1 worker is eligible fleet-wide, arithmetic decides immediately with 0 tokens. The shortlist takes at most 4 candidates.
- **Sent to Controller LLM (`routeQuestion`):** Minimal prompt containing candidate IDs, candidate model, total score, where the candidate would be *starting from*, its own estimated cost, and a single-line summary of live terms (`briefScore`). Keeps prompt token cost low (~1/3 of full table).
- ⛔ **Reuse is described the way the score measured it.** `warm` on a shortlist entry is
  `session ?? resumable`, and `reuse` says which: `live`, `reopen`, or nothing. A closed-but-reopenable
  conversation used to be printed as `cold start` beside a table showing `affinity 1 · cold 0` — the
  controller was being asked to choose between a description and the arithmetic under it.
- ⛔ **Each candidate is priced from where it starts.** The prompt carried one figure for the whole
  task (`pessimisticOn()` — the worst agent the fleet has measured, identical for every candidate), so
  nothing the controller saw could show that one candidate already held the context the other would
  pay to rebuild. Per-candidate estimates come from the same memoised `cachedEstimate(adapter, model,
  warm)` that priced the `price` term; the fleet-wide figure is printed only when no candidate could
  be priced on its own.
- ⚠️ The question ends by stating the preference outright: where nothing else separates the
  candidates, pick the one already holding the conversation.
- **Stored for Humans (`routeDetail`):** Full legend and complete term-by-term formula tables stored on `consult.detail` for inspection in the UI.
- **Closed-Set Validation (`validateRoute`):** The controller returns JSON:
  ```json
  {"workerId": "<exact_worker_id>", "model": "<candidate_model>", "why": "..."}
  ```
  Both `{ workerId, model }` pairs and legacy bare `workerId` are supported; a bare `workerId` falls back to that worker's highest-scoring candidate pair. Any unlisted worker or model is rejected.

### 4.5 Deterministic Fallback
If:
- No controller worker is designated or available,
- The controller is out of quota or rate-limited (`CONTROLLER_HIGH_WATER = 80%`),
- The controller reaches the hourly limit (`HOURLY_CAP = 20` consults/hr),
- The consult times out (`CONSULT_TTL_MS.route = 90` seconds), or
- The controller returns invalid JSON or an unlisted worker ID,

Then `fallbackFor` automatically selects the **top-scoring candidate (`best`)** from the arithmetic. The fleet never halts due to controller absence.

---

### 4.8 Model Exploration (ε-greedy)

⛔ **Off by default, and opted into** (`modelExploration: boolean`, default `false`, with rate `modelExplorationRate: number`, default `0.10`).

Scoring can starve unmeasured models: a model with no prior and no quality reviews scores 0 for `fitness`, so today's winner earns the runs that make it win tomorrow. Model exploration breaks this feedback loop by occasionally sampling alternative models on the same worker.

- **Rule:** With probability `modelExplorationRate`, swap the winner with an alternative routable model on the **same worker**.
- **Preference for discovery:** If any alternative model has unmeasured fitness (`fitnessFor().value === null`), exploration picks from the unmeasured pool first before uniform random selection.
- **Strict exclusions (never explores when):**
  1. `modelExploration` is `false`.
  2. The task pinned a model (`constraints.model` or `constraints.modelsByWorker`).
  3. The winner is warm, reopenable, or sticky (swapping would forfeit warm cache context).
  4. `task.kind === 'plan'`.
  5. The task's complexity band is `high` (experiment on cheap work, not high-stakes tasks).
  6. The worker offers only 1 routable model.
- **Audit trail:** An explored decision records `basis: 'explore'` in `routing_decisions`, preserves the full ranked ledger of candidate pairs, and posts a notice to the task thread.

---

## 4.9 Phase 4: The decision is kept

⛔ **Every dispatch writes a `routing_decisions` row before anything can fail** (`routingdecisions.ts`,
called from `dispatch`). It holds the objective vector that was in force, every weight it produced with
its published formula, and **every candidate's term-by-term derivation** — value, weight, sign,
contribution and the basis in words — plus how the winner was picked (`score`, `controller`,
`pinned`, `sticky`, `reuse` or `explore`).

- ⛔ **`sticky` is a conversation returning to the account it is already talking to**, and it wins
  outright rather than adding a term. Warmth is one weight among nine, which is right for unattended
  work and wrong for a thread a person is in: routing it elsewhere silently swaps the model, drops
  every turn of context, and answers the operator's next sentence as a stranger. ⚠️ The two escapes
  are the candidate list rather than a special case — a person who reassigns writes
  `constraints.workerId` and the loop skips everyone else, and an account that has spent its window is
  removed by the quota gate. In both, nothing is found and the ordinary scoring decides. A sticky
  decision still records the whole ranked field, so the arithmetic it declined to use is auditable.

- ⛔ **`reuse` is the tie-break of §4.2a**, not a term: the scores came within ε and only some of the
  tied candidates already held this task's conversation. ⚠️ `RoutingDecision.warm` and each
  candidate's `warm` are `session ?? resumable` — a reopened conversation is reuse, because the
  dispatch really does call `resumableSession` and continue it.

- ⛔ **Written at dispatch, not in `chooseTarget`.** Scoring runs on every tick for every eligible
  task, most of which are then held for a resource, a window or a controller answer. Recording there
  would fill the table with hypotheticals at one row per task per tick. A row here means *this task
  was actually handed to this account*.
- ⛔ **Read back, never recomputed.** The windows, prompt caches and context sizes that produced a
  score existed for one tick. Re-deriving one later produces a plausible number that answers a
  different question and is indistinguishable from the real one — the same argument
  `quality_reviews` makes for storing its rubric version.
- ⚠️ A row is written **before** the spawn can fail, deliberately: a dispatch that then loses a race
  for a worktree does not un-make the routing decision. The row holds no run id and claims no run
  started.
- ⚠️ Recording is wrapped: nothing the fleet does depends on the row existing, and a scheduler that
  refused to start work because an analytics insert threw would trade the thing that matters for the
  thing that watches it.

The ledger is what **Analytics › Routing Model › Overview** renders, five at a time with a pager.

---

## 4.10 Where each axis is measured, and where it is shown

The scheduler weighs exactly three things, and each has its own body of measurement, its own failure
modes and its own honest gaps. The UI is one tab per axis for that reason, not for layout:

| Axis | Measured in | Feeds | Shown in |
|---|---|---|---|
| **Quality** | `review.ts` / `reviewer.ts` — a peer agent grades a landed diff against a seven-dimension rubric, blended (`fitness.ts`) with a checked-in public benchmark prior | `contextRot`, `contextHeld`, `capabilityFit`, and, since 2026-09-05, **`fitness`** | Routing Model › Quality and › Models |
| **Cost** | `estimator.ts`, `price.ts`, `spend.ts` — what runs actually cost, per (agent, model) | `cacheWarmth`, `cold`, `quotaRisk`, `projectSwitch`, `contextHeld`, and, since 2026-09-05, **`price`** | Routing Model › Cost and › Models |
| **Velocity** | `pace.ts` over `activetime.ts` — median active time per finished task, per (agent, model) | `pace`, plus the concurrency multiplier in `policy()` | Routing Model › Velocity |

⚠️ **Analytics › Statistics reads the same three axes and is not this table.** `src/daemon/statistics.ts`
folds the last 200 finished tasks into a measured distribution — average, p50, p99, p100 — per agent,
then per model, then per effort, crediting each task exactly as §4.x does via the exported
`creditedKeys` in `pace.ts` so there is one implementation of the credit rule and not two. Nothing it
prints is shrunk, blended or clamped, so its numbers **will not match** the pace factor, the blended
fitness or the estimator's median, and are not meant to: those exist to be acted on, these exist to be
read. Its Quality tab falls back to the benchmark prior when a key has no clean review yet, which is
the ordinary state of a new fleet.

⛔ **Quality feeds one term, and it is still not a gate.** `fitness` is the only routing term a peer
review reaches, and it reaches it only after being shrunk (§3.4) toward a checked-in public
benchmark prior — precisely *because* this fleet's own composites are uncalibrated across providers
and reviewers, and a handful of lucky reviews would otherwise mint a reputation no controlled
comparison backs. A low-fitness model is never excluded: it stays a legal candidate at value 0, and it
can still win outright on `price` against a dearer model that clears the same bar. Wiring a *measured*
score straight into a gate before it had been shown to measure anything is the mistake this project
already made and wrote down; what changed is not that guard being lifted, but a term arriving that is
shaped so it structurally cannot become one.

---

## 5. Worked Examples

### Scenario 1: Warm Session Reuse on a 1-Slot Worker

**Context:**
- Task `t12` receives a user reply. It previously ran on `Worker A` (`claude-code`, 1 slot allowed).
- `Worker A` has `Session s1` idle with 45 minutes remaining on prompt cache TTL.
- `Worker B` (`claude-code`, 1 slot allowed) is completely idle (0 sessions open, 0% quota used).
- Objective: Balanced (`cost: 0.30, velocity: 0.30, quality: 0.40`).

**Phase 1 (Hard Gates):**
- `Worker A`: `sessions = [s1]`, `reuse = s1`. `busy = sessions.filter(s => s.id !== reuse.id).length = 0 < 1`. **Worker A is ELIGIBLE (not at capacity).**
- `Worker B`: `sessions = []`, `reuse = null`. `busy = 0 < 1`. **Worker B is ELIGIBLE.**

**Phase 2 (Scoring):**

| Term | Weight | Worker A (Warm Reuse) | Worker B (Cold Start) |
|---|:---:|---|---|
| `cacheWarmth` | `+1.480` | $45/60 \times 1.480 = \mathbf{+1.110}$ | $0 \times 1.480 = \mathbf{0.000}$ |
| `contextHeld`| `+1.260` | $1.0 \times 1.260 = \mathbf{+1.260}$ | $0 \times 1.260 = \mathbf{0.000}$ |
| `cold` | `−1.190` | $0 \times -1.190 = \mathbf{0.000}$ | $1.0 \times -1.190 = \mathbf{-1.190}$ |
| `capabilityFit` | `+1.220` | $1.0 \times 1.220 = \mathbf{+1.220}$ | $1.0 \times 1.220 = \mathbf{+1.220}$ |
| `quotaRisk` | `−0.860` | $0.0 \times -0.860 = \mathbf{0.000}$ | $0.0 \times -0.860 = \mathbf{0.000}$ |
| `pace` | `+0.810` | $0.0 \times 0.810 = \mathbf{0.000}$ | $0.0 \times 0.810 = \mathbf{0.000}$ |
| **Total Score** | | $\mathbf{+3.590}$ | $\mathbf{+0.030}$ |

**Outcome:**
Score gap is $3.590 - 0.030 = 3.560 \gg 0.10$. **Worker A wins decisively.** 0 tokens spent on routing.

⚠️ Both workers score `pace` at **0** here because neither has finished a task on this fleet yet.
Once each has, that term is what separates two otherwise-identical cold candidates.

---

### Scenario 2: Concurrency Contention on a 1-Slot Worker

**Context:**
- `Worker A` (1 slot allowed) is actively executing Turn 2 of Task `t14`.
- New independent Task `t15` is submitted.
- `Worker B` (1 slot allowed) is idle.

**Phase 1 (Hard Gates):**
- `Worker A`: `sessions = [s1]`, `reuse = null` (Task `t15` cannot reuse Task `t14`'s active session). `busy = 1 >= 1`. **Worker A is EXCLUDED (`Worker A at capacity`).**
- `Worker B`: `busy = 0 < 1`. **Worker B is ELIGIBLE.**

**Outcome:**
`Worker B` is the only eligible candidate. Task `t15` dispatches to `Worker B` immediately without calculating scores or asking the controller.

---

### Scenario 3: 5-Hour and 7-Day Quota Window Scoring

**Context:**
- Task `t20` is a cold task requiring a standard worker.
- Fleet candidates:
  - **Worker 1 (Claude 1):** 5h window at 35% used.
  - **Worker 2 (Claude 2):** 5h window at 71% used.
  - **Worker 3 (Claude 3):** 5h window at 40% used, but received a fresh `rate_limit_event` warning on its 7-day window (`allowed_warning`).
  - **Worker 4 (Claude 4):** 5h window at 94% used.
- Objective: Balanced (`quotaRisk` weight: `0.860`). No worker has a measured pace yet, so `pace` is
  `0.000` for all four and the comparison is `quotaRisk` alone.

**Phase 1 (Hard Gates):**
- Worker 1, 2, 3: Pool % < 92%. **Eligible.**
- Worker 4: Pool % = 94% ≥ 92%. **Excluded** (`Claude 4 at 94% of its 5h window`, hold until reset).

**Phase 2 (Scoring Quota Risk):**
The cold baseline every candidate shares here is $\text{cold} + \text{capabilityFit} = -1.190 + 1.220 = +0.030$.

- **Worker 1:**
  - $\text{percent} = 35 \le 50 \implies \text{windowRisk} = 0.0$
  - $\text{quotaRisk} = \max(0, 0.0) = 0.0$
  - Quota contribution: $0.0 \times -0.860 = \mathbf{0.000}$
  - Total Score: $\mathbf{+0.030}$
- **Worker 2:**
  - $\text{percent} = 71 \implies \text{windowRisk} = (71 - 50) / 42 = 0.500$
  - $\text{quotaRisk} = \max(0, 0.500) = 0.500$
  - Quota contribution: $0.500 \times -0.860 = \mathbf{-0.430}$
  - Total Score: $0.030 - 0.430 = \mathbf{-0.400}$
- **Worker 3:**
  - $\text{percent} = 40 \implies \text{windowRisk} = 0.0$
  - `rate_limit_event` advisory $\implies \text{evidence} = 1.0$
  - $\text{quotaRisk} = \max(1.0, 0.0) = 1.000$
  - Quota contribution: $1.000 \times -0.860 = \mathbf{-0.860}$
  - Total Score: $0.030 - 0.860 = \mathbf{-0.830}$

**Outcome:**
Rankings: **Worker 1 (+0.030)** > **Worker 2 (-0.400)** > **Worker 3 (-0.830)**.
Worker 1 beats Worker 2 by 0.430 (> 0.10), so **Worker 1 wins cleanly** without a controller consult.

---

### Scenario 4: Near-Tie on a Large Task & Controller Consult

**Context:**
- Task `t30` is a large refactor estimated at **220,000 tokens**.
- Candidates:
  - **Worker A:** Cold, 5h window at 54% used ($\text{windowRisk} = (54-50)/42 = 0.095 \implies \text{score} = 0.030 - 0.082 = -0.052$).
  - **Worker B:** Cold, 5h window at 52% used ($\text{windowRisk} = (52-50)/42 = 0.048 \implies \text{score} = 0.030 - 0.041 = -0.011$).
  - Neither has a measured pace, so `pace` contributes `0.000` to both. ⚠️ **This is the tie the
    velocity axis exists to break**: once either has finished a task, the term stops being 0 and the
    consult below is no longer reached.
- Score gap: $|-0.011 - (-0.052)| = 0.041 \le 0.10$ (`ROUTE_EPSILON`).

**Execution:**
1. Both workers have fresh quota readings (no baseline probe needed).
2. Gap ($0.042 \le 0.10$) and task size ($220\text{k} \ge 150\text{k}$) trigger a consult.
3. Neither holds a conversation for this task, so the §4.2a reuse tie-break says nothing and the
   consult goes ahead. The controller receives:
   ```
   # Candidates
   - w_b — Worker B: score -0.011, cold start, ~$0.31 (220000 tokens) from there
     weighed: cold -1.190, capabilityFit +1.220, quotaRisk -0.041 (unmeasurable here: pace)
   - w_a — Worker A: score -0.052, cold start, ~$0.31 (220000 tokens) from there
     weighed: cold -1.190, capabilityFit +1.220, quotaRisk -0.082 (unmeasurable here: pace)
   ```
   ⚠️ Had Worker A held this task's conversation — live or closed and reopenable — the tie would
   never have reached here: §4.2a would have taken it for `basis: 'reuse'` at zero tokens, and its
   line would have read `holds this task's own conversation, closed but reopenable` rather than
   `cold start`.
4. **If Controller replies:** `{"workerId": "w_b", "why": "Worker B has slightly lower window utilization"}` $\implies$ Dispatched to `Worker B`.
5. **If Controller times out (90s) or has no quota:** Fallback chooses `Worker B` (highest arithmetic score). Zero disruption.

---

### Scenario 5: Model-Aware Routing & Sufficiency Bar (Low vs High Complexity)

**Context:**
- A single worker `Worker A` has routable models: `claude-haiku-4-5-20251001` (cheap, prior 0.418, $0.05 est.) and `claude-opus-5` (expensive, prior 0.846, $0.40 est., an 8× ratio).
- Standard cold start baseline: $\text{cold} + \text{capabilityFit} = -1.190 + 1.220 = \mathbf{+0.030}$.

#### Case 1: Low-Complexity Task under Balanced Objective
- Objective: Balanced (`cost: 0.30, velocity: 0.30, quality: 0.40`).
- Weights: $\text{fitness} = 0.4 + 1.6 \times 0.40 = \mathbf{+1.040}$; $\text{price} = 0.5 + 2.0 \times 0.30 = \mathbf{-1.100}$.
- Complexity: `low` $\implies$ sufficiency bar $\text{required} = \mathbf{0.35}$.
- Model evaluations:
  - **Haiku:**
    - Prior $0.418 \ge 0.35 \implies \text{fitness value} = \mathbf{1.0}$.
    - Cheapest candidate ($0.05) $\implies \text{price value} = \log(0.05 / 0.05) / \log(8) = \mathbf{0.0}$.
    - Score: $+0.030 + 1.0 \times 1.040 - 0.0 \times 1.100 = \mathbf{+1.070}$.
  - **Opus:**
    - Prior $0.846 \ge 0.35 \implies \text{fitness value} = \mathbf{1.0}$.
    - 8× price ratio ($0.40 / 0.05 = 8$) $\implies \text{price value} = \log(8) / \log(8) = \mathbf{1.0}$.
    - Score: $+0.030 + 1.0 \times 1.040 - 1.0 \times 1.100 = \mathbf{-0.030}$.
- **Outcome:**
  Score gap: $+1.070 - (-0.030) = \mathbf{1.100} \gg 0.10$. Haiku wins decisively because it meets the sufficiency bar and is 8× cheaper. Zero extra tokens spent on overpowered models.

#### Case 2: High-Complexity Task under Quality-Focused Objective
- Task: Large multi-file architectural refactor (`complexity: high` $\implies \text{required} = \mathbf{0.75}$).
- Objective: Quality-focused (`cost: 0.10, velocity: 0.10, quality: 0.80`).
- Weights:
  - $\text{fitness} = 0.4 + 1.6 \times 0.80 = \mathbf{+1.680}$
  - $\text{price} = 0.5 + 2.0 \times 0.10 = \mathbf{-0.700}$
  - Baseline: $\text{cold} (-0.930) + \text{capabilityFit} (+1.740) = \mathbf{+0.810}$
- Model evaluations:
  - **Haiku:**
    - $\text{shortfall} = 0.75 - 0.418 = 0.332 > 0.25 \implies \text{fitness value} = \mathbf{0.0}$.
    - Cheapest candidate $\implies \text{price value} = \mathbf{0.0}$.
    - Score: $+0.810 + 0.0 \times 1.680 - 0.0 \times 0.700 = \mathbf{+0.810}$.
  - **Opus:**
    - Prior $0.846 \ge 0.75 \implies \text{fitness value} = \mathbf{1.0}$.
    - 8× price ratio $\implies \text{price value} = \mathbf{1.0}$.
    - Score: $+0.810 + 1.0 \times 1.680 - 1.0 \times 0.700 = \mathbf{+1.790}$.
- **Outcome:**
  Score gap: $+1.790 - (+0.810) = \mathbf{0.980} \gg 0.10$. The quality-focused objective and high complexity bar flip the routing decisively to **Opus**.
