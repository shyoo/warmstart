# Plan & Split — implementation plan

**2026-09-03 · t178 · design of record, not status.** Status lives in `HANDOFF.md`.

⭐ **Built on 2026-09-04 by t182**, substantially as designed. Where the implementation departed from
this document, the code and the docs it owes are the authority: `docs/landing.md` for `merge-branch`,
`docs/mcp.md` for the two tools, `docs/routing.md` §3.9 for the two-turn dispatch, and `docs/ui.md`
for the two composer rows. ⚠️ Two things this document got wrong, both found by building it:
**§3.9's remedy** is sibling *attribution* rather than a third condition on the reading, and a
diverged target is **not** a refusal — the rebase that precedes the fast-forward absorbs it, which is
what makes a sibling landing mid-run an ordinary event rather than an error.

A **Plan & Split** task is one an agent *plans* rather than performs: it clarifies the requirement
with the operator, files a handful of concrete subtasks, waits for every one of them to settle, and
then comes back to look at the result as a whole.

⛔ This is not the same thing as today's `kind: 'plan'`, and the difference is the whole proposal.
Today a plan task is never dispatched at all — it is handed to the **unattended controller**, which
has no tools, cannot read the repository and cannot ask a question. It answers once, in JSON, and
its children arrive as drafts with no prompts. Plan & Split gives the planning turn to a real agent
session with the repository in front of it and `ask_human` in its hand.

**The five design decisions were put to the operator on 2026-09-03 and are answered in §7.** They
are what this document is built on; changing one changes the shape, not the detail.

---

## 1. What exists today, and where

| Thing | Where | What it does now |
|---|---|---|
| the kind | `src/shared/tasks.ts:86` | `TaskKind = 'work' \| 'plan'` |
| the skip | `src/daemon/scheduler.ts:394` | a `plan` task is never dispatched; `askForPlan` enqueues a consult |
| the consult | `src/daemon/scheduler.ts:1279` | `kind: 'decompose'`, cooldown-gated, free until drained |
| the question | `src/daemon/judgment.ts:305` | `decomposeQuestion(task)`, capped at `MAX_DECOMPOSE_CHILDREN = 8` |
| the apply | `src/daemon/judgment.ts:351` | `applyDecompose` — children land as `draft`, edges point backwards only |
| the fallback | `src/daemon/judgment.ts:844` | ⛔ never guesses a plan; rests the task for a person |
| the composer | `src/renderer/src/components/NewTask.tsx:260` | `isPlan` hides **everything** |
| the RPC | `src/daemon/api.ts:932` | `task.plan` takes `{ title, projectId, prompt }` and nothing else |

⭐ The decomposition validator is worth keeping whatever else changes. `validateDecomposition`
(`judgment.ts:89`) makes a cycle impossible *by construction* — an edge must point at an earlier
child — rather than detectable afterwards. Agent-authored DAGs are exactly where cycles come from,
and `task_split` reuses this rule unchanged.

### The gap the operator named

In `plan` mode the composer draws the project pill and the kind pill. Attachments, priority,
dependencies, conversation reuse, finish policy, worker, model, effort, the schedule clock and the
Draft button are all behind `!isPlan` (`NewTask.tsx:383-682`), and `submit` throws away everything
it does not send (`NewTask.tsx:288`). That is honest about today's behaviour — none of it would be
read, because nothing runs — and it stops being honest the moment a plan task is dispatched.

---

## 2. The lifecycle

```
  operator files a Plan & Split task: planner settings, and the pieces' settings
        │
   ┌────▼──────────────────────────────────────────┐
   │ phase 1 — the planner run                     │  a normal dispatch: worker, session,
   │  reads the repo · ask_human · task_split      │  workspace, quota, metering
   └────┬──────────────────────────────────────────┘
        │  task_split raises ONE approval card and blocks on it
        │  on approval: N children filed atomically, each targeting the plan branch
        │  parent gains one `settled` edge per child
        ▼
   parent parks at `blocked` · run ends `blocked` · workspace released · costs nothing
        │
   ┌────▼──────────────────────────────────────────┐
   │ the children, scheduled normally               │  cut FROM the plan branch,
   │  each rebases, checks, fast-forwards it        │  merged back INTO the plan branch
   └────┬──────────────────────────────────────────┘
        │  each terminal child → admitDependents(child) → admit(parent)
        │  last one settles → parent `ready`
        ▼
   ┌───────────────────────────────────────────────┐
   │ phase 2 — the resolution run                  │  resumed warm if its session lived,
   │  reviews the integrated branch · task_complete│  cold with its handoff if not
   └───────────────────────────────────────────────┘
        │
        ▼  the plan task lands onto `main` under its own finish policy, once
```

⛔ **The wait costs nothing, and holds nothing.** The planner's process ends at the split;
re-admission is arithmetic on a ten-second tick. That is the only shape compatible with *the
scheduler costs zero tokens* and with *a reply to a stopped task is a new run on the same thread*.

⭐ **Re-checked against `retainedReservations`**, which landed on 2026-09-04 after this design was
written (`scheduler.ts:4351`). It counts a worker's slot as held by `awaiting_human` tasks and by
`running` ones whose session has closed — and by **neither** for `blocked`. So a planner waiting on
its children occupies no worker slot for however long they take, which is what D2 needs and is now
verified rather than assumed.

⭐ **Nothing reaches the trunk until the plan is whole.** The plan task's branch is the integration
branch. Children are cut from it and merge back into it; only the resolution run lands the whole
thing onto `main`. That is decision **D4**, and §3.2–§3.4 and §3.9–§3.10 are what it costs.

---

## 3. What has to change underneath

Ten findings from reading the code. Each is a real obstacle, not a preference. ⚠️ §3.9 and
§3.10 were found on 2026-09-03 by counting §3.4's call sites against the tree rather than trusting
the earlier count; both are created *by* §3.4's own change, and neither raises an error when wrong.

### 3.1 A dependency edge has no release rule, and needs one

`admit()` (`src/daemon/tasks.ts:703`) counts a prerequisite as unmet unless its status is exactly
`completed`. A subtask that fails or is cancelled therefore holds its parent at `blocked` **for
ever** — and the invariant is that every held status needs something that ends the hold.

⛔ Not fixed by loosening `admit()` globally. A person who says *"do B after A"* means A succeeded;
releasing B onto a failed A would silently change every existing edge in the fleet.

→ **The edge-release migration** adds `require text not null default 'completed'` to `task_deps`, values
`completed | settled`. `admit()` reads it. `task_split` writes `settled` edges; every other edge —
the composer's, `attachDependency`'s, `applyDecompose`'s — keeps today's meaning untouched.

### 3.2 A child cut from the trunk cannot see its siblings' work

`prepareWorkspace` cuts a new task branch from `baseRef(project)`, which is the *project's* landing
target (`worktrees.ts:67`, `:335`). Under D4 that is the wrong base: child 2 would be cut from `main`
and would not contain child 1's work, so a `depends_on` edge between them would order the runs and
deliver nothing.

→ The base becomes the task's **own** landing target, not the project's. For an ordinary task those
are the same string and nothing changes; for a split child it is the plan branch. ⚠️ The plan branch
must therefore exist before any child is dispatched — it does, because phase 1 created it, but that
is an assumption worth an assertion in `applySplit` rather than a hope.

### 3.3 ⛔ Merging into the plan branch needs a landing strategy that does not exist

This is the largest single piece of work in the proposal, and it is not obvious from the outside.

`merge-local` — the strategy `commit-and-merge` resolves to, and the fleet default — does its merge
**inside the operator's own trunk checkout**: `git merge --ff-only <branch>` run in
`ctx.project.root`, gated by `trunkNotReady(root, target)`, which refuses unless the trunk has the
target *checked out* and clean (`landing.ts:637`, `:689`). The reason is stated there and is
correct: git refuses to update a branch a worktree holds.

A child landing onto the plan branch would therefore require the operator's checkout to be sitting
on the plan branch. That is not acceptable and never will be — the trunk is the operator's, and
*agents work in a pooled worktree, never the trunk*.

→ A sixth strategy, **`merge-branch`**: rebase the child onto its target, run the project's checks,
and fast-forward the target **ref** from inside the child's own worktree (`git update-ref`), with no
checkout of the target anywhere. The fast-forward is guaranteed by the rebase that precedes it, which
is the same proof `retireBranch` already requires.

⛔ Its precondition is that the target branch is checked out **nowhere**, and it must verify that
rather than assume it. It is true while children run, because the plan task is `blocked` and its
workspace was parked (`switch --detach`) when phase 1 ended — but "true today" and "checked" are
different things, and this is the one place where being wrong corrupts a branch.

⚠️ `strategyFor` picks it from **data, not a name**: the strategy is a function of the resolved
policy *and* whether the task's target is the project's own landing target. ⛔ Never
`if (task.kind === 'plan')` in the landing path.

⚠️ Two children finishing together both want the plan branch. That is a contended resource, so it is
a **hold**: an exclusive `Resource` keyed on the branch, taken the way `landResourceId` already takes
one per project. Reuse `awaitLandTurn`; do not invent a second queue.

### 3.4 A per-task landing target has to reach every reader of one

`landingTarget` is a project-level field today (`projects.ts:31`, `:380`). ⚠️ **Counted against the
tree on 2026-09-03 it has 24 production readers across seven files**, not the thirteen an earlier
pass of this document claimed:

| File | Readers | What they are |
|---|---|---|
| `landing.ts` | 9 | `:199` `:210` `:572` `:834` `:985` `:992` `:1004` `:1094` `:1216` |
| `scheduler.ts` | 6 | `:2168` `:2365` run `trunkShaBefore`; `:3339` `:3343` `:3518` the trunk tripwire; `:4752` |
| `finish.ts` | 3 | `:208` `:411` `:454` |
| `worktrees.ts` | 2 | `:68` `baseRef`; `:237` |
| `reviewer.ts` | 2 | `:222` `:250`, both `resolveRange` |
| `cancel.ts` | 1 | `:139` |
| `api.ts` | 1 | `:858` |

⛔ **Every one of them, or none.** The failure mode is documented in this repository by name: two
reference points in one finish path, and the silent one won — t22, 2026-08-29, where `decideFinish`
read the local `main` and `landTask` read `origin/main` 109ms later. A split whose children are cut
from the plan branch by one path and measured against `main` by another reproduces that exactly, and
it reports success.

→ One resolver, `landingTargetFor(task, project)`, and all 24 call sites go through it.
`Task.landingTarget` is null for everything that exists today, so the resolver returns the project's
answer unchanged and the change is provably inert outside a split.

⚠️ **`scheduler.ts` and `reviewer.ts` are not wiring.** The six in the scheduler and the two in the
reviewer change *meaning* under D4, each in a way that produces a wrong answer rather than an error.
They are §3.9 and §3.10, and they are the reason this commit is not the inert rename it looks like.

### 3.5 Every child would be held for a gate that may never answer

`riskOf` (`src/daemon/judgment.ts:505`) returns `controller` for any agent-filed task whose mandate
allows `commit` or `push` — every coding subtask. `admitAgentTask` (`src/daemon/api.ts:156`) then
files a `gate` consult and leaves the child a `draft`. A split of five would produce five drafts and
five consults, and on an install with no controller turn available, nothing would ever run.

→ **D3**: the split is approved once, as a split. `task_split` files a `Question` and blocks on it —
the same `question.ask` path `ask_human` uses, which already parks the task at `awaiting_human`
(`questions.ts:174`) and puts the card on the Attention bar. On approval the children are created
already admitted, and `admitAgentTask` is not consulted: a human approved this exact set, by title,
one second ago. On rejection the operator's note comes back as the tool's reply and the planner
revises.

⭐ The approval being *structural* rather than an instruction in the prompt is the point. An agent
told to ask before splitting can forget; an agent whose `task_split` call blocks cannot.

⚠️ **And it has a price the rest of the design does not: the approval window holds a worker slot.**
`awaitingHumanReservations` (`scheduler.ts:4320`) counts an `awaiting_human` task against its
worker's `maxConcurrent`, deliberately — the session is retained so the answer resumes warm. A split
raised at midnight therefore idles a 1-slot worker until somebody approves it, which an `ask_human`
mid-task also does but for a question that is usually answered in minutes. ⛔ Not a reason to make
the approval non-blocking; a reason to say so out loud, and to reconsider only if a real split is
seen sitting overnight.

### 3.6 The budget halves per child

`shareBudget(parent, 0.5)` (`src/daemon/tasks.ts:398`) gives each child half of what the parent has
*left*, evaluated in creation order: 50 / 25 / 12.5 / 6.25 / 3.1%. For a split that is nonsense.

→ `splitBudget(parent, n)` divides the remainder equally. ⚠️ Moot on this install — a human root
task is created with `grantedTokens: 0` and `riskOf` only enforces a budget above zero — but the
arithmetic is two lines and being wrong quietly is how it stays wrong.

### 3.7 The fan-out cap and the decomposition cap disagree

`ROOT_MANDATE.maxChildren = 5` (`src/shared/tasks.ts:212`) against `MAX_DECOMPOSE_CHILDREN = 8`
(`judgment.ts:40`). `createTask` enforces the mandate, so a split of six from a human-filed task is
refused today with a message about a fan-out cap nobody set.

→ The mandate stays the authority. The composer exposes the fan-out as a pill on the pieces row
(default 5, ceiling 8) and writes it into the task's mandate, so the number the operator sees is the
number enforced. ⛔ Never two caps, one of them invisible.

### 3.8 A split can silently lose a child to the duplicate merge

`findNearDuplicate` (`src/daemon/tasks.ts:550`) merges any agent-filed task whose normalised title
matches a live one from the last window, and returns the *existing* task. Inside a split that would
drop a piece of work and leave the parent waiting on a task belonging to something else entirely.

→ `task_split` checks its own titles for collisions before the approval card is raised — the
operator should never be shown a plan that cannot be filed — and creates its children with the merge
suppressed.

### 3.9 ⛔ The trunk tripwire fires on a sibling landing

`decideFinish` returns `trunk-moved` when **both** halves hold: the task's branch carries no
unlanded commits *and* the landing target moved while the run was in flight (`finish.ts:188`,
`:197`). The verdict is then refused and handed to a person, and `scheduler.ts:3518` logs the run by
name as a tripwire hit. It exists because of t17, 2026-08-28 — an agent that committed to the trunk
instead of its branch and reported success three times.

Today the reading is taken against the *project's* target, so it is rare. The moment §3.4 wires the
resolver in, a split child measures against **the plan branch** — and under D4 a sibling landing onto
the plan branch is the designed behaviour, happening constantly while other children run.

⛔ So the pairing that is supposed to be the signature of a fault becomes routine: a child that
legitimately produced no commits — it answered a question, or its work was already there — is refused
its verdict and accused in the log, because a sibling landed while it ran.

→ The tripwire needs a third condition on a split child: the movement must not be attributable to a
sibling. The cheap and honest version is to compare the target's movement against the set of commits
this task's siblings landed, which `landedHeadSha` already records per child. ⚠️ Do **not** simply
disable it for children — that hands back exactly the hole t17 came through, on the tasks that write
the most code.

### 3.10 ⛔ A child's quality grade would be computed over its siblings' code

`resolveRange` (`review.ts:163`) finds the commits to review on a two-rung ladder, and both rungs
are wrong for a split child measured against `main`.

- Rung 1 requires `landedHeadSha` to be an ancestor of the target (`headOnTrunk`). A child lands onto
  the **plan branch** and never onto `main`, so this fails for every child until the plan itself
  lands.
- Rung 2 is then `merge-base(target, childBranch)..childBranch`. The child was cut from the plan
  branch, so `merge-base(main, child)` is where the *plan branch* diverged from `main` — and the
  range therefore contains the planner's own commits and every sibling merged in before this child
  was cut.

⭐ The result is a grade that looks exactly like a real one: `authorshipOf` names the child's author,
and the diff is other agents' work. That is the failure `resolveRange`'s own comment refuses by name
— *"A review of the wrong commits is worse than no review"* — arrived at from a direction it did not
anticipate.

→ Both `reviewer.ts` call sites take `landingTargetFor(task, project)`. With the child's target set
to the plan branch, rung 1 resolves (the child *did* land onto it) and the range is the child's own
commits. ⚠️ This is the one call site where getting §3.4 half-done is worse than not starting: a
partially-wired resolver produces grades, and a grade is stored.

---

## 4. The design

### 4.1 Data model

- **The edge-release migration** — `task_deps.require`, §3.1.
- **The plan-target migration** — `tasks.landing_target text` and `tasks.child_defaults_json text`.
  Both null for every row that exists, both guarded by `hasColumn`, both replay-safe.
- ⛔ **Named, not numbered, and that is deliberate.** This tree was at 36 when the plan was written
  and at 40 four hours later. `versionBefore` records the failure by name: two branches added a
  migration 27 in parallel and `MIGRATION_COUNT - 1` quietly began asserting the wrong one. Take the
  next free numbers when you write them, and pin any test by *text* through `versionBefore`.
- No new status. `blocked` already means *waiting on prerequisites*, already re-admits, and already
  renders in the `queued` lane (`Flow.tsx:10`) and the Blocked view (`tasks.ts:119`). A new
  `awaiting_children` would be a fourth spelling of a hold, and every status must belong to exactly
  one view bucket.
- `LandingStrategyId` gains `'merge-branch'`. ⛔ `data-model.md` owes an edit — a union changed.

### 4.2 Daemon

| File | Change |
|---|---|
| `db.ts` | the two migrations above |
| `tasks.ts` | `admit()` honours `require`; `addDependency(…, require)`; `splitBudget`; a `mergeDuplicates: false` input |
| `split.ts` **new** | `applySplit(parentTaskId, sessionId, children)` — validate everything, raise the approval, then create everything, or nothing |
| `landing.ts` | `merge-branch`; `landingTargetFor`; `strategyFor` reads the resolved target; the branch lease |
| `finish.ts`, `cancel.ts`, `api.ts`, `worktrees.ts` | the thirteen `landingTarget` reads go through the resolver (§3.4) |
| `scheduler.ts` | `plan` tasks are dispatched; `planPrompt` / `resolutionPrompt`; the run outcome at a split |
| `judgment.ts` | `decompose` survives as the fallback for a plan task that cannot be given an agent turn (**D1**) |

⛔ **`applySplit` is all-or-nothing.** The whole set is validated — count against the mandate, titles
non-empty and mutually distinct, `depends_on` indices strictly backwards, project and mandate
inherited, budget divisible — *before the approval card is raised*, and nothing is written until the
operator says yes. A half-applied split is a parent blocked on children that do not exist.

⚠️ **Parking the parent works because of an existing guard.** `endUnfinishedRun`
(`scheduler.ts:3823`) only touches a task still `running` or `assigned`, so the `blocked` written by
`applySplit` survives the planner's process exit. The run's outcome is recorded as `blocked`, not
`failed` — the same reasoning the question path already uses: a run that stopped because it had filed
its plan did not fail at anything.

### 4.3 MCP — two tools, worker tier

| Tool | Does |
|---|---|
| `task_split` | file the whole plan in one call: 2–N pieces, each with its own prompt, with edges between them. Raises one approval and blocks on it. Atomic. |
| `task_depend` | add one edge between two pieces of **this task's own split**. ⛔ Never an arbitrary task in the fleet |

⚠️ **Two more tools means a bigger prompt prefix on every worker session, not only on plan tasks.** A
session's MCP config is frozen for its lifetime and workers on one project get identical configs
(`docs/mcp.md` §2), so this is a real and recurring cost paid by every run.

⭐ It is still the right shape, and there is a precedent for exactly it: `checkpoint` is registered
for every worker and **named in the prompt only** for tasks whose completion mode resolves to
`checkpointed` (`src/mcp/index.ts:266`). ⛔ The alternative — a third `planner` tier — buys a third
prompt-cache prefix on the install, which `docs/mcp.md` §2 warns about by name.

`task_split`'s reply text is load-bearing: it names each child as `t<seq>`, says the parent is now
waiting on all of them, and tells the agent to **stop**. An agent that carries on after splitting is
spending a turn on work it has just delegated.

### 4.4 The two prompts

Both live beside `promptFor` (`scheduler.ts:2894`) and are selected on `task.kind`, which the
scheduler already branches on at line 394. ⚠️ Not a violation of *never branch on a mode name* —
that invariant is about adapters and objectives, which are data. A task kind is a domain fact.

**Phase 1 — planning.** You are planning this work, not doing it. Read enough of the repository to be
concrete. Use `ask_human` for anything that changes what gets built. Then call `task_split` once —
the operator approves the whole plan before anything is filed, so make each piece legible on a card.
Each piece must be completable by an agent that has not read this conversation, so its prompt carries
its own context: what to change, where, and what done looks like. Use `depends_on` only where one
piece genuinely needs another's code — an edge you did not need costs a subtask's wait. Do not write
code. After the split, stop.

⛔ A split of one is refused. If the planner concludes the work is a single task, the honest move is
`ask_human`, not a split with one child that adds a round trip and no parallelism.

**Phase 2 — resolution.** Prepended with a table of every child: `t<seq> · <status> · <summary or
failure reason>`, and the statement that this branch already contains everything they merged. Some
may have failed, and that is why you are here. Review the result as a whole; small gaps you fix here,
large ones you ask about. Then the ordinary finish instruction applies unchanged — the project's
checks, `task_complete`, the commit-hygiene paragraph — and the plan task lands onto `main` once.

### 4.5 UI — two rows of settings (D5)

- `KIND_OPTIONS` (`NewTask.tsx:72`) — the Plan entry becomes **Plan & Split** with a hint that says
  what it now does. Still two entries: D1 replaces the behaviour rather than adding a kind.
- ⛔ **Delete `!isPlan` from every control except the schedule clock and the Draft button.** The clock
  and Draft stay task-only for now: a scheduled plan and a draft plan are both coherent and neither
  is what was asked for.
- In plan mode the bar splits into two labelled groups: **Planner** (worker, model, effort, reuse,
  attachments, dependencies, priority — what the planning turn runs as) and **Pieces** (worker,
  model, effort, finish, reuse, priority, fan-out — what each child inherits). ⚠️ The captions are
  not decoration: two identical rows of pills with no labels is the failure this buys.
- `composerprefs.ts` remembers both rows; `composerprefs.test.ts` round-trips the second.
- `task.plan`'s params grow to carry both. The branch inside `submit` shrinks to the kind flag.
- A plan task's thread shows its children with their outcomes — the same edges `Dependencies.tsx`
  already draws, read the other way (`dependentsOf`, `blockedDependentsOf`). Additive.
- `docs/ui.md` owes an edit; ⛔ a child's summary is agent output, so it is text, never markup.

---

## 5. Work breakdown

Ten commits, each landable on its own and each leaving the tree green. The first five are the ones
that carry risk; 5–9 are mostly wiring.

1. **The edge release rule.** The edge-release migration, `admit()`, `addDependency`, tests in `manualdeps.test.ts`
   and `dependents.test.ts`. ⭐ Nothing depends on this and it is self-contained — landing it first
   keeps every later commit revertible without a schema rollback.
2. **The per-task landing target.** `tasks.landing_target`, `landingTargetFor`, and **all 24** call
   sites (§3.4). ⛔ Provably inert on its own: every existing row is null. Land it and watch a normal
   task still land normally *before* anything depends on it.
2b. **The two readers that change meaning** — the trunk tripwire (§3.9) and the reviewer's range
   (§3.10). ⚠️ Split out of 2 deliberately: 2 is a mechanical substitution anybody can review by
   eye, and these two are judgement calls that need their own tests and their own red run. Bundling
   them would hide two behaviour changes inside a commit whose whole claim is that it has none.
3. **`merge-branch`.** The new strategy, the branch lease, the not-checked-out precondition.
   `landing.test.ts` + `landingcorners.test.ts`. This is the piece most likely to be wrong.
4. **`applySplit` and its validation.** `src/daemon/split.ts` + `split.test.ts`, pure against a temp
   database. No MCP, no prompt, no UI: the whole safety boundary tested where it is cheapest.
5. **The approval.** `task_split` blocks on a `Question`; rejection returns the note.
6. **The MCP tools.** `task_split`, `task_depend`, `agent.split`, `agent.depend`, `docs/mcp.md`.
7. **The scheduler.** Dispatch plan tasks, the two prompts, the run outcome, children cut from the
   plan branch. `scheduling.test.ts`, `worktrees.test.ts`.
8. **The composer.** Two rows, `composerprefs.ts`, `task.plan`'s payload, `docs/ui.md`.
9. **The thread view** — children and their outcomes on a plan task's page.

⚠️ Commits 7 and 8 are the pair that can produce a green suite over a broken feature: `test/ui.test.mjs`
never opens a project and its worker has no credentials, so a plan task filed there files nothing and
runs nothing. Anything asserted about a split in L3 passes against an empty list
(`docs/testing.md` §3). The proof for those two is L2 plus one hand-driven task.

## 6. Tests

| Tier | What it proves |
|---|---|
| L1 | the validator: the cap, backwards-only edges, duplicate titles, an empty prompt, a split of one, the budget division |
| L1 | `admit()` against a `settled` edge onto a `failed` dep, and a `completed` edge onto the same dep |
| L1 | `landingTargetFor` returns the project's answer for every task that has no target of its own |
| L1 | ⛔ the tripwire does **not** fire on a child with an empty branch whose plan branch moved because a sibling landed — and still fires when it moved for any other reason (§3.9) |
| L1 | ⛔ `resolveRange` on a split child returns that child's own commits, not its siblings' (§3.10). Watched red against the project target first |
| L1 | `strategyFor` picks `merge-branch` from the resolved target and never from a kind |
| L1 | `promptFor` on a plan task in each phase, with the CLI stubbed onto PATH — ⛔ `plan()` resolves the command first and CI has no CLI (`docs/testing.md` §3) |
| L2 | a real git fixture: child branch cut from the plan branch, rebased, checked, ref fast-forwarded, and the plan branch **not checked out anywhere** while it happens |
| L2 | file a plan task on the probe adapter, split it, watch the parent park at `blocked`, settle the children, watch it come back |
| L3 | the composer draws both rows in plan mode, and files what it drew |
| by hand | one real split on this repository, end to end, before it is called done |

⛔ Every new guard is watched going **red** before it is trusted green — `merge-branch` above all,
because a merge strategy that silently does nothing looks exactly like one that worked.

## 7. Decisions taken

Put to the operator on 2026-09-03 and answered.

| # | Question | Answer |
|---|---|---|
| **D1** | Replace today's Plan, or add a third kind? | **Replace it — one Plan button.** `kind: 'plan'` becomes Plan & Split and is dispatched to a planning agent. The controller `decompose` consult survives as the fallback for a plan task that cannot be given an agent turn. |
| **D2** | How does the planner wait? | **End the run and come back.** The task parks at `blocked`; `admitDependents` re-admits it; a second run resolves. The wait bills nothing. |
| **D3** | Do the subtasks need approval? | **One approval for the whole split**, raised by `task_split` before anything is filed. Then no per-child gate. |
| **D4** | What happens to each subtask's work? | **Branch off the plan; the planner lands the whole.** Children are cut from and merge into the plan branch; only the resolution run reaches `main`. This is what §3.2–§3.4 pay for. |
| **D5** | What do the composer's settings mean? | **Two rows — planner and pieces.** "Plan with one model, build with another" is set, not asked for. |

## 8. Deliberately not in this version

- **Monitor mode.** The planner waits for every child to settle, full stop. A planner that reacts to
  a child running long is a second scheduler with an LLM in it, and the deterministic version has to
  exist and be watched first. ⚠️ The hook it would need already exists — `runWatchdogs` sees an
  overrunning run — so nothing here forecloses it.
- **Re-splitting.** A planner that reviews the result and wants three more pieces is a good idea and
  a second design. Today it calls `task_create`, which still works.
- **Cross-project splits.** Children inherit the parent's project, and the mandate says so.
- **Pushing a plan branch.** `landedRef` prefers `origin/<target>` when it verifies, so a plan branch
  that somebody pushes would start being measured against the remote and local merges into it would
  read as unlanded. ⛔ Out of scope, and worth a refusal rather than silence.
