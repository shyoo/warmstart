# Plan & Execute — implementation plan

**2026-09-15 · t456 · design of record, not status.** Status lives in `HANDOFF.md`.

A **Plan & Execute** task is Plan & Split with the fan-out and the aggregation removed: one planner
turn and one executor turn, two runs, no third turn to merge anything. It exists because Plan &
Split's third turn is only worth paying for when there is something to *integrate* — several pieces
built by agents that could not see each other. With one piece there is nothing at the seams, and the
planner's review is a second full read of work that was already done to its own instruction.

---

## 1. What the published work says

⚠️ **Measure, don't assert.** Everything below is somebody else's measurement on somebody else's
workload, gathered 2026-09-15. None of it was reproduced on this fleet, and the numbers are here to
size the decision, not to justify a claim in the UI.

| Claim | Source | What it actually measured |
|---|---|---|
| Plan-and-execute saves money because "sub-tasks can be made to smaller, domain-specific models. The larger model then is only called for (re-)planning steps" | [LangChain, *Plan-and-Execute Agents*](https://www.langchain.com/blog/planning-agents) | An architecture note, not a benchmark. States three claimed gains — speed (the big model is not consulted after each action), cost (cheap executor), quality (the planner is forced to think the whole thing through) — and one drawback: serial tool calling, so a longer wall clock than a parallel decomposition |
| Plan-Execute cost **$1.24/task against Reflexion's $5.12** — 4.4×; the split was ~15% of tokens in planning, ~85% in execution | [Morph, *Multi-Agent Model Routing: Planner + Executor Pairs*](https://www.morphllm.com/multi-agent-model-routing) (vendor blog) | A vendor benchmark against *Reflexion*, whose cost comes from ~2.8 self-reflection iterations per task. ⚠️ This is not the comparison Warmstart is making — the baseline here is Plan & Split, not Reflexion — so the ratio does not transfer. What does transfer is the token split: planning is a small fraction of the spend, so *which model plans* matters far less to the bill than *which model executes* |
| A **weak planner** costs far more system performance than a weak executor; attacks on the planner are the effective ones; planner memory matters and executor memory does not | [PEAR: Planner-Executor Agent Robustness Benchmark](https://arxiv.org/abs/2510.07505) | ⛔ **Cite with care: the arXiv version was withdrawn by administrators over authorship.** The [ACL Findings version](https://aclanthology.org/2026.findings-eacl.237.pdf) stands. Direction of the finding matches the design here — spend on the planner, economise on the executor |
| Executor capability is the **dominant lever**: strong executor **64.2%** pass vs **42.5%** for the compact tier, at **~$0.035–0.041** vs **$0.006–0.007** per task (≈6×). No representation trick (compression, restructuring, scoped loading) recovered the gap | [*Compression, structure, and executor capability*](https://arxiv.org/html/2607.03048) | ⛔ **The finding that constrains this feature.** A cheaper executor is a real 6× saving and a real ~22-point quality drop on that workload. So Plan & Execute must never *silently* downgrade the executor: the operator picks it, and the composer says what it is trading |

**What this adds up to for Warmstart.** The saving Plan & Execute offers over Plan & Split is not
mainly the cheaper executor — the Executor row already exists and Plan & Split already puts cheap
models on pieces. It is the **third turn**: a planner resolution run that re-reads the whole change
on the expensive model. On this install a planner run is a cold, full-context read of the repository
plus the diff. Removing it is the measurable win, and it is measurable *here* rather than in a paper:
compare a Plan & Execute task's total run cost against a Plan & Split of one piece on the same work.

⭐ **The codebase already argues for this shape.** `MIN_SPLIT_PIECES` in
[`src/daemon/split.ts`](../src/daemon/split.ts) refuses a split of one, and its reason is exactly the
case Plan & Execute serves: *"A split of one buys a round trip, a second workspace and a second cold
context, and delivers no parallelism at all."* Plan & Execute is the honest answer to that refusal —
you still get the round trip and the cold context, but you no longer pay the third turn for them, and
the cold context is the point when it is a *different, cheaper* model.

---

## 2. The lifecycle, against Plan & Split's

```
Plan & Split                                  Plan & Execute
                                              
        ┌── piece ──┐                         
plan ───┼── piece ──┼─── resolve ── land      plan ───── execute ───── land
        └── piece ──┘                         
                                              
3 turns · N+1 workspaces · pieces merge       2 turns · 2 workspaces · executor lands
into the plan branch, planner lands it        onto the project's target directly
```

---

## 3. What is already there and what is missing

| Thing | Where | Today | Needed |
|---|---|---|---|
| kind | `src/shared/tasks.ts` `TaskKind` | `work \| plan \| conversation \| debate` | a way to tell the two plan shapes apart |
| composer kind pill | `NewTask.tsx` `KIND_OPTIONS` | four options | five |
| the two rows | `NewTask.tsx` `composer-plan-table` | Planner / **Executor** (already that word) | the Executor row loses its *Up to N pieces* pill in execute mode |
| prefs | `composerprefs.ts` `ComposerKind`, `PiecePrefs` | remembered per row | one more kind value |
| phase | `prompt.ts` `planPhaseOf` | derived from whether children exist | unchanged — derived, never stored |
| the split | `split.ts` `validateSplit` / `applySplit` | ≥2 pieces, children land onto the plan branch | exactly 1 piece in execute mode, landing onto the *project's* target |
| the approval | `api/agent.ts` `agent.split` | blocks on one `choice` question | same gate, different wording |
| resolution | `prompt.ts` `resolutionInstruction` | third turn | ⛔ not reached in execute mode |
| the diagram | — | nothing | a small inline SVG per plan kind in the composer |

---

## 4. The decisions put to the operator

See §7. They are what the rest of this document is built on; changing one changes the shape.

---

## 5. Docs this owes

`docs/routing.md` §3.9 (two turns becomes two shapes), `docs/data-model.md` (`TaskKind`),
`docs/landing.md` (a Plan & Execute executor lands onto the trunk, not a plan branch),
`docs/mcp.md` (`task_split`'s piece floor is no longer unconditionally 2), `docs/ui.md` §composer,
`README.md` (the four-kind table becomes five), `HANDOFF.md`.

---

## 6. Tests

L1: `split.test.ts` (one piece accepted in execute mode and refused in split mode; the executor's
landing target is the project's, not the plan branch; the plan task settles from its child rather
than being re-admitted for a turn), `prompt.test.ts` (the execute-mode planning instruction; no
resolution instruction is ever produced), `composerprefs.test.ts` (the fifth kind round-trips),
`taskview.test.ts` (`kindLabel`). L3 `test/ui.test.mjs`: the kind pill offers five options and the
diagram swaps when the kind changes. ⚠️ `test/ui.test.mjs` never opens a project tab, so anything
inside one is asserted by mutating the code and watching it go red first.

---

## 7. The decisions

**Put to the operator on 2026-09-15 and answered.** They are what the shape rests on; changing one
changes the shape, not the detail.

### D1 — Topology: **a one-piece split whose plan task closes at the handoff**

Three were offered. The operator chose the third.

- The planner calls the existing `task_split` with **exactly one** piece — same tool, same blocking
  approval, same atomic filing. ⭐ **No new MCP tool**, which matters beyond tidiness: `docs/mcp.md`
  §2 records that a tool definition invalidates the prompt-cache prefix of *every* worker session on
  the install, not only plan tasks.
- `applySplit` writes **no** `settled` edge back onto the planner and leaves its status alone.
  `agent.split` then completes the planner through `completeTask` — ⛔ not by asking the agent to
  call `task_complete`, because an agent that forgets leaves the run open and the worker slot
  reserved (t226).
- The executor is an ordinary `work` task: cut from the planner's branch, landing onto the
  **project's** target.
- ⚠️ The accepted cost: the card the operator filed goes green while the work is still running, and
  Attention fires on the executor — a task they did not file. The rejected alternatives were the plan
  task *waiting* and auto-completing when the executor settled (more machinery, one card to watch),
  and reassigning the same task for a second run (fewest rows, but needs the new tool).

### D2 — Executor model: **inherit as today, plus a notice that states the trade**

Not a pre-selected cheap model and not a required pin. The Executor row keeps the last-selected
behaviour every other pill has; `executornotice.ts` says what the pairing is and what it costs.
⛔ Advisory, never a gate — a one-account fleet must still be able to use the feature. ⛔ And it never
ranks two models: that module can see two ids and nothing else, and §1's measurement is quoted with
the fact that it was not reproduced here.

### D3 — The approval gate stays, reworded *(taken, not asked)*

`task_split` blocks on one operator approval. Plan & Execute keeps it and changes only the sentence
about what happens next: this is the **only** look anybody gets at the instruction, because no review
turn follows, and telling somebody it will be reviewed would describe a turn this shape has not got.

### D4 — Base and target are answered separately *(taken, not asked)*

The executor is cut from the planner's branch and lands onto the project's target. Cutting from the
plan branch costs nothing and carries anything the planner did leave behind; landing onto a plan
branch would put finished, verified work somewhere nothing will ever land it. `plannerBranchFor` asks
`isIntegrationParent`; `createTask` asks the new `integratesChildren`.

### D5 — The diagram is drawn for **both** plan shapes

`PlanShape` in the composer. A topology has to be said in the order the words come; drawn, it is one
glance. ⚠️ A diagram of the *dispatch*, not a mockup — so nothing in it goes stale when the composer
changes.

---

## 8. What was built, and what was not

Built 2026-09-15 as designed, and pinned at L3 the same day: `test/ui.test.mjs` reaches the composer
from the title bar without a project tab, so it asserts the fifth option, both diagrams' labels, the
absence of the fan-out and planner-finish pills in execute mode and the two notices (446 checks,
2026-09-15). Both diagrams were also looked at in the built app — the first draw put the *pieces*
label on the bottom dot, which no assertion would have caught.

⚠️ **The honest gap**: nothing here has been run against a real agent. The cost claim in §1 — that
removing the third turn is the measurable win — remains unmeasured on this fleet, and the way to
measure it is one Plan & Execute against one Plan & Split of a single piece on the same work
(`HANDOFF.md`, remaining work item 2).
