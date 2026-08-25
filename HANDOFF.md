# agentyard — Session Handoff

Multi-agent controller: a scheduler that routes coding-agent tasks to the worker, session and moment
where they are cheapest. Electron shell + `orchestratord` daemon. Windows now; macOS/Linux written
for, untested.

**This file is current state + what to do next. It is not a changelog.** Keep it **under 200 lines** —
if you add a line, find the one it obsoletes and cut it in the same edit. Finished work moves to
`transient_docs/changes_history.md`; a *rule* to `AGENTS.md`; a durable *fact* to `docs/`.

**Baseline (2026-08-25, M3):** `npm run typecheck` clean · `npm run build` clean · `npm test` 38/38 ·
`npm run test:daemon` 47/47 · `npm run test:ui` 16/16 · L4 (opt-in) landed a real agent commit on
origin/main. Electron 44.0.0, Node 24.18.1 under Electron, 0 npm vulnerabilities.

---

## Where the build is

| Milestone | State |
|---|---|
| **M0** scaffold | ✅ repo, licence, docs, Electron shell |
| **M1** fleet substrate + commissioning | ✅ daemon, cost-model loader, workers, quota, PTY, transcript metering, fleet UI |
| **M2** tasks, threads, resources, authorship | ✅ tasks + DAG, cancel/delete, approvals, projects, worktree pool, auto-land, scheduler v1 |
| **M3** cost intelligence | ✅ cache clock, compaction reserve, objective vector, estimator, preemption, watchdogs |
| **M4** controller agent | ⬜ next |
| **M5** multi-provider (`antigravity-cli`, `openai-compatible`) | ⬜ |
| **M6** packaging | ⬜ |

Scope: `transient_docs/implementation_plan_2026-08-24.md` §14, as amended by **A1 (2026-08-25)** —
`gemini-cli` is retired, D5 closes per adapter (§9.1), approvals and cancel/delete are new objects.

## What exists

```
src/daemon/            orchestratord. Runs as Electron-with-ELECTRON_RUN_AS_NODE, detached.
  index.ts             entry: lock, db, server, poller, scheduler, tailer wiring, shutdown
  server.ts  api.ts    HTTP+WS on 127.0.0.1:<random>, bearer token, typed RPC
  db.ts                node:sqlite + numbered migrations (v2)
  costmodel.ts         the four questions; user dir > bundled > compiled-in
  workers.ts           registry, isolation roots, retire-keeps-credentials
  quota.ts             the staleness ladder - read this before trusting a percentage
  sessions.ts          two transports: pty (node-pty) and stream (real pipes); orphan reaping
  transcript.ts        metering: iterations[], TTL split, cache clock  (+ .test.ts)
  tasks.ts             DAG, admission, mandates, budgets, runs           (+ tasks.test.ts)
  cancel.ts            wind-down into a resting state; delete is separate and human-only
  approvals.ts         policy engine, escalation clock, remembered rules
  scheduler.ts         the zero-token loop: gates, scoring, dispatch, watchdogs, preemption
  cacheclock.ts        the six moves - the piece the whole cost model exists for
  reserve.ts           the compaction reserve, and every belief with its basis attached
  objective.ts         the weight vector, in exactly two consumers    (+ cost.test.ts)
  estimator.ts         what a task will cost, from what tasks have cost
  stream.ts            stream-json records: the free live rate-limit signal
  projects.ts          .agentyard/project.json; policy committed, state private
  resources.ts         the broker - if the scheduler owns the claim, the lock is unnecessary
  worktrees.ts         pooled worktrees, task-named branches, prepare hook
  landing.ts           LandingStrategy; auto-land, serialised by an exclusive land: resource
  which.ts             PATH resolution - node-pty does not do it
  adapters/            claude-code; capabilities + policy as data
src/mcp/               the MCP server the agent CLI spawns: approve, task_complete, task_create,
                       request_human, handoff. Target of --permission-prompt-tool.
src/main/              window host + the daemon's only client (holds the token)
src/renderer/          fleet strip, approvals bar, tasks, projects, workers, doctor, xterm pane
costmodels/            anthropic.subscription.2026-08.json
docs/                  cost-model.md, glossary.md — maintained; read before reasoning about cost
```

## What M1 measured, and what it cost the design

Three findings changed the code. All are in `docs/cost-model.md`; the short version:

1. ⛔ **`claude -p /usage` is not free and does not report usage.** The slash command is taken as a
   prompt and spends a real turn. The plan inherited the opposite claim from prior art. There is now
   no free live quota probe, so `quota.ts` reports a **rung** and an **age**, and stale readings
   render as *unknown*. Closing this properly is M3 work (see below).
2. **`claude auth status --json` is free, local and exits 1 while still printing valid JSON.** It is
   what commissioning and Doctor verify with.
3. **node-pty does not search PATH** — a spawn fails with a bare *File not found* for a command that
   runs fine in a shell. Everything goes through `which.ts`.

Also: `node:sqlite` replaced better-sqlite3. It ships inside Electron's own Node, so there is no
native module to rebuild against Electron's ABI and nothing to break at packaging time.

## What M2 measured, and what it cost the design

1. **`--print` will not run under a PTY** — *"Input must be provided either through stdin"*. A
   pseudo-terminal is not piped stdin. The `stream` transport therefore uses **real pipes**; only
   `pty` uses node-pty.
2. **The workspace-trust dialog blocks a fresh worktree**, and is skipped only in non-interactive
   mode. Second independent reason scheduled work runs on `stream` — on a PTY every dispatch would
   hang on a dialog with nobody there to answer.
3. **`stream-json` emits free live `rate_limit_event` records** with a status and a real `resetsAt`
   (`docs/cost-model.md` §5). Not a percentage, but most of what a preemption deadline needs, and it
   costs nothing because it rides a turn already being paid for.
4. **Anthropic's own desktop app drives its CLI the same way** — `--output-format stream-json
   --input-format stream-json --permission-prompt-tool`. Visible in the process list on this machine;
   independent confirmation of the transport choice.

## What M3 built, and what it still cannot see

**Works, and does not depend on a percentage:**

- **The cache clock**, six moves, in `cacheclock.ts`. Context size and TTL are both exact from the
  transcript, so this is real arithmetic. Every decision is recorded — including the ones that did
  nothing — so "why is that session still open?" is answerable from data.
- **Preemption at a window boundary**, driven by the reset time from the live `rate_limit_event`,
  which is exact. Preempted work goes to `paused_quota` with `not_before = resets_at` and resumes
  itself. ⛔ Never cancelled.
- **The estimator** over completed runs — median, never mean, with confidence reported.
- **Warm-session reuse for the same task**: a reply into a warm session costs `0.1·C` against `2.0·C`
  into a dead one, and a task waiting on a person now keeps its session rather than closing it.
- **The objective vector**, in exactly two consumers.

⚠️ **The compaction reserve reports `unknown` on a real worker today, and that is correct.** It needs
`remaining` in *tokens*, which needs a fresh percentage **and** a learned `tokens_per_percent`. There
is no free fresh percentage. So the gate is honest reporting, not yet load-bearing — it becomes
load-bearing the moment **R2** or **R3** lands. `docs/cost-model.md` §10.

**Not verified, and marked as such in the code:**

- **R6 — is `/compact` honoured as a user message on the `stream` transport?** The cache clock's
  compact move sends it that way. Inferred from the CLI's slash-command handling, not measured. If it
  is not, the fallback is handoff-and-close, which is already implemented.
- **Keepalive has never actually fired against a live session** — it needs a warm session and an idle
  hour. The arithmetic is unit-tested; the execution is not.

## Next: M4 — the controller agent

1. **The controller as a fleet member** with its own quota, so when its window runs low its next
   decision routes elsewhere. ⛔ Never in the scheduling loop — that loop is deterministic and free.
2. **Decomposition as a task** (plan §18.1): a `plan` task whose output is a set of *draft* children
   with dependency edges. Prompts are written at promotion, not at creation.
3. **Judgment events only**: ambiguous routing, failure triage, risk-gating agent-created work.
4. **Chat and thread panes** — talking to the controller, or to one agent directly.

## Open questions

- **Refreshing the quota cache without spending a turn.** Nothing found refreshes
  `cachedUsageUtilization` — not an interactive start, not a `-p` run. Until something does, M3 must
  build token accrual from the transcripts agentyard already meters exactly, calibrated against
  whatever readings do arrive. This is the biggest hole in the cost model — **R3** below is the
  experiment that closes or confirms it.
- **Auto-mode classifier cost on a subscription** (`docs/cost-model.md` §9). Documented as billable on
  Enterprise and API-billed accounts, unstated for Pro/Max/Team, and agentyard defaults Claude workers
  to `auto`. ⛔ Do not assume it is free — **R1** below measures it.
- **Vertex / Antigravity cache pricing.** Deliberately not guessed; `costmodels/` has the slot. M5.
- **Antigravity `ask`-hit shape.** That `agy` surfaces approvals over `stream-json` is inferred from
  its documented three-tier model, not measured. Verify at M5.
- **`expected idle` estimator** (plan §8.6). Cannot be designed further without real queue data. M3.
- **D7** stands: external resource services wrapped, never vendored. **D5 is closed** (plan §9.1).

## Measurement runs owed

These are the questions above turned into experiments. Each is cheap, each needs a **quiet worker**
(one session, nothing else running on that account), and each answers something the design is
currently guessing at. Run them when a window is otherwise idle; record the result in
`docs/cost-model.md` with the date and the CLI version, and delete the entry from here.

**The instrument.** agentyard meters *assistant turns* exactly from the transcript. Quota measures
*everything the account spent*. So the gap between them is everything the CLI spent that never reached
a transcript — the auto-mode classifier, title generation, whatever else. That gap is the measurement.

| # | Question | Method | What it changes |
|---|---|---|---|
| **R1** | Does the auto-mode classifier bill on a subscription? | Same shell-heavy task run twice on a quiet worker: once `--permission-mode auto`, once `default` with a narrow allowlist so nothing prompts. Read `/usage` by hand in a TUI before and after each. Compare (quota delta − transcript tokens) between the two runs | If it bills, `auto` stops being a free default and the objective vector has to price it. `docs/cost-model.md` §9 |
| **R2** | `tokens_per_percent` per (worker, model, tokenizer) | While exactly one session is live, sample `/usage` by hand at intervals and diff against transcript tokens over the same span | Turns percent into tokens, which is what every gate actually needs. Plan §8.5 |
| **R3** | What refreshes `cachedUsageUtilization`? | Note `fetchedAtMs`, then try in turn: `/usage` inside an interactive session · a long run · a fresh CLI start after some hours. Stop at the first that moves it | If anything does, the poller becomes real and R2 gets automatic. If nothing does, M3 must accrue tokens itself |
| **R4** | Real compaction cost end to end | Compact a session of known size; diff transcript tokens across the `compact_boundary` and record `durationMs` | Three samples so far (139k · 116k · **161k** ms). The spread matters more than the mean for the T+53m deadline |
| **R5** | Second account on a transplanted transcript | Commission a second worker, copy a small transcript into its root, `--resume`, complete one turn | Discovery is measured; completion is not. Shapes cross-account continuation. `docs/cost-model.md` §7 |
| **R6** | Is `/compact` honoured as a user message on the `stream` transport? | Send it into a live stream session and watch for a `compact_boundary` record in the transcript | The cache clock's compact move depends on it. If not, that move becomes handoff-and-close everywhere |
| **R7** | Does the live rate-limit `status` warn before it refuses? | Let one window fill while watching `rate_limit_samples` | Decides whether the live signal is an early warning or an obituary |

**R2 and R3 now block the compaction reserve**, which reports `unknown` until one of them lands. R1
and R6 change how the cache clock behaves. R5 needs a second subscription.

## Standing decisions worth not relitigating

- **Daemon, not all-in-Electron.** The premise is unattended progress across quota windows.
- **Deterministic scheduler; the LLM only on judgment events.** A loop running every 10s for weeks
  must not bill anything, and the fleet must survive the controller's own quota running out.
- **PTY-hosted CLI, transcript for state.** We own stdin, so `/compact` is a function call. But no
  ANSI parsing ever determines state.
- **The renderer never holds the daemon token.** It renders untrusted agent output.
- **Pooled git worktrees, task-named branches, trunk untouched by agents.**
- **Capabilities and objectives are data.** No `if (adapter === …)`, no `if (mode === …)`.
- **An approval is not a task; cancel is not delete.** Plan §7.3 and §7.4.
