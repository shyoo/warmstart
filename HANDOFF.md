# Multi Agent Controller — Session Handoff

Multi-agent controller: a scheduler that routes coding-agent tasks to the worker, session and moment
where they are cheapest. Electron shell + `orchestratord` daemon. Windows now; macOS/Linux built and
started in CI, never run against a real agent CLI.

**This file is current state + what to do next. It is not a changelog.** Keep it **under 200 lines** —
if you add a line, find the one it obsoletes and cut it in the same edit. Finished work moves to
`transient_docs/changes_history.md`; a *rule* to `AGENTS.md`; a durable *fact* to `docs/`.

**Baseline (2026-09-01, measured):** typecheck · build clean · `npm test` 1281/1283 (2 POSIX-only
skipped) · `test:daemon` 145/145 · `test:ui` 213/213 · `test:pack` 18/18 · L4 landed a real agent
commit on origin/main. Electron 44.0.0, electron-builder 26.15.3. ⛔ **`npm run lint` is red** — 3
errors in `sessions.ts` (2 unsafe `JSON.parse` assignments, 1 empty `catch`), all from `652be27`.
CLIs here: claude 2.1.252 · agy 1.1.22 · codex 0.151.0 · local-llm 1.0.0 (qwen3-coder live tested).
⚠️ With none installed — the CI state — the daemon suite skips 5 checks, each with a stated reason.

⭐ **`scripts/build-win.ps1` runs all of the above** (`-Help` for options, `-Restart` for the inner loop);
content-addressed, **92s cold, ~0s warm**. ⛔ **One packaged app — `release\win-unpacked\`**, so running
the repo's copy while building blocks the pack step, correctly.

---

## Where the build is

**M0–M6 are all shipped.** M0 scaffold · M1 fleet substrate and commissioning · M2 tasks, threads,
resources, authorship · M3 cost intelligence · M4 controller agent · M5 multi-provider
(`antigravity-cli`, `openai-compatible`) · M6 packaging. ⚠️ Shipped is not the same as proven — the
gaps are below. Scope: `transient_docs/implementation_plan_2026-08-24.md` §14, amended by **A1/A2/A3**.
⛔ What each milestone *measured* is in `transient_docs/changes_history.md`; read it before re-deriving.

## What exists

```
src/daemon/            orchestratord. Runs as Electron-with-ELECTRON_RUN_AS_NODE, detached.
  index.ts             entry: lock, db, server, poller, scheduler, tailer wiring, shutdown
  server.ts  api.ts    HTTP+WS on 127.0.0.1:<random>, bearer token, typed RPC
  db.ts                node:sqlite + numbered migrations (v31). ⛔ Every one must survive being
                       replayed: `versionBefore` rewinds and reruns everything after it
  costmodel.ts         the four questions; user dir > bundled > compiled-in
  workers.ts           registry, isolation roots, retire-keeps-credentials, display order only
                       (+ workerorder.test.ts)
  quota.ts             the staleness ladder + the self-pacing poller: active/idle cadence, a parked
                       task's own release time, the urgent queue (+ quotaprobing/quotacycle tests)
  sessions.ts          pty and stream; reaping; resuming a closed conversation (+ resume.test.ts).
                       ⛔ `state` is the *process*: `closed` asked · `abandoned` unwatched · `failed`
                       alone (+ sessionstate.test.ts)
  transcript.ts        metering: iterations[], TTL split, cache clock  (+ .test.ts)
  tasks.ts             DAG, admission, mandates, budgets, runs           (+ tasks.test.ts)
  cancel.ts            wind-down into a resting state; delete is separate and human-only
  attachments.ts       the only writer of attachment bytes: sniff, bind, prune (+ .test.ts)
  approvals.ts         policy engine, escalation clock, remembered rules
  scheduler.ts         scoring, dispatch, watchdogs, continueTask (+ routing.test.ts,
                       runfailure.test.ts - who is blamed when a run does not succeed;
                       preemption.test.ts - wrapping a run up once, and the switches that gate it;
                       poolgate.test.ts - ⛔ a busy resource holds a task, it never fails one)
  eligibility.ts       ⛔ the account gates, in ONE list. Work and judgment both read it; they
                       each kept their own until 2026-08-27 and the copies drifted
  activetime.ts        how long an agent actually worked - runs summed, minus every stretch spent
                       waiting on a person. ⛔ Never wall-clock (+ .test.ts)
  activity.ts          the live peephole: a bounded in-memory tail of what a run is saying.
                       ⚠️ Rendered *inside* the task thread now, not in a pane below it
  landing.ts           auto-land, serialised by an exclusive land: resource (+ landing.test.ts)
  conversations.ts     which **runs** a conversation served, in order, under their task; never
                       stored. `conversationOutcome` is the *work*, not `state` (+ .test.ts)
  sharing.ts           who may borrow whose conversation: same project, account, model, effort;
                       three tiers, off by default (+ .test.ts). docs/sessions.md is the spec
  finish.ts            what finishing means: one policy, resolved task > project > fleet, the
                       decision that follows, and the loose-ends scan (+ .test.ts). ⛔ The tool
                       never writes a commit. docs/landing.md is the spec (+ conflict.test.ts)
  log.ts               a file per day, a ring buffer for a UI that just opened, every level
                       broadcast (+ .test.ts)
  cacheclock.ts        the six moves - what the whole cost model exists for. A move is a request;
                       moveOutcome() is what stops it being re-asked (+ .test.ts)
  compaction.ts        the compaction ledger. ⛔ Records the *ask*, so one that never landed shows
  lifecycle.ts         how the daemon is asked to stop itself. ⛔ Asked, never killed by pid
  settings.ts          the fleet defaults: autoCompact, autoPreempt, autoOverrunPreempt,
                       autoRunawayStop, probe intervals (active + idle), finishPolicy, sessionSharing
  reserve.ts           the compaction reserve, and every belief with its basis attached
  objective.ts         the weight vector + every weight’s published formula (+ cost.test.ts)
  controller.ts        the consult queue, the caps, and choosing who answers (+ controller.test.ts,
                       controllerchoice.test.ts - who may be asked, and who may not)
  judgment.ts          the five events: question, closed answer set, fallback (+ judgment.test.ts)
  chat.ts              the one place the controller gets tools - a person is watching
  estimator.ts         what a task will cost **on a named agent**, from what tasks have cost
                       (+ estimator.test.ts) - one median for six agents was 81x wrong
  stream.ts            stream-json records: the free live rate-limit signal
  projects.ts          .multi_agent_controller/project.json; policy committed, state private
  resources.ts         the broker - if the scheduler owns the claim, the lock is unnecessary
  worktrees.ts         pooled worktrees, task-named branches, prepare hook. ⛔ A slot does not
                       arrive clean; rescueDirt commits what the last run left onto its branch, and
                       taskBranches reads the ones nothing has checked out (+ .test.ts)
  which.ts             PATH resolution - node-pty does not do it
  adapters/            claude-code - antigravity-cli - openai-compatible - local-llm; capabilities as data
                       (+ adapters.test.ts). Read docs/adapters.md before changing one
    external.ts        declarative adapters from <dataDir>/adapters/*.json  (+ external.test.ts)
    generic.ts         the driver behind one. ⛔ JSON only, never JavaScript
src/mcp/               the MCP server the agent CLI spawns. Two tiers chosen by the daemon: worker
                       (task_complete, task_create, ask_human, handoff) and controller
                       (fleet/task/approval/estimate). ⛔ Neither can delete anything.
src/main/              window host + the daemon's only client (holds the token); the tray, and
                       `uisettings.ts` - preferences main must read when the daemon is not answering
src/renderer/          fleet strip, approvals bar, tasks, project settings (policy tier), workers,
                       Logs, LooseEnds, Conversations (+ lib/format.test.ts)
costmodels/            anthropic.* - google.antigravity.* - openai.codex.* - local.llm.*; compiled in, so a
                       packaging slip cannot leave the scheduler unable to price
docs/                  cost-model.md, glossary.md, adapters.md, landing.md, sessions.md, routing.md
.claude/skills/commit/ /commit: docs, suites, package, commit, push
```

## What is true right now and not yet proven

- ⭐ **All three providers have a free quota probe** (**R3 closed**). ⚠️ Free of tokens, not of *sessions*: each `/usage` refresh opens a PTY that registers with the vendor's bridge — 150 against 14 real work sessions in four days. ⛔ Those already registered are account-side; only the operator can archive them. ⭐ **There is no refresh clock any more** (2026-08-31, `transient_docs/quota_staleness_2026-08-31.md`): `ensureFreshQuota()` refreshes **at the dispatch gate and when a run ends**, backing off on the **attempt** rather than the reading's age — age-keyed retry said *yes* forever on the one worker that could not answer, starving every worker behind it. ⚠️ The UI prints `read 2h ago`, never the word `stale`; warning colour is reserved for *every check since has failed*. ⚠️ Not yet run in flight.
- ⭐ **And the fleet now says *when* it needs one** (2026-08-31, t70/t71, `docs/cost-model.md`). t70 was preempted at the top of its 5h window while the card read **63%**: the trigger was a live `rate_limit_event`, the card was the last thing the vendor happened to write, and nothing reconciled them. The poller no longer runs on one interval — it asks `probeDemand()` what the fleet is doing, computes its own delay, and asks `refreshNow()` (**the same ledger** `ensureFreshQuota` uses, so never two terminals on one account) in the three cases where something *is* about to act on the number: a **run in flight** (at the operator's own cadence — the only window that moves), a **parked task 30s past its reset**, and a **live rate-limit warning or quota preemption** (`requestUrgentProbe`). ⛔ And `not_before` was the **only** release test, so a task parked `now+5h` by the overrun path's fallback stayed parked with a hand-probed **0%** on the account — `quotaReleaseFor` is the second, held to the dispatch gate's own standard. ⛔ `QuotaWindow.group` was **dropped on the way into the store** (**migration 26**), so the per-pool gate had been falling back to the busiest pool for every reader that goes through `quota_samples` — i.e. every gate. ⚠️ Idle probing is its own setting (`idleProbeIntervalMinutes`, 20m). ⚠️ **None of it has run in flight**; 52 unit checks cover it.
- ⭐ **A reading is announced where it is *stored*** (2026-09-01, t86). All 4 callers that write one now emit `quota.changed` through `storeAndPublish` — the gate and run-end used to write in silence, which are the two moments somebody is watching — and `quotaFreshness` recomputes age against a ticking clock instead of the value stamped at send time. ⛔ The 3h reading that started it was **not** a fault: an idle account keeps its reading by design. ⚠️ Not yet seen in flight.
- ⭐ **A stopped run's work now travels on its branch, and a claimed finish is checked against the repository** (2026-09-01, t91/t92/t23/t79, `docs/landing.md`). ⛔ Four holes, one shape — *nothing looked past the workspace*. (a) `rescueDirt` stashed what an interrupted run had not committed; a stash belongs to a **repository**, so the next run checked out an empty branch and started over — t92 spent **13.3M tokens** re-deriving work that was in `stash@{0}`. It now **commits onto the branch** (`Multi-Agent-Controller-Rescue` trailer), stashing only on a detached HEAD, and the resumed run is told. (b) Such a tip is a rescue, not a result, and is condition **6** of the landing bar. (c) *Nothing to land* read a clean tree + a branch level with the trunk as *the task answered a question* — byte-for-byte what a preempted run leaves — so it now asks `git stash list`, filtered by git's own `On <branch>:`. (d) The loose-ends scan read **workspaces**, and a finished task's branch is checked out nowhere: `t23` and `t79` sat here for days carrying zero commits, unreported. It now enumerates `refs/heads/` per project, shows a **branch left behind** row with **Retire it** (`looseend.retire`, which re-derives the proof itself), and a task cancelled to `cancelled` gives an empty branch back. ⚠️ 36 new checks; **none of it has run in flight**.
- ⭐ **A vendor caution no longer ends a run, and elevated baseline + warning preempts** (2026-08-31, t71/t75). `lastRateLimit` returned the newest sample of **any** window, so a `seven_day` advisory landing 12s after a healthy `five_hour` reading preempted three runs at 5h **17% · 0% · 19%** and parked the task until **2026-09-07**. Now `rejected` stops a run alone; `allowed_warning` needs this fleet's own reading of *that* window to agree (≥50%, `QUOTA_RISK_FLOOR`); `runWatchdogs` falls back to `run.quotaBefore` when mid-run staleness elapses; `resumeAt` comes from the sample that decided; an expired sample is forgotten; and a later advisory cannot mask an earlier refusal. ⚠️ Neither has been re-run in flight.
- ⭐ **`/compact` had never once run, and now says so either way** (2026-08-31). `autoCompact` was on from 07:48Z with the newest `clock_events` row dated 2026-08-27, because `expectedIdleMs` returns exactly 2h whenever anything is in flight while the balanced threshold is 2.02h — move 4 was unreachable on any fleet that was doing anything. That placeholder is flagged `confident: false` and no longer buys a keepalive on a large context. ⛔ **Migration 24** `compactions` records the **ask** as well as the outcome, so one that never landed is visible; the thread posts a system message and the task pane draws before → after. ⭐ **And it now compacts a conversation the clock structurally could not see — before its prefix lapses** (2026-09-01, t93, `docs/cost-model.md` §4). Every clock move is a prompt and a prompt needs a process, so `runCacheClock` iterated `live`/`idle` only — which excludes exactly the conversation that sits still for hours: one **between runs**. t92's run 2 was preempted at 21:35, the process exited, and session `59eda2c6` sat closed for **2h05m** with **no `clock_events` row at all**; run 3 revived it at 23:40 into **84,254** tokens of context carrying **345,708** since its last compaction and read **15.7M** cache tokens in twenty minutes. ⛔ **A compaction is not one price**: while the prefix is warm it reads a cache (**0.1·C**); once it has lapsed the same compaction rebuilds the prefix first (**~1.25·C**) — and a task parked on a 5h window comes back long after the 1h TTL has gone, so compacting only at resume buys the expensive one every time. **Move 7 `revive_compact`** is a second pass over `warmClosedConversations()`: at **T+45m** of the TTL (never below 5m left, which is a ~30s spawn plus a compaction measured at 110·115·139·161s) it starts a process on the conversation, sends `/compact` and closes it again on the boundary. ⛔ Only for a task **parked on a clock** (`paused_quota`/`scheduled`, `not_before` beyond the compaction window) — that one test proves the conversation has a future, proves the spend is not speculative, and removes the race where the scheduler dispatches into it mid-compaction; a `ready` task is left to the dispatcher. ⛔ Put back down always — a live work session with no run and no workspace claim is a state nothing else expects. ⚠️ `compactOnResume()` stays as the **last resort** (daemon down, prefix already lapsed, no clock on the task); the two cannot both fire, because a landed compaction zeroes `tokensSinceCompact`. ⚠️ `post_tokens` is null for move 7 by construction. ⚠️ 41 new checks (`revivecompact.test.ts`); **neither has run in flight**.
- ⭐ **A held task now says *when*, and a person may overrule the 92% gate** (2026-09-01, t71). Two faults from one discarded number. ⛔ t71 was **pinned** — `constraints.workerId`, set by hand — so nothing routed it to a full account; `chooseTarget` skips every other worker on its first line. But the gate that held it wrote *"ClaudeThird at 92% of its Claude 5h window"* and threw away the `resets_at` **2h29m** behind it, so (a) the operator could not tell a five-minute wait from a five-hour one, and (b) `expectedIdleMs` read `ready` as *dispatchable* and answered "work queued now" — the one answer that suppresses cache-clock moves 2/3/4 on **every live session**, for the whole window. **Migration 25**: `hold_until` (descriptive only, deliberately *not* `not_before`, which `admit()` reads) and `quota_override_until`. ⛔ The override lifts the dispatch cliff and the matching 95% mid-run preempt and **nothing else** — not a disabled account, not capacity, not the window boundary, and never a vendor `rejected`; nor does it touch `windowRisk`, so an overridden account still scores last. ⚠️ Neither has run in flight.
- ⭐ **The reserve reads the percentage when it cannot read tokens** (2026-08-31, t73). `remainingTokens` needs a `tokens_per_percent` calibration and the `calibration` table has **zero rows**, so `reserveState` answered `unknown` for every worker holding a session and move 5 — *reserve at risk, compact now regardless* — had **never fired**. Measured: 17:31, a run routed to ClaudeThird and held at the 92% dispatch gate, while `ef5e90dc` sat on that account since 10:38 with **401,341** context tokens and 1.4M since its last compaction, and no `/compact` was ever sent. `windowPressure()` now makes the **same reading that refuses the dispatch** call the reserve `at_risk`, per pool, refusing a stale or already-reset window exactly as the gate does. ⛔ `remainingTokens` stays null: a percentage is not promoted to a token count. ⛔ Move 5 now also requires `worthCompactingNow`, because a full window stays full for hours and the old condition would have re-sent `/compact` every four minutes. ⚠️ **R2 still open** for the token rung; ⚠️ not yet run in flight.
- ⭐ Quota is a routing input: `windowRisk` slopes to the 92% gate — now the shared `WINDOW_HIGH_WATER`, read by the gate, the pool balance and the reserve — and every score prints its derivation.
- ⚠️ **Never exercised end to end: the tray *icon* and keepalive firing** (each one's arithmetic is unit-tested). ⭐ *A compaction landing no longer belongs on that list*: the ledger holds **two** clock-issued compactions from 2026-09-01 that landed, at **214,298** and **232,088** pre-tokens in **110s** and **115s** — the first end-to-end proof that `/compact` is honoured on the `stream` transport. ⚠️ Both sessions closed before a turn could measure the result, so `post_tokens` is null on both.
- ⭐ **The board can be read at a glance, without shortening a single instruction** (2026-09-01, t92, `docs/glossary.md` › *Title, and title summary*). ⛔ A task's `title` **is its prompt** — `promptFor()` sends it verbatim and the New Task form files the whole textarea into it — so the lists, headers and chips that draw a title were drawing paragraphs, and nothing could truncate them without truncating an instruction. **Migration 29** adds `title_summary`, written by the controller and read by nothing but the UI, which renders `titleSummary ?? title`; the task thread's first entry is still the full prompt, verbatim. Free on the four judgment calls the scheduler already makes (each answer may carry a `summary`, discarded on its own if unusable — it can never fail the decision it rode in on), and a fifth **`title`** consult covers everything else: the only judgment call that spends a turn without changing what runs, so it is **off by default** (`summariseTitles`), files **one question per tick**, and has a 24-hour cooldown so a task the controller declined to label is not re-asked forever. ⚠️ Editing a title **drops** its summary rather than re-deriving it. ⚠️ Covered by `titlesummary.test.ts` (7), `judgment.test.ts` (+12) and `taskview.test.ts` (+4); **no controller has answered one in flight**, so what a real summary reads like is unmeasured.
- ⭐ **Every intervention on a live session has an off switch** — Settings > Global: `autoCompact`/`autoPreempt` **on**, `autoRunawayStop` **off**, `summariseTitles` **off**, `probeIntervalMinutes` 5m.
- ⭐ **A full workspace pool holds a task rather than failing it** (2026-08-29). ⛔ No dependency edge: a hold is re-decided every tick, so priority wins. ⚠️ A fleet wider than its pool is *named*, never silently grown.
- ⭐ **The stall watchdog tells stuck from slow, and has fired in flight** (2026-08-30): 13m into a hung codex run it posted the process tree and 0.0s of CPU gained in 70s. ⛔ It reports and never kills.
- ⭐ **A question shows on the task, and a stale branch has a way back** (2026-08-30, t59). `askQuestion` never changed the status, so a task waiting seven minutes on a person read `running`; it now rests at `awaiting_human` and is put back when the answer is taken. ⛔ And `readMergeability` asked about `origin/<target>` while `merge-local` rebases onto the **local** one — on the default policy the pre-flight check answered about a different ref, so conflicts were found inside `landTask`, two branches past the `resolve-conflict` verdict built to hand them back. Both bases now come from `landingBaseFor`. A **Resolve & retry** button sends a conflicted branch back to an agent. ⚠️ None of the three has run in flight.
- ⭐ **A task asked to finish can no longer hang on an answer that never comes** (2026-08-30). `ask-agent` leaves the run open and bet the agent would report again; nothing checked. t58 obeyed in 17s, never reported, and sat `running` for 50m holding ws3. `runWatchdogs` now re-runs `decideFinish` against the tree once the session has been silent past `finishReplyOverdue`. ⚠️ Fired in flight **once, by hand** on t58; the automatic path is unproven.
- ⭐ **Finishing is a ladder, and the default no longer pushes** (2026-08-30, `docs/landing.md`): `await-human` · `commit-only` · `commit-and-verify` · **`commit-and-merge`** · `commit-and-push`, plus `pull-request` and `custom`. The old default pushed on every completed task, and every push starts a ten-job CI matrix — 103 runs in five days, allowance exhausted 2026-08-29. ⛔ The tool never writes a commit, never destroys work it will not land, and never merges into a trunk somebody is working in. ⚠️ `commit-and-merge` has **never run in flight**, nor has the conflict ask. ⭐ `runChecks` runs `check` in the **daemon**, outside any worker sandbox — and the one-shot prompt now says so.
- ⭐ **An agent can ask a person a real question, and be answered** (2026-08-30; `docs/glossary.md`). The **Question** object replaces `request_human`, which went through the approval path and could only answer allow/deny. Four ways in: `ask_human`, Claude Code's own `AskUserQuestion` intercepted at `approve` (measured, R14), `checkpoint`, and — on an adapter with **no MCP and therefore no `ask_human`** — the `NEEDS DECISION:` line its prompt asks it to end with, plus one `- option — detail` bullet per choice. ⛔ That line was matched, quoted into `hold_reason` and **thrown away**, so antigravity and codex could ask questions that were structurally unanswerable (t63, 2026-08-30: three named designs, no reply channel). It now files a real question, born **parked** — the turn is over, so there is no waiter — and answering a parked question **re-queues the task**, which nothing did before. Unanswered **parks**; a run that stopped to ask is `blocked`, not `failed`. ⚠️ **Only Claude has used any of it in flight**; the MCP-less path is unproven, and t63 itself predates it. ⚠️ The thread card has **no rendering test**; seeding one needs a live run. ⚠️ **R15**: can an MCP client hold a tool call for minutes?
- ⭐ **"Took" is agent time, not wall-clock** (2026-09-01, `docs/cost-model.md` §10). It was `lastRunEnded - firstRun` — the span a task *existed inside* — so it counted queueing, quota parks and every minute a question sat waiting: `ask_human` holds its tool call open until somebody answers, and a task whose agent worked 4m and whose question was answered next morning read **fifteen hours**. That was the number behind every per-agent and per-model duration. `activetime.ts` sums runs and subtracts the stretches an open question or escalated approval covers, **derived** from those rows so a late answer corrects it; dispatch, routing and CLI start-up count as work, and the wall-clock span still shows beside it. ⚠️ **Nothing routes or estimates on it yet** — the instrument had to exist first. ⚠️ Blind to a wait that never became a row (a vendor rate limit mid-turn), so it is an upper bound.
- ⭐ **An image can be pasted into a task, and reaches each CLI by the channel it actually has** (2026-09-01, `docs/glossary.md` › *Attachment*, *Image input*). ⛔ t65 shipped a **survey and plan only** (`445ac52`), which read as a feature to anybody who remembered the task and not the diff — there was no `onPaste` in `src/` at all. `multimodalInput: true` was declared on all three built-ins, read by nothing, and wrong about one: agy does not ignore an image block, it **fails the whole turn** on one (`num_turns: 0`, measured 2026-08-31), which an operator would read as the agent failing. It is now `imageInput: 'inline' | 'spawn-flag' | 'none'` — Claude takes a base64 block in the envelope it is already sent, codex takes `-i <file>` at spawn (**initial prompt only**; it has no stdin conversation), agy takes none — gated once in `sendPrompt`, not per encoder. **Migration 31** `attachments` holds metadata with the bytes on disk; `promptFor` returns `{ text, attachments }` and the images that travel are those of the messages that travel; `spawnSession` moved **below** it, because a `spawn-flag` adapter needs the file list before its process exists. ⛔ The **absolute path is in the prompt on every adapter** — all three read a PNG off disk, and on agy that is the only channel. The renderer downscales to 1568px and uploads one image per call, so `MAX_BODY_BYTES` stays 4 MB. ⚠️ 41 new checks; ⚠️ **no image has reached a real dispatched run** (R16), and question answers stay out of scope until R16b is measured.
- ⭐ **The daemon's log is readable from inside the app** (Settings > Logs): live, filterable, ring-buffered so a late window still sees the past; a file per day, kept a fortnight.
- ⭐ **The middle tier is settable at last** (2026-08-31, t68). Finish policy, session sharing and completion mode all resolve **task → project → fleet**, and the *project* rung of all three could only be reached by hand-editing committed JSON — the task pane offered `inherit (…)` against a tier with no writer. `project.setPolicy` patches the same keys `project.json` already uses, with landing target and workspace pool size beside them, and the project's **Settings** tab now reads Project settings → Policy → Verification → this project's own resources. ⛔ It **patches**: keys it was not asked about, including ones from a newer version, survive, and it refuses rather than overwrites a file that will not parse (`projectpolicy.test.ts`; `ui.test.mjs` +7). ⚠️ The check-command textarea had borrowed `.ask-input`, whose whole design is to be invisible.
- ⭐ **A person can say one task waits for another** (2026-09-01, `docs/glossary.md` › *Prerequisite*). `task_deps`, the cycle check and `admit()` shipped in M2 and only an agent calling `task_create` with `depends_on` could reach them — filing "do X after Y" by hand meant leaving X a draft and remembering. The New Task form takes prerequisites at filing (born `blocked`: `createTask` writes the edges before it admits) and the ledger adds or drops them afterwards through `task.addDependency` / `task.removeDependency`, which **re-run admission on the same call** — the gap between recording an edge and deriving `blocked` is a window the scheduler dispatches in — and return the redrawn list beside the task. ⛔ A **running** task is not clawed back; the edge applies to its next dispatch and the thread says so. ⚠️ Covered by `dependents.test.ts`, `manualdeps.test.ts` (the RPC pair and its result shape) and 6 `ui.test.mjs` checks that drive the ledger end to end; nothing here changes what dispatches.
- ⭐ **Model and effort are choosable, inherited and visible** (2026-08-29): **task → worker → the CLI's own default**, via `resolveModelChoice`. Multi-pool workers set a default per pool and the scheduler balances on quota. ⚠️ **`selectableEffort` is true for `claude-code` only**.
- ⛔ **Codex could never have completed a task, five bugs deep** (fixed 2026-08-30, `docs/adapters.md`): stdin held open against a CLI reading to EOF, `mcp: true` on an adapter that cannot register one, `turn.completed` without its terminal half — then, on t56, the landing. `landing.finishInstruction` was read with no policy check, so a `commit-and-merge` project sent codex *"Run /commit … Do not push"* — a Claude-only skill whose sixth step **is** the forbidden push; and `stall.test.ts` asserted a **host capability**, the WMI query codex's sandbox denies, so the suite went red in the worker and green on the host and the agent read that as its own regression. ⛔ And in a worktree it could not commit **at all**: `--sandbox workspace-write` forbids the trunk's `.git`, where a worktree keeps its index, objects and ref — three t56 runs, ~1.8M tokens, 30d quota 0%→34%, every commit refused at `index.lock`. `plan()` now passes `--add-dir` for each. ⚠️ **No codex task has completed yet**; t56 is the re-run that settles it, and the `--add-dir` grant is argv-proven and **unproven against a live sandbox**.
- ⭐ **Antigravity runs, reports its quota, and resumes a conversation by id** (**R9**, measured 2026-08-28). ⚠️ It meters differently: one aggregate usage record per run, `cache_write` always 0, and cache reads that dwarf everything else — 12.5M in a median run (2026-08-30).
- ⭐ **The estimator answers per agent and model, not one number for the fleet** (2026-08-30, `docs/cost-model.md` §10). `size(task) × factor(adapter, model)`, keyed off `runs.adapter_id`/`runs.model` (**migration 23**), warmth divided out. One fleet median was **81x** wrong across two agents. ⛔ **Routing was left alone deliberately**: zero of 54 tasks has run on two keys, so nothing yet separates *expensive agent* from *agent that gets the big tasks*. Factors feed estimates and gates only.
- ⛔ **Nothing is proven off Windows.** CI runners carry no agent CLI, and CI is red (above). ⛔ **Unsigned**: a certificate and an Apple Developer account, not a config line.

## Next

M0–M6 are done. What is left is not a milestone but a list, in the order it would pay off:

1. **Run the suites on macOS or Linux with an agent CLI installed** — the largest unmeasured surface.
2. **R2 (`tokens_per_percent`)** — now only the reserve's *token* rung needs it; routing and the reserve's high-water rung read percentages directly.
3. **Signing and notarisation**, without which the installers warn or refuse.
4. **Reuse across tasks — built end to end, unproven in flight** (2026-09-01, `docs/sessions.md`).
   Borrowing now also **revives another task's *finished* conversation** by `--resume` — the case
   that fires on a real fleet: completing a task closes its session and each new one rebuilt ~41.5k
   tokens. Gated on **same project, account, model, effort**. ⛔ The borrower is told whose context
   it is; the lender's thread is told by name.
   ⭐ Clock **move 5b** compacts a conversation past **70%** a queued task was refused. ⚠️ Sharing
   stays **off at every tier** (operator, 2026-09-01): nothing has run in flight, 60% never fired,
   and **no conversation has served two tasks** — Conversations' `Shared` chip is empty by
   construction, and runs-per-conversation (nine) is what varies today.
5. **The trunk tripwire is built and has never fired.** An empty branch under a moved trunk goes to
   `awaiting_human` naming the commits (`decideFinish`'s `trunk-moved`). ⚠️ Provoking it means
   reintroducing the bug `--add-dir` fixed.
6. **`antigravity-cli` still has no real isolation root.** `envFor()` sets no `HOME`, so all four
   workers share the operator's `~/.gemini`. Per-worker `HOME` is the fix; the credential is in the
   OS keyring so sign-in *should* survive, and "should" is doing the work there.
7. **Thread and Cost have no automated coverage.** `ui.test.mjs` drives a project's **Settings**, **Conversations** and **Session TUI**; those two are by hand.
8. **Put human-in-the-loop and `commit-and-merge` in front of a real agent.** Both built, neither
   used by one: dispatch a design task, answer what it asks, watch it merge — what L1–L3 cannot prove.
9. **Meter codex off its rollout** — R10 is answered (§5), but `metering` stays `'stream'`, so a PTY-hosted codex run is unmetered, and the estimator never sees it.
10. **Compute `overrunFactor` in cost, not raw tokens**, and let preempted runs feed `estimateTask`.
   ⚠️ 92–98% of a run's tokens are cache reads, so it fires on long work — why `autoRunawayStop` ships off.

## Open questions

- **Auto-mode classifier cost on a subscription** (`docs/cost-model.md` §9). Billable on Enterprise and
  API-billed accounts, unstated for Pro/Max/Team, and Claude workers default to `auto`. ⛔ Do not assume it is free — **R1** measures it.
- **Vertex / Antigravity cache pricing.** Both declare `cache.kind: "unpriced"`; needs a published figure, not an experiment. ⚠️ agy reports `cache_read_tokens: 0` on every turn (measured 2026-08-28), so there may be nothing to price.
- **`expected idle` estimator** (plan §8.6). Not designable without real queue data.

## Measurement runs owed
Each is cheap and needs a **quiet worker** - one session, nothing else on that account. Record the result in `docs/cost-model.md` with the
date and CLI version, then delete the row. **The instrument:** a run records a quota reading either side of itself and transcript metering
beside it; the difference is what the CLI spent that never reached a transcript.

| # | Question | Method | What it changes |
|---|---|---|---|
| **R1** | Does the auto-mode classifier bill on a subscription? | ⭐ A run now records the window either side of itself, so the task pane shows (quota delta − transcript tokens). Run one shell-heavy task twice on a quiet worker, `auto` then `default` | If it bills, `auto` stops being a free default and the objective vector has to price it. §9 |
| **R2** | `tokens_per_percent` per (worker, model, tokenizer) | With exactly one session live, sample `/usage` by hand at intervals and diff against transcript tokens over the same span | Turns percent into tokens, which is what every gate actually needs. Plan §8.5 |
| **R4** | Real compaction cost end to end | Compact a session of known size; diff transcript tokens across the `compact_boundary` and record `durationMs` | Five samples (139k · 116k · **161k** · 110k · 115k ms), the last two from this fleet's own ledger. The spread matters more than the mean for the T+53m deadline. ⚠️ `post_tokens` is still null on every one of them |
| **R8** | Does a real model answer a consult in the shape the validators accept? | Designate a controller, file a `plan` task, run `controller.drain`, read the row: `answered` or `fallback`, and the `fallbackReason` | The one M4 path L1 cannot reach |

R1 changes the cache clock. **Closed:** R7 (2026-08-31 — it *does* warn first, but not about the number the fleet strip shows, §5) · R10/R11 (08-29) · R12 (08-30) · **R6** (08-31 — the `compactions` ledger records the ask, so a row that stays `never landed` **is** the negative result). ⚠️ **R5 dropped**: resuming is measured and shipped within an account; its transplant needs a second subscription.

## Standing decisions worth not relitigating

⛔ The invariants live in `AGENTS.md`; these are the ones most re-argued by somebody who has not read it:

- **Daemon, not all-in-Electron.** The premise is unattended progress across quota windows.
- **Deterministic scheduler; LLM on judgment events only.** A loop running every 10s for weeks must not bill anything, and the fleet survives with no controller at all.
- **PTY-hosted CLI, transcript for state.** We own stdin, so `/compact` is a function call. ⚠️ ANSI parsing determines state in exactly one declared place - a quota reading. Never a session's state.
- **Capabilities and objectives are data.** No `if (adapter === …)`, no `if (mode === …)`.
