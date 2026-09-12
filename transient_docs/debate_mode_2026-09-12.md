# Debate mode — implementation plan

**2026-09-12 · t379 · design of record, not status.** Status lives in `HANDOFF.md`.

A **Debate** task is one where several agents answer the same question *independently*, are then
made to read each other and revise, and are arbitrated by an **organizer** that reports an
agreement — *with its dissent* — to the operator, who decides what happens next.

⛔ **Its product is a decision, not a commit.** That single sentence is what most of §4 pays for:
every path in this codebase that finishes a task assumes the work left commits behind, and a seat
that produced only an argument trips the empty-branch guard by design rather than by accident.

⚠️ **The operator's own prior discussion could not be read.** The task cites
`https://claude.ai/chat/34665901-9c86-4f5f-adac-f6d2ff3aeb62`, which is a private conversation this
session has no credential for. Everything below is built from the task's own bullet list, from
reading this tree, and from the literature in §2 — so where this document guesses at something that
conversation settled, §9 records what was asked rather than assuming it.

---

## 1. What it is, and what it is not

| | Debate | Plan & Split | Conversation |
|---|---|---|---|
| Agents | 2–5 on the **same** question | 1 planner, then N on **different** pieces | 1 |
| First turn | blind, in parallel | one planner | one |
| What each produces | a position on the thread | commits on a branch | commits on a branch |
| What the parent does | arbitrates, reports, then may execute | integrates and lands | keeps talking |
| What lands | whatever the operator chooses afterwards | the integrated branch | when a person says so |

⭐ **Why this tool is a good host for it.** Debate's cost is dominated by *re-reading*: every round
after the first hands each seat a context it already holds. Measured on this machine and quoted in
`README.md`, a cold turn built 41,542 tokens of prompt prefix that a resumed one read back for 65 —
and a cache read is `0.1×` base input against `2.0×` to rebuild (`docs/cost-model.md`). A debate
built on warm seats is therefore *much* cheaper than N×R cold runs, and this codebase already routes
a reply into the session that holds the context (`warmSessionFor`, `scheduler.ts`). Debate on a stock
agent harness pays the rebuild every round; here it does not.

⛔ **It is not a vote.** §2 is unambiguous on this and it decides the shape: diversity pays off under
a *judge* and does not pay off under majority voting. An organizer that counts is an organizer that
throws away the only thing heterogeneity buys.

---

## 2. What the literature says, and what each finding changes here

⚠️ **None of this was measured on this fleet.** It is *inferred* from published work, cited below,
and every claim it drives is either an advisory string in the UI or a prompt — never a gate. The
first debate run on this install is what would begin measuring it, and §7 says what to record.

| Finding | Source | What it changes |
|---|---|---|
| Diverse teams **dramatically** outperform homogeneous ones under judge-based selection, and give **no** advantage under majority voting — judge-based selection won 42 of 42 tasks | [*When Agents Disagree: The Selection Bottleneck*](https://arxiv.org/html/2603.20324v1) | The organizer **judges**; it never tallies. The composer's heterogeneity notice is about *seats*, and it is worth saying only because a judge is reading them |
| Cross-family pairs are what carry the gain; same-family pairs show minimal gains | [*When and Why Does Multi-Agent Debate Fail*](https://arxiv.org/html/2510.20963) | The notice is computed on the **adapter**, not the model name. Two Claude models are the same family; Claude + Antigravity is not |
| **Competitive** framing degrades results by up to 15 percentage points; collaborative truth-seeking framing with evidence verification beat single-agent self-consistency at a matched token budget (86.29 vs 81.98 F2) | ibid. | ⛔ The seat prompt must never ask an agent to *win*. §5.6 — "Debate" is the operator's word for the feature; the prompt asks for the most defensible answer, and says the others are colleagues |
| Consensus-seeking debaters **neglect critical disagreements** in order to agree | ibid. | ⛔ `converged` may never mean *they agreed*. The organizer is required to record dissent, and an agreement with no dissent section is refused (§5.7) |
| Debate *hacking*: fabricated evidence, overconfident claims, redundancy dressed as verification. Remedy: evidence verification by quote matching | ibid. | ⭐ In a repository we have something better than quote-matching: a **file path either exists or it does not**. §5.8 |
| Gains scale with agents and rounds through ~3–4 rounds and diminish beyond; **rounds alone** diminish fastest, with diversity and argument confidence mattering more | [*Adaptive heterogeneous MAD*](https://link.springer.com/article/10.1007/s44443-025-00353-3), [*MAD for LLM Judges*](https://arxiv.org/html/2510.12697v1) | Rounds 1–3 offered plainly; 4–5 offered behind the diminishing-return notice the operator asked for |
| Diminishing returns past ~5 agents; ensembles of 9+ cost more for no accuracy | ibid. | Seats cap at **5**, which is also `ROOT_MANDATE.maxChildren` — one cap, not two (§4.3) |
| LLM judges favour their **own** generations; the bias tracks familiarity/perplexity | [*Self-Preference Bias in LLM-as-a-Judge*](https://www.semanticscholar.org/paper/Self-Preference-Bias-in-LLM-as-a-Judge-Wataoka-Takahashi/cf01d7c40cbf815de0f62fa78c2352ba546ad680), [*Emergence of Biased Consensus*](https://arxiv.org/html/2608.02827) | ⭐ This repository already has the rule: *a quality review never grades its own author, excluded by **adapter**, not by account*. The organizer notice reuses it verbatim |
| Fully-connected debate grows messages, tokens and latency ~**quadratically** in agents; sparse topologies preserve or improve quality | [*Improving MAD with Sparse Communication Topology*](https://arxiv.org/pdf/2406.11776), [*Dynamic Trust-Aware Sparse Topology*](https://arxiv.org/pdf/2606.01828) | The exchange is a **choice** (**D4**), because at 2–3 seats full cross-visibility is affordable and at 5 it is not |
| ⚠️ Several results find MAD does **not** beat a single agent at a matched budget, and underperforms plain self-consistency | [*When Does Delegation Beat Majority?*](https://arxiv.org/pdf/2606.08098), [*The Cost of Consensus*](https://arxiv.org/html/2605.00914), [*Single-Agent LLMs Outperform Multi-Agent Systems Under Equal Thinking Token Budgets*](https://arxiv.org/html/2604.02460v1) | ⛔ **The composer says so.** This is a feature whose own literature says it is often not worth it; a tool built on *every belief carries its basis* does not get to omit that from the screen where the money is committed |

### 2.1 The answer to "organizer or vote, and how good a model?"

**An organizer, and a strong one.** Three of the findings above converge on it: a judge is what makes
diversity pay; a tally is what makes it worthless; and a judge's failure mode is preferring what looks
familiar to it. So:

- **Recommend the highest-fitness model the fleet has** for the organizer seat. `fitnessTable()`
  (`src/daemon/fitness.ts`) already ranks every (adapter, model) by a published benchmark prior blended
  with this fleet's own peer reviews, and already carries the rule that *nothing gates on it*. The
  composer sorts the organizer picker by it and says why. It does not refuse a weak organizer.
- **Recommend an organizer whose adapter is not the only adapter in the room.** Same sentence
  `docs/architecture.md` already uses for peer review. ⚠️ Advisory, because on a one-account fleet it
  is unsatisfiable, and a gate that cannot be satisfied is a feature that cannot be used.
- ⛔ **Not the unattended controller.** A consult gets no tools, cannot read the repository, and
  answers once in JSON against a closed set. The organizer has to read the code the seats are arguing
  about, has to raise a question and wait, and — per the operator's own list — has to be able to *do
  the work afterwards*. That is a dispatched agent session, which is the same conclusion Plan & Split
  reached for the same reason (`scheduler.ts` ~:492). The consult survives as the escape hatch for a
  debate with no project, exactly as it does for a plan.

---

## 3. What exists today, and why the "channel" is already built

The operator's list asks for *"a channel between agent-to-agent … which we probably need an infra to
be able to that"*. ⭐ **The infrastructure is already here, and nothing about it is new work.** Eight
mechanisms, all in production:

| Need | What already does it |
|---|---|
| N agents on one question, each individually routed, metered, priced and gated | N child **tasks**. A run belongs to one task, so parallel seats *must* be tasks (`docs/architecture.md` § *Work, holds and evidence*) |
| Filing them atomically, or not at all | `applySplit` (`src/daemon/split.ts`) — validate the whole set, write it together, unwind on failure |
| The parent waiting on all of them for free | `settled` dependency edges + `admit()` (`src/daemon/tasks.ts`). The parent parks at `blocked`, holds no worker slot, no session and no workspace, and re-admits on arithmetic |
| **Sending one agent another agent's words** | `addMessage` + `continueTask` (`api/tasks.ts` `task.message`) — delivered into the live session when there is one, and otherwise a new run on the same thread |
| Reading N agents' output into one prompt | `resolutionInstruction` (`src/daemon/prompt.ts`) already composes a roll of every child with its outcome into the parent's next prompt |
| Blocking an agent on a human decision with buttons | a `choice` `Question` (`src/daemon/questions.ts`), which `task_split` already blocks on |
| Keeping a seat's context between rounds at `0.1×` | `warmSessionFor`, then `--resume` (`docs/sessions.md`) |
| Structure in an agent's reply | `extractJson` + a closed-set validator (`src/daemon/judgment.ts`, `reviewer.ts`) |

⛔ **So there is no new transport, no message bus and no agent-to-agent socket.** A seat never talks
to another seat; the daemon carries text between threads, which is what makes every exchange visible
in the UI, replayable from the database, and impossible to do off the record. A direct channel would
be the one design where the operator cannot see what was said.

---

## 4. What has to change underneath

Eleven findings from reading the tree. Each is a real obstacle, not a preference, and the first two
produce a *wrong answer* rather than an error.

### 4.1 ⛔ A seat that produces no commit does not complete

`decideFinish` (`src/daemon/finish.ts`) step 3 fires whenever `state.unlandedCommits === 0`, and its
last branch returns `await-human`: *"No work landed — check if the agent answered as a question
instead of making changes."* That guard is correct and was earned (t17). But a debate seat's whole
job is to answer rather than to change anything, so **every seat would park at `awaiting_human`** —
which is not a `SETTLED_STATUSES` member, so the parent's edge never releases and the debate stalls
on its first round, N times, each one holding a worker slot through `awaitingHumanReservations`.

→ **A new finish policy, `report-only`**: the deliverable is on the thread, nothing is expected on the
branch, so the verdict is `done` and the task completes. ⛔ Listed **outside** `FINISH_ORDER`'s ladder
beside `pull-request` and `custom`, because it is not a rung — it does strictly *less* than
`await-human`, not one thing more than the rung below. Checked before step 3, after the
rebase-in-progress guard. Any incidental dirt in the seat's workspace is carried by `rescueDirt` onto
the seat's own branch exactly as it is today; nothing is discarded and nothing is swept into a commit.

⭐ It is worth more than debate. Migration 51 exists because *"some tasks complete valid work with no
commits"* and the only answer was an operator ticking `non_gradable` afterwards. This is the answer
in front: a research task, a question, a review can now be filed as what it is.

### 4.2 ⛔ Blindness is not free — two seats on one account are each other's borrow candidates

`sharing.ts`'s gates are *same project, same account, same model, same effort, clean, room to grow*.
Two seats of a homogeneous debate match **every one of them**. So with session sharing on, seat 2 can
be dispatched into the conversation seat 1 just finished, read everything seat 1 argued, and the
"blind" first round is silently not blind — with no error anywhere, and a cheaper bill that looks like
a win.

→ Seats are filed with `sessionSharing: 'off'`, unconditionally, and it is **not** an operator
setting. ⚠️ Sharing is `off` at every tier today, so this is inert on this install and would become a
correctness bug the first time somebody turned it on. A seat's *own* session across rounds is a
different mechanism (`warmSessionFor` tries own runs first, needs no permission, discloses nothing)
and is exactly what we want.

### 4.3 A roster is not a candidate set

`ChildDefaults.workerIds` is *"a closed list, not a preference"* — the accounts the scheduler may pick
from for any piece. A debate needs the opposite: seat 1 is **exactly** (account A, Opus, high) and
seat 2 is **exactly** (account B, Gemini). Reusing `workerIds` would let the scheduler put three seats
on one account and call it a debate.

→ A new shape, `DebateSeat { workerId, model?, effort? }`, and the roster is an **ordered list** of
them. A duplicate (worker, model, effort) triple is *allowed* — that is a homogeneous debate, which
the operator may want — but it is what the heterogeneity notice counts.

⛔ **One cap, not two.** `ROOT_MANDATE.maxChildren` is 5 and `createTask` enforces it, so the seat
control offers 2–5 and the number on screen is the number that will be allowed. This is §3.7 of
`plan_and_split_2026-09-03.md` restated: a split of six was refused with a message about a cap nobody
set.

### 4.4 The default fleet runs a 3-seat debate one seat at a time

`maxConcurrent` defaults to **1** per worker (`boundedConcurrency(…, 1)`, `workers.ts`) and
`poolSize` defaults to **3** (`projects.ts` `DEFAULTS`). So on the commonest install — one account,
default pool — three seats are three serial runs, and a 4-seat debate additionally waits on the
workspace pool.

→ Not a bug and not something to route around: it is a fact the composer states, next to the seat
count, in the same voice `poolIsNarrow` (`scoring.ts`) already uses for the pool — *said out loud and
not silently corrected*. ⚠️ Blindness survives serialisation, because each seat is its own session
with its own context and 4.2 keeps them apart.

### 4.5 The parent must re-block itself, in this order

`setStatus` re-admits dependents on the transition **into** a settled status. Nothing re-blocks a
parent when a dependency goes back *out* of `completed`. So a round is: re-queue every seat
(`continueTask`), **then** `setStatus(parent, 'blocked')`, **then** `admit(parent)` — which recomputes
from the world and would find the edges unmet. In the other order the parent is admitted against
seats that have not yet moved and is dispatched into a round that has not happened.

⚠️ `applySplit` already ends in exactly this pattern, including its *"re-derive rather than trust the
write above"* `admit()`. Reuse the shape; do not invent a second one.

### 4.6 `validateSplit` refuses a debate parent

`if (parent.kind !== 'plan')`. The operator's *"Split the work"* verdict is the organizer calling
`task_split`, so a debate parent has to be accepted. One line, plus the sentence in the tool
description — and `plannerBranchFor` / `createTask`'s `effectiveLandingTarget` both key on
`parent?.kind === 'plan'` too, so pieces of a debate's split would otherwise be cut from the trunk
instead of from the organizer's branch (§3.2 of the Plan & Split plan, in reverse).

### 4.7 ⛔ `task.kind` is immutable, and one of the five verdicts wants it to change

`updateTask`'s statement names every column it writes and `kind` is not among them; no other path
writes it. *"Ask follow-up questions (more getting into conversation mode)"* is literally a request to
become a `conversation`, whose contract is `isOpenConversation(task)` = `kind === 'conversation' &&
finishPolicy === 'inherit'` — read by the prompt's closing instruction, by `resolveFinishPolicy`, by
`endConversationTurn`, by `land_work` and by the thread's buttons.

→ **D3**: the kind changes. ⛔ **One way, `debate` → `conversation` only, and only from the verdict
path** — never a column a UI can set, never a reversal, and the transition writes a thread line, so
what looks afterwards like an ordinary conversation can still be traced to the debate that produced
it. ⚠️ `updateTask` is *not* the writer: a mutation reachable from `task.update` would be a kind
anybody could change on any row, which is exactly the property that makes `kind` safe to branch on in
`promptFor` today. It gets its own narrow writer in `debate.ts`, asserting the current kind first.

### 4.8 A seat has nothing to grade, and the debate's grade is not about the agreement

`resolveRange` (`review.ts`) needs commits; a seat has none, so every seat would enter the grading
queue and fail out of it. → seats are created `nonGradable: true` (migration 51's column, used for
exactly this). ⚠️ And the *debate* task's grade, if it ever lands commits, measures the organizer's
**execution** turn. It must never be read as a grade of the agreement, and `docs/glossary.md` owes
that sentence.

### 4.9 Three files hold a judgement about `plan` that a debate needs its own answer to

| Where | What it says about `plan` | What a debate needs |
|---|---|---|
| `complexity.ts` `complexityOf` | `kindValue = isPlan ? 1 : 0` — a plan is maximally complex | The **organizer** is plan-like (1). A **seat** is not a plan and is sized from its prompt like any task |
| `exploration.ts` `exploreRoute` | never experiment with a model on a plan task | Neither the organizer nor a seat may be model-swapped: a seat's model *is* the operator's roster, and swapping one would silently make a heterogeneous debate homogeneous. ⛔ A pinned model already refuses exploration (`task.constraints.model`), so seats are covered by the existing rule and the organizer needs the `plan` clause extended |
| `scoring.ts` `chooseTarget` | skip the routing consult for a plan | Same for a debate: both are pinned, so there is nothing to consult about |

⚠️ Each of the three is a one-line change with no behaviour to prove, and each is wrong silently.

### 4.10 A debate needs a project

Seats read a repository; a debate about nothing in particular has no seats worth paying for. The
scheduler already refuses a `plan` with no project and routes it to the controller consult instead
(`scheduler.ts` ~:500); a debate takes the same guard, with a hold reason that says so rather than a
consult, because the consult cannot run a debate.

### 4.11 The cost preview needs an estimate for a task that does not exist yet

`task.estimate` takes a task **id**. The whole point of the notice is that it appears *before*
anything is filed. → a new RPC that takes the composer's own inputs (`title`, `projectId`, `kind`,
the roster, rounds) and answers with per-seat and total figures plus a `basis` string. It reuses
`complexityOf` and `estimateTask` unchanged; what is new is that it accepts a description instead of
a row. ⛔ It returns `null` money with `usdConfidence: 'none'` rather than `$0.00` when nothing behind
it could be priced — the rule `task.estimate` already keeps.

---

## 5. The design

### 5.1 Data model

- **`TaskKind` gains `'debate'`.** `docs/data-model.md` owes an edit — a union changed.
- **Migration 68** (next free; ⛔ take the next number when you write it and pin any test by *text*
  through `versionBefore`): `tasks.debate_json text` — null for every row that exists, guarded by
  `hasColumn`, replay-safe. It holds the whole debate state:

```jsonc
{
  "seats":    [{ "workerId": "…", "model": "claude-opus-5", "effort": "high" }],
  "rounds":   3,              // the operator's cap. ⛔ never raised by anything
  "exchange": "full",         // or "digest" — D4, the operator's pill
  "round":    2,              // which round the seats are in now
  "verdict":  null            // null | "execute" | "split" | "discuss" | "complete" | "stop"
}
```

- **`FinishPolicy` gains `'report-only'`** (§4.1), outside `FINISH_ORDER`.
- **`QuestionOrigin` gains `'debate'`** so the verdict card is attributable.
- **One narrow kind transition, `debate` → `conversation`** (D3, §4.7), written only by `debate.ts`
  from the verdict path and never by `updateTask`.
- **No new status and no new `DependencyRequirement`.** `blocked` already means *waiting on
  prerequisites*, already re-admits, already renders in the queued lane; `settled` already releases on
  any resting terminal state and is already told which was which.

### 5.2 The lifecycle

```
  operator files a Debate task: the question, the roster, the rounds, the organizer
        │
   ┌────▼───────────────────────────────────────────────┐
   │ round 1 — the seats, BLIND                         │ N ordinary dispatches: each pinned to
   │  each reads the repo, answers, task_complete        │ its own (account, model, effort), each
   │  finish policy: report-only · sharing: off          │ metered and priced on its own row
   └────┬───────────────────────────────────────────────┘
        │  parent blocked on N `settled` edges — costs nothing, holds nothing
        ▼
   ┌────────────────────────────────────────────────────┐
   │ the organizer's turn r                              │ prompt carries every position verbatim,
   │  reads N positions + the citation report            │ plus which citations do not resolve
   │  calls debate_round ONCE:                           │
   │    { continue, briefs[] }  or  { converged, … }     │
   └────┬───────────────────────────────────────────────┘
        │ continue, and rounds remain      │ converged, or rounds exhausted
        ▼                                   ▼
   each seat gets its brief as a        ONE choice Question with the five
   thread message + continueTask;       verdicts. ⛔ blocks the tool call,
   parent re-blocks (§4.5) ─────────┐   the way task_split blocks
                                     │        │
                                     └────────┤ the operator answers
                                              ▼
       execute · split · discuss · complete · stop   (§5.9)
```

⛔ **The wait between rounds costs nothing and holds nothing**, which is the only shape compatible
with *the scheduler costs zero tokens*. `retainedReservations` counts no slot for a `blocked` task —
verified for Plan & Split on 2026-09-04 and unchanged.

### 5.3 Who may stop, and who may not

⛔ **The organizer may converge early; it may never extend.** The round count is the budget the
operator authorised, and *preference never widens authority* is the rule this codebase already states
about `finishPolicy` versus `mandate.allowed`. Early convergence saves the operator money and is
allowed unconditionally; a request for one more round is a request the tool refuses with the reason.

**The deterministic fallback, written first.** If the organizer's turn fails, never calls the tool, or
calls it with something that will not validate three times, the debate does **not** guess a winner: it
parks at `awaiting_human` with every seat's position on the thread, unsynthesised, and says which of
the three happened. An unarbitrated debate is still N useful answers; a fabricated agreement is worse
than none.

### 5.4 Daemon

| File | Change |
|---|---|
| `db.ts` | migration 68 |
| `debate.ts` **new** | `validateDebate`, `openDebate` (file the seats atomically, reusing `applySplit`'s all-or-nothing shape), `nextRound` (write briefs, re-queue seats, re-block the parent in §4.5's order), `debatePhaseOf`, `citationReport` |
| `finish.ts` | `report-only`, checked before step 3 |
| `split.ts` | accept a `debate` parent (§4.6) |
| `tasks.ts` | `plannerBranchFor` and `effectiveLandingTarget` accept a debate parent; `DebateSeat` plumbing |
| `prompt.ts` | four new prompts (§5.6), selected on `debatePhaseOf` beside `planPhaseOf` |
| `scheduler.ts` | a `debate` task with no project takes the plan guard's shape (§4.10) |
| `complexity.ts` `exploration.ts` `scoring.ts` | §4.9, one line each |
| `questions.ts` | the `debate` origin; the verdict card |
| `api/tasks.ts` | `task.debate` (file one), `task.debateState` (read one), `task.estimatePreview` (§4.11) |

⛔ `debate.ts` holds the safety boundary for the same reason `split.ts` does: it is the expensive
thing to get wrong and the cheap thing to test, against a temp database with no agent, no prompt and
no UI in the way.

### 5.5 MCP — one new tool

| Tool | Does |
|---|---|
| `debate_round` | ⛔ **The organizer's only move, called once per round.** Either `{ continue: true, briefs: [{ seat, text }] }` — one brief per seat, delivered as a thread message — or `{ converged: true, agreement, dissent, confidence }`, which raises the verdict card and **blocks until a person answers**, returning their choice |

⚠️ **One tool, and it is not free.** Changing tool definitions invalidates the whole prompt-cache
prefix, and a session's MCP config is frozen for its lifetime, so **every** worker session on the
install pays for this — not only debates. `docs/mcp.md` §2 says so by name, and `checkpoint`,
`task_split` and `land_work` each paid it before. It follows the same mitigation: registered for
everyone, **named in the prompt only for a debate organizer**.

⛔ **Not three tools.** A separate `debate_post` for seats and `debate_verdict` for the organizer were
considered and rejected: a seat's position is already carried by `task_complete`'s summary, which is
already written onto the thread as an `agent` message, and a third prefix buys nothing the closing
instruction cannot say. ⛔ And not a third **tier** — that would buy a third prompt-cache prefix on the
install, which `docs/mcp.md` §2 warns about by name.

### 5.6 The four prompts

⚠️ Selected on `debatePhaseOf(task)`, a domain fact, beside `planPhaseOf`. Not a violation of *never
branch on a mode name* — that rule is about adapters and objectives, which are data.

**A seat, round 1 (blind).** *You are one of N agents answering this question independently. The
others cannot see your answer and you cannot see theirs; that is deliberate, and an answer that hedges
towards what you imagine they will say is worth nothing.* Read enough of the repository to be
concrete — real paths, real functions. State the answer you would defend, the reasoning, what would
have to be true for you to be wrong, and how confident you are. ⛔ **Cite real paths** — every
`path/to/file.ts` you name is checked against this repository before anybody reads your position, and
a citation that does not resolve is reported next to your name. Then `task_complete` with your
position as the summary. Do not commit, and do not change anything.

**A seat, round r > 1.** Prepended with the organizer's brief (and, under `exchange: "full"`, every
other seat's position verbatim). *These are colleagues working on the same problem, not opponents.*
⛔ Where you were wrong, say so and say why — changing your mind on evidence is the most valuable thing
you can do here. Where you were right and they disagree, say what evidence would settle it. ⚠️ **Do
not converge for the sake of converging**: an unresolved disagreement recorded honestly is worth more
than an agreement nobody believes.

**The organizer, round r.** Prepended with every seat's position verbatim, each labelled with its
account and model, plus the citation report (§5.8). *You are arbitrating, not competing, and you are
not casting a vote.* Weigh the arguments on their evidence, not on who made them or how confidently.
⛔ Where the positions agree because nobody examined the question, say so — agreement is not evidence.
Then call `debate_round` once: either continue with one brief per seat naming **the specific
disagreement each has to address**, or converge with the agreement, the dissent, and your confidence.
⛔ An agreement with an empty dissent section is refused; if there genuinely is none, say that in the
dissent field and say what was never contested.

**The organizer, post-verdict.** One paragraph per verdict, and only the one that was chosen. For
`execute` it is the ordinary work instruction — the agreement is the spec, the project's checks, the
commit hygiene, `task_complete` — sent into the session that already holds the whole debate.

### 5.7 What the agreement has to contain

⛔ **Four parts, and a reply missing any of them is refused with the reason** — the closed-set rule
`judgment.ts` already keeps, and the *"first establish there is a reply"* rule before it: a turn that
ended in `isError` carries the vendor's words where the answer goes, and those validate as badly as a
bad answer.

1. **Agreed** — what to do, concretely enough to execute.
2. **Dissent** — who disagreed, with what, and on what grounds. ⛔ Never empty (§2, consensus
   collapse).
3. **Confidence** — the organizer's own, with the reason.
4. **Unresolved** — what the debate did not settle and what would settle it.

### 5.8 ⭐ The citation check

Every position is scanned for `path/to/file.ext` patterns and each is tested against the debate task's
own workspace. Paths that do not resolve are listed beside the seat's name in the organizer's prompt
and on the debate board.

⛔ **A report, never a penalty.** It says *this claim cites a file that does not exist in this
repository*, which is one of the few things about an argument this tool can establish rather than
believe. It does not score the seat, does not exclude it, and does not edit its words.

⚠️ There is precedent for exactly this, in this repository: `src/daemon/docs.test.ts` extracts
`src/…` paths from backticks and tests `existsSync`, and it exists because *"a doc naming a file is
making a claim about where something lives"*. A debater naming a file is making the same claim.

### 5.9 The five verdicts

Exactly the operator's list, each mapped to a mechanism that already exists:

| Verdict | What happens |
|---|---|
| **Execute as agreed (organizer does the work)** | The tool call returns the choice, the organizer keeps working **in the same warm session**, under the debate task's own finish policy. No new run, no cold start |
| **Split the work** | The organizer calls `task_split` — §4.6's one line is what makes this free. Pieces are cut from the debate branch and merge back into it, exactly as a plan's are |
| **Ask follow-up questions** | **D3**: the task becomes a `conversation` — one column, one direction, at this one moment — and the operator keeps talking in the organizer's own warm session |
| **Mark completed** | `task_complete` with the agreement as the summary. ⛔ Needs `report-only` (§4.1) or the empty-branch guard hands it back to a person |
| **Stop the work** | `cancelTask` into a resting state. ⛔ *Cancel is not delete*: every position, every round and every run stays |

### 5.10 UI

- **`KIND_OPTIONS` gains a fourth entry**, *Debate* — "several agents answer independently, then argue
  it out under an organizer". ⚠️ The comment above that array currently says *"Three. Multi-task
  belongs here next"* and owes an edit.
- **One settings row, `Debate`**, beside the existing Planner/Executor rows: the **roster** (reusing
  `WorkersPicker`, which already does per-account model and effort), **rounds** (1–5), the
  **organizer** (account + model, sorted by `fitnessTable()`), and the **exchange** pill (D4: *verbatim* or
  *organizer's digest*, defaulting to verbatim).
- **Three notices under the row, and every one of them carries its basis** — the rule this codebase
  applies to a routing score applied to a piece of advice:
  - *Heterogeneity.* Computed on distinct **adapters** in the roster (§2). One adapter: "all N seats
    are the same family — published work finds most of debate's gain comes from **different** model
    families, and same-family pairs show minimal gains." Two or more: says so, approvingly. ⛔ Never a
    refusal: not every operator has a second provider, and the notice says which of theirs would help.
  - *Cost.* From `task.estimatePreview` (§4.11): per seat, × seats, × rounds, + the organizer, as a
    **multiple of the same question asked once**, with `usdConfidence` and the `basis` string shown.
    Plus the serialisation fact (§4.4) when the roster's accounts cannot run in parallel.
  - *Diminishing returns.* On rounds 4–5 and on seats 4–5, naming what the literature found and that
    it was **not** measured here. And ⚠️ **the honest caveat**: several published results find debate
    does not beat one good agent at the same token budget. It is a sentence, on the screen where the
    money is committed, and it is the reason this feature can be trusted.
- **The debate board**, on the task's thread: one column per seat, one row per round, each cell the
  position with its confidence and its unresolved citations; the organizer's brief between rows; the
  agreement and its dissent at the foot. ⛔ Every cell is agent output, so it is **text** parsed by
  `lib/markdown.ts`'s closed subset — no raw HTML, no `dangerouslySetInnerHTML`.
- **The verdict card** is an ordinary `choice` question: it appears on the Attention bar and on the
  task, and it is answerable from the phone, because `Question` already is.
- `composerprefs.ts` remembers the roster, the rounds and the organizer; its test round-trips them.

---

## 6. Work breakdown

Nine commits, each landable on its own, each leaving the tree green. The first three carry the risk.

1. **`report-only`** (§4.1). The union, `decideFinish`'s new branch before step 3, `FINISH_LABELS` /
   `FINISH_SHORT`, the composer's finish menus. ⛔ Self-contained, useful on its own, and landing it
   first keeps every later commit revertible without a schema change. ⚠️ Watch the empty-branch guard
   go **red** for a `report-only` task first — a finish policy that silently does nothing looks
   exactly like one that worked.
2. **The kind, the column and the roster.** `TaskKind`, migration 68, `DebateSeat`, `validateDebate`,
   `openDebate`, and §4.9's three one-liners. `debate.test.ts` against a temp database: the seat cap
   against the mandate, a roster of one refused, `sessionSharing: 'off'` on every seat,
   `nonGradable` on every seat, and the atomic unwind.
3. **The round loop** (§4.5). `nextRound`, and the ordering test that is the whole point: re-queue,
   then block, then admit — asserted by driving it in the wrong order and watching the parent get
   dispatched into a round that has not happened.
4. **`debate_round`**, the validator (§5.7) and the blocking verdict question. `docs/mcp.md`.
5. **The prompts** (§5.6) and the citation report (§5.8). `prompt.test.ts` — ⛔ anything calling
   `plan()` needs the CLI on PATH and CI has none (`docs/testing.md` §3).
6. **The five verdicts** (§5.9), including §4.6's line and D3's one-way kind writer. ⛔ The kind change
   gets its own test asserting it refuses every direction and every entry point but the one.
7. **The estimate preview** (§4.11) and the three notices' arithmetic, in a pure module with its own
   L1 tests. ⛔ The renderer does not compute money.
8. **The composer row** (§5.10) and `composerprefs`.
9. **The debate board** on the thread.

⚠️ **Commits 8 and 9 are the pair that can produce a green suite over a broken feature.**
`test/ui.test.mjs` never opens a project and its worker has no credentials, so a debate filed there
files nothing and runs nothing, and anything asserted about seats passes against an empty list
(`docs/testing.md` §3). Their proof is L2 plus one hand-driven debate.

⛔ **The feature is not done until one real debate has run on this repository**, on a question whose
answer somebody can check.

## 7. Tests

| Tier | What it proves |
|---|---|
| L1 | `report-only` completes a clean branch with no commits, and no other policy's behaviour moved |
| L1 | the roster: the cap against `ROOT_MANDATE.maxChildren`, a debate of one refused, duplicate triples **allowed**, an empty question refused, the all-or-nothing unwind |
| L1 | ⛔ every seat is filed `sessionSharing: 'off'`, and `borrowCandidates` offers a sibling seat's session **nothing** even with sharing forced on (§4.2). Watched red first |
| L1 | the round order (§4.5): the parent is `blocked` and not dispatchable at every point between rounds |
| L1 | the organizer's reply validator: a missing dissent section refused, an `isError` envelope refused *as an error* and not as bad formatting, `converged` accepted, a request to go past the operator's cap refused with its reason |
| L1 | ⛔ the organizer may stop early and may not extend — asserted on the stored cap, not on the prompt |
| L1 | ⛔ the kind transition (D3) refuses `conversation` → `debate`, refuses a second application, and is unreachable from `task.update` |
| L1 | the citation report flags a path that does not exist and passes one that does |
| L1 | the cost preview: N seats × R rounds against one run, and `null` money with `usdConfidence: 'none'` where nothing could be priced |
| L1 | the heterogeneity notice counts **adapters**, so two Claude models read as one family |
| L2 | a full debate on the probe adapter: 2 seats × 2 rounds, seats settle, parent re-blocks, briefs land on the right threads, the verdict card blocks and each of the five answers does what §5.9 says |
| L2 | the deterministic fallback: an organizer that never calls the tool parks the debate at `awaiting_human` with the positions intact and no agreement invented |
| L3 | the composer draws the Debate row, the three notices appear with their numbers, and it files what it drew |
| by hand | one real debate on this repository, heterogeneous if the fleet allows it, before it is called done |

**What the first real run is worth measuring**, since §2 is entirely inferred: total tokens and money
against the same question asked once of the strongest single agent; how much of rounds 2+ was cache
read rather than rebuild (the §1 claim); whether the organizer's agreement changed anything a person
would have missed; and how many citations did not resolve. Record it in `docs/cost-model.md` with the
date and CLI versions, the way every other number in this repository is recorded.

## 8. Documentation this owes

`docs/data-model.md` (three unions and a migration) · `docs/mcp.md` (one tool) ·
`docs/glossary.md` (**seat**, **organizer**, **debate**, and §4.8's sentence) ·
`docs/landing.md` (`report-only`) · `docs/ui.md` (the kind, the row, the board) ·
`docs/sessions.md` (§4.2) · `docs/testing.md` only if a new class of false pass appears ·
`README.md` (a user-facing feature) · `HANDOFF.md` (always).

## 9. Decisions taken

Put to the operator on 2026-09-12 and answered. These are what the rest of this document is built
on; changing one changes the shape, not the detail.

| # | Question | Answer |
|---|---|---|
| **D1** | What is the organizer? | **A dispatched agent**, with its own worktree, `ask_human` in its hand and the ability to execute the agreement afterwards. §2.1. ⚠️ The unattended controller consult survives *only* as the escape hatch for a debate with no project (§4.10), and it cannot arbitrate one. The composer recommends the highest-`fitnessTable()` model and an adapter that is not the only one in the room — ⛔ advisory, never a gate |
| **D2** | What does a seat's turn leave behind? | **The position on the thread, and nothing on the branch** — the new `report-only` finish policy (§4.1). The thread is already the durable, queryable, UI-visible record, and a debate does not put five opinion files in somebody's repository |
| **D3** | How does *"Ask follow-up questions"* work? | **Convert the task to a `conversation`** — a new, narrow, **one-way** kind change, allowed at the verdict moment and nowhere else (§4.7). It keeps the organizer's warm session, which holds the whole debate; filing a new task would pay a cold rebuild of exactly the context this tool exists to preserve |
| **D4** | What does a seat read in round 2+? | **An operator pill, defaulting to verbatim.** `exchange: "full"` hands each seat every other position verbatim plus the organizer's brief; `"digest"` hands it the brief alone. ⚠️ Stored in `debate_json`, so it is **data** and never a branch on a seat count |
| **D5** | Who decides the debate is over? | **The operator's cap, with early convergence allowed and no extension.** *Preference never widens authority*: stopping early only ever saves money and needs no permission, and a request to go past the cap is refused with its reason (§5.3) |

⭐ All five were answered as recommended, so nothing in §§1–8 was written against a decision that
then went the other way.

## 10. Deliberately not in this version

- **A seat that can run code.** Seats read and argue. A seat that can edit the workspace is N agents
  writing to N branches nobody asked for, and the verdict `Split the work` is the supported way to
  turn an agreement into edits.
- **Adaptive seat count or adaptive topology.** §2's newer work grows the graph from confidence and
  divergence mid-debate. That is a second scheduler with an LLM in it; the deterministic version has to
  exist and be watched first. Nothing here forecloses it — the roster and the exchange are both data.
- **Debate as a *judgment event*.** Using a debate to answer the controller's own questions (routing,
  triage) is a real idea and a different design: those answer in seconds against a 4-minute
  deterministic fallback, and a debate does not.
- **Re-debating.** An organizer that wants a fresh round after convergence files a new debate.
- **Cross-project debate.** Seats inherit the parent's project, and the mandate says so.
- **A debate with no project** (§4.10). Refused with a reason, not silently degraded.

---

## 11. Amendment, t382 (2026-09-12) — sycophancy, and why no seat is told to disagree

The operator asked whether seats should be *instructed to disagree*. A three-seat debate on that
question (t382: Opus, Gemini, GPT) converged on **no**, and the organizer's agreement was executed:

- **Measured on t382 itself:** two of three seats, in both rounds, obeyed `task_complete`'s
  *"One line: what was done"* over §5.6's *"your position as the summary"* — three paid runs, one
  arbitrable position. Fix at the source (the seat prompt now says the summary IS the whole
  position, against the tool's hint — a tool-definition change would invalidate the prompt cache
  install-wide) and a net after it (`landCompletion` appends a report-only run's closing prose).
- **The lever is at the flip, not the stance.** The literature in §2 already costs competitive
  framing at 15pp; newer work finds an assigned dissenting role degrades accuracy the same way,
  moderate disagreement beats maximal, and sycophancy's damage is a position adopted on a peer's
  confidence rather than on evidence. So: `roundBriefFor` quotes the seat its own prior position and
  falsification condition back and asks for a per-peer **change ledger** with the evidence behind
  every change; `flipReport` says, deterministically, whether a round cites anything an earlier
  round did not; the organizer's roster shows each seat's **stated confidence** as text; and
  `validateAgreement` refuses a dissent short enough to be "none".
- **Lenses, gated.** `DebateSeat.lens` is an evidence base, never a stance, offered by the composer
  only at `adapterSpread === 1`.
- **Still unmeasured, and what would measure it:** whether anonymising the organizer's roster beats
  labelling it (a three-arm run: labelled, confidence-only, blind); whether lenses help at all (the
  flip report on a lens-on/lens-off pair). One seat (`gpt-5.6-luna`) reported `task_complete` was not
  in its tool set in round 2 — a separate adapter-exposure defect, not yet run down.

## 12. Amendment, t387 (2026-09-12) — the first run's control text and workspace

The first run established that the raw question may itself contain implementation and finishing
instructions. A seat is not a cheap implementation worker: `seatPromptFor` now puts the question
behind an explicit **QUESTION UNDER DEBATE** boundary, tells the seat to state its interpretation of
ambiguity, and refuses the quoted prompt authority to edit, commit, rebase or finish. This is the
deterministic turn-zero framing; an extra paid organizer turn before any independent evidence exists
is not added. The organizer still first spends tokens after the blind positions exist, where it has
evidence to arbitrate rather than merely paraphrasing the operator.

Measured from refs on 2026-09-12: all three seat branches were initially created from `origin/main`
at `316aa33`; t383 and t384 moved to local `main` at `59bf185` only because they obeyed the quoted
prompt's rebase instruction, while t385 correctly remained at `316aa33`, six commits before the
debate implementation at `467c90e`. `report-only` now resolves its starting ref to the local landing
target regardless of delivery strategy. The completion wording is capability-neutral too: Codex's
adapter deliberately declares `mcp: false`, so a seat is told to use the completion contract at the
end of its generated prompt instead of being told an MCP tool exists.
