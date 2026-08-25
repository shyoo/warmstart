# agentyard — Session Handoff

Multi-agent controller: a scheduler that routes coding-agent tasks to the worker, session and moment
where they are cheapest. Electron shell + `orchestratord` daemon. Windows now; macOS/Linux written
for, untested.

**This file is current state + what to do next. It is not a changelog.** Keep it **under 200 lines** —
if you add a line, find the one it obsoletes and cut it in the same edit. Finished work moves to
`transient_docs/changes_history.md`; a *rule* to `AGENTS.md`; a durable *fact* to `docs/`.

**Baseline (2026-08-25, M1):** `npm run typecheck` clean · `npm run build` clean · `npm test` 7/7 ·
21/21 daemon integration checks · app launches, commissions two workers and renders them.
Electron 44.0.0, Node 24.18.1 under Electron, 0 npm vulnerabilities.

---

## Where the build is

| Milestone | State |
|---|---|
| **M0** scaffold | ✅ repo, licence, docs, Electron shell |
| **M1** fleet substrate + commissioning | ✅ daemon, cost-model loader, workers, quota, PTY, transcript metering, fleet UI |
| **M2** tasks, threads, resources, authorship | ⬜ next — now also **approvals** (§7.3) and **cancel/delete** (§7.4) |
| **M3** cost intelligence | ⬜ the differentiator |
| **M4** controller agent | ⬜ |
| **M5** multi-provider (`antigravity-cli`, `openai-compatible`) | ⬜ |
| **M6** packaging | ⬜ |

Scope: `transient_docs/implementation_plan_2026-08-24.md` §14, as amended by **A1 (2026-08-25)** —
`gemini-cli` is retired, D5 closes per adapter (§9.1), approvals and cancel/delete are new objects.

## What exists

```
src/daemon/            orchestratord. Runs as Electron-with-ELECTRON_RUN_AS_NODE, detached.
  index.ts             entry: lock, db, server, poller, tailer wiring, shutdown
  server.ts  api.ts    HTTP+WS on 127.0.0.1:<random>, bearer token, typed RPC
  db.ts                node:sqlite + numbered migrations (v1)
  costmodel.ts         the four questions; user dir > bundled > compiled-in
  workers.ts           registry, isolation roots, retire-keeps-credentials
  quota.ts             the staleness ladder - read this before trusting a percentage
  sessions.ts          PTY spawn/attach, scrollback, orphan reconciliation
  transcript.ts        metering: iterations[], TTL split, cache clock  (+ .test.ts)
  which.ts             PATH resolution - node-pty does not do it
  adapters/            claude-code; capabilities + policy as data
src/main/              window host + the daemon's only client (holds the token)
src/renderer/          fleet strip, workers + wizard, doctor, xterm pane
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

## Next: M2 — tasks, threads, resources, authorship

1. **Task/Run schema + status machine**, including `paused_user` / `cancelling` / `cancelled` and the
   `cancel` record (plan §7.4). Migration v2.
2. **Cancel wind-down** reusing the preemption protocol: interrupt, wrap up, ⛔ release every claim
   even if the wrap-up fails, decide the session on the cache clock, cancel the subtree. Delete is
   separate, human-only, soft, and never removes runs.
3. **Approvals (plan §7.3).** The `Approval` object, the agentyard MCP server behind
   `--permission-prompt-tool`, project rules, the Approvals bar, remember-as-rule, and escalation to
   `awaiting_human` at 30 minutes. ⛔ Structured capture only — never read the terminal.
4. **Projects + `.agentyard/project.json`**, then the resource broker with **pooled git worktrees**
   as its first implementation, then the `auto-land` strategy.
5. **Scheduler v1**: admission, dependencies, hard quota gates, manual pinning.

**Spike still open from M1:** confirm a second account can complete a turn on a **transplanted
transcript** (`docs/cost-model.md` §7 — discovery is measured, completion is not). Needs a second
subscription; do it when one is commissioned.

## Open questions

- **Refreshing the quota cache without spending a turn.** Nothing found refreshes
  `cachedUsageUtilization` — not an interactive start, not a `-p` run. Until something does, M3 must
  build token accrual from the transcripts agentyard already meters exactly, calibrated against
  whatever readings do arrive. This is the biggest hole in the cost model.
- **Auto-mode classifier cost on a subscription** (`docs/cost-model.md` §9). Documented as billable on
  Enterprise and API-billed accounts, unstated for Pro/Max/Team, and agentyard defaults Claude workers
  to `auto`. Measure at M3 — same task, `auto` vs `default`. ⛔ Do not assume it is free.
- **Vertex / Antigravity cache pricing.** Deliberately not guessed; `costmodels/` has the slot. M5.
- **Antigravity `ask`-hit shape.** That `agy` surfaces approvals over `stream-json` is inferred from
  its documented three-tier model, not measured. Verify at M5.
- **`expected idle` estimator** (plan §8.6). Cannot be designed further without real queue data. M3.
- **D7** stands: external resource services wrapped, never vendored. **D5 is closed** (plan §9.1).

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
