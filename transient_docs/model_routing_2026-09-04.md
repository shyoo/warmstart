# Model-aware routing — scoring a (worker, model) pair, not just an account (2026-09-04)

**Filed 2026-09-04 (t227) in three parts, all landed 2026-09-05.** Part 1 (t227): the four
independent inputs — a benchmark-prior file and its loader, a zero-token complexity read, a
prior/review fitness blend, and an opt-in per-worker model allowlist. Part 2 (t227/t228): wiring —
`chooseTarget` expands each eligible worker into candidate `(worker, model)` pairs, `objective.ts`
gains `fitness` and `price`, and an off-by-default ε-greedy explorer breaks the feedback loop scoring
would otherwise create. Part 3 (t229): the operator surface (Analytics › Routing Model › Models) and
the documentation update this file is part of. Everything measured here was measured in this worktree
against the repository at the head of `main` on 2026-09-05.

⛔ **Read `docs/routing.md` §§2.4, 3.4, 3.5 and 4.8 before this file.** They are the maintained,
current authority on the mechanism; this page is the record of *why* it is shaped the way it is and
what has not yet been checked against a real fleet.

---

## 1. The problem

Every account on this fleet is not one thing. `claude-code` alone prices three models roughly eight
times apart on this install's own cost model; Antigravity's Gemini pool alone offers seventeen. Before
this work, routing chose an *account* and let `resolveModelChoice` pick whichever model that account
already defaulted to — so a typo fix and an architectural rewrite dispatched to the same account ran
on the same model, and there was no way to prefer the cheap one for the first and the capable one for
the second without a person manually pinning a model on every task.

Three things had to exist before "prefer the cheap sufficient model" was even a question the scheduler
could ask:

1. **Something to measure a model's fitness against**, since this fleet's own peer reviews are sparse,
   uncalibrated across providers, and easy to overfit to a lucky handful of grades.
2. **Something to measure a task's difficulty against**, since "how hard is this" had never been asked
   anywhere in the codebase — `estimateTask` answers "how big", from run history, never from the
   prompt.
3. **A reason routing candidates would ever include more than one model per worker**, since scoring
   only ever ran once per eligible account.

And a fourth problem, visible only once the first three exist: a model with no benchmark prior and no
clean review scores 0 for fitness under any sufficiency bar, so the arithmetic alone would never
route to it — and a model that never runs is never measured, which *looks* like evidence and is only
silence.

---

## 2. What shipped

### 2.1 Part 1 — four independent, separately testable inputs

- **`benchmarks/coding-agents.2026-09.json` + `benchmarks.ts`.** A versioned, checked-in 0..1
  "agentic coding" prior per model id, covering all 26 ids across `costmodels/*.json`. Resolution is
  exact id → longest matching family prefix → `null`, mirroring the two-level ladder `factorFor`
  (`estimator.ts`) and `paceFor` (`pace.ts`) already climb. Every entry states its own `basis`:
  `published` (a leaderboard scores this exact id, with a source and a retrieval date), `inferred` (a
  neighbouring or predecessor model stands in, with the mapping stated), or `unknown`. Researched
  mostly from Terminal-Bench 2.1 (`vals.ai`), with Anthropic's own published Haiku 4.5 figures and
  OpenRouter's Qwen3-Coder figure filling the two gaps that leaderboard did not cover.
- **`complexity.ts`.** Scores a task's *prompt* — `task.title`, which **is** the prompt on this fleet
  — 0..1, for zero tokens: word count (log-scaled, boosted to dominance by a stated `estTokens`),
  structure (code fences, file paths, lists, acceptance criteria), a whole-word verb lexicon,
  required capabilities, attachment count, and dependency fan-out. A `plan` task's own `kind` signal
  absorbs whatever it takes to keep the total at or above the medium floor, so a plan is never called
  low without capping any other task's ceiling — the floor is paid for out of one signal's own
  weight, never reserved from the other six.
- **`fitness.ts`.** Blends the benchmark prior with this fleet's **clean** quality reviews (single
  author, blinded without a leak) in log space: `prior^(K/(n+K)) · measured^(n/(n+K))`, `K=8`. Three
  degenerate cases, each explicit: prior alone (nothing graded), measured alone (no prior exists), or
  `null` (neither — never 0, never 0.5).
- **The routable-models allowlist.** Migration 47 adds `workers.routable_models_json`. `null`/`[]`
  resolve through `routableModelsFor` to exactly the one model a worker already defaults to, which is
  what keeps the whole feature inert until an operator opts a worker into a second model. Validated
  against the cost model on write.

### 2.2 Part 2 — candidate pairs, two new terms, and an explorer

`chooseTarget` (`scheduler.ts`) expands each worker that clears the account-level gates into one
candidate per entry in `routableModelsFor(worker)` (capped at 8), pinning to a single pair where a
warm/reopenable session or a task constraint already names a model. The 92% quota-pool gate moves
inside that per-model loop, so a multi-pool account can have one pool blocked and another free at the
same time — see `docs/routing.md` §1 and §2.3.

Two new terms in `objective.ts`:

- **`fitness`** (`0.4 + 1.6×quality`) — a **sufficiency bar**, not a leaderboard. The task's
  complexity band sets a required fitness (low 0.35, medium 0.55, high 0.75); a pair that clears it
  scores 1.0 regardless of margin, and `price` is what separates two pairs that both clear it.
- **`price`** (`0.5 + 2.0×cost`) — a logarithmic 0..1 penalty against the *cheapest candidate in this
  decision's own field*, saturating at 8×. Priced in dollars when every candidate has one, falling
  back to priced tokens for the whole field the moment one does not.

**Exploration** (`exploration.ts`), off by default: with probability `modelExplorationRate` (default
0.10), swaps the winner for another routable model on the *same* worker, preferring one with
unmeasured fitness. Excluded on a pin, a warm/reopenable/sticky session, a `plan` task, a
high-complexity task, or a worker with one routable model. Recorded as `basis: 'explore'` and posted
to the task thread.

### 2.3 Part 3 — the operator surface

`routing.models` (`api.ts`) serves a `ModelReport` (`@shared/routing.ts`): one row per (worker,
model) pair *the adapter can price*, not only the routable ones — `routable` is the field that tells
the two apart, because the page exists to answer "should I widen this allowlist" as much as "what did
the fleet actually do". Each row carries the benchmark prior and its basis, the clean composite and
its clean count, the blended fitness and its basis, an estimated cost per task (`n/a`, never
`$0.00`), the measured pace factor, the quota pool and its live percentage, and how many dispatches —
and how many explorations — actually chose that pair, read from `routing_decisions`.

`ModelsModel.tsx` is a new Analytics › Routing Model tab, in the same "one page per axis, numbered
teaching sections then a table" idiom as `VelocityModel.tsx`.

---

## 3. Design decisions

**Sufficiency, not excellence.** A leaderboard-shaped fitness term — reward the highest scorer always
— would route every task to the most capable and most expensive model available, which is exactly the
failure mode a per-model routing feature exists to avoid. The complexity band exists so "good enough"
has a task-specific meaning, and clearing it earns the *full* bonus rather than a partial one: a model
at 0.95 fitness against a 0.35 bar is not preferred over one at 0.40, because nothing about the task
in front of it needs the difference.

**The benchmark prior is the baseline, and the fleet's own reviews are the correction — never the
reverse.** `transient_docs/quality_review_2026-09-03.md` §12 already recorded that nothing calibrates
a review composite across providers or reviewers, and that no task on this fleet has ever been run
twice on two models. Trusting the measured composite from review one would let three lucky reviews
outrank a model a hundred honest, mediocre reviews had actually placed lower. `K=8` — larger than the
estimator's `SHRINK_K=5` or pace's `SHRINK_K=4` — says plainly that a peer-graded composite is the
least calibrated of the three quantities this fleet shrinks toward a prior.

**Complexity costs zero tokens, on principle, not as an optimisation.** `AGENTS.md`: "The scheduler
costs zero tokens." Asking a controller "how hard is this task" would have been the obvious way to
build this, and would have violated the one invariant that makes this scheduler affordable to run
continuously. Every signal in `complexity.ts` is either already on the `Task` row or one indexed
query away.

**The allowlist is opt-in and empty by default.** An allowlist that defaulted to "every model the
adapter can price" would have handed the scorer roughly sixty (worker, model) candidates a tick on
this fleet's four commissioned adapters — several of which nobody chose and several of which cost
eight times what the operator was already paying. `null`/`[]` resolving to today's single default is
what keeps the *candidate set* on an existing install exactly what it was.

**Inertness needed a second gate, which the three parts did not have between them.** Keeping the
candidate set unchanged is not the same as keeping the *scores* unchanged, and reviewing the merged
branch as a whole is what surfaced the difference. `routableModelsFor` resolves an empty allowlist to
the worker's current default — a real model id — so `fitness` read a benchmark prior for it and
`price` estimated it, on every fleet, opted in or not. Two accounts whose defaults differed scored
0.549 apart on a medium-complexity task and 1.040 apart on a high one, against a `ROUTE_EPSILON` of
0.10. `modelRoutingActive()` (`workers.ts`) now holds both terms at 0 fleet-wide until some
non-retired worker has a non-empty allowlist. It is fleet-global rather than per-worker on purpose:
zeroing only the un-opted-in workers would put an opted-in worker carrying a real `price` penalty
against one scored as though its model were free.

⚠️ **The test that was supposed to guarantee this asserted the weaker half.** It was named for
every score being identical and checked only the candidate list, which is why three green suites and
a passing typecheck did not catch it. `routing.test.ts` now asserts both terms term-by-term — value,
contribution and basis — on a prompt deliberately above the `low` band, where the two priors would
otherwise tie and pass vacuously.

**Exploration is off by default and framed as a real cost.** It is a scheduler that deliberately does
not pick the arithmetic's own winner, on the same reasoning `autoRunawayStop` and `summariseTitles`
already use for a similar class of decision: a real cost, paid for information, that an operator
should choose to pay rather than have paid on their behalf.

---

## 4. What this does not do, and what is unproven

⛔ **No A/B pair has ever been run.** Nothing here has dispatched the same task twice on two models and
compared what came back — the entire fitness blend, the sufficiency bar and the price penalty are
built from measured *inputs* (benchmark leaderboards, this fleet's own quality reviews, this fleet's
own cost history) but the *output* — does a low-complexity task actually finish just as well on the
cheap model it was routed to — has not been checked against reality once.

⛔ **The benchmark priors for this fleet's specific model ids are largely `inferred`, not `published`.**
Of the 26 ids in `costmodels/*.json`, several — every effort tier of every Gemini Flash generation,
`claude-opus-4-6-thinking`, `gpt-oss-120b-medium` — have no leaderboard entry under that exact name and
rest on a mapping to a neighbouring or predecessor model. `benchmarkPrior`'s `basis` string says which
for every one of them, but "labelled honestly" is not the same claim as "measured".

⛔ **The complexity heuristic has never been checked against a human's judgment of the same prompts.**
Nobody has taken a sample of real tasks, asked a person to rate their difficulty, and compared it to
what `complexity.ts` produced. The band thresholds (0.34/0.67) and the per-signal weights are
reasoned from first principles and unit-tested for internal consistency, not calibrated against an
external judgment.

⛔ **Exploration has never been switched on outside a unit test.** `modelExploration` ships `false` on
every install. Nobody has watched it pick an unmeasured model on a live fleet, seen the thread notice
it posts, or confirmed that the resulting sample actually moves a pair's fitness away from `null` the
way it is designed to.

⚠️ **The cost estimate a routing decision competes on is fleet-neutral, not task-specific, until a key
has real samples.** `estimateTask`'s own confidence machinery is unchanged by this work; a brand-new
`(worker, model)` pair with zero completed runs is priced off the fleet's neutral median run scaled by
whatever factor a *different* key on the same adapter has earned, which is the same caveat
`estimator.ts` has always carried and this feature inherits rather than solves.

⚠️ **The Models report's dispatch and exploration counts are a full scan of `routing_decisions`.**
Correct today, and explicitly not paginated — `dispatchCountsByPair` (`routingdecisions.ts`) reads
every row and parses its `candidates_json` looking for the chosen entry. Fine for an analytics page a
person opens; a fleet with a very long routing history has not been measured against it.

---

## 5. Where each piece lives

| Concern | File |
|---|---|
| Benchmark priors, the data | `benchmarks/coding-agents.2026-09.json` |
| Benchmark priors, the loader | `src/daemon/benchmarks.ts` |
| Task complexity | `src/daemon/complexity.ts` |
| Fitness blend | `src/daemon/fitness.ts` |
| Routable-models allowlist | migration 47 (`db.ts`), `Worker.routableModels` (`protocol.ts`), `routableModelsFor` (`workers.ts`) |
| Candidate pair expansion, per-pair quota gate | `chooseTarget` (`scheduler.ts`) |
| `fitness` / `price` weights | `objective.ts` |
| Exploration | `src/daemon/exploration.ts` |
| The kept decision, `basis: 'explore'` | `src/shared/routing.ts`, `routingdecisions.ts` |
| The operator report | `modelReport()` / `'routing.models'` (`api.ts`), `ModelReport` (`@shared/routing.ts`) |
| The operator surface | `src/renderer/src/components/ModelsModel.tsx` |
