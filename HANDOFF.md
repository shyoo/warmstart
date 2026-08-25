# agentyard — Session Handoff

Multi-agent controller: a scheduler that routes coding-agent tasks to the worker, session and moment
where they are cheapest. Electron shell + `orchestratord` daemon. Windows now; macOS/Linux written
for, untested.

**This file is current state + what to do next. It is not a changelog.** Keep it **under 200 lines** —
if you add a line, find the one it obsoletes and cut it in the same edit. Finished work moves to
`transient_docs/changes_history.md`; a *rule* to `AGENTS.md`; a durable *fact* to `docs/`.

**Baseline (2026-08-24, commit: M0 scaffold):** `npm run typecheck` clean, `npm run build` clean,
app launches with no console errors, preload bridge and `app:info` IPC round-trip verified, window
renders the zero-state. Electron 44.0.0, Node v22.19.0, 0 npm vulnerabilities.

---

## Where the build is

**M0 (scaffold) is done.** Everything below M0 is not started.

| Milestone | State |
|---|---|
| **M0** scaffold | ✅ repo, licence, docs, Electron + Vite + TS shell that opens |
| **M1** fleet substrate + commissioning | ⬜ next |
| **M2** tasks, threads, resources, authorship | ⬜ |
| **M3** cost intelligence | ⬜ the differentiator |
| **M4** controller agent | ⬜ |
| **M5** multi-provider | ⬜ |
| **M6** packaging | ⬜ |

Scope of each: `transient_docs/implementation_plan_2026-08-24.md` §14, **as amended by A1
(2026-08-25)**: `gemini-cli` is off the roadmap, D5 closes per adapter (§9.1), and M2 gains approvals
(§7.3) and cancel/delete (§7.4).

## What exists

```
src/main, src/preload   Electron shell. Window host only. Sandboxed preload (CJS - see AGENTS.md).
src/renderer            React 19 + Vite. Zero-state UI, design tokens, dark + light themes.
src/shared/ipc.ts       AppInfo contract. Deliberately thin - the real channel is the daemon's.
src/daemon/             README only. orchestratord is M1.
costmodels/             anthropic.subscription.2026-08.json - the first cost model.
docs/                   cost-model.md, glossary.md. Both maintained; read before reasoning about cost.
transient_docs/         implementation_plan_2026-08-24.md - design of record, D1-D18 with reasoning.
```

## Next: M1 — fleet substrate + commissioning

Goal: *"Anyone can add their accounts and drive them from one window."* M1 alone replaces manually
juggling several agent windows. Suggested order — each step is independently verifiable:

1. **`orchestratord` skeleton** (`src/daemon`). Long-lived Node process, single-instance lock,
   SQLite via `better-sqlite3` with numbered migrations, HTTP + WS on `127.0.0.1` at a random port,
   token written to a mode-600 file the UI reads. Electron connects as a client and shows the real
   status in the existing status bar (it currently hard-codes *not running (M1)*).
   ⚠️ Native modules go **here**, never the renderer.
2. **Cost-model loader.** Read `costmodels/*.json`, expose `costOfKeepalive` / `costOfCompact` /
   `costOfColdStart` / `cacheExpiryFor`. Do this early — everything downstream asks it questions, and
   building it late invites inline arithmetic. See `docs/cost-model.md` §8.
3. **Worker registry + commissioning wizard.** Settings → Workers: adapter detection (`claude`,
   `agy` on PATH — ⛔ not `gemini`, retired 2026-06-18), isolation root creation (`<appdata>/agentyard/workers/<slug>`) or adoption of an
   existing one, **login via embedded PTY running the vendor CLI** (agentyard never touches a
   credential), verify + label via `probeQuota`, policy (enabled, human-occupied, max concurrent —
   default 1, allowed projects). Plus the **Doctor** panel.
   ⛔ Nothing machine-specific may be hard-coded; the app must open on a clean profile with zero
   workers, say so, and offer the wizard. The current zero-state already does the "say so" half.
4. **Quota poller.** `claude -p /usage` with the `.claude.json` `cachedUsageUtilization` fallback.
   Per account, on an interval and after each run. Isolated module with a hard fallback: on any parse
   failure, log once and degrade conservatively rather than stalling the scheduler.
5. **PTY spawn/attach.** `@lydell/node-pty`, minted `--session-id` so the transcript path is known
   before the process starts. Stream bytes to the UI over WS; xterm.js + fit + serialize so backscroll
   survives the UI reopening. Read-only until "take the keyboard" is toggled.
6. **Transcript tailer.** Per-turn usage summing `usage.iterations[]`, `cache_creation` split by TTL,
   context size, idle **from request start**, `effort`, `gitBranch`. This is the metering layer and it
   must be exact — see `docs/cost-model.md` §6 for the three traps.
7. **Fleet strip + sidebar.** Quota bars, reset countdowns, per-session cache countdown (amber T+45m,
   red T+53m). Tabular numerals are already wired via `.num` / `.mono`.

**Spike inside M1:** once a second account is logged in, confirm it can actually complete a turn on a
**transplanted transcript** (`docs/cost-model.md` §7 — discovery is measured, completion is not). The
answer shapes how M3 builds cross-account continuation.

## Open questions

- **Vertex / Antigravity cache pricing.** The Google pricing page truncated on two fetch attempts on
  2026-08-24 and the numbers were deliberately not guessed. `costmodels/` has the schema slot. Fill at
  M5 when the adapter is built. ⛔ Do not populate from memory.
- **`expected idle` estimator** (implementation plan §8.6). The keepalive-vs-compact choice is only as
  good as this, and it cannot be designed further without real queue data. M3 ships a crude version
  (queue depth + dependency readiness + median human response latency) and improves it from `events`.
- **Auto-mode classifier cost on a subscription** (`docs/cost-model.md` §9). Billable on Enterprise
  and API-billed accounts; unstated for Pro/Max/Team, and agentyard defaults Claude workers to `auto`.
  Measure at M3. ⛔ Do not assume it is free.
- **D7** remains on its recommendation: external resource services wrapped, never vendored. **D5 is
  closed** — permissions come from a capability, not a global default (plan §9.1).

## Standing decisions worth not relitigating

Full record with reasoning in `transient_docs/implementation_plan_2026-08-24.md`. The ones most often
re-questioned:

- **Daemon, not all-in-Electron.** The premise is unattended progress across quota windows. If closing
  the window kills the fleet, the product does not work.
- **Deterministic scheduler; the LLM only on judgment events.** A loop running every 10s for weeks must
  not bill anything, and the fleet must survive the controller's own quota running out.
- **PTY-hosted CLI, transcript for state.** We own stdin, so `/compact` is a function call rather than
  UI automation. But no ANSI parsing ever determines state.
- **Pooled git worktrees, task-named branches, trunk untouched by agents.**
- **Capabilities and objectives are data.** No `if (adapter === …)`, no `if (mode === …)`.
