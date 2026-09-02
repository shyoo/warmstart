# Task Routing & Judgment Decisions

How Multi Agent Controller decides which worker, session, and moment will run a task.

The scheduler's core loop runs every **10 seconds** and costs **zero tokens**. Every decision is
deterministic arithmetic over measured costs, cache lifetimes, and quota windows. The LLM
controller is consulted only on discrete judgment events when the arithmetic cannot separate two
close candidates on a large task.

---

## 1. Architectural Invariants & Decision Phases

Task routing executes in four sequential phases:

```
┌────────────────────────────────────────────────────────┐
│ Phase 1: Hard Eligibility & Capacity Gates             │
│ (Worker constraints, health, capabilities,             │
│  concurrency slots & session reuse, 92% quota cliff)   │
└───────────────────────────┬────────────────────────────┘
                            │ (Eligible candidate workers)
┌───────────────────────────▼────────────────────────────┐
│ Phase 2: Deterministic Candidate Scoring               │
│ (Sum of ± weight × value: warm cache bonus, cold       │
│  penalty, context rot, quota risk across 5h/7d windows)│
└───────────────────────────┬────────────────────────────┘
                            │ (Ranked candidates: Best & Second)
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

1. **Phase 1 (Hard Gates):** Disqualifies unfit or unavailable workers immediately. A task that cannot run on Worker A may run on Worker B right now.
2. **Phase 2 (Scoring):** Calculates a continuous, linear, unitless score for every eligible candidate. **Higher score wins.**
3. **Phase 3 (Judgment & Tie-Breaking):** If one candidate clearly wins (gap > 0.10) or the task is small (< 150k tokens), the arithmetic decides with zero token cost. Only genuine near-ties on large tasks enqueue an LLM consult.
4. **Phase 4 (Dispatch):** Dispatches the task to the chosen session/worker or waits on held resources.

---

## 2. Phase 1: Hard Eligibility & Capacity Gates

Before scoring, every worker in the fleet is evaluated against hard admission rules in `src/daemon/scheduler.ts` and `src/daemon/eligibility.ts`:

### 2.1 Task Constraints & Account Fitness
- **Target constraints:** If `task.constraints.workerId` or `task.constraints.adapterId` is set, only matching workers are considered.
- **Account fitness (`accountUnavailability`):** A worker is excluded if it is:
  - Switched off (`enabled: false`)
  - Human-occupied (`humanOccupied: true` — tracked for quota accounting, but never handed automated turns)
  - Not installed (`installed: false`)
  - Signed out (`identity.loggedIn === false`)
  - Quarantined (`health.state === 'suspect'` — failed a dispatch with zero metered turns)
  - Retired (`health.state === 'retired'`)
- **Capability fit:** If a task requires specific features (`task.constraints.needs`, e.g. `mcp`, `edit`), workers lacking that adapter capability are excluded.

### 2.2 Concurrency & The 1-Slot Session Reuse Rule
Each worker defines `maxConcurrent` (default `1` parallel run):
- `atCapacity(sessions, maxConcurrent, reuse)` counts active work sessions on that worker.
- ⛔ **The 1-Slot Continuation Rule:** Reusing an existing idle session (`reuse`) starts **no new process**. Therefore, `reuse` is explicitly **exempt** from the capacity count.

```typescript
// src/daemon/scheduler.ts
export function atCapacity(
  sessions: Session[],
  maxConcurrent: number,
  reuse: Session | null
): boolean {
  const busy = sessions.filter((s) => s.purpose === 'work' && s.id !== reuse?.id).length
  return busy >= maxConcurrent
}
```

#### What this means in practice:
- **Worker A has 1 slot, currently executing a turn for Task 1:** Task 2 arrives. Worker A is busy (`busy = 1 >= 1`). Worker A is rejected with `Worker A at capacity`.
- **Worker A has 1 slot, Task 1 is resting at `awaiting_human` with an idle warm session:** The operator replies to Task 1. Task 1 reuses its own warm session (`reuse = s1`). The session count excludes `s1`, so `busy = 0 < 1`. **Task 1 is NOT blocked by its own resting session** and continues immediately.
- **Worker A has 1 slot, Task 1 is resting at `awaiting_human`, and a new Task 2 arrives:** Task 2 cannot reuse Task 1's session (unless session sharing is explicitly enabled). For Task 2, `reuse` is null, so `busy = 1 >= 1`. Task 2 cannot start on Worker A until Task 1's session exits or is evicted.

### 2.3 Quota High-Water Gate (92%)
- **Pool-aware lookup:** Multi-pool workers (such as Google Antigravity, which meters Gemini separately from Claude/GPT) look up the specific quota pool matching the task's resolved model (`resolveModelChoice`).
- **Freshness & Expiry:** Quota readings that have passed their `resetsAt` time or are stale are marked `quotaUnverified: true` and are **not** blocked (allowing CLIs without usage probes to operate).
- **The 92% Gate (`QUOTA_HIGH_WATER = 92`):** If a trusted pool reading is ≥ 92%, the candidate is excluded with `${worker.label} at X% of its window`, and `quotaHoldUntil` is set to the window's `resetsAt` timestamp.
- **The Human 92% Override (`task.overrideQuota`):** 92% is a caution, not a vendor rejection. An operator can overrule the 92% gate for a pinned task. The override lifts the dispatch cut and matching 95% preemption cliff, but **never** bypasses `windowRisk` scoring, vendor `rejected` rate-limits, or disabled account gates.

---

## 3. Phase 2: Candidate Scoring Arithmetic

Every candidate that clears Phase 1 is scored using the objective vector.

### 3.1 Objective Weights
Weights derive from the objective vector `(cost, velocity, quality)` configured globally or per-project/task:

| Term | Direction | Weight Formula (`objective.ts`) | Balanced (`0.34, 0.33, 0.33`) | Value Range | Meaning of Value = 1 |
|---|:---:|---|:---:|:---:|---|
| **`warm`** | Bonus (+1) | `1.0 + 2.2×cost − 0.6×velocity` | `+1.550` | 0 .. 1 | A full TTL of prompt cache remaining — **the provider's own TTL**, 60m on Anthropic, 30m on Codex |
| **`affinity`** | Bonus (+1) | `0.8 + 1.0×cost + 0.4×quality` | `+1.272` | 0 or 1 | A conversation already holds this task's context — **live or reopenable** |
| **`contextRot`** | Penalty (−1) | `0.6 + 1.6×quality` | `−1.128` | 0 .. 1 | Context window is 100% full (starts at >50%) |
| **`projectSwitch`** | Penalty (−1) | `0.3 + 0.6×cost` | `−0.504` | 0 or 1 | Reusable session belongs to another project |
| **`quotaRisk`** | Penalty (−1) | `0.5 + 1.2×cost` | `−0.908` | 0 .. 1 | At 92% of window or vendor rate-limit warning |
| **`cold`** | Penalty (−1) | `0.8 + 2.0×cost − 0.7×velocity` | `−1.249` | 0 or 1 | No conversation to reuse, live or reopenable (pays full cache write) |
| **`capabilityFit`** | Bonus (+1) | `0.7 + 1.3×quality` | `+1.129` | 0 .. 1 | All required task capabilities are present |
| **`unproven`** | Penalty (−1) | Fixed `0.35` | `−0.350` | 0 .. 1.5 | Account has never completed a metered turn |

Total score:
$$\text{Score} = \sum (\text{sign} \times \text{weight} \times \text{value})$$

### 3.2 Deep Dive: Warm Cache Preference & Session Affinity
Prompt cache creation costs up to **2.0×** base input tokens, while a cache read costs only **0.1×** and refreshes the TTL for free.

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
  - `warm` value = $\max(0, \min(1, \frac{\text{cacheExpiresAt} - \text{now}}{\text{TTL}}))$, where
    **TTL is the provider's own** (`CostModel.cacheTtlMs()`) — 60 min on Anthropic, 30 min on Codex.
  - `affinity` value = `1.0`
  - `cold` value = `0.0`
- If starting cold: `warm` = `0.0`, `affinity` = `0.0`, `cold` = `1.0` (pays the cold start penalty).

⛔ **Why (2) exists — t123, 2026-09-02.** `codex exec` reads one prompt, runs one turn and exits, so a
codex conversation is *never* a live idle session. With only (1), every codex candidate scored
`affinity 0 · warm 0 · cold 1` — identical to an account that had never heard of the task. t123 ran on
CodexFirst leaving 175,626 tokens of context in a closed conversation; the retry twenty minutes later
scored a cold ClaudeThird above it. Three separate things had to change: the adapter had to declare
`resumeSession`, the conversation had to carry a cache clock at all (`creditStreamTurn` wrote none —
see `docs/cost-model.md` §1c), and the score had to look past the live slot.

⚠️ **`warm` is not filtered out of (2), and neither is `affinity` filtered by it.** A lapsed
conversation still remembers the task, which is most of why reopening beats starting over — so
`affinity` holds while `warm` falls to 0. Scoring a cold prefix as warm would claim a discount that
is not there.
- Under cost-heavy objectives (`cost: 0.7`), the preference for warm cache rises steeply (`warm` weight: `+2.48`, `cold` penalty: `−2.13`), strongly serializing tasks onto existing warm sessions. Under velocity-heavy objectives (`velocity: 0.7`), cold penalty drops to `−0.51`, encouraging parallel dispatch.

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

## 4. Phase 3: Tie-Breaking, Controller Judgment Consult & Fallback

Once candidates are scored, they are sorted descending: `best` (highest score) and `second`.

### 4.1 When Arithmetic Decides Immediately (Zero Tokens)
The scheduler selects `best` immediately without consulting the LLM controller if:
- There is only 1 eligible candidate worker.
- The task is a decomposition task (`task.kind === 'plan'`).
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

### 4.3 Stale Quota Pre-Check (`needsBaseline`)
Stale quota zeroes out `windowRisk`, which can manufacture artificial ties. Before spending tokens on a controller consult, the scheduler checks if any tied candidate has stale quota. If so, it defers the consult and triggers a background quota probe first (`reason: 'reading quota for tied candidates before asking the controller'`).

### 4.4 Consult Prompt vs Detailed Derivation
- **Sent to Controller LLM (`routeQuestion`):** Minimal prompt containing candidate IDs, total score, warm status, and a single-line summary of live terms (`briefScore`). Keeps prompt token cost low (~1/3 of full table).
- **Stored for Humans (`routeDetail`):** Full legend and complete term-by-term formula tables stored on `consult.detail` for inspection in the UI.
- **Closed-Set Validation (`validateRoute`):** The controller must return JSON:
  ```json
  {"workerId": "<exact_worker_id>", "why": "..."}
  ```
  Any returned ID not in the candidate list is rejected.

### 4.5 Deterministic Fallback
If:
- No controller worker is designated or available,
- The controller is out of quota or rate-limited (`CONTROLLER_HIGH_WATER = 80%`),
- The controller reaches the hourly limit (`HOURLY_CAP = 20` consults/hr),
- The consult times out (`CONSULT_TTL_MS.route = 90` seconds), or
- The controller returns invalid JSON or an unlisted worker ID,

Then `fallbackFor` automatically selects the **top-scoring candidate (`best`)** from the arithmetic. The fleet never halts due to controller absence.

---

## 5. Worked Examples

### Scenario 1: Warm Session Reuse on a 1-Slot Worker

**Context:**
- Task `t12` receives a user reply. It previously ran on `Worker A` (`claude-code`, 1 slot allowed).
- `Worker A` has `Session s1` idle with 45 minutes remaining on prompt cache TTL.
- `Worker B` (`claude-code`, 1 slot allowed) is completely idle (0 sessions open, 0% quota used).
- Objective: Balanced (`cost: 0.34, velocity: 0.33, quality: 0.33`).

**Phase 1 (Hard Gates):**
- `Worker A`: `sessions = [s1]`, `reuse = s1`. `busy = sessions.filter(s => s.id !== reuse.id).length = 0 < 1`. **Worker A is ELIGIBLE (not at capacity).**
- `Worker B`: `sessions = []`, `reuse = null`. `busy = 0 < 1`. **Worker B is ELIGIBLE.**

**Phase 2 (Scoring):**

| Term | Weight | Worker A (Warm Reuse) | Worker B (Cold Start) |
|---|:---:|---|---|
| `warm` | `+1.550` | $45/60 \times 1.550 = \mathbf{+1.163}$ | $0 \times 1.550 = \mathbf{0.000}$ |
| `affinity`| `+1.272` | $1.0 \times 1.272 = \mathbf{+1.272}$ | $0 \times 1.272 = \mathbf{0.000}$ |
| `cold` | `−1.249` | $0 \times -1.249 = \mathbf{0.000}$ | $1.0 \times -1.249 = \mathbf{-1.249}$ |
| `capabilityFit` | `+1.129` | $1.0 \times 1.129 = \mathbf{+1.129}$ | $1.0 \times 1.129 = \mathbf{+1.129}$ |
| `quotaRisk` | `−0.908` | $0.0 \times -0.908 = \mathbf{0.000}$ | $0.0 \times -0.908 = \mathbf{0.000}$ |
| **Total Score** | | $\mathbf{+3.564}$ | $\mathbf{-0.120}$ |

**Outcome:**
Score gap is $3.564 - (-0.120) = 3.684 \gg 0.10$. **Worker A wins decisively.** 0 tokens spent on routing.

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
- Objective: Balanced (`quotaRisk` weight: `0.908`).

**Phase 1 (Hard Gates):**
- Worker 1, 2, 3: Pool % < 92%. **Eligible.**
- Worker 4: Pool % = 94% ≥ 92%. **Excluded** (`Claude 4 at 94% of its 5h window`, hold until reset).

**Phase 2 (Scoring Quota Risk):**
- **Worker 1:**
  - $\text{percent} = 35 \le 50 \implies \text{windowRisk} = 0.0$
  - $\text{quotaRisk} = \max(0, 0.0) = 0.0$
  - Quota contribution: $0.0 \times -0.908 = \mathbf{0.000}$
  - Total Score: $\mathbf{-0.120}$
- **Worker 2:**
  - $\text{percent} = 71 \implies \text{windowRisk} = (71 - 50) / 42 = 0.500$
  - $\text{quotaRisk} = \max(0, 0.500) = 0.500$
  - Quota contribution: $0.500 \times -0.908 = \mathbf{-0.454}$
  - Total Score: $-0.120 - 0.454 = \mathbf{-0.574}$
- **Worker 3:**
  - $\text{percent} = 40 \implies \text{windowRisk} = 0.0$
  - `rate_limit_event` advisory $\implies \text{evidence} = 1.0$
  - $\text{quotaRisk} = \max(1.0, 0.0) = 1.000$
  - Quota contribution: $1.000 \times -0.908 = \mathbf{-0.908}$
  - Total Score: $-0.120 - 0.908 = \mathbf{-1.028}$

**Outcome:**
Rankings: **Worker 1 (-0.120)** > **Worker 2 (-0.574)** > **Worker 3 (-1.028)**.
Worker 1 beats Worker 2 by 0.454 (> 0.10), so **Worker 1 wins cleanly** without a controller consult.

---

### Scenario 4: Near-Tie on a Large Task & Controller Consult

**Context:**
- Task `t30` is a large refactor estimated at **220,000 tokens**.
- Candidates:
  - **Worker A:** Cold, 5h window at 54% used ($\text{windowRisk} = (54-50)/42 = 0.095 \implies \text{score} = -0.206$).
  - **Worker B:** Cold, 5h window at 52% used ($\text{windowRisk} = (52-50)/42 = 0.048 \implies \text{score} = -0.164$).
- Score gap: $|-0.164 - (-0.206)| = 0.042 \le 0.10$ (`ROUTE_EPSILON`).

**Execution:**
1. Both workers have fresh quota readings (no baseline probe needed).
2. Gap ($0.042 \le 0.10$) and task size ($220\text{k} \ge 150\text{k}$) trigger a consult.
3. The controller receives:
   ```
   # Candidates
   - w_b — Worker B: score -0.164, cold start
     weighed: cold -1.249, capabilityFit +1.129, quotaRisk -0.044
   - w_a — Worker A: score -0.206, cold start
     weighed: cold -1.249, capabilityFit +1.129, quotaRisk -0.086
   ```
4. **If Controller replies:** `{"workerId": "w_b", "why": "Worker B has slightly lower window utilization"}` $\implies$ Dispatched to `Worker B`.
5. **If Controller times out (90s) or has no quota:** Fallback chooses `Worker B` (highest arithmetic score). Zero disruption.
