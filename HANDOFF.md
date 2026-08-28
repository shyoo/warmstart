# Multi Agent Controller — Session Handoff

Multi-agent controller: a scheduler that routes coding-agent tasks to the worker, session and moment
where they are cheapest. Electron shell + `orchestratord` daemon. Windows now; macOS/Linux built and
started in CI, never run against a real agent CLI.

**This file is current state + what to do next. It is not a changelog.** Keep it **under 200 lines** —
if you add a line, find the one it obsoletes and cut it in the same edit. Finished work moves to
`transient_docs/changes_history.md`; a *rule* to `AGENTS.md`; a durable *fact* to `docs/`.

**Baseline (2026-08-28, measured on this machine):** `npm run typecheck` clean · `npm run lint` clean ·
`npm run build` clean · `npm test` 315/315 · `npm run test:daemon` 124/124 · `npm run test:ui` 70/70 ·
`npm run test:pack` 18/18 · L4 (opt-in) landed a real agent commit on origin/main. Electron 44.0.0,
electron-builder 26.15.3, 0 npm vulnerabilities. CLIs here: claude 2.1.247 · agy 1.1.22 · codex 0.149.1.

⭐ **`scripts/build-win.ps1` runs all of the above; `-Help` lists its options, `-Restart` is the inner
loop.** Steps are content-addressed and skipped when unchanged: **92s cold, ~0s warm**.
⛔ **One packaged app: `release\win-unpacked\`, and it is the build's** — **the app to use is the
one the installer installs**. Running the repo's copy while building blocks the pack step, correctly.

⚠️ **With no agent CLI the daemon suite skips 5 checks**, each with a stated reason — the CI state.
Simulate it with a PATH of System32, node and git and an empty `HOME`; it found the dispatch-gate
bug. **All ten CI jobs pass on all three platforms**; what that misses is below.

---

## Where the build is

**M0–M6 are all shipped.** M0 scaffold · M1 fleet substrate and commissioning · M2 tasks, threads,
resources, authorship · M3 cost intelligence · M4 controller agent · M5 multi-provider
(`antigravity-cli`, `openai-compatible`) · M6 packaging. ⚠️ Shipped is not the same as proven — the
gaps are in *What is true right now and not yet proven*, below.

Scope: `transient_docs/implementation_plan_2026-08-24.md` §14, as amended by **A1/A2/A3**
(2026-08-25, recorded there).

⛔ What each milestone *measured* is in `transient_docs/changes_history.md`. Read it before re-deriving any of it.

## What exists

```
src/daemon/            orchestratord. Runs as Electron-with-ELECTRON_RUN_AS_NODE, detached.
  index.ts             entry: lock, db, server, poller, scheduler, tailer wiring, shutdown
  server.ts  api.ts    HTTP+WS on 127.0.0.1:<random>, bearer token, typed RPC
  db.ts                node:sqlite + numbered migrations (v8)
  costmodel.ts         the four questions; user dir > bundled > compiled-in
  workers.ts           registry, isolation roots, retire-keeps-credentials
  quota.ts             the staleness ladder - read this before trusting a percentage
  sessions.ts          two transports: pty (node-pty) and stream (real pipes); orphan reaping
  transcript.ts        metering: iterations[], TTL split, cache clock  (+ .test.ts)
  tasks.ts             DAG, admission, mandates, budgets, runs           (+ tasks.test.ts)
  cancel.ts            wind-down into a resting state; delete is separate and human-only
  approvals.ts         policy engine, escalation clock, remembered rules
  scheduler.ts         scoring, dispatch, watchdogs, continueTask (+ routing.test.ts,
                       runfailure.test.ts - who is blamed when a run does not succeed;
                       preemption.test.ts - wrapping a run up once, and the switches that gate it)
  eligibility.ts       ⛔ the account gates, in ONE list. Work and judgment both read it; they
                       each kept their own until 2026-08-27 and the copies drifted
  activity.ts          the live peephole: a bounded in-memory tail of what a run is saying
  landing.ts           auto-land, serialised by an exclusive land: resource (+ landing.test.ts)
  cacheclock.ts        the six moves - what the whole cost model exists for. A move is a request;
                       moveOutcome() is what stops it being re-asked (+ .test.ts)
  lifecycle.ts         how the daemon is asked to stop itself. ⛔ Asked, never killed by pid
  settings.ts          the three fleet switches the operator owns - autoCompact, autoPreempt,
                       autoRunawayStop (Overview > Cost). Per-worker, `enabled` is a switch on its
                       Workers row - held out of dispatch, not retired
  reserve.ts           the compaction reserve, and every belief with its basis attached
  objective.ts         the weight vector, in exactly two consumers    (+ cost.test.ts)
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
src/renderer/          fleet strip, approvals bar, tasks, projects, workers, doctor, xterm pane
                       (+ lib/format.test.ts)
costmodels/            anthropic.* - google.antigravity.* - openai.codex.*; compiled in, so a
                       packaging slip cannot leave the scheduler unable to price
docs/                  cost-model.md, glossary.md, adapters.md - maintained; read before reasoning
.claude/skills/commit/ /commit: docs, suites, package, commit, push
```

## What is true right now and not yet proven

- ⭐ **Both providers have a free live quota probe** — `refreshUsage()` on Probe, a 30-minute floor,
  and before a dispatch needing a baseline. ⛔ **R3 closed**; `docs/cost-model.md` §5 has the ladder.
- ⚠️ **The compaction reserve still reports `unknown`**, for one reason: it needs `remaining` in
  *tokens*, so **R2** (`tokens_per_percent`) is the blocker, not a stale percentage
  (`docs/cost-model.md` §10). ⛔ Until it lands it scores zero as a routing input — only checked
  evidence may move a score.
- ⚠️ **A worker is not usable until somebody answers the CLI's first-run questions.** Print mode skips
  them, so work runs while a TUI — and a quota probe — cannot. `Finish setup` opens that terminal.
- ⛔ **Every suite that drives a build product refuses a stale one.** `checkBuildIsCurrent()` guards
  `test:daemon` and `test:ui`; the asar check guards `test:pack`. Three green-and-wrong runs in one
  day is what bought them.
- ⚠️ **The tray *icon* has never been exercised end to end** — appearing, close-to-hide,
  click-to-restore. Global > This app owns the switch, and it and `daemon.shutdown` are covered.
- ⭐ **Every intervention on a live session has an off switch** — Overview > Cost: `autoCompact` and
  `autoPreempt` **on**, `autoRunawayStop` **off**. ⛔ Preemption also fires *once* now: it waits 120s
  for the wrap-up, and the watchdog re-fired on that state every tick (t5, 2026-08-28: 13 prompts
  into a session that had already committed, driving the factor it policed from 3.1× to 3.9×).
- ⚠️ **The runaway factor measures the wrong thing, which is why its switch ships off.** 92–98% of a
  run's token total is cache reads (`docs/cost-model.md` §10) — it fires on long work, not expensive
  work — and `estimateTask` learns only from `completed` runs. Calibrating it is item 5 under **Next**.
- ⭐ **A pool worktree left dirty no longer kills the next task.** `switch --detach` carries
  uncommitted changes with it, so parking freed a slot's branch and left its edits for the next claim
  to die on. `rescueDirt` stashes them — never `reset --hard`; recover with `git stash list` there.
- ⚠️ **Pinning a task to an account and a model has never run end to end; only its refusals have.**
  `checkConstraints` (api.ts) rejects what nothing can honour, and ⛔ **`selectableEffort` is false on
  all three built-ins** (`docs/adapters.md` has the per-CLI reason), so no effort control is drawn.
- ⚠️ **Two M3 paths are unverified and marked in the code:** `/compact` on the `stream` transport
  (**R6**), and keepalive *execution*. The arithmetic is unit-tested; the firing is not.
- ⚠️ **No consult has ever been answered by a real model** - the fallbacks are proved, the answer
  path is synthetic only. **R8**.
- ⭐ **Antigravity runs and reports its quota**, both since 2026-08-27; **R9 closed the opposite way
  round from how it was asked** (`docs/cost-model.md` §5). ⚠️ Unproven past the `init` record: **no
  Antigravity task has ever completed**, so R11 and R13 stand — and with `mcp: false` it cannot call
  `task_complete`, so `awaiting_human` every run is the honest outcome there.
- ⛔ **Anything needing a real agent CLI is unproven off Windows.** CI proved three platforms build,
  start, package and schedule; the runners have no CLI, so every capability in `docs/adapters.md`
  was measured on Windows only.
- ⛔ **Unsigned.** SmartScreen warns and Gatekeeper refuses — the honest state of a pre-alpha; it
  needs a certificate and an Apple Developer account, not a config line.

## Next

M0–M6 are done. What is left is not a milestone but a list, in the order it would pay off:

1. **Run the suites on macOS or Linux with an agent CLI installed.** See above — this is the largest
   unmeasured surface in the project.
2. **R2 (`tokens_per_percent`)** — the last thing between a refreshable percentage and a compaction
   reserve that reports a number. Now cheap to run, because the percentage refreshes on demand.
3. **Signing and notarisation**, without which the installers warn or refuse.
4. **Warm-session reuse across tasks in one project** — the biggest remaining cost win. The
   scheduler's own comment says why it is not done: the workspace claim has to move from the task to
   the session first, so a session can outlive the task that opened it.
5. **Compute `overrunFactor` in cost, not raw tokens**, and let preempted runs feed `estimateTask`.
   Both are the price of turning `autoRunawayStop` on. The cost model already prices cache reads
   separately, so nothing needs measuring first.

## Open questions

- **Auto-mode classifier cost on a subscription** (`docs/cost-model.md` §9). Documented as billable on
  Enterprise and API-billed accounts, unstated for Pro/Max/Team, and Claude workers default to `auto`.
  ⛔ Do not assume it is free — **R1** measures it.
- **Vertex / Antigravity cache pricing.** Both cost models declare `cache.kind: "unpriced"` and the clock declines to act. Needs a published figure, not an experiment.
- **`expected idle` estimator** (plan §8.6). Not designable without real queue data.
- **Are the consult prompts good enough?** The honest gap in M4 (**R8**). ⛔ If replies fail
  validation the prompt is wrong, not the validator.

## Measurement runs owed

The questions above as experiments. Each is cheap and each needs a **quiet worker** - one session,
nothing else on that account. Record the result in `docs/cost-model.md` with the date and CLI
version, and delete the row. **The instrument:** a run records a quota reading either side of
itself, and transcript metering beside it; their difference is what the CLI spent that never
reached a transcript. ⛔ Never merged.

| # | Question | Method | What it changes |
|---|---|---|---|
| **R1** | Does the auto-mode classifier bill on a subscription? | ⭐ A run now records the window either side of itself, so the task pane shows (quota delta − transcript tokens). Run one shell-heavy task twice on a quiet worker, `auto` then `default` | If it bills, `auto` stops being a free default and the objective vector has to price it. §9 |
| **R2** | `tokens_per_percent` per (worker, model, tokenizer) | With exactly one session live, sample `/usage` by hand at intervals and diff against transcript tokens over the same span | Turns percent into tokens, which is what every gate actually needs. Plan §8.5 |
| **R4** | Real compaction cost end to end | Compact a session of known size; diff transcript tokens across the `compact_boundary` and record `durationMs` | Three samples so far (139k · 116k · **161k** ms). The spread matters more than the mean for the T+53m deadline |
| **R5** | Second account on a transplanted transcript | Commission a second worker, copy a small transcript into its root, `--resume`, complete one turn | Discovery is measured; completion is not. Shapes cross-account continuation. §7 |
| **R6** | Is `/compact` honoured as a user message on `stream`? | Send it into a live stream session and watch for a `compact_boundary` record | ⚠️ Not urgent — the clock gives up after two ignored attempts. A `no` makes handoff-and-close the only move on that transport |
| **R7** | Does the live rate-limit `status` warn before it refuses? | Let one window fill while watching `rate_limit_samples` | Decides whether the live signal is an early warning or an obituary |
| **R8** | Does a real model answer a consult in the shape the validators accept? | Designate a controller, file a `plan` task, run `controller.drain`, read the row: `answered` or `fallback`, and the `fallbackReason` | The one M4 path L1 cannot reach |
| **R10** | Does the codex rollout JSONL carry per-turn usage `transcript.ts` can meter? | Run one small task on a codex worker; open `$CODEX_HOME/sessions/**/rollout-*.jsonl` | If not, `meteredFromTranscript` is wrong and codex runs are invisible to the cost model — a bigger hole than pricing |
| **R11** | The `stream-json` / `--json` event shapes for agy and codex | One turn each, capture stdout verbatim | `stream.ts` parses Anthropic's records only. Until this lands, neither new adapter contributes rate-limit signal or result text |
| **R12** | Is headless compaction reachable on codex? | Try to drive compaction from `codex exec`; watch for a compaction record | If yes, `manualCompact` flips true and two cache-clock moves become available on that provider |

**R2 blocks the compaction reserve** (R3 is closed). R1 and R6 change how the cache clock behaves;
R5 needs a second subscription.

## Standing decisions worth not relitigating

⛔ The invariants live in `AGENTS.md`. These four are the ones most often re-argued by somebody who
has not read it:

- **Daemon, not all-in-Electron.** The premise is unattended progress across quota windows.
- **Deterministic scheduler; the LLM only on judgment events, never inline.** A loop running every 10s
  for weeks must not bill anything, and the fleet must survive there being no controller at all.
- **PTY-hosted CLI, transcript for state.** We own stdin, so `/compact` is a function call. ⚠️ ANSI
  parsing determines state in exactly one declared place - a quota reading. Never a session's state.
- **Capabilities and objectives are data.** No `if (adapter === …)`, no `if (mode === …)`. Proved
  against three real CLIs in M5, and against declared ones in M6.
