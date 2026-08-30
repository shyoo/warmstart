# Multi Agent Controller — Session Handoff

Multi-agent controller: a scheduler that routes coding-agent tasks to the worker, session and moment
where they are cheapest. Electron shell + `orchestratord` daemon. Windows now; macOS/Linux built and
started in CI, never run against a real agent CLI.

**This file is current state + what to do next. It is not a changelog.** Keep it **under 200 lines** —
if you add a line, find the one it obsoletes and cut it in the same edit. Finished work moves to
`transient_docs/changes_history.md`; a *rule* to `AGENTS.md`; a durable *fact* to `docs/`.

**Baseline (2026-08-30, measured):** typecheck · lint · build clean · `npm test` 760/762 (2 POSIX-only
skipped) · `test:daemon` 125/125 · `test:ui` 142/142 · `test:pack` 18/18 · L4 (opt-in) landed a real
agent commit on origin/main. Electron 44.0.0, electron-builder 26.15.3, 0 npm vulnerabilities.
CLIs here: claude 2.1.251 · agy 1.1.22 · codex 0.151.0.

⭐ **`scripts/build-win.ps1` runs all of the above**; `-Help` lists its options, `-Restart` is the inner
loop. Content-addressed: **92s cold, ~0s warm**. ⛔ **One packaged app — `release\win-unpacked\`** — and
running the repo's copy while building blocks the pack step, correctly.

⚠️ **With no agent CLI the daemon suite skips 5 checks**, each with a stated reason — the CI state;
simulate it with a PATH of System32, node and git and an empty `HOME`. ⛔ **CI itself has not run since
2026-08-29T21:54Z**: 12 pushes, each blocked by GitHub billing — **nothing is verified off Windows.**

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
  db.ts                node:sqlite + numbered migrations (v19)
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
  estimator.ts         what a task will cost, from what tasks have cost
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
                       (task_complete, task_create, request_human, handoff) and controller
                       (fleet/task/approval/estimate). ⛔ Neither can delete anything.
src/main/              window host + the daemon's only client (holds the token); the tray, and
                       `uisettings.ts` - preferences main must read when the daemon is not answering
src/renderer/          fleet strip, approvals bar, tasks, projects, workers, global, xterm pane,
                       Logs, LooseEnds, Conversations (who shared what) (+ lib/format.test.ts)
costmodels/            anthropic.* - google.antigravity.* - openai.codex.*; compiled in, so a
                       packaging slip cannot leave the scheduler unable to price
docs/                  cost-model.md, glossary.md, adapters.md, landing.md, sessions.md
.claude/skills/commit/ /commit: docs, suites, package, commit, push
```

## What is true right now and not yet proven

- ⭐ **All three providers have a free quota probe** (**R3 closed**, `docs/cost-model.md` §5). A
  stale-but-known reading is labelled, not dropped, and Antigravity's **two pools gate separately**.
  ⭐ **Codex joined 2026-08-29**: `codex app-server`'s `account/rateLimits/read` (~700ms, live, what
  `/status` shows), else its rollout. ⛔ **Free reports quota too** — one 30-day window, so an id comes from a window's *length*, never its slot.
- ⚠️ **The compaction reserve still reports `unknown`** (**R2**, `docs/cost-model.md` §10). ⭐ But
  quota is a routing input again (2026-08-30): `windowRisk` slopes from 50% to the 92% gate, on the
  window the gate read, saturating where it cuts. ⛔ It had been *nothing* — both triggers unreachable
  — costing four consults answered from worker names. ⭐ Every score now prints its derivation.
- ⚠️ **Two things have never been exercised end to end: the tray *icon*, and keepalive *execution*.** The tray switch and `daemon.shutdown` are covered; the keepalive arithmetic is unit-tested and its firing is not.
- ⭐ **Every intervention on a live session has an off switch** — Settings > Global: `autoCompact` and
  `autoPreempt` **on**, `autoRunawayStop` **off**, plus configurable `probeIntervalMinutes` (default 5m).
- ⭐ **A full workspace pool holds a task instead of failing it** (2026-08-29): `poolPressure` gates before routing, and contention throws `Contended`, which the tick returns to `ready`. ⛔ No dependency edge — a hold is re-decided every tick, so priority still wins. ⚠️ `poolSize` is untouched; a fleet wider than its pool is *named* on the row, not silently grown.
- ⭐ **The stall watchdog can now tell stuck from slow** (2026-08-29): after 12m of silence it samples the run's whole process tree, and a flat CPU total says stuck. ⛔ It reports and never kills or changes status — a run blocked on the network looks the same. ⚠️ It has caught one real incident by hand and none in flight.
- ⭐ **One finish policy, resolved task > project > fleet** (`docs/landing.md`): `await-human` ·
  `agent-lands` · `pull-request` · `custom`, replacing `landing.strategy` and `verification`. ⛔ **The
  tool never writes a commit** and never destroys work it will not land. Loose work — and, since
  2026-08-30, **a branch that will not rebase** — gets *one* instruction to the still-live agent and
  otherwise rests intact under **Loose ends**. ⚠️ The conflict ask is proven against a real repo in
  `conflict.test.ts` and **has never fired in flight**. `mandate.land` stays the authority throughout.
- ⭐ **The daemon's log is readable from inside the app** (Settings > Logs): live, filterable, backed
  by a ring buffer so a window opened late still sees the past, and a file per day kept a fortnight.
- ⭐ **Model and effort are choosable, inherited and visible** (2026-08-29): **task → worker → the
  CLI's own default**, via `resolveModelChoice`, shared by the scheduler and both forms. Multi-pool
  workers (e.g. Antigravity) configure default models per pool and the scheduler auto-balances
  based on available quota/budget. ⚠️ **`selectableEffort` is true for `claude-code` only**.
- ⭐ **Antigravity runs, reports its quota, and resumes a conversation by id** (**R9** closed the
  opposite way round from how it was asked, `docs/cost-model.md` §5; the stream shapes and
  `--conversation` measured 2026-08-28). ⚠️ **No Antigravity task has ever completed** - with
  `mcp: false` it cannot call `task_complete`, so `awaiting_human` is honest there - and R13 stands.
  ⛔ It restores a conversation but reports `cache_read_tokens: 0` throughout: context, not cache.
- ⛔ **Nothing is proven off Windows.** CI runners carry no agent CLI, so `docs/adapters.md` was always Windows-only — and CI has not run at all since 2026-08-29 (see the top of this file).
- ⛔ **Unsigned.** SmartScreen warns and Gatekeeper refuses — a certificate and an Apple Developer account, not a config line.

## Next

M0–M6 are done. What is left is not a milestone but a list, in the order it would pay off:

1. **Run the suites on macOS or Linux with an agent CLI installed** — the largest unmeasured surface.
2. **R2 (`tokens_per_percent`)** — now only the *reserve* needs it; routing reads percentages directly.
3. **Signing and notarisation**, without which the installers warn or refuse.
4. **Resident sessions — built; two things unproven.** `docs/sessions.md` is the spec. A live trial
   put **five tasks through one conversation**, two committing borrowers kept apart.
   ⚠️ The **60% share ceiling has never fired** (context 43k → 49k). ⚠️ Sharing is off at every tier.
   - **`git worktree lock` and a provenance marker.** Claude Code's sweep uses both and this pool
     uses neither. Only bites when the daemon dies mid-run, which is when nobody is watching.
5. **The trunk tripwire is built and has never fired.** A run whose branch is empty while the
   trunk's target moved now goes to `awaiting_human` naming the commits (migration 14,
   `decideFinish`'s `trunk-moved`). ⚠️ Unproven against a real incident — the failure it watches for
   has been fixed by `--add-dir`, so provoking it means reintroducing the bug on purpose.
6. **`antigravity-cli` still has no real isolation root.** `envFor()` sets no `HOME`, so all four
   workers share the operator's `~/.gemini`. Per-worker `HOME` is the fix; the credential is in the
   OS keyring so sign-in *should* survive, and "should" is doing the work there.
7. **The project Thread tab has no automated coverage.** `test/ui.test.mjs` files every task with no
   project, so that tab is checked by `typecheck` and by hand only. Needs a real project root.
8. **Meter codex off its rollout** — R10 is answered (§5), but `metering` stays `'stream'`, so a PTY-hosted codex run is unmetered.
9. **Compute `overrunFactor` in cost, not raw tokens**, and let preempted runs feed `estimateTask`.
   ⚠️ It measures the wrong thing today — 92–98% of a run's tokens are cache reads, so it fires on
   long work, which is why `autoRunawayStop` ships off. The cost model already prices cache reads
   separately, so nothing needs measuring first.

## Open questions

- **Auto-mode classifier cost on a subscription** (`docs/cost-model.md` §9). Billable on Enterprise and
  API-billed accounts, unstated for Pro/Max/Team, and Claude workers default to `auto`. ⛔ Do not assume it is free — **R1** measures it.
- **Vertex / Antigravity cache pricing.** Both declare `cache.kind: "unpriced"`; needs a published figure, not an experiment. ⚠️ agy reports `cache_read_tokens: 0` on every turn (measured 2026-08-28), so there may be nothing to price.
- **`expected idle` estimator** (plan §8.6). Not designable without real queue data.

## Measurement runs owed

Each is cheap and needs a **quiet worker** - one session, nothing else on that account. Record the
result in `docs/cost-model.md` with the date and CLI version, then delete the row. **The instrument:**
a run records a quota reading either side of itself and transcript metering beside it; the difference
is what the CLI spent that never reached a transcript.

| # | Question | Method | What it changes |
|---|---|---|---|
| **R1** | Does the auto-mode classifier bill on a subscription? | ⭐ A run now records the window either side of itself, so the task pane shows (quota delta − transcript tokens). Run one shell-heavy task twice on a quiet worker, `auto` then `default` | If it bills, `auto` stops being a free default and the objective vector has to price it. §9 |
| **R2** | `tokens_per_percent` per (worker, model, tokenizer) | With exactly one session live, sample `/usage` by hand at intervals and diff against transcript tokens over the same span | Turns percent into tokens, which is what every gate actually needs. Plan §8.5 |
| **R4** | Real compaction cost end to end | Compact a session of known size; diff transcript tokens across the `compact_boundary` and record `durationMs` | Three samples so far (139k · 116k · **161k** ms). The spread matters more than the mean for the T+53m deadline |
| **R6** | Is `/compact` honoured as a user message on `stream`? | Send it into a live stream session and watch for a `compact_boundary` record | ⚠️ Not urgent — the clock gives up after two ignored attempts. A `no` makes handoff-and-close the only move on that transport |
| **R7** | Does the live rate-limit `status` warn before it refuses? | Let one window fill while watching `rate_limit_samples` | Decides whether the live signal is an early warning or an obituary |
| **R8** | Does a real model answer a consult in the shape the validators accept? | Designate a controller, file a `plan` task, run `controller.drain`, read the row: `answered` or `fallback`, and the `fallbackReason` | The one M4 path L1 cannot reach |
| **R12** | Is headless compaction reachable on codex? | Try to drive compaction from `codex exec`; watch for a compaction record | If yes, `manualCompact` flips true and two cache-clock moves become available on that provider |

R1, R6 change the cache clock. **R10/R11 closed 2026-08-29** (§5). ⚠️ **R5 dropped**: resuming is measured and shipped within an account; its transplant needs a second subscription.

## Standing decisions worth not relitigating

⛔ The invariants live in `AGENTS.md`. These are the ones most often re-argued by somebody who has not
read it:

- **Daemon, not all-in-Electron.** The premise is unattended progress across quota windows.
- **Deterministic scheduler; LLM on judgment events only.** A loop running every 10s for weeks must not bill anything, and the fleet survives with no controller at all.
- **PTY-hosted CLI, transcript for state.** We own stdin, so `/compact` is a function call. ⚠️ ANSI parsing
  determines state in exactly one declared place - a quota reading. Never a session's state.
- **Capabilities and objectives are data.** No `if (adapter === …)`, no `if (mode === …)`.
