# Maintainability, coverage and documentation plan — 2026-09-07 (t291)

⚠️ **Dated. Never read this for status** — `HANDOFF.md` carries that. This is the survey and the
sequenced plan that came out of it. As an item lands, `HANDOFF.md` says so and the line here stops
being interesting.

Everything below is **measured on the tree at `cb61eb0`**, not estimated. Where a number appears, the
command that produced it is named, so the next person can re-run it rather than trusting this file.

---

## 0. What was actually landed in t291

The plan is the deliverable; the operator chose to also land the safe foundation the rest of it rests
on. These are done and green:

| Landed | Was |
|---|---|
| `src/daemon/git.ts` — one `git()` / `tryGit()` | four private copies, three `maxBuffer` sizes, **two different whitespace rules** |
| `src/shared/errors.ts` — `errorMessage(err)` | 91 hand-written copies of the same ternary |
| `src/mcp/payload.ts` + 21 checks | the agent-facing parser, untestable and untested |
| `npm run coverage` | no coverage tooling at all; the question was unanswerable |
| `vitest.config.ts` collects `*.test.tsx` | a check written beside a component would silently never run |
| a guard on what `local-llm-bridge.ts` may import | *see §1.4 — this one bit during the work* |

**Baseline the tooling now reports** (`npm run coverage`, 2026-09-07): **50.27% statements**
(19,919/39,618), 81.16% branches, 77.31% functions, over 134 files and 2,768 L1 checks.

---

## 1. Refactoring

### 1.1 The god modules

Four files carry a disproportionate share of the codebase, and each is several unrelated jobs sharing
a lexical scope. This is the main maintainability finding: nothing is *wrong* in them, but nothing can
be changed in them cheaply either, because the blast radius of an edit is the whole file.

| File | Lines | What is actually in it |
|---|---|---|
| `src/daemon/scheduler.ts` | 6,744 | **8 responsibilities**, 79 exports, 111 top-level functions |
| `src/renderer/src/components/TaskThread.tsx` | 4,167 | **34 components** in one module |
| `src/shared/tasks.ts` | 2,940 | types *and* resolvers *and* normalisers *and* label tables |
| `src/daemon/api.ts` | 1,709 | one `buildApi()` returning **115 RPC handlers** |

⛔ **Split by seam, one seam per commit, never all at once.** The dispatch path is the riskiest code
in the repository and a 6,744-line move is unreviewable. Each step below is a pure move plus the
imports it forces, with the suite green in between and no behaviour change in the same commit.

**`scheduler.ts` → in this order** (earlier ones are nearly free; later ones touch dispatch):

1. `prompt.ts` — `promptFor`, `BuiltPrompt`, `planPhaseOf`, `framingLapsed`, `resumedAnchor`. ~600
   lines, already has its own suite (`prompt.test.ts`, 44 checks) and one caller. **Start here.**
2. `scoring.ts` — `chooseTarget`, `windowRisk`, `quotaRiskOf`, `scoreLegend`, `formatScore`,
   `briefScore`, `unproven`, `poolPressure`, `reuseTieBreak`, `ScoreTerm`, `ScoreBreakdown`. Pure
   arithmetic, covered by `routing.test.ts`.
3. `residency.ts` — `atCapacity`, the three `*Reservations`, `leastValuableResident`,
   `sessionLeaseId`.
4. `turnend.ts` — `onSessionExit`, `onStreamResult`, `needsDecisionIn`, `taskCompletionIn`,
   `deadOnArrival`, `overloadFailureRetry`, the idle-turn set.
5. `resolutions.ts` — the five `resolve*OnTask`, `commitConversation`, `landConversation`,
   `relandTask`, `pendingWorkFor`. These are RPC-driven actions, not scheduling.
6. What is left — `tick`, `dispatch`, the watchdogs — **is** the scheduler, and should end at
   roughly 1,500 lines.

**`TaskThread.tsx` →** the seven `*Picker` components are the clearest win and are described in §1.2.
Beyond that: `thread/RunRow.tsx` (`RunRow`, `ReviewRow`, `CompactionRow`, `QuotaDelta`,
`outcomeClass`), `thread/Decide.tsx` (`Decide`, `QuotaDecide`, `QuotaOverride`), `thread/Facts.tsx`
(`Fact`, `ModelFact`, `CacheCost`, `SessionFact`). ⭐ Move the pure helpers (`outcomeClass`,
`paceNote`) into `lib/threadview.ts` as you go — that is where they become testable, which is the
point of the exercise rather than a side effect.

**`shared/tasks.ts` →** split the *resolvers* (`resolveFinishPolicy`, `resolveSessionSharing`,
`resolveCompletionMode`, `projectOrientationChoice`, `projectSeedPrompt`, `normalise`,
`normaliseAsk`) into `shared/policy.ts`, leaving `tasks.ts` as types and label tables. ⚠️ It is
imported by all four processes, so this is a wide but shallow diff — do it alone, in one commit.

**`api.ts` →** `buildApi()` is one object literal of 115 entries. Split it into per-domain builders
(`apiTasks(ctx)`, `apiWorkers(ctx)`, `apiProjects(ctx)`, `apiQuality(ctx)`, `apiAgent(ctx)`) merged in
`buildApi`. The typing (`{ [M in RpcMethod]: Handler<M> }`) survives the split unchanged, so an
exhaustiveness failure still names the missing method.

### 1.2 Duplication, in descending order of what it costs

| Duplication | Count | Status |
|---|---|---|
| `err instanceof Error ? err.message : String(err)` | 91 | ⭐ **done** — `errorMessage` |
| private `git(cwd, args)` runners | 4 | ⭐ **done** — `daemon/git.ts` |
| `const run = promisify(execFile)` | 7 | 3 remain (`landing`, `worktrees`, `stall`) — fold into a `spawn.ts` alongside `git.ts` |
| the `busy` + `note` + try/catch/`setBusy(false)` action shape | 35 (22 in `TaskThread.tsx`) | ⛔ **the biggest remaining one.** A `useAction()` hook in `renderer/src/lib/` collapses each to two lines |
| the `*Picker` component shape | 7 | one `TaskSettingPicker` taking `{ rpcMethod, field, options, title }`; ~400 lines becomes ~120 |
| `median()` | 3 (+ `medianFloat`) | one in a `daemon/stats.ts`; `quality.ts`'s returns `null` for empty and the others return `0`, which is the kind of disagreement that ends up in a report |
| `adapterLabels()` | 2 | `quality.ts` returns a `Record`, `statistics.ts` a `Map`, same query |
| `childrenOf()` | 2 | ⛔ `split.ts` requires **both** `parent.dependsOn ∋ child` and `child.parentTaskId`; `cancel.ts`'s private copy does not. Make `cancel.ts` use `split.ts`'s and delete the copy — **verify against a split task first**, the two answers differ |
| `titleCase()` | 2 | leave them. One splits CLI headings, one model ids; sharing them would couple two things that only look alike |

⚠️ **`resolveFinishPolicy` and `resolveSessionSharing` appear twice each and are *not* duplication** —
the `daemon/` ones bind the fleet tier from `settings()` and delegate. Their docblocks are copied
verbatim, though, so the wrapper should point at the original rather than restate it.

### 1.3 Test-fixture sprawl

⛔ **This is the largest single block of redundant code in the repository and it is all in tests.**

- **~25 near-duplicate fixture builders**: `seedWorker` ×8, `seedSession` ×6, `makeTask` ×5,
  `makeProject` ×5, `git` ×5, `pinnedTask` ×3, `seedRun`/`seedQuota`/`seedReading`/`makeRepo` ×2 each.
- **342 raw `.prepare()` SQL calls across 41 of 134 test files.** A column rename is currently a
  41-file edit, and the suites are coupled to the schema rather than to the behaviour they check.

**Plan.** Add `src/daemon/testkit.ts` — not bundled, because `electron.vite.config.ts` names its
entry points explicitly and nothing imports it from one. It exports the builders the suites keep
rewriting (`seedWorker`, `seedSession`, `seedRun`, `seedQuota`, `seedReading`, `makeTask`,
`makeProject`, `makeRepo`, `openTestDb`), each with the union of the options the copies take.

⚠️ **Migrate suites opportunistically, not in one sweep.** A 41-file mechanical rewrite is exactly the
change whose review nobody finishes. Convert a suite when you are already editing it, and make the
three `pinnedTask` copies the first ones — they are byte-identical apart from a default title.

### 1.4 A constraint found the hard way, now guarded

`src/daemon/adapters/local-llm-bridge.ts` **may not import through the `@shared` alias.**
`local-llm.test.ts` spawns it as *TypeScript source* under `node --experimental-strip-types`, which
resolves no aliases; the child then dies before its `init` record and all seven checks in that suite
wait out a 15s timeout and report as **slow rather than broken**. This happened during t291's own
`errorMessage` sweep. `local-llm.test.ts` now asserts the rule directly, so the next attempt fails in
one second with a sentence instead of in 105 with none.

---

## 2. Test coverage

### 2.1 Where the 50% actually is

⛔ **Read this against `docs/testing.md` §1 or it will mislead.** `npm run coverage` instruments
**L1 only**. The daemon's HTTP surface is proven at L2 and the renderer at L3, and neither is counted
here. A file at 0% is *not covered by pure-logic checks*; it is not necessarily untested.

| Area | Statements | Reading |
|---|---|---|
| `src/shared` | **94.36%** | the model of what good looks like here |
| `src/daemon` | 76.40% | solid; the gaps are named below |
| `src/renderer/src/lib` | 75.76% | the extract-and-test pattern works |
| `src/daemon/adapters` | 65.27% | stream decoding is well covered, spawning is not |
| **`src/renderer/src` (components)** | **0.00%** | ⛔ ~15k statements. **This one number is the whole gap** |

### 2.2 The gaps worth closing, in order of value

1. ⛔ **Renderer components: 0% at L1, and 3 of 35 have any check at all** (`Flow`, `NewProject`,
   `Price`). ⚠️ **The fix is not jsdom.** This project's tiers put components at L3 against a real
   daemon, and adding a DOM tier would be a fourth way to test the same thing. The fix is the one
   `lib/` already demonstrates: as each component in §1.1 is split out, its decisions — which button
   to draw, what a row says, when a control is disabled — move to `lib/` as pure functions and get
   checked there. Coverage follows the refactor; it is not a separate project.
2. ⛔ **56 of 115 RPC methods are named by no test.** Notably **every `agent.*` handler** —
   `agent.complete`, `agent.awaitHuman`, `agent.createTask`, `agent.split`, `agent.depend`,
   `agent.handoff` — which is the surface agents actually call. The underlying functions are tested;
   what is not is the handler: its parameter validation, its error shape, what it assembles. Cover
   these at **L2**, where a real daemon answers, and take the `agent.*` six first.
3. **`gradebatch.ts` (6.7%), `chat.ts` (11.1%), `cancel.ts` (45.1%), `reviewer.ts` (48.6%).**
   ⛔ `cancel.ts` is the one to do first: it owns *cancel is not delete*, an invariant in `AGENTS.md`,
   and it holds the divergent `childrenOf` from §1.2.
4. **`src/shared/routing.ts` and `src/shared/statistics.ts` are at 0%** — small, pure, and shaping
   what an operator reads. The cheapest checks on this list.
5. **`daemon/adapters/generic.ts` (26.4%)** — the fallback every declarative adapter runs through, so
   a gap here is a gap in all of them at once.

### 2.3 How to keep the number honest

⛔ **No coverage threshold, deliberately** — the config says why. A gate makes the cheapest route to
green a test that executes a line and asserts nothing about it, and `docs/testing.md` §3 is a list of
the times a suite here already produced a confident false pass. The number is a map of where to look.

⭐ **Watch every new guard go red before trusting it green** — already the rule, and it earned its
place twice in t291 (the `multi_select` check, and the bridge-import guard that was written *because*
seven checks had been failing silently as timeouts).

---

## 3. Documentation

The mechanical half is guarded: `docs/docs.test.ts` fails on an unindexed page, a dead relative link,
a cited `src/…` path that no longer exists, and `AGENTS.md`/`HANDOFF.md` over 200 lines. Nothing below
is a broken link — these are things that are *true but not written down*, or written in more places
than one.

| Page | Owes |
|---|---|
| `docs/testing.md` | ⭐ **the coverage tier**: what `npm run coverage` measures, that it is L1-only, why there is no threshold, and the 2026-09-07 baseline. Done in t291 |
| `docs/architecture.md` §5 | the module table names ~30 of 66 daemon files; add `git.ts`, and re-cut it as §1.1's splits land |
| `docs/development.md` §4 | the `--experimental-strip-types` constraint from §1.4 — it is a platform failure that looks like something else, which is exactly what that section is for |
| `AGENTS.md` | one line under *Things that will bite*: one `git()`, one `errorMessage()`. ⚠️ Only when the alternatives are gone, or it is a rule about code that still exists |
| `docs/ui.md` | when the `*Picker` collapse lands: one component, seven uses |
| `docs/mcp.md` | that the parsing half now lives in `payload.ts` and is checked |

⚠️ **The standing rule applies to every line above: if you are about to append, say what you are
removing.** `docs/cost-model.md` is 1,649 lines and `docs/routing.md` 729; both are reference that has
only ever grown. Neither is wrong, so neither is urgent — but the next edit to either should leave it
shorter.

---

## 4. Sequencing

Each row is one commit, green in between, no behaviour change mixed into a move.

**Executed 2026-09-08 as t293–t297, reviewed as a batch by t292, finished by t298.** All eleven rows
are in.
⛔ The status column is what was *measured* on the branch afterwards, not what the piece reported —
two rows came back marked complete having done something other than the row.

| # | Work | §  | Status |
|---|---|---|---|
| 1 | `scheduler.ts` → `prompt.ts` | 1.1 | ✅ 557 lines |
| 2 | `useAction()` hook, applied to `TaskThread.tsx`'s 22 sites | 1.2 | ✅ `lib/useAction.ts` |
| 3 | `TaskSettingPicker` replaces the seven pickers | 1.2 | ✅ t298 — one component, menus in `lib/threadview.ts` |
| 4 | `scheduler.ts` → `scoring.ts` | 1.1 | ✅ 1,403 lines |
| 5 | `testkit.ts` + the three `pinnedTask` suites | 1.3 | ✅ 350 lines, 4 suites on it |
| 6 | L2 checks for the six `agent.*` RPCs | 2.2 | ✅ `test/daemon.test.mjs` +250 |
| 7 | `cancel.ts`: adopt `split.ts`'s `childrenOf` | 1.2 / 2.2 | ✅ the one behaviour change, its own commit |
| 8 | `api.ts` → per-domain builders | 1.1 | ✅ (redone by t292 — see below) |
| 9 | `TaskThread.tsx` → `thread/*`, decisions into `lib/` | 1.1 / 2.2 | ✅ t298 — 4,086 → 1,973 lines |
| 10 | `shared/tasks.ts` → `shared/policy.ts` | 1.1 | ✅ (finished by t292 — see below) |
| 11 | the rest of the `scheduler.ts` seams | 1.1 | ✅ `residency.ts`, `turnend.ts`, `resolutions.ts` |

### What the batch left behind

⚠️ **Row 8 was filed as done having only renamed the problem, and was redone during review.** As
landed by t297, `src/daemon/api/*.ts` each held a list of RPC method *names* and called a shared
`pickApi()` that re-picked keys out of an already-built object; the 118-entry handler literal was
intact inside `apiHandlers()` and `api.ts` had **grown** 1,710 → 1,730 lines. t292 moved the handler
bodies for real: `api.ts` is now **28 lines**, the five domain files hold 66–525 lines each, and
`api/support.ts` (458) carries the types, `ApiContext` and the shared validators. ⛔ The completeness
proof survived the move and was re-verified by experiment — deleting `agent.depend` from its domain
file fails the build naming `Property '"agent.depend"' is missing in type … but required in type
'Api'`, at both `Pick<Api, AgentMethod>` and `satisfies Api`. The one thing t297 did leave that was
worth keeping is the partition itself: its five name lists were a correct, non-overlapping inventory
of all 118 methods, and they became the five `*Method` unions.

⭐ **Rows 3 and 9, unattempted by the batch, were done as t298 (2026-09-08).** `TaskThread.tsx` is
**1,973 lines** and 12 components, from 4,086 and 34. The seven pickers are one `TaskSettingPicker`
over pure menu functions in `lib/threadview.ts` (19 L1 checks, where there were none); the rest went
to `thread/{Facts,Decide,RunRow,Disclosure}.tsx`. ⚠️ `Disclosure.tsx` is not in §1.1's list and is
there to keep the graph acyclic — three callers on both sides of the seam draw those two
collapsibles. ⛔ The move was verified byte-for-byte: all 25 function bodies compared against their
text in the parent commit, none differing by anything but `export`. `docs/ui.md` §3 now carries the
"one component, seven uses" line it was owed.

⚠️ **And the L3 suite grew the five checks that make row 3 verifiable at all** — the seven controls
are drawn, `inherit` reads as what it resolves to on the button and as `inherit (…)` in the menu, and
a choice round-trips to the daemon and back. ⛔ Writing them exposed a section of `test/ui.test.mjs`
that had been asserting against **whichever thread was still on screen**: the ledger checks read the
model row of a task nobody had opened, and passed only while the timing held. It navigates now.

⚠️ **Row 10 landed as a copy, not a move**, and was finished during review: the six resolvers were
duplicated into `policy.ts` while the originals stayed in `tasks.ts` renamed `_*Legacy` — ~200 lines
of dead code, with the load-bearing ⛔/⚠️ docblocks stranded on the dead copies. t292 deleted them and
carried the docblocks over. `normalise` is the one that could not simply move: `parseObjective` in
`tasks.ts` needs the same arithmetic and `policy.ts` imports `tasks.ts`, so the implementation stays
there as `normaliseObjective` and `policy.ts` re-exports it under the public name.

⚠️ **Row 11 stopped short of the §1.1 target.** `scheduler.ts` is 3,780 lines, not ~1,500. The five
seams are real moves with no re-export shims, but each new module imports back from `scheduler.ts`,
so the cycles are load-bearing: `14f7155` fixed a module-eval TDZ read of `QUOTA_HIGH_WATER` that
this shape introduced. ⛔ Nothing in these modules may read a scheduler binding at module-eval time.

⚠️ **1–6 are worth doing whatever happens to 7–11.** They are self-contained, and every one of them
makes the file it touches cheaper to change before anything larger is attempted in it.
