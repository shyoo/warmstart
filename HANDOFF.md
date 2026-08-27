# Multi Agent Controller — Session Handoff

Multi-agent controller: a scheduler that routes coding-agent tasks to the worker, session and moment
where they are cheapest. Electron shell + `orchestratord` daemon. Windows now; macOS/Linux built and
started in CI, never run against a real agent CLI.

**This file is current state + what to do next. It is not a changelog.** Keep it **under 200 lines** —
if you add a line, find the one it obsoletes and cut it in the same edit. Finished work moves to
`transient_docs/changes_history.md`; a *rule* to `AGENTS.md`; a durable *fact* to `docs/`.

**Baseline (2026-08-27, measured on this machine):** `npm run typecheck` clean · `npm run lint` clean ·
`npm run build` clean · `npm test` 219/219 · `npm run test:daemon` 110/110 · `npm run test:ui` 37/37 ·
`npm run test:pack` 18/18 · L4 (opt-in) landed a real agent commit on origin/main. Electron 44.0.0,
electron-builder 26.15.3, 0 npm vulnerabilities. CLIs here: claude 2.1.247 · agy 1.1.21 · codex 0.149.1.

⚠️ **With no agent CLI the daemon suite skips 5 checks**, each with a stated reason — the CI state,
and why `summary()` prints skips beside the result. Simulate it with a PATH of System32, node and git
and an empty `HOME`; it is what found the dispatch-gate bug. **All ten CI jobs pass on all three
platforms**; what that does *not* cover is below.

---

## Where the build is

| Milestone | State |
|---|---|
| **M0** scaffold | ✅ repo, licence, docs, Electron shell |
| **M1** fleet substrate + commissioning | ✅ daemon, cost-model loader, workers, quota, PTY, transcript metering, fleet UI |
| **M2** tasks, threads, resources, authorship | ✅ tasks + DAG, cancel/delete, approvals, projects, worktree pool, auto-land, scheduler v1 |
| **M3** cost intelligence | ✅ cache clock, compaction reserve, objective vector, estimator, preemption, watchdogs |
| **M4** controller agent | ✅ consult queue + fallbacks, four judgment events, controller MCP tier, chat + thread panes |
| **M5** multi-provider (`antigravity-cli`, `openai-compatible`) | ✅ two adapters measured against the real CLIs, two cost models, capability consequences proved |
| **M6** packaging | ✅ electron-builder, a suite that drives the *packaged* app, declarative adapters, pull-request landing |

Scope: `transient_docs/implementation_plan_2026-08-24.md` §14, amended by **A1/A2/A3 (2026-08-25)**:
`gemini-cli` retired, D5 closes per adapter (§9.1), approvals and cancel/delete are new objects,
decomposition is a roadmap not a DAG (§18.1), and a judgment event is a **queued question with a
deterministic fallback** rather than a call the scheduler makes (§11.1).

⛔ What each milestone *measured* is in `transient_docs/changes_history.md`. Read it before
re-deriving any of it.

## What exists

```
src/daemon/            orchestratord. Runs as Electron-with-ELECTRON_RUN_AS_NODE, detached.
  index.ts             entry: lock, db, server, poller, scheduler, tailer wiring, shutdown
  server.ts  api.ts    HTTP+WS on 127.0.0.1:<random>, bearer token, typed RPC
  db.ts                node:sqlite + numbered migrations (v7)
  costmodel.ts         the four questions; user dir > bundled > compiled-in
  workers.ts           registry, isolation roots, retire-keeps-credentials
  quota.ts             the staleness ladder - read this before trusting a percentage
  sessions.ts          two transports: pty (node-pty) and stream (real pipes); orphan reaping
  transcript.ts        metering: iterations[], TTL split, cache clock  (+ .test.ts)
  tasks.ts             DAG, admission, mandates, budgets, runs           (+ tasks.test.ts)
  cancel.ts            wind-down into a resting state; delete is separate and human-only
  approvals.ts         policy engine, escalation clock, remembered rules
  scheduler.ts         gates, scoring, dispatch, watchdogs, continueTask (+ routing.test.ts,
                       runfailure.test.ts - who is blamed when a run does not succeed)
  activity.ts          the live peephole: a bounded in-memory tail of what a run is saying
  landing.ts           auto-land, serialised by an exclusive land: resource (+ landing.test.ts)
  cacheclock.ts        the six moves - the piece the whole cost model exists for
  reserve.ts           the compaction reserve, and every belief with its basis attached
  objective.ts         the weight vector, in exactly two consumers    (+ cost.test.ts)
  controller.ts        the consult queue, the caps, and choosing who answers (+ controller.test.ts)
  judgment.ts          the four events: question, closed answer set, fallback (+ judgment.test.ts)
  chat.ts              the one place the controller gets tools - a person is watching
  estimator.ts         what a task will cost, from what tasks have cost
  stream.ts            stream-json records: the free live rate-limit signal
  projects.ts          .multi_agent_controller/project.json; policy committed, state private
  resources.ts         the broker - if the scheduler owns the claim, the lock is unnecessary
  worktrees.ts         pooled worktrees, task-named branches, prepare hook
  which.ts             PATH resolution - node-pty does not do it
  adapters/            claude-code - antigravity-cli - openai-compatible; capabilities as data
                       (+ adapters.test.ts). Read docs/adapters.md before changing one
    external.ts        declarative adapters from <dataDir>/adapters/*.json  (+ external.test.ts)
    generic.ts         the driver behind one. ⛔ JSON only, never JavaScript
src/mcp/               the MCP server the agent CLI spawns. Two tiers, chosen by the daemon:
                       worker (task_complete, task_create, request_human, handoff) and controller
                       (fleet/task/approval/estimate). Target of --permission-prompt-tool. No delete.
src/main/              window host + the daemon's only client (holds the token)
src/renderer/          fleet strip, approvals bar, tasks, projects, workers, doctor, xterm pane
                       (+ lib/format.test.ts)
costmodels/            anthropic.* - google.antigravity.* - openai.codex.*; compiled in, not read
                       from disk, so a packaging slip cannot leave the scheduler unable to price
docs/                  cost-model.md, glossary.md, adapters.md - maintained; read before reasoning
                       about cost, vocabulary, or what a given CLI can actually do
.claude/skills/commit/ /commit: docs, suites, package, commit, push
```

## What is true right now and not yet proven

- ⭐ **There is a free live quota probe.** `/usage` typed into an interactive session is client-side:
  it spends nothing and rewrites `cachedUsageUtilization`. `refreshUsage()` drives it on the Probe
  button, on a 30-minute floor, and before a dispatch that needs a baseline. ⛔ **R3 is closed** —
  `docs/cost-model.md` §5 has the ladder and what else was tried.
- ⚠️ **The compaction reserve still reports `unknown`,** and now for one reason rather than two: it
  needs `remaining` in *tokens*, so a fresh percentage is no longer the blocker — **R2**
  (`tokens_per_percent`) is. `docs/cost-model.md` §10. ⛔ Until it lands the reserve cannot be a
  *routing* input at all — scoring `unknown` as half-risk silently meant "penalise any worker holding
  a session", so it is scored zero and only checked evidence moves the score.
- ⚠️ **A worker is not usable until somebody answers the CLI's first-run questions in its own root.**
  Signing in writes neither `hasCompletedOnboarding` nor folder trust; print mode skips both, so
  scheduled work runs while a TUI - and therefore `/usage`, and therefore a cost baseline - cannot.
  `Finish setup` opens that terminal.
- ⭐ **A worker is held out of dispatch by evidence** — a run producing no metered turn is charged to
  the account, not the task. **A run carries a quota reading either side of it**, never merged with
  the transcript token count: their difference is R1's instrument. Rules in AGENTS.md, cases in
  `runfailure.test.ts`.
- ⚠️ **Sessions are reused within a task, never across tasks in a project.** The detail pane says
  which happened, so the claim is checkable. Closing the second half is item 4 in *Next*.
- ⭐ **A reply to a stopped task continues it**: same thread, a new **run**, re-queued through the
  scheduler so it is gated, metered and landed like any other. `continueTask()`.
- ⭐ **`awaiting_human` is answerable.** It states what it wants (on the task, not only in the thread)
  and offers **Mark done** — `resolveTask()`, a person's judgement, recorded as one. Before this it
  was the only resting state with nothing to press.
- ⛔ **A completed task never unblocked its dependents until 2026-08-27.** The scheduler carried a
  private copy of `admitDependents` that re-set each dependent to the status it already had, so the
  DAG never advanced past its first edge. Nothing else re-admits a `blocked` task. Found by a test
  written for something else; the correct implementation was exported and called by nobody.
- ⭐ **`npm run pack` packages into `release/suite/`**, so the packaged suite runs with the app open —
  building into the directory somebody executes from is what caused `EBUSY: rmdir release\win-unpacked`,
  and closing the app is not an acceptable answer. ⛔ **Every suite below L1 drives a build product and
  none of them builds one**, so `checkBuildIsCurrent()` (daemon, ui) and the asar check (pack) refuse
  when the artefact predates `src/`. Three green-and-wrong runs on 2026-08-27 are why.
- ⚠️ **Two M3 paths are unverified and marked in the code:** whether `/compact` is honoured on the
  `stream` transport (**R6**), and keepalive *execution*, which needs a warm session and an idle
  hour. The arithmetic is unit-tested; the firing is not.
- ⚠️ **No consult has ever been answered by a real model.** L1 runs with nobody able to answer, which
  proves the fallbacks and leaves the answer path on synthetic replies only. **R8**.
- ⛔ **Anything needing a real agent CLI is unproven off Windows.** CI proved three platforms build,
  start, package and schedule; the runners have no CLI and cannot sign in to one, so every adapter
  capability in `docs/adapters.md` was measured on Windows only.
- ⛔ **Unsigned.** Windows SmartScreen warns and macOS Gatekeeper refuses. That is the honest state of
  a pre-alpha; fixing it needs a certificate and an Apple Developer account, not a config line.

## Next

M0–M6 are done. What is left is not a milestone but a list, in the order it would pay off:

1. **Run the suites on macOS or Linux with an agent CLI installed.** See above — this is the largest
   unmeasured surface in the project.
2. **R2 (`tokens_per_percent`)** — the last thing between a refreshable percentage and a compaction
   reserve that reports a number. Now cheap to run, because the percentage refreshes on demand.
3. **Signing and notarisation**, without which the installers warn or refuse.
4. **Warm-session reuse across tasks in one project** — the biggest remaining cost win, and the
   reason it is not done is in the scheduler's own comment: the workspace claim has to move from the
   task to the session first, so a session can outlive the task that opened it without leaking a
   claim or switching a branch under a running agent.

## Open questions

- **Turning a percentage into tokens (R2).** The percentage is now refreshable; what no vendor
  publishes is what one percent of a window is worth, and every gate needs tokens.
- **Auto-mode classifier cost on a subscription** (`docs/cost-model.md` §9). Documented as billable on
  Enterprise and API-billed accounts, unstated for Pro/Max/Team, and Claude workers default to `auto`.
  ⛔ Do not assume it is free — **R1** measures it.
- **Vertex / Antigravity cache pricing.** Not guessed, and recorded as such: both new cost models
  declare `cache.kind: "unpriced"`, which the clock reads and declines to act on. Closing this needs a
  published figure, not an experiment.
- **`expected idle` estimator** (plan §8.6). Cannot be designed further without real queue data.
- **Are the consult prompts good enough?** The honest gap in M4. **R8** measures it. ⛔ If replies fail
  validation the prompt is wrong, not the validator — never widen a closed set to fit a reply.

## Measurement runs owed

The questions above as experiments. Each is cheap, each needs a **quiet worker** (one session,
nothing else on that account), and each answers something the design is guessing at. Run them when a
window is idle; record the result in `docs/cost-model.md` with the date and CLI version, and delete
the row.

**The instrument**, now on screen rather than run by hand: transcript metering is exact for assistant
turns, quota covers everything the account spent, and their difference is what the CLI spent that
never reached a transcript. A run records both. ⛔ They are never merged.

| # | Question | Method | What it changes |
|---|---|---|---|
| **R1** | Does the auto-mode classifier bill on a subscription? | ⭐ No longer by hand: a run now records the window either side of itself, so the task pane shows (quota delta − transcript tokens) directly. Run the same shell-heavy task twice on a quiet worker, `auto` then `default`, and read both | If it bills, `auto` stops being a free default and the objective vector has to price it. §9 |
| **R2** | `tokens_per_percent` per (worker, model, tokenizer) | With exactly one session live, sample `/usage` by hand at intervals and diff against transcript tokens over the same span | Turns percent into tokens, which is what every gate actually needs. Plan §8.5 |
| **R4** | Real compaction cost end to end | Compact a session of known size; diff transcript tokens across the `compact_boundary` and record `durationMs` | Three samples so far (139k · 116k · **161k** ms). The spread matters more than the mean for the T+53m deadline |
| **R5** | Second account on a transplanted transcript | Commission a second worker, copy a small transcript into its root, `--resume`, complete one turn | Discovery is measured; completion is not. Shapes cross-account continuation. §7 |
| **R6** | Is `/compact` honoured as a user message on `stream`? | Send it into a live stream session and watch for a `compact_boundary` record | The cache clock's compact move depends on it. If not, that move becomes handoff-and-close everywhere |
| **R7** | Does the live rate-limit `status` warn before it refuses? | Let one window fill while watching `rate_limit_samples` | Decides whether the live signal is an early warning or an obituary |
| **R8** | Does a real model answer a consult in the shape the validators accept? | Designate a controller, file a `plan` task, run `controller.drain`, read the row: `answered` or `fallback`, and the `fallbackReason` | The one M4 path L1 cannot reach |
| **R9** | Does `agy -p /usage` run the slash command for free? | Run it on a quiet signed-in worker; compare against `/usage` typed into an interactive session | ⚠️ `--disable-slash-commands` is documented as disabling expansion *in print mode*, implying print mode expands them — the opposite of Claude Code. Would be **the first free quota probe this project has ever had** |
| **R10** | Does the codex rollout JSONL carry per-turn usage `transcript.ts` can meter? | Run one small task on a codex worker; open `$CODEX_HOME/sessions/**/rollout-*.jsonl` | If not, `meteredFromTranscript` is wrong and codex runs are invisible to the cost model — a bigger hole than pricing |
| **R11** | The `stream-json` / `--json` event shapes for agy and codex | One turn each, capture stdout verbatim | `stream.ts` parses Anthropic's records only. Until this lands, neither new adapter contributes rate-limit signal or result text |
| **R12** | Is headless compaction reachable on codex? | Try to drive compaction from `codex exec`; watch for a compaction record | If yes, `manualCompact` flips true and two cache-clock moves become available on that provider |

**R2 blocks the compaction reserve** (R3 is closed). R1 and R6 change how the cache clock behaves;
R5 needs a second subscription.

## Standing decisions worth not relitigating

⛔ The architecture invariants live in `AGENTS.md` and load into every session. These are the four
choices most likely to be re-argued by someone who has not read it:

- **Daemon, not all-in-Electron.** The premise is unattended progress across quota windows.
- **Deterministic scheduler; the LLM only on judgment events, never inline.** A loop running every 10s
  for weeks must not bill anything, and the fleet must survive there being no controller at all.
- **PTY-hosted CLI, transcript for state.** We own stdin, so `/compact` is a function call. But no
  ANSI parsing ever determines state.
- **Capabilities and objectives are data.** No `if (adapter === …)`, no `if (mode === …)`. Proved
  against three real CLIs in M5, extended in M6 to adapters an operator declares in JSON.
