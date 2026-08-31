# Multi Agent Controller — Session Handoff

Multi-agent controller: a scheduler that routes coding-agent tasks to the worker, session and moment
where they are cheapest. Electron shell + `orchestratord` daemon. Windows now; macOS/Linux built and
started in CI, never run against a real agent CLI.

**This file is current state + what to do next. It is not a changelog.** Keep it **under 200 lines** —
if you add a line, find the one it obsoletes and cut it in the same edit. Finished work moves to
`transient_docs/changes_history.md`; a *rule* to `AGENTS.md`; a durable *fact* to `docs/`.

**Baseline (2026-08-31, measured):** typecheck · lint · build clean · `npm test` 897/899 (2 POSIX-only
skipped) · `test:daemon` 141/141 · `test:ui` 171/171 · `test:pack` 18/18 · L4 (opt-in) landed a real
agent commit on origin/main. Electron 44.0.0, electron-builder 26.15.3, 0 npm vulnerabilities.
CLIs here: claude 2.1.251 · agy 1.1.22 · codex 0.151.0.

⭐ **`scripts/build-win.ps1` runs all of the above** (`-Help` for options, `-Restart` for the inner loop);
content-addressed, **92s cold, ~0s warm**. ⛔ **One packaged app — `release\win-unpacked\`**, so running
the repo's copy while building blocks the pack step, correctly.

⚠️ **With no agent CLI the daemon suite skips 5 checks**, each with a stated reason — the CI state;
simulate it with a PATH of System32, node and git and an empty `HOME`. ⛔ **CI has not been green since
2026-08-29T04:41Z**: 61 consecutive non-success runs (measured 2026-08-30), the recent ones dead in 2–5s
on GitHub billing — **nothing is verified off Windows.** ⚠️ The macOS-only-on-dispatch matrix trim in
`ci.yml` is therefore **still unproven**: a wrong `fromJSON` ternary yields *no* matrix jobs, which reads
as passing. One run that actually executes settles it.

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
  db.ts                node:sqlite + numbered migrations (v22)
  costmodel.ts         the four questions; user dir > bundled > compiled-in
  workers.ts           registry, isolation roots, retire-keeps-credentials, the fleet's display
                       order - ⛔ display only (+ workerorder.test.ts)
  quota.ts             the staleness ladder - read this before trusting a percentage
  sessions.ts          two transports: pty (node-pty) and stream (real pipes); orphan reaping;
                       resuming a conversation a closed session left behind  (+ resume.test.ts)
  transcript.ts        metering: iterations[], TTL split, cache clock  (+ .test.ts)
  tasks.ts             DAG, admission, mandates, budgets, runs           (+ tasks.test.ts)
  cancel.ts            wind-down into a resting state; delete is separate and human-only
  approvals.ts         policy engine, escalation clock, remembered rules
  scheduler.ts         scoring, dispatch, watchdogs, continueTask (+ routing.test.ts,
                       runfailure.test.ts - who is blamed when a run does not succeed;
                       preemption.test.ts - wrapping a run up once, and the switches that gate it;
                       poolgate.test.ts - ⛔ a busy resource holds a task, it never fails one)
  eligibility.ts       ⛔ the account gates, in ONE list. Work and judgment both read it; they
                       each kept their own until 2026-08-27 and the copies drifted
  activity.ts          the live peephole: a bounded in-memory tail of what a run is saying.
                       ⚠️ Rendered *inside* the task thread now, not in a pane below it
  landing.ts           auto-land, serialised by an exclusive land: resource (+ landing.test.ts)
  conversations.ts     which conversation served which tasks - a join, never stored (+ .test.ts)
  sharing.ts           who may borrow whose conversation: three tiers, mechanical gates, off by
                       default (+ .test.ts). docs/sessions.md is the spec for both
  finish.ts            what finishing means: one policy, resolved task > project > fleet, the
                       decision that follows, and the loose-ends scan (+ .test.ts). ⛔ The tool
                       never writes a commit. docs/landing.md is the spec (+ conflict.test.ts)
  log.ts               a file per day, a ring buffer for a UI that just opened, every level
                       broadcast (+ .test.ts)
  cacheclock.ts        the six moves - what the whole cost model exists for. A move is a request;
                       moveOutcome() is what stops it being re-asked (+ .test.ts)
  lifecycle.ts         how the daemon is asked to stop itself. ⛔ Asked, never killed by pid
  settings.ts          the fleet defaults: autoCompact, autoPreempt, autoOverrunPreempt,
                       autoRunawayStop, probeIntervalMinutes, finishPolicy, sessionSharing
  reserve.ts           the compaction reserve, and every belief with its basis attached
  objective.ts         the weight vector + every weight’s published formula (+ cost.test.ts)
  controller.ts        the consult queue, the caps, and choosing who answers (+ controller.test.ts,
                       controllerchoice.test.ts - who may be asked, and who may not)
  judgment.ts          the four events: question, closed answer set, fallback (+ judgment.test.ts)
  chat.ts              the one place the controller gets tools - a person is watching
  estimator.ts         what a task will cost **on a named agent**, from what tasks have cost
                       (+ estimator.test.ts) - one median for six agents was 81x wrong
  stream.ts            stream-json records: the free live rate-limit signal
  projects.ts          .multi_agent_controller/project.json; policy committed, state private
  resources.ts         the broker - if the scheduler owns the claim, the lock is unnecessary
  worktrees.ts         pooled worktrees, task-named branches, prepare hook. ⛔ A slot does not
                       arrive clean; rescueDirt stashes what the last run left (+ .test.ts)
  which.ts             PATH resolution - node-pty does not do it
  adapters/            claude-code - antigravity-cli - openai-compatible; capabilities as data
                       (+ adapters.test.ts). Read docs/adapters.md before changing one
    external.ts        declarative adapters from <dataDir>/adapters/*.json  (+ external.test.ts)
    generic.ts         the driver behind one. ⛔ JSON only, never JavaScript
src/mcp/               the MCP server the agent CLI spawns. Two tiers chosen by the daemon: worker
                       (task_complete, task_create, ask_human, handoff) and controller
                       (fleet/task/approval/estimate). ⛔ Neither can delete anything.
src/main/              window host + the daemon's only client (holds the token); the tray, and
                       `uisettings.ts` - preferences main must read when the daemon is not answering
src/renderer/          fleet strip, approvals bar, tasks, project settings (policy tier), workers,
                       Logs, LooseEnds, Conversations (who shared what) (+ lib/format.test.ts)
costmodels/            anthropic.* - google.antigravity.* - openai.codex.*; compiled in, so a
                       packaging slip cannot leave the scheduler unable to price
docs/                  cost-model.md, glossary.md, adapters.md, landing.md, sessions.md
.claude/skills/commit/ /commit: docs, suites, package, commit, push
```

## What is true right now and not yet proven

- ⭐ **All three providers have a free quota probe** (**R3 closed**). ⚠️ Free of tokens, not of *sessions*: each `/usage` refresh opens a PTY that registers with the vendor's bridge — 150 against 14 real work sessions in four days, so `REFRESH_AFTER_MS` is now 2h. ⛔ Those already registered are account-side; only the operator can archive them.
- ⚠️ **The compaction reserve still reports `unknown`** (**R2**). ⭐ Quota is a routing input again: `windowRisk` slopes to the 92% gate and every score prints its derivation.
- ⚠️ **Never exercised end to end: the tray *icon*, and keepalive firing** (its arithmetic is unit-tested).
- ⭐ **Every intervention on a live session has an off switch** — Settings > Global: `autoCompact`/`autoPreempt` **on**, `autoRunawayStop` **off**, `probeIntervalMinutes` 5m.
- ⭐ **A full workspace pool holds a task rather than failing it** (2026-08-29). ⛔ No dependency edge: a hold is re-decided every tick, so priority wins. ⚠️ A fleet wider than its pool is *named*, never silently grown.
- ⭐ **A quota pause now ends on its own clock** (2026-08-31, t60). `preempt` parks a task as `paused_quota` carrying `not_before = resetsAt` and three places said it *"resumes itself"* — `admitScheduled` reads only `scheduled`, `admit` refuses every held status, `resumeTask` took neither, so that field was read by **nothing** and t60 sat 291s past its own resume time with no button either. `resumeQuotaPaused()` runs in `tick()`; `resumeTask` and the menu now accept it. ⛔ Back to `ready`, not to a worker. ⭐ Beside it: `stale` is an **age** test, so a reading two minutes old whose window has since reset was trusted for hours (measured: 88% on a window that reset 6m earlier). `windowExpired()` makes an expired window **unknown, never zero**. ⚠️ Neither has run in flight.
- ⭐ **The stall watchdog tells stuck from slow, and has fired in flight** (2026-08-30): 13m into a hung codex run it posted the process tree and 0.0s of CPU gained in 70s. ⛔ It reports and never kills.
- ⭐ **A question shows on the task, and a stale branch has a way back** (2026-08-30, t59). `askQuestion` never changed the status, so a task waiting seven minutes on a person read `running`; it now rests at `awaiting_human` and is put back when the answer is taken. ⛔ And `readMergeability` asked about `origin/<target>` while `merge-local` rebases onto the **local** one — on the default policy the pre-flight check answered about a different ref, so conflicts were found inside `landTask`, two branches past the `resolve-conflict` verdict built to hand them back. Both bases now come from `landingBaseFor`. A **Resolve & retry** button sends a conflicted branch back to an agent. ⚠️ None of the three has run in flight.
- ⭐ **A task asked to finish can no longer hang on an answer that never comes** (2026-08-30). `ask-agent` leaves the run open and bet the agent would report again; nothing checked. t58 obeyed in 17s, never reported, and sat `running` for 50m holding ws3. `runWatchdogs` now re-runs `decideFinish` against the tree once the session has been silent past `finishReplyOverdue`. ⚠️ Fired in flight **once, by hand** on t58; the automatic path is unproven.
- ⭐ **Finishing is a ladder, and the default no longer pushes** (2026-08-30, `docs/landing.md`): `await-human` · `commit-only` · `commit-and-verify` · **`commit-and-merge`** · `commit-and-push`, plus `pull-request` and `custom`. The old default pushed on every completed task, and every push starts a ten-job CI matrix — 103 runs in five days, allowance exhausted 2026-08-29. ⛔ The tool never writes a commit, never destroys work it will not land, and never merges into a trunk somebody is working in. ⚠️ `commit-and-merge` has **never run in flight**, nor has the conflict ask. ⭐ `runChecks` runs `check` in the **daemon**, outside any worker sandbox — and the one-shot prompt now says so.
- ⭐ **An agent can ask a person a real question, and be answered** (2026-08-30; `docs/glossary.md`). The **Question** object replaces `request_human`, which went through the approval path and could only answer allow/deny. Four ways in: `ask_human`, Claude Code's own `AskUserQuestion` intercepted at `approve` (measured, R14), `checkpoint`, and — on an adapter with **no MCP and therefore no `ask_human`** — the `NEEDS DECISION:` line its prompt asks it to end with, plus one `- option — detail` bullet per choice. ⛔ That line was matched, quoted into `hold_reason` and **thrown away**, so antigravity and codex could ask questions that were structurally unanswerable (t63, 2026-08-30: three named designs, no reply channel). It now files a real question, born **parked** — the turn is over, so there is no waiter — and answering a parked question **re-queues the task**, which nothing did before. Unanswered **parks**; a run that stopped to ask is `blocked`, not `failed`. ⚠️ **Only Claude has used any of it in flight**; the MCP-less path is unproven, and t63 itself predates it. ⚠️ The thread card has **no rendering test**; seeding one needs a live run. ⚠️ **R15**: can an MCP client hold a tool call for minutes?
- ⭐ **The daemon's log is readable from inside the app** (Settings > Logs): live, filterable, ring-buffered so a late window still sees the past; a file per day, kept a fortnight.
- ⭐ **The middle tier is settable at last** (2026-08-31, t68). Finish policy, session sharing and completion mode all resolve **task → project → fleet**, and the *project* rung of all three could only be reached by hand-editing committed JSON — the task pane offered `inherit (…)` against a tier with no writer. `project.setPolicy` patches the same keys `project.json` already uses, with landing target and workspace pool size beside them, and the project's **Settings** tab now reads Project settings → Policy → Verification → this project's own resources. ⛔ It **patches**: keys it was not asked about, including ones from a newer version, survive, and it refuses rather than overwrites a file that will not parse (`projectpolicy.test.ts`; `ui.test.mjs` +7). ⚠️ The check-command textarea had borrowed `.ask-input`, whose whole design is to be invisible.
- ⭐ **Model and effort are choosable, inherited and visible** (2026-08-29): **task → worker → the
  CLI's own default**, via `resolveModelChoice`. Multi-pool workers set a default per pool and the
  scheduler balances on quota. ⚠️ **`selectableEffort` is true for `claude-code` only**.
- ⛔ **Codex could never have completed a task, five bugs deep** (fixed 2026-08-30, `docs/adapters.md`): stdin held open against a CLI reading to EOF, `mcp: true` on an adapter that cannot register one, `turn.completed` without its terminal half — then, on t56, the landing. `landing.finishInstruction` was read with no policy check, so a `commit-and-merge` project sent codex *"Run /commit … Do not push"* — a Claude-only skill whose sixth step **is** the forbidden push; and `stall.test.ts` asserted a **host capability**, the WMI query codex's sandbox denies, so the suite went red in the worker and green on the host and the agent read that as its own regression. ⛔ And in a worktree it could not commit **at all**: `--sandbox workspace-write` forbids the trunk's `.git`, where a worktree keeps its index, objects and ref — three t56 runs, ~1.8M tokens, 30d quota 0%→34%, every commit refused at `index.lock`. `plan()` now passes `--add-dir` for each. ⚠️ **No codex task has completed yet**; t56 is the re-run that settles it, and the `--add-dir` grant is argv-proven and **unproven against a live sandbox**.
- ⭐ **Antigravity runs, reports its quota, and resumes a conversation by id** (**R9**, measured
  2026-08-28). ⚠️ It meters differently: one aggregate usage record per run, `cache_write` always 0,
  and cache reads that dwarf everything else — 12.5M in a median run (2026-08-30).
- ⭐ **The estimator answers per agent and model, not one number for the fleet** (2026-08-30,
  `docs/cost-model.md` §10). Over 73 completed runs `antigravity-cli/gemini-3.7-flash-medium` medians
  **81x** `claude-code/claude-sonnet-5` (93x priced), so the old fleet median described neither —
  every agy run stood at ~4x its estimate against a 3x runaway watchdog. Now
  `size(task) × factor(adapter, model)`, priced by `CostModel.priceRun`, keyed off `runs.adapter_id`
  and `runs.model` (**migration 23**), warmth divided out (×0.92 warm / ×1.21 cold, measured).
  ⛔ **Routing was left alone deliberately** — zero of 54 tasks has run on two keys, so nothing
  separates *expensive agent* from *agent that gets the big tasks*. Factors feed estimates and gates
  only.
- ⛔ **Nothing is proven off Windows.** CI runners carry no agent CLI, and CI is red (above). ⛔ **Unsigned**: a certificate and an Apple Developer account, not a config line.

## Next

M0–M6 are done. What is left is not a milestone but a list, in the order it would pay off:

1. **Run the suites on macOS or Linux with an agent CLI installed** — the largest unmeasured surface.
2. **R2 (`tokens_per_percent`)** — now only the *reserve* needs it; routing reads percentages directly.
3. **Signing and notarisation**, without which the installers warn or refuse.
4. **Resident sessions — built; two things unproven** (`docs/sessions.md`). A live trial put five
   tasks through one conversation. ⚠️ The **60% share ceiling has never fired**; sharing is off at
   every tier. ⚠️ The workspace pool uses neither `git worktree lock` nor a provenance marker, which
   bites only when the daemon dies mid-run — when nobody is watching.
5. **The trunk tripwire is built and has never fired.** An empty branch under a moved trunk goes to
   `awaiting_human` naming the commits (`decideFinish`'s `trunk-moved`). ⚠️ Provoking it means
   reintroducing the bug `--add-dir` fixed.
6. **`antigravity-cli` still has no real isolation root.** `envFor()` sets no `HOME`, so all four
   workers share the operator's `~/.gemini`. Per-worker `HOME` is the fix; the credential is in the
   OS keyring so sign-in *should* survive, and "should" is doing the work there.
7. **The project Thread tab still has no automated coverage.** `test/ui.test.mjs` seeds a real git project since 2026-08-31 and drives its **Settings** tab; Thread, Sessions and Cost are checked by hand.
8. **Put human-in-the-loop and `commit-and-merge` in front of a real agent.** Both are built and
   neither has been used by one. Dispatch a design task to a Claude worker, answer what it asks, and
   watch it merge locally — the one thing L1–L3 cannot prove. Costs tokens.
9. **Meter codex off its rollout** — R10 is answered (§5), but `metering` stays `'stream'`, so a PTY-hosted codex run is unmetered.
10. **Compute `overrunFactor` in cost, not raw tokens**, and let preempted runs feed `estimateTask`.
   ⚠️ It measures the wrong thing today — 92–98% of a run's tokens are cache reads, so it fires on
   long work, which is why `autoRunawayStop` ships off. The cost model already prices cache reads
   separately, so nothing needs measuring first.

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
| **R4** | Real compaction cost end to end | Compact a session of known size; diff transcript tokens across the `compact_boundary` and record `durationMs` | Three samples so far (139k · 116k · **161k** ms). The spread matters more than the mean for the T+53m deadline |
| **R6** | Is `/compact` honoured as a user message on `stream`? | Send it into a live stream session and watch for a `compact_boundary` record | ⚠️ Not urgent — the clock gives up after two ignored attempts. A `no` makes handoff-and-close the only move on that transport |
| **R7** | Does the live rate-limit `status` warn before it refuses? | Let one window fill while watching `rate_limit_samples` | Decides whether the live signal is an early warning or an obituary |
| **R8** | Does a real model answer a consult in the shape the validators accept? | Designate a controller, file a `plan` task, run `controller.drain`, read the row: `answered` or `fallback`, and the `fallbackReason` | The one M4 path L1 cannot reach |

R1, R6 change the cache clock. **R10/R11 closed 2026-08-29**, **R12 closed 2026-08-30** (§5). ⚠️ **R5 dropped**: resuming is measured and shipped within an account; its transplant needs a second subscription.

## Standing decisions worth not relitigating

⛔ The invariants live in `AGENTS.md`; these are the ones most re-argued by somebody who has not read it:

- **Daemon, not all-in-Electron.** The premise is unattended progress across quota windows.
- **Deterministic scheduler; LLM on judgment events only.** A loop running every 10s for weeks must not bill anything, and the fleet survives with no controller at all.
- **PTY-hosted CLI, transcript for state.** We own stdin, so `/compact` is a function call. ⚠️ ANSI parsing
  determines state in exactly one declared place - a quota reading. Never a session's state.
- **Capabilities and objectives are data.** No `if (adapter === …)`, no `if (mode === …)`.
