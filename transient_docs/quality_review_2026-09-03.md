# Peer quality review — grading an agent's work, and storing the grade (2026-09-03)

**Filed 2026-09-03 (t153). Plan only — nothing in `src/` implements any of this yet.**
Four design decisions were put to the operator and are recorded in §4. Everything measured here was
measured in this worktree on 2026-09-03 against the repository at `da837d9`.

⛔ **Read §2 before §5.** Most of what this feature needs already exists — a run is already a metered,
attributed, per-task record, and `extractJson` already turns an agent's reply into a validated
object. The parts that do *not* exist are smaller and stranger than they look, and one of them
(§7, finding the diff of a task whose branch was deleted at landing) is the only piece that has to
be written *before* the next task lands or the data is gone for good.

---

## 1. The problem

Each task is run once, by one agent, for cost reasons. One run produces no comparison: it says the
task finished, not whether it finished *well*. There is no field anywhere in this app that says
"this work was good" — `RunOutcome` says `completed`, which is a statement about the process
exiting, and `activeMs` says how long it took, which is a statement about speed. Both are already
measured. Quality is not.

So: **a second agent grades the first agent's diff against a published rubric, the score is stored on
the task, and the reviewer is never the agent that did the work.** Peer review, in the ordinary sense.

⚠️ **What this is not.** It is not a correctness gate — nothing blocks on the score, no task changes
status because of it, and a 3/10 lands exactly as a 9/10 does. It is an *instrument*, in the sense
HANDOFF uses that word: a number kept beside the work so that a question asked in three months
("is Codex actually worse at this repo's UI code, or did it just draw the hard tasks?") has data
behind it instead of a memory.

---

## 2. What is true today

### 2.1 The substrate that already exists, and is enough

| What the review needs | Where it already is | Notes |
|---|---|---|
| The original human prompt | `tasks.title` | ⛔ `title` **is** the prompt — `promptFor()` sends it verbatim. `title_summary` is the label. |
| Every intermediate prompt | `runs.prompt`, `task_messages` | The exact text sent to the CLI, per run, including handoff notes and branch notices. |
| Who did the work | `runs.adapter_id`, `runs.model` | ⛔ Stamped on the run at dispatch and re-asked in `finishRun`, so it outlives the session. This is what makes "who is being graded" answerable at all. |
| Token cost of the review | `runs.input_tokens` … `cache_write_tokens`, fed by `creditTurn` | Automatic **if and only if** the review is a real `runs` row — `creditTurn` finds its run by `session_id`. See §5.1. |
| Rendering it as `#7 Quality Review` | `chronologicalTimeline()` + `RunRow`'s `#{index} Run` | `taskview.tsx:393`, `TaskThread.tsx:1632`. The timeline already numbers runs and compactions together. |
| Parsing a JSON verdict from an agent | `extractJson()`, `controller.ts:562` | Handles fences, nested braces and braces inside strings. Exported already. Reuse it; do not write a second one. |
| Asking one agent one tool-less question | `controller.ts`'s `ask()` / `spawnSession({ purpose: 'consult' })` | The shape is right. The bookkeeping is wrong for this — see §5.1. |
| "Is this account fit to be given a turn" | `accountUnavailability()`, `eligibility.ts` | ⛔ One list, shared by work and judgment. The reviewer gate reads it too and adds nothing to it. |
| A read-only mode per CLI | `capabilities.permissionModes` | Present on all three, spelled differently — see §6.2. |
| A cheap model per provider | `costmodels/*.json` | `claude-haiku-4-5`, `gemini-3.7-flash-*`, `gpt-5.4-mini`, `qwen3-coder-30b-a3b`. |

### 2.2 The four things that do not exist

1. **No record of what a landed task's diff was.** `mergeLocal` fast-forwards the trunk and then
   calls `retireBranch`, which does `git branch -D` (`landing.ts:331`). `LandingResult.commit` — the
   branch tip — is returned, logged and thrown away; the base it was rebased onto is never captured
   at all. After a successful land there is nothing on the task that identifies its commits.
   ⛔ **This is the piece that has to ship first**, because every task that lands between now and
   then loses the ability to be reviewed accurately. See §7.
2. **No `review` session purpose.** `SessionPurpose` is `'work' | 'login' | 'consult' | 'chat' | 'probe'`
   (`protocol.ts:532`). A review is none of them: it needs a real `cwd` (unlike `consult`), no MCP
   tools (unlike `work`), and its own concurrency bound.
3. **No kind on a run.** Every `runs` row is work today, and **25 `from runs` references across
   seven files** assume it (counted 2026-09-03). See §5.2 for the audit — this is the highest-risk
   part of the change, and it is risky by *breadth*, not depth.
4. **No rubric, no score, nowhere to put one.** §3 and §8.

### 2.3 Two facts measured today that change the design

**⭐ Measured 2026-09-03, last 60 commits on this branch:** **37** carry a
`Co-Authored-By: <agent> <…>` trailer naming the model that wrote them, and **20** name an agent
(*"codex"*, *"Claude"*, *"antigravity"*) in the commit message **body, outside any trailer** — e.g.
`da837d9`'s subject is literally *"The subcommand that lets codex go home"*.

⛔ **So blinding (§4, decision 2) is exact on structured fields and best-effort on prose, and the
plan must say so rather than claim a guarantee it cannot keep.** Stripping trailers is mechanical
and complete. Redacting prose is not: replacing *"codex"* with *"AGENT-A"* throughout a commit body
that explains a codex-specific sandbox bug produces a paragraph that no longer means anything, and a
reviewer reading it would score the *redaction* rather than the work. §6.4 records the leak instead
of pretending to prevent it.

**⚠️ The git author is not a leak.** All 60 commits are authored `Sunghwan Yoo <shyoo@…>` — the agent
commits under the operator's git identity. Only the trailer and the prose name the agent.

---

## 3. The rubric

### 3.1 What real benchmarks do, and what this borrows

Read 2026-09-03. Sources at the end of this section.

- **Senior SWE-Bench** (Snorkel) is the closest match to the question being asked here. It grades a
  patch along two axes — *relative code quality* (minimality, approach, hygiene, fluency,
  craftsmanship) and *codebase practice alignment* (style consistency, pattern adherence, library
  usage, abstraction level, documentation fit) — with a two-judge panel and a **patch bloat** metric
  (SLOC of the submission ÷ SLOC of the reference). ⛔ Its judge is explicitly **not** a universal
  taste: it reads the surrounding repository and asks whether the patch fits *that*. That is the
  single most important thing to copy, and it is why §4's decision 1 (the reviewer can open files)
  matters more than any other lever in this plan.
- ⚠️ **We have no reference solution**, which is the axis Senior SWE-Bench leans on hardest. Its
  bloat ratio and "relative to expert" scoring are unavailable here. The substitute is the
  repository itself plus the task's own prompt — which is weaker, and §12 says so.
- **Score range.** The reported human/LLM alignment peak is a **0–5** scale (0.89 Pearson); longer
  scales drift. The operator asked for 10-point, and 10-point is what ships — with **explicit
  anchors written at 2/4/6/8/10** so the judge is choosing between five described states and
  interpolating, rather than picking a number off a bare line. That is the mitigation the
  score-range-bias literature actually recommends, and it costs five sentences per dimension.
- **Anchoring bias.** A judge shown a prior score converges on it. ⛔ Therefore: **one reviewer, one
  pass, and the review prompt never contains a previous review of the same task.** Re-reviewing is
  allowed (§8.4) and each review is independent by construction.
- **Self-preference bias.** Judges favour their own output; the standard mitigation is not to let a
  model grade itself. That is the whole premise here, and §6.1 makes it a hard constraint rather
  than a default.
- **Holistic scoring is where judges are least reliable** on long agentic outputs, which is why the
  headline number is computed by the daemon from the dimensions (§4, decision 4) and not asked for.

Sources: [Senior SWE-Bench — how it works](https://senior-swe-bench.snorkel.ai/blog/2026-06-16-how-it-works) ·
[Senior SWE-Bench overview](https://snorkel.ai/blog/senior-swe-bench-evaluating-coding-agents-like-senior-engineers/) ·
[Anchoring bias in LLM-as-a-judge](https://arxiv.org/html/2608.25869) ·
[Quantifying and mitigating self-preference bias](https://arxiv.org/abs/2604.22891) ·
[Contrastive decoding mitigates score range bias](https://arxiv.org/pdf/2510.18196) ·
[LLMs-as-judges survey](https://arxiv.org/pdf/2412.05579) ·
[SWE Atlas](https://arxiv.org/html/2605.08366v1) ·
[CodeCriticBench](https://arxiv.org/pdf/2502.16614) ·
[AI coding benchmarks explained](https://www.openhands.dev/blog/ai-coding-benchmarks-explained)

### 3.2 The seven dimensions

Each scored **0–10**, each with a written rationale citing a file and line from the diff. Weights are
published in `src/daemon/review.ts` and shown next to the score in the UI, exactly as `objective.ts`
publishes its weight vector.

| # | Dimension | Weight | The one question it asks |
|---|---|---|---|
| 1 | **Requirement fidelity** | 0.20 | Did it do what was actually asked — all of it, and only it? |
| 2 | **Correctness & robustness** | 0.20 | Does the change do what it claims, including on the paths nobody exercised? |
| 3 | **Test & verification** | 0.15 | Would the new tests have failed before this change, and do they test behaviour? |
| 4 | **Codebase fit** | 0.15 | Does it look like the code around it, and reuse what is already there? |
| 5 | **Scope discipline** | 0.10 | Is the diff the size the job needed? |
| 6 | **Maintainability** | 0.10 | Can the next person change this safely without asking the author? |
| 7 | **Self-sufficiency** | 0.10 | How much did it cost in retries, questions and hand-holding to get here? |

Weights sum to 1.00. ⛔ Correctness and fidelity together are 40%: a beautiful patch that does the
wrong thing is a failure, and the rubric has to say so numerically or it does not mean it.

### 3.3 The anchors, in full

These go into the prompt verbatim. They are what makes a 7 mean the same thing on Tuesday as on
Friday, and what makes a 7 from Codex comparable with a 7 from Antigravity.

**1 · Requirement fidelity** — measured against the original human prompt, not against what the agent
decided the task was.

- **10** — Every stated requirement is met. Ambiguities were resolved the way a careful colleague
  would, and where a judgment call was made it is stated (in a commit message, a comment, or a
  question the agent asked).
- **8** — All requirements met; one ambiguity resolved silently in a defensible direction.
- **6** — The main requirement is met; a secondary one is partially done or quietly dropped without
  saying so.
- **4** — A stated requirement is missing or was reinterpreted into something easier.
- **2** — The change addresses a related problem rather than the one asked about.
- **0** — Does not address the request.

**2 · Correctness & robustness**

- **10** — Correct on the happy path and on the error, empty, concurrent and boundary paths. Failure
  modes are handled deliberately and visibly; nothing swallows an error into a wrong-but-quiet state.
- **8** — Correct; one unhandled edge case that is unlikely and would fail loudly.
- **6** — Correct for the intended use; a plausible input or ordering produces wrong behaviour.
- **4** — A defect a careful reviewer would catch on one read — an off-by-one, an unawaited promise,
  a resource never released, a null path.
- **2** — Works only on the exact case demonstrated.
- **0** — Does not work, or breaks existing behaviour.

**3 · Test & verification**

- **10** — New behaviour has tests that would fail without the change. They assert observable
  behaviour, cover at least one failure path, and are placed where this repository puts tests.
- **8** — Good coverage of the happy path, thin on failure paths.
- **6** — Tests exist and pass but largely restate the implementation, or only cover the case the
  author was already thinking about.
- **4** — A token test, or tests for the easy part while the risky part is untested.
- **2** — No tests where the change plainly needed them.
- **0** — No tests, and existing tests were weakened, skipped or deleted to make the change pass.

⚠️ **Not every change needs a test**, and a judge that insists otherwise is wrong about this
repository as much as any other. A pure-CSS change, a doc edit, or a rename has no behaviour to
assert. Score **`null`** rather than 0 when the dimension does not apply; the composite renormalises
over the dimensions that were scored (§8.2).

**4 · Codebase fit** — the Senior SWE-Bench axis, and the reason the reviewer gets to read files.

- **10** — Indistinguishable in style from the code around it: naming, structure, error handling,
  comment density and the level of abstraction all match. Existing helpers are reused. No new
  dependency where the project already has one that does the job.
- **8** — Fits well; one small divergence (a naming choice, a slightly different error shape).
- **6** — Recognisably a different hand — works, reads as bolted on. Reimplements something small
  the codebase already has.
- **4** — Introduces a pattern the project does not use, or a dependency it did not need.
- **2** — Ignores the surrounding conventions.
- **0** — Fights them: parallel abstractions, duplicated state, a second way to do an existing thing.

**5 · Scope discipline**

- **10** — Every hunk is necessary. No drive-by reformatting, no speculative generality, no dead
  scaffolding, no unrelated file touched.
- **8** — Essentially minimal; one small unrelated tidy-up.
- **6** — Noticeable extra surface — an abstraction with one caller, an option nothing sets.
- **4** — A refactor was carried along with the fix, mixing two reviews into one diff.
- **2** — The change is several times the size the job needed.
- **0** — Sweeping unrequested rewrite.

⚠️ **Small is not automatically good.** A one-line change that skips work the task asked for scores
low on dimension 1 and must not be rewarded here for being short.

**6 · Maintainability**

- **10** — A stranger can change this in six months. Names say what things are, the structure makes
  the next change obvious, non-obvious decisions carry their reason, and the docs the change made
  wrong were fixed in the same diff.
- **8** — Clear; one place where the reason for a choice is not recorded.
- **6** — Readable but requires re-deriving the author's intent in a couple of places.
- **4** — Hidden coupling, a magic value with no name, or an interface that invites misuse.
- **2** — Would need rewriting before it could safely be extended.
- **0** — Actively misleading — comments contradict code, names lie about behaviour.

**7 · Self-sufficiency** — ⛔ **The daemon supplies the facts; the reviewer supplies the judgment.**
The prompt states the observed run history (how many runs, how many failed, how many project-check
failures, how many questions the agent asked a human, whether work was left uncommitted) and the
reviewer scores how much of that was *avoidable*.

- **10** — One run, checks passed first time, no human input needed beyond the original prompt, work
  committed cleanly.
- **8** — One or two runs; a question was asked and it was a genuinely necessary one.
- **6** — Several runs, or checks failed once and were fixed without help.
- **4** — Repeated check failures, or a question the original prompt already answered.
- **2** — Needed a person to unstick it, or left uncommitted work behind.
- **0** — Did not converge without substantial human rework.

⚠️ **Retries are not automatically the agent's fault.** A run preempted at a quota window boundary,
or one that stopped because a workspace was contended, is the scheduler's doing. The prompt states
the `RunOutcome` of each prior run precisely so the reviewer can tell `preempted` from `failed`, and
the anchors are to be read as being about the agent's contribution only.

### 3.4 A worked example — `d31b2e9`, in this repository

⚠️ Written by hand as a calibration sample, not produced by a model. Its purpose is to fix what the
numbers mean before any agent is asked to produce one; it belongs in `review.test.ts` as the fixture
the prompt-builder and the parser are checked against.

**The task** (paraphrased from the commit): the fleet's narrowing control floated below the whole
fleet strip; put it in a left rail directly beneath the *Fleet* label, alongside the worker cards.

**The diff:** `FleetStrip.tsx` +34/−36, `app.css` +18/−1, `test/ui.test.mjs` +36/−0. Three files,
89 insertions, 36 deletions.

| Dimension | Score | Rationale |
|---|---|---|
| Requirement fidelity | **9** | The control is in a left rail beneath the label, which is exactly what was asked. The extra CSS is the geometry that request implies, not scope creep. |
| Correctness & robustness | **8** | Layout-only, and the failure mode of a layout change is visible. Not 10 because nothing here demonstrates the narrow-window case, which is where a new rail is most likely to collapse. |
| Test & verification | **9** | 36 lines added to `ui.test.mjs` asserting the *geometry* — the rail's position relative to the cards — rather than the presence of an element. That is the difference between a test that would have caught the bug and one that would not. |
| Codebase fit | **9** | Uses the existing `ui.test.mjs` harness and the project's CSS conventions; no new dependency, no new pattern. |
| Scope discipline | **8** | 70 lines touched in `FleetStrip.tsx` for a placement change is more than the minimum, though a rail is a structural move and the near-equal +34/−36 says it is a relocation rather than an addition. |
| Maintainability | **8** | Clear. Not 9 because the CSS carries no note about *why* the rail is fixed-width, which is the number the next person will want to change. |
| Self-sufficiency | **9** | One run, checks passed, no questions. |

**Weighted composite: 8.6 / 10.** (9×.20 + 8×.20 + 9×.15 + 9×.15 + 8×.10 + 8×.10 + 9×.10)

⭐ Read the spread, not the total. Nothing here is below 8, which is what a small, well-scoped,
tested change should look like — and it is exactly the shape that makes an 8.6 on a 400-line
multi-file change mean something different.

---

## 4. Decisions taken (operator, 2026-09-03)

**D1 · The reviewer runs read-only in the project trunk, with the diff inline.** Not a pooled
worktree (which would make reviews compete with real work for a scarce resource, and would be unable
to review a landed task at all once its branch is deleted), and not diff-only (which would make
dimension 4 — codebase fit — guesswork, and it is the dimension the research says matters most).
⚠️ The trunk may have moved past the reviewed commits; the prompt states the trunk SHA and the
reviewed SHA range explicitly and tells the reviewer to trust the diff over the working tree.

**D2 · Blind.** The review prompt names no adapter, no model, no worker label, no account. The run
history is anonymised to *"run 1"*, *"run 2"*, *"a different agent took over at run 3"*.
⚠️ Exact on structured fields, best-effort on prose — see §2.3 and §6.4.

**D3 · No eligible peer means no review.** The button reports which agents were considered and why
each was rejected, and writes nothing. The task keeps `qualityReview = none` so a later sweep finds
it. ⛔ Every stored score was produced by a non-author; there is no asterisked variant of that claim.

**D4 · The headline score is a weighted mean over the dimensions, weights published in code.**
Recomputed from stored dimension scores, so changing the weights re-scores history instead of
orphaning it. No holistic score is asked for.

---

## 5. Data model

### 5.1 A review is a run — migration 35

⛔ **A `runs` row, not a new table, and the reason is metering.** `creditTurn` (`tasks.ts:1274`) is
the only place spend is recorded, and it finds its run by `session_id`. A review that was not a run
would have to grow a parallel metering path — a second reader of the transcript, a second place for
the numbers to be wrong — to satisfy the requirement that its token cost be recorded. It would also
have to grow a parallel timeline entry to render as `#7 Quality Review`. Both already exist.

```sql
-- 35 — a run has a kind, and a review is one.
alter table runs add column kind text not null default 'work';   -- 'work' | 'quality_review'

create table quality_reviews (
  id                 text primary key,
  task_id            text not null references tasks(id) on delete cascade,
  run_id             text not null references runs(id),   -- ⛔ the metering, and the timeline entry
  reviewer_worker_id text not null,
  reviewer_adapter   text not null,
  reviewer_model     text,
  -- Who is being graded. ⛔ Stored, not derived at read time: the runs it is derived from can be
  -- re-attributed by `finishRun`, and a score whose subject changes after the fact is not a record.
  subject_adapter    text not null,                        -- the agent credited with the work
  subject_model      text,
  -- ⭐ True when more than one adapter contributed a non-failed run. The operator asked for these to
  -- be reported separately and to decide later how to treat them; this is that flag.
  mixed_authorship   integer not null default 0,
  authorship_json    text not null default '[]',           -- [{ adapterId, model, runs, lastAt }]
  -- The reviewed range, copied here so the record survives the branch and the trunk moving.
  base_sha           text,
  head_sha           text,
  diff_files         integer,
  diff_insertions    integer,
  diff_deletions     integer,
  diff_truncated     integer not null default 0,
  -- The verdict.
  scores_json        text,        -- { fidelity: {score, rationale}, ... } — score may be null
  composite          real,        -- ⚠️ null when the review failed; never 0, which is a real score
  summary            text,
  status             text not null,   -- 'pending' | 'complete' | 'failed' | 'refused'
  failure_reason     text,
  rubric_version     text not null,
  blinded            integer not null default 1,
  -- ⚠️ True when a name that blinding could not remove survives in the prose. See §6.4.
  blinding_leak      integer not null default 0,
  created_at         integer not null,
  completed_at       integer
);
create index quality_reviews_task on quality_reviews(task_id, created_at desc);
```

⛔ **`alter table … add column` has no `if not exists` in SQLite**, and every migration here must
survive being replayed (`db.ts:19`). Migration 35 is therefore a **function**, guarded by
`hasColumn(conn, 'runs', 'kind')` — the same shape as migrations 29 (`db.ts:906`) and 32
(`db.ts:967`).

### 5.2 The audit `runs.kind` forces — ⛔ the riskiest part of this change

**25 `from runs` references across seven files** (counted 2026-09-03: `tasks.ts` 9, `db.ts` 9,
`estimator.ts` 3, and one each in `activetime.ts`, `compaction.ts`, `conversations.ts`,
`sessions.ts`) and every one of them means *work* today. Each must be visited, and the default
answer is **`and kind = 'work'`**:

| Site | Must exclude reviews? | Why |
|---|---|---|
| `estimator.ts:225,271,540` | ⭐ **Yes, critical** | Reviews would enter the estimator's training data. A cheap one-turn review folded into the median for "what does a task cost" corrupts the number every gate reads. |
| `tasks.ts:104–109` (`first_run_at`, `last_run_ended_at`, last worker, last model) | ⭐ **Yes, critical** | Otherwise a reviewed task reports the *reviewer's* model as its own, and `taskview.tsx:212`'s "what ran beats what would run" starts lying on every reviewed row. |
| `activetime.ts:251` | **Yes** | ⛔ `activeMs` is *how long an agent worked on the task*. Grading it is not working on it. |
| `conversations.ts:118` | **No** — but tag it | A review is a real conversation that really happened; hiding it would make the Conversations page disagree with the runs table. Render the kind instead. |
| `db.ts:375–398, 557, 873` | **Review individually** | Session-state repair and project inference. A review session is a real session; most of these want it. |
| `tasks.ts:1238` `runsFor` | **No** | The thread wants both — that is the whole point of `#7 Quality Review`. |
| `tasks.ts:1252,1261` `lastRunForSession` / `runForSession` | **No** | Per-session, and a review session serves exactly one review run. |
| `sessions.ts:390` | **No** | "Is a run open in this session" is true of a review too. |
| `compaction.ts:291` | **No** | Attribution of a compaction to its task; correct either way. |
| `creditTurn` (`tasks.ts:1274`) | ⚠️ **Partially** | Charge the *run* (wanted) but ⛔ **not** `task.budget.spentTokens` — that budget gates admission and overrun for the task's own work, and a grade must not push a task over its budget. Split the two writes on `kind`. |

⚠️ `runfailure.test.ts`, `metering.test.ts`, `estimator.test.ts` and `activetime.test.ts` each need a
case proving a review run does not contaminate them. That is the acceptance criterion for this
section — not "the column exists".

### 5.3 On the task

```sql
-- migration 35, continued
alter table tasks add column quality_review_id     text;      -- the latest review
alter table tasks add column quality_review_score  real;      -- ⚠️ denormalised for the table
alter table tasks add column quality_review_at     integer;
alter table tasks add column quality_reviewer      text;      -- reviewer adapter id
```

⚠️ **Denormalised on purpose, and it is the only denormalisation here.** The task table sorts and
filters on the score across hundreds of rows; a join per row to `quality_reviews` on every
`task.page` would be paid on every keystroke of the filter box. The four fields are written by one
function (`recordReview`) and by nothing else.

New `Task` fields: `qualityReviewId`, `qualityScore`, `qualityReviewedAt`, `qualityReviewer` — all
nullable, `null` meaning *not reviewed*, which is distinct from *reviewed and scored zero*.

---

## 6. The reviewer

### 6.1 Choosing one — `pickReviewer(task)`

```
1. Determine the subject: the adapter(s) that produced this task's non-failed work runs.
   ⭐ Credit goes to the adapter of the LAST run that produced committed work (operator's rule).
   If more than one adapter appears, mixed_authorship = 1 and authorship_json lists them all.
2. Candidates = listWorkers() minus every worker whose adapterId appears in the authorship list.
   ⛔ Excluded by ADAPTER, not by worker: ClaudeSecond grading ClaudeThird is Claude grading Claude.
3. Filter by accountUnavailability() — the one shared list, unchanged.
4. Filter by quota: the same WINDOW_HIGH_WATER gate work goes through. A review is cheap but it is
   not free, and spending the last 8% of a window on a grade rather than on work is the wrong trade.
5. Filter by capability: the adapter must declare readOnlyPermissionMode (§6.2).
6. Prefer the adapter with the fewest reviews of this subject in the last 30 days, then the one with
   the most quota headroom. ⚠️ Round-robin over reviewers, so no single agent's taste dominates the
   dataset — the closest this can get to Senior SWE-Bench's two-judge panel at one judge's cost.
7. If the candidate set is empty: return { worker: null, reason } naming EVERY candidate and its
   rejection. D3.
```

⛔ **No `if (adapter === …)` anywhere in this.** Step 5 is a capability, step 4 is a quota reading,
step 2 is a set difference on ids. `AGENTS.md`'s rule holds.

### 6.2 A read-only mode is a capability, not a name

Measured 2026-09-03 from each adapter's declaration:

| Adapter | `permissionModes` | Read-only member |
|---|---|---|
| `claude-code` | `default, manual, acceptEdits, plan, auto, dontAsk, bypassPermissions` | ⭐ `plan` |
| `antigravity-cli` | `default, accept-edits, plan, dangerously-skip-permissions` | ⭐ `plan` |
| `openai-compatible` (codex) | `read-only, workspace-write, danger-full-access` | ⭐ `read-only` |
| `local-llm` | *(empty)* | ⛔ none — not eligible to review |

Add to `AdapterCapabilities`:

```ts
/**
 * The permission mode in which this CLI may read the repository and may not write to it.
 *
 * ⛔ A capability, not a name, and null is a real answer: an adapter with no such mode is not
 * offered review work at all rather than being run in a mode that can edit the trunk. The reviewer
 * is spawned in the operator's own project root — the one directory in this app where an unwanted
 * edit is not recoverable by throwing a branch away.
 */
readOnlyPermissionMode: string | null
```

⚠️ `external.ts` defaults it to `null`, so a declarative adapter is excluded until it says otherwise.
That is the safe direction.

### 6.3 The dispatch — `purpose: 'review'`

`SessionPurpose` gains `'review'`. In `spawnSession`:

- **`mcpConfig`: `null`.** Same reasoning as `consult` (`sessions.ts:700`): the daemon parses and
  applies the answer itself, every tool definition is cache prefix, and an unattended grader that
  could *act* is a much larger thing to trust. It also keeps `promptFor`'s trap closed — the
  reviewer is never told to call `task_complete`, so it never hunts for a tool it does not have.
- **`permissionMode`: `adapter.capabilities.readOnlyPermissionMode`.**
- **`cwd`: the project root.** ⚠️ Not a pooled worktree (D1) — no claim, no `prepareWorkspace`, no
  branch switch, nothing that can collide with real work. ⛔ Read-only mode is what makes running in
  the operator's own trunk acceptable, and it is why §6.2 is a hard gate rather than a preference.
- **Concurrency: one review per worker at a time, fleet-wide one at a time**, bounded exactly as
  `consult` is (`sessions.ts:665`) and exempt from `maxConcurrent` for the same stated reason.
- **`transport`: `'stream'`**, as all non-interactive work is.
- `whyNoSession` gains `review` alongside `work`.

Then, in order: `startRun({ kind: 'quality_review', … })` → a delayed prompt as `openConversation`
does → collect `assistant_text` / `result` exactly as `controller.ts`'s `ask()` does → `closeSession`
→ `extractJson` → validate → `recordReview` → `finishRun(runId, 'completed' | 'failed')`.

⚠️ **A timeout, and a cap.** `REVIEW_TIMEOUT_MS = 5 * 60 * 1000` and a fleet-wide hourly cap
mirroring `HOURLY_CAP`. A review that produces no parseable JSON is `status: 'failed'` with the
reason kept — ⛔ never a score of 0, which is a real grade and would be a lie about the work.

### 6.4 Blinding — `blind(text)`

Applied to the diff, the commit messages, the prompts and the run history:

**Removed exactly (structured):**
- `Co-Authored-By:` trailers (37 of the last 60 commits) and `Generated with [Claude Code]` lines.
- Every worker label, adapter id, adapter label and model id, from the run history and from prompts.
- The `runs` metadata block: only `outcome`, ordinal and duration bucket survive, as *"run 1"*, …
- `.claude/`, `.gemini/`, `.codex/` path components in file lists → the path is kept, the vendor
  directory is generalised, because *which* dotfile directory a task touched names the agent.

**Not removed (prose), and recorded instead:** a commit body or a source comment that names an agent
(20 of the last 60). ⛔ Redacting these produces text that no longer means anything (§2.3), so
`blind()` returns `{ text, leaked: boolean }`, the flag is stored as `blinding_leak`, and the UI puts
a small marker on such a score. ⚠️ A cross-agent comparison that has not excluded leaked reviews is
not a clean comparison, and the field is there so that can be checked rather than assumed.

⭐ `blind()` is a pure function over strings. It gets its own test file with the real leak cases from
this repository's history as fixtures — that is the cheapest possible way to keep it honest.

---

## 7. Finding the diff — ⛔ ship this first

### 7.1 The problem, precisely

`mergeLocal` (`landing.ts:521`) rebases the branch onto the base, fast-forwards the trunk, and calls
`retireBranch` → `git branch -D` (`landing.ts:331`). `finishWithoutLanding` deletes it too. After
either, the task's commits are in the trunk's history and **nothing identifies which ones they are**:
`LandingResult.commit` (the tip) is logged and discarded, and the base was never captured.

⚠️ `runs.trunk_sha_before` exists but is the wrong number — it is read at *dispatch*, before the
rebase, so it is not a parent of the landed commits.

### 7.2 The fix — two SHAs, recorded at the moment they are known

```sql
alter table tasks add column landed_base_sha text;
alter table tasks add column landed_head_sha text;
```

`LandingStrategy.land` already computes both in `mergeLocal`: `base` is `landingBaseFor(...)`
resolved to a SHA immediately after the successful rebase, and `head` is the existing
`const commit = await git(cwd, ['rev-parse', 'HEAD'])`. Add `base` to `LandingResult` beside
`commit`, and have `landTask` write the pair onto the task on `ok: true`. ⭐ After a fast-forward
merge both SHAs are reachable from the trunk forever, so `git diff <base>..<head>` answers correctly
long after the branch is gone. The same two lines go into `autoLand` and `pullRequest`.

### 7.3 Resolution order, and declining honestly

```
1. tasks.landed_base_sha && landed_head_sha, and both resolve in the trunk  → git diff base..head
2. task.branch still exists                → merge-base(landingTarget, branch)..branch
3. Neither                                 → refuse: "this task landed before its commit range was
                                              recorded and its branch has been retired; there is no
                                              diff to review." Status 'refused', no score written.
```

⛔ **Never guess.** A review of the wrong commits is worse than no review, because it produces a
number that looks exactly like a real one. Rung 3 is the honest answer for every task that landed
before this ships, and the plan accepts that the existing backlog is largely unreviewable — which is
precisely why §7.2 is the first thing built.

### 7.4 Size, and truncation

Read `git diff --stat` first. Budget **~120k characters of diff text** (≈30k tokens) in the prompt.
Over budget, include full hunks for as many files as fit in descending order of *change density*, and
list the remainder as `path | +N/−M (not shown)`. ⛔ Set `diff_truncated` and say so in the prompt in
one sentence: *"N of M changed files are shown in full; the rest are listed with their line counts.
Score what you can see and say in your rationale that the diff was truncated."* A judge that does not
know it is looking at part of a change will score the part as if it were the whole.

⚠️ Lockfiles, `dist/`, `out/`, and generated files are listed but never inlined.

---

## 8. Scoring and storage

### 8.1 The answer shape

```json
{
  "rubric_version": "1.0",
  "scores": {
    "requirement_fidelity":  { "score": 9, "rationale": "…" },
    "correctness":           { "score": 8, "rationale": "…" },
    "tests":                 { "score": null, "rationale": "CSS-only; no behaviour to assert." },
    "codebase_fit":          { "score": 9, "rationale": "…" },
    "scope_discipline":      { "score": 8, "rationale": "…" },
    "maintainability":       { "score": 8, "rationale": "…" },
    "self_sufficiency":      { "score": 9, "rationale": "…" }
  },
  "summary": "One or two sentences.",
  "notable": ["at most three specific observations, each citing file:line"]
}
```

Validation is closed, exactly as `applyConsult` is: seven known keys, `score` an integer 0–10 or
`null`, `rationale` a non-empty string under 600 characters. ⛔ Anything else → `status: 'failed'`
with the reason recorded. **No repair pass, no re-ask** — a second turn to fix a malformed answer
doubles the cost of the cheapest thing in the system, and a model that cannot emit seven keys is a
finding about that model worth keeping.

### 8.2 The composite

```ts
/**
 * The weight vector, published because it is a judgment call.
 *
 * ⛔ Correctness and fidelity are 40% between them: a well-crafted patch that does the wrong thing
 * is a failure, and the number has to say so. Style fit is 15% and never more — it is the dimension
 * a judge is most confident and least right about.
 *
 * ⚠️ Renormalised over the dimensions actually scored. A `null` (the dimension does not apply — a
 * CSS change has no tests to weigh) must not drag the mean down, and must not silently redistribute
 * to whichever dimension happens to be listed next.
 */
export const RUBRIC_WEIGHTS = {
  requirement_fidelity: 0.20,
  correctness:          0.20,
  tests:                0.15,
  codebase_fit:         0.15,
  scope_discipline:     0.10,
  maintainability:      0.10,
  self_sufficiency:     0.10
} as const
```

`composite = Σ(wᵢ·sᵢ) / Σ(wᵢ)` over scored dimensions, rounded to one decimal. ⛔ Computed in the
daemon from the stored dimension scores, never read from the model's reply, and recomputable — so
changing a weight re-scores history rather than orphaning it (D4).

### 8.3 Mixed authorship

`authorship_json` is built from the task's work runs grouped by `adapter_id`, ordered by time:

```json
[ { "adapterId": "claude-code", "model": "claude-opus-5", "runs": 2, "lastAt": 1756000000000 },
  { "adapterId": "openai-compatible", "model": "gpt-5.6-terra", "runs": 1, "lastAt": 1756000100000 } ]
```

⭐ **Credit goes to the last adapter that produced committed work** (`subject_adapter`), and
`mixed_authorship` is set whenever the list has more than one entry. ⚠️ Any aggregate that compares
agents must filter on `mixed_authorship = 0` by default and say so on screen — a score attributed to
Codex for a task Claude did 80% of is not evidence about Codex. ⛔ The plan deliberately does **not**
apportion a score between agents: nothing here can measure who contributed which hunk, and inventing
a split would be exactly the confident unsourced number `AGENTS.md` forbids.

### 8.4 Re-reviewing

`quality_reviews` keeps every row; `tasks.quality_review_id` points at the latest. ⛔ A second review
never sees the first (anchoring, §3.1). Two independent reviews of one task that disagree by more
than ~2 points are the most interesting rows in this dataset — they are the measurement of how much
the *judge* is worth — and a later analysis pass can find them with one query.

---

## 9. The prompt

Assembled by `buildReviewPrompt(task, diff, history)` in `src/daemon/review.ts`. Structure, in order:

1. **Role and bounds.** *"You are grading a code change against a rubric. Do not fix anything, do
   not edit any file, do not run any command that writes. You may read files to understand the code
   around the change."*
2. ⭐ **The effort instruction, stated first because it is the one most likely to be ignored:**
   *"Keep this to a single pass. Read the diff, open at most a handful of files you actually need to
   judge whether the change fits the code around it, and answer. Do not explore the repository, do
   not run the test suite, do not attempt to reproduce anything. A thorough review is not what is
   wanted here; a calibrated one is."*
3. **The rubric**, all seven dimensions with all their anchors (§3.3) — ~1,400 tokens, and the part
   worth every token it costs.
4. **The original request** (`task.title`, verbatim).
5. **Follow-up instructions**, if any (`task_messages` with `role: 'human'`), blinded.
6. **The observed run history**, anonymised: *"3 runs. Run 1 completed. Run 2 was preempted at a
   quota window boundary (not a failure of the work). Run 3 completed. The agent asked 1 question.
   Project checks failed once and were fixed. No work was left uncommitted."* — the raw material for
   dimension 7, and the sentence in brackets is what stops a scheduler event being scored as
   incompetence.
7. **The diff**, blinded, with `--stat` first and the truncation note if any.
8. **The repository's own conventions**, one line: *"This project documents its rules in `AGENTS.md`
   and its current state in `HANDOFF.md`. Read `AGENTS.md` if you need to judge whether the change
   follows this project's conventions."* ⭐ Cheaper and more accurate than restating them, and it is
   the mechanism that makes dimension 4 a *repository-relative* judgment rather than the reviewer's
   personal taste — the Senior SWE-Bench property this rubric most wants.
9. **The output contract** — the JSON shape from §8.1, and *"reply with the JSON object and nothing
   else."*

### 9.1 The cost, estimated

⚠️ **Estimated, not measured** — no review has been run. Stated so the first real one can be checked
against it and this line replaced with a measurement.

| Component | Tokens |
|---|---|
| Rubric + role + contract | ~1,800 |
| Task prompt + follow-ups + run history | ~500–2,000 |
| Diff (typical, this repo) | ~4,000–30,000 |
| File reads the reviewer chooses | ~2,000–15,000 |
| Output (7 rationales + summary) | ~700–1,200 |
| **Total** | **~9k–50k, cold, no cache reuse** |

Against a median work run on this fleet in the millions of tokens, a review is **well under 1%** of
the task it grades. ⭐ That is the argument for making it a one-turn, tool-less, small-model job and
keeping it that way — the moment a review earns the right to a second turn it stops being free and
starts being a thing to budget for.

### 9.2 Which model

Default per adapter, in a published table beside the rubric weights:

| Adapter | Review model | Why |
|---|---|---|
| `claude-code` | `claude-haiku-4-5` | The cheap rung of the pool that is already metered. |
| `antigravity-cli` | `gemini-3.7-flash-medium` | ⚠️ Already the Gemini-pool default for this fleet. |
| `openai-compatible` | `gpt-5.4-mini` | The cheap rung of the codex model list. |

⚠️ **A guess, and an important one.** Whether a small model can hold a seven-dimension rubric and
produce calibrated, non-clustered scores is unmeasured — R17, §12. The choice is one field on the
review record (`reviewer_model`), so the experiment is: review the same five tasks on the small and
the large model of one provider and compare the spread. If the small model clusters everything at
7–8, it is not a judge and the default moves up a rung.

---

## 10. UI

### 10.1 The button, in the task thread

Placed in the thread's right-hand facts column, under the timeline, and shown when the task is in a
finished state (`completed`, `landed`, or resolved) **and** a diff can be resolved (§7.3):

```
quality review
  [ Request review ]   Grades this task's diff against the published rubric.
                       A different agent than the one that did the work.
```

States, and each says something different:
- **Not reviewed** → the button, plus which agent would be picked.
- **No peer available** (D3) → the button is disabled and the reason names every candidate and its
  rejection: *"Antigravity is out of window until 14:20 · Codex is not commissioned · Claude did this
  work."* ⛔ Never a bare "unavailable".
- **Running** → the live spinner already used for a run, and the review appears in the timeline
  immediately as `#N Quality Review · pending`.
- **Complete** → the score, the seven dimensions with their rationales in a disclosure, the reviewer
  agent and model, the token cost, and the timestamp.
- **Failed / refused** → the reason, and the button again.

### 10.2 In the timeline

`TimelineItem` gains `{ kind: 'review'; review: QualityReview; ts }`, and `chronologicalTimeline`
merges it with runs and compactions on `created_at`. It renders through a `ReviewRow` that mirrors
`RunRow` — ⭐ `#{index} Quality Review`, exactly the label the operator asked for — showing reviewer,
model, composite score, tokens and duration. ⚠️ The underlying `runs` row is *not* also drawn as a
`RunRow`; `chronologicalTimeline` filters `kind === 'work'` for runs so a review is one entry, not two.

### 10.3 In the task table

One numeric column, `Quality`, between `Tokens` and `Status`: the composite to one decimal, `—` when
unreviewed, with the reviewer and date on hover. Sortable. ⚠️ A leaked-blinding review (§6.4) or a
`mixed_authorship` one carries a small marker, because those are the rows that must not be read as
clean comparisons.

### 10.4 Everything else stays where it is

⛔ **No new top-level view.** This is a field on a task, not a place to go. A dedicated
"Quality" page would be a second board to keep in step with the first, and the comparison this
feature exists to enable is a query over stored rows — which is a thing to run when there is
something to compare, not a screen to build before there is.

---

## 11. Order of work

Each step is shippable and each is testable without the one after it.

| # | Step | Files | Proves |
|---|---|---|---|
| **1** | ⛔ **Record `landed_base_sha` / `landed_head_sha`** at landing. Migration 35a. | `landing.ts`, `tasks.ts`, `shared/tasks.ts` | `landing.test.ts` — a landed task carries a resolvable range. ⭐ Do this first; every task that lands before it is permanently unreviewable. |
| **2** | `runs.kind`, and the fifteen-query audit (§5.2). | `db.ts`, `tasks.ts`, `estimator.ts`, `activetime.ts`, `conversations.ts` | `estimator.test.ts`, `activetime.test.ts`, `metering.test.ts` — a review run changes none of their numbers. |
| **3** | `quality_reviews` table + `recordReview` + the composite. | `db.ts`, new `review.ts` | `review.test.ts` — the §3.4 fixture scores 8.6; a `null` renormalises; a malformed reply fails without writing a score. |
| **4** | `blind()`. | `review.ts` | `blinding.test.ts` — real trailers from this repo's history are stripped; a prose mention sets `leaked`. |
| **5** | Diff assembly, truncation, and the §7.3 resolution ladder. | `review.ts`, `worktrees.ts` | `reviewdiff.test.ts` — each rung, including rung 3 refusing rather than guessing. |
| **6** | `readOnlyPermissionMode` capability + `purpose: 'review'`. | `adapters/*.ts`, `sessions.ts`, `protocol.ts` | `adapters.test.ts` — every built-in declares one or declares null; a review session gets no MCP config. |
| **7** | `pickReviewer` + dispatch + parse. | `review.ts` | `reviewer.test.ts` — an author's adapter is never chosen; an empty candidate set names every rejection. |
| **8** | `review.request` / `review.get` RPC. | `api.ts`, `protocol.ts` | `taskpage.test.ts` |
| **9** | UI: button, timeline row, table column. | `TaskThread.tsx`, `Tasks.tsx`, `taskview.tsx`, `app.css` | `taskview.test.ts` + `ui.test.mjs` |
| **10** | ⭐ **Run one in flight.** | — | R17 (§12). Nothing above proves a model can do this. |

⚠️ Steps 1–5 touch no agent and cost no tokens; they are unit-testable end to end. Steps 6–9 are
plumbing over paths that already work. Step 10 is the only one that can fail for reasons this plan
cannot anticipate, which is the right shape for it to be last.

**Documentation owed on landing:** `docs/glossary.md` gains *Quality review*, *Rubric*, *Subject
agent*, *Blinding*; `AGENTS.md` gains one invariant — ⛔ *a review never grades its own author, and a
score is never written by a path that could not name the reviewer*; HANDOFF gains one line and this
file moves to `transient_docs/changes_history.md`.

---

## 12. What this does not do, and what is unproven

- ⛔ **No review has ever been run.** Every number in §9.1 is an estimate and every claim about what
  a model will produce is a guess. **R17** is the first measurement owed: review the same five
  finished tasks on a small and a large model of one provider, and compare the spread. If the small
  model clusters at 7–8 it is not a judge (§9.2).
- ⚠️ **One judge, not a panel.** Senior SWE-Bench averages two. Round-robin over reviewers (§6.1)
  spreads the bias across the dataset rather than removing it from any single score. A second
  reviewer is a one-line change and a doubling of cost; the data from R17 decides whether it is worth it.
- ⚠️ **No reference solution**, so the strongest axis in the literature is unavailable (§3.1).
- ⚠️ **Blinding leaks on prose**, measured at 20 of the last 60 commits (§2.3). Recorded, not fixed.
- ⛔ **The existing backlog is largely unreviewable** — tasks that already landed have no recorded
  commit range and no branch (§7.3, rung 3). Accepted, and the reason step 1 ships first.
- ⚠️ **Nothing calibrates the scale across providers.** A 7 from Gemini and a 7 from Claude are
  assumed comparable and have not been shown to be. The §3.4 worked example is the only fixed point,
  and it is one hand-written sample. Until several agents have scored the *same* task, cross-agent
  comparison is suggestive rather than evidential — and the round-robin plus `quality_reviews`
  keeping every row is what makes that experiment possible later.
- ⛔ **Nothing gates on the score.** No task changes status, no routing decision reads it, the
  estimator does not see it. It is an instrument. Wiring it into routing before it has been shown to
  measure anything would be the mistake this project has already made once and documented.
