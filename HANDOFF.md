# agentyard — Session Handoff

Multi-agent controller: a scheduler that routes coding-agent tasks to the worker, session and moment
where they are cheapest. Electron shell + `orchestratord` daemon. Windows now; macOS/Linux written
for, untested.

**This file is current state + what to do next. It is not a changelog.** Keep it **under 200 lines** —
if you add a line, find the one it obsoletes and cut it in the same edit. Finished work moves to
`transient_docs/changes_history.md`; a *rule* to `AGENTS.md`; a durable *fact* to `docs/`.

**Baseline (2026-08-25, M4):** `npm run typecheck` clean · `npm run build` clean · `npm test` 78/78 ·
`npm run test:daemon` 79/79 · `npm run test:ui` 21/21 · L4 (opt-in) landed a real agent commit on
origin/main. Electron 44.0.0, Node 24.18.1 under Electron, 0 npm vulnerabilities.

---

## Where the build is

| Milestone | State |
|---|---|
| **M0** scaffold | ✅ repo, licence, docs, Electron shell |
| **M1** fleet substrate + commissioning | ✅ daemon, cost-model loader, workers, quota, PTY, transcript metering, fleet UI |
| **M2** tasks, threads, resources, authorship | ✅ tasks + DAG, cancel/delete, approvals, projects, worktree pool, auto-land, scheduler v1 |
| **M3** cost intelligence | ✅ cache clock, compaction reserve, objective vector, estimator, preemption, watchdogs |
| **M4** controller agent | ✅ consult queue + fallbacks, four judgment events, controller MCP tier, chat + thread panes |
| **M5** multi-provider (`antigravity-cli`, `openai-compatible`) | ⬜ next |
| **M6** packaging | ⬜ |

Scope: `transient_docs/implementation_plan_2026-08-24.md` §14, as amended by **A1/A2/A3 (2026-08-25)**
— `gemini-cli` is retired, D5 closes per adapter (§9.1), approvals and cancel/delete are new objects,
decomposition is a roadmap not a DAG (§18.1), and a judgment event is a **queued question with a
deterministic fallback** rather than a call the scheduler makes (§11.1).

## What exists

```
src/daemon/            orchestratord. Runs as Electron-with-ELECTRON_RUN_AS_NODE, detached.
  index.ts             entry: lock, db, server, poller, scheduler, tailer wiring, shutdown
  server.ts  api.ts    HTTP+WS on 127.0.0.1:<random>, bearer token, typed RPC
  db.ts                node:sqlite + numbered migrations (v4)
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
  controller.ts        the consult queue, the caps, and choosing who answers (+ controller.test.ts)
  judgment.ts          the four events: question, closed answer set, fallback (+ judgment.test.ts)
  chat.ts              the one place the controller gets tools - a person is watching
  estimator.ts         what a task will cost, from what tasks have cost
  stream.ts            stream-json records: the free live rate-limit signal
  projects.ts          .agentyard/project.json; policy committed, state private
  resources.ts         the broker - if the scheduler owns the claim, the lock is unnecessary
  worktrees.ts         pooled worktrees, task-named branches, prepare hook
  landing.ts           LandingStrategy; auto-land, serialised by an exclusive land: resource
  which.ts             PATH resolution - node-pty does not do it
  adapters/            claude-code; capabilities + policy as data
src/mcp/               the MCP server the agent CLI spawns. Two tiers, chosen by the daemon:
                       worker (task_complete, task_create, request_human, handoff) and controller
                       (fleet/task/approval/estimate). Target of --permission-prompt-tool. No delete.
src/main/              window host + the daemon's only client (holds the token)
src/renderer/          fleet strip, approvals bar, tasks, projects, workers, doctor, xterm pane
costmodels/            anthropic.subscription.2026-08.json
docs/                  cost-model.md, glossary.md — maintained; read before reasoning about cost
```

## What M1-M3 measured, and what it cost the design

⛔ Read `transient_docs/changes_history.md` before re-deriving any of this. The five findings that
still constrain every design decision:

1. **`claude -p /usage` is not free and does not report usage** — the slash command is taken as a
   prompt and spends a real turn. There is no free live quota probe, so `quota.ts` reports a **rung**
   and an **age**, and stale readings render as *unknown*.
2. **`--print` will not run under a PTY**, and the **workspace-trust dialog blocks a fresh worktree**
   outside non-interactive mode. Two independent reasons scheduled work runs on `stream` (real pipes)
   and only human sessions run on `pty`.
3. **`stream-json` emits free live `rate_limit_event` records** with a status and a real `resetsAt`.
   Not a percentage, but exactly what a preemption deadline needs, and it rides a turn already paid
   for. It is why preemption works without a percentage.
4. **node-pty does not search PATH** — everything goes through `which.ts`.
5. **`claude auth status --json` is free, local, and exits 1 while printing valid JSON** — read the
   stdout, never the exit code.

⚠️ **The compaction reserve still reports `unknown` on a real worker, and that is correct.** It needs
`remaining` in *tokens*, which needs a fresh percentage **and** a learned `tokens_per_percent`, and
there is no free fresh percentage. Honest reporting, not yet load-bearing — it becomes load-bearing
the moment **R2** or **R3** lands. `docs/cost-model.md` §10.

⚠️ **Two M3 paths remain unverified and are marked in the code:** whether `/compact` is honoured as a
user message on the `stream` transport (**R6**), and keepalive *execution*, which needs a warm session
and an idle hour. The arithmetic is unit-tested; the firing is not.

## What M4 built, and what it deliberately refuses to do

**The shape, and it is the whole point.** Two loops. The scheduler runs every 10s, costs nothing, and
when it wants judgment it **enqueues a question and carries on**. A second loop runs every 30s, is the
only loop in the daemon that can spend, and drains that queue one question at a time on a controller
account. ⛔ **Every question has a deterministic answer before it is asked**, and that answer fires on
a timer whether or not the controller ever replies.

So the fallback is the *normal* path, not the error path: on a fresh install, on an account out of
quota, at 3am with the controller's own window closed, the fleet behaves exactly as it did before M4.

**The four judgment events.**

| Event | Fires when | Falls back to |
|---|---|---|
| `decompose` | a `plan` task becomes ready | ask a person to break it up. ⛔ Never guesses a plan |
| `triage` | a task has failed twice | park it for a person — where the deterministic path already put it |
| `gate` | an agent files a task that commits, pushes, or outspends its parent (§7.2) | leave it a `draft`, which holds nothing |
| `route` | two candidates within ε **and** the task is over 150k tokens | the highest-scoring worker |

**Three structural bounds** (plan §11.1 has the reasoning):

1. ⛔ **A consult has no tools.** It answers with JSON validated against a closed set. A hallucinated
   worker id is a validation failure, not a dispatch; an unknown model is refused rather than passed
   to a CLI to fail on a real account; a **forward dependency edge is rejected, making a cycle
   impossible by construction** rather than detectable afterwards.
2. **Its most open-ended output lands in `draft`** — dispatches nothing, assigned to nobody.
3. **Capped:** one per worker, one in flight fleet-wide, 20/hour, plus a per-subject cooldown so a
   task failing every tick is not re-diagnosed every tick.

**Leadership delegation is just the gates.** `role` is `worker | controller | both`, default `both`
so a one-account install works unconfigured. Above 80% of a *trusted* 5h reading, or on a live
rate-limit status that is not `allowed`, an account stops being chosen; when none is left the fallback
answers. Nothing special happens at the floor — that *is* the floor.

**Tools live in exactly one place: the chat session**, because a person is watching. It runs in the
operator's home directory (no branch to throw away), so it uses the adapter's *prompting* mode and its
tool use goes through the same approval policy and Approvals bar as an agent's. The tier comes from
the MCP config the daemon writes, so an agent cannot promote itself with an environment variable.
⛔ Neither tier has `task_delete`.

**Also landed:** a note typed into a running task is delivered into its live session — `0.1·C`, and it
refreshes the TTL — and marked delivered so the next prompt does not charge for it twice (§18.4).

⚠️ **No consult has ever been answered by a real model.** Every L1 check runs with nobody able to
answer, which is deliberate and proves the fallbacks — but the *answer* path (spawn, one turn, JSON
out, apply) has only been exercised against synthetic answers in L0. **R8** below.

## Next: M5 — multi-provider

1. **`antigravity-cli` (`agy`)** as the second adapter. Two capability differences prove the design
   twice over: no `/compact`, and no classifier-backed auto (§9.1). Both must express themselves as
   missing capabilities, never as a branch in scheduling code.
2. **`openai-compatible`** as the third, and the second and third **cost models** to go with them.
   ⛔ Vertex and Antigravity cache pricing is deliberately not guessed; `costmodels/` has the slot.
3. **Verify the Antigravity `ask`-hit shape.** That `agy` surfaces approvals over `stream-json` is
   inferred from its documented three-tier model, not measured.

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
- **`expected idle` estimator** (plan §8.6). Cannot be designed further without real queue data.
- **Are the consult prompts good enough?** Unknown, and it is the honest gap in M4: the validators are
  tested, the fallbacks are tested, but no real model has yet answered one. **R8** measures it. ⛔ If
  replies fail validation the prompt is wrong, not the validator — never widen a closed set to fit a
  reply.
- **Warm-session reuse across tasks in one project.** The bigger cost prize and still not done: it
  needs the workspace claim to move from the task to the session, so a session can outlive the task
  that opened it without leaking a claim or switching a branch under a running agent.
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
| **R8** | Does a real model answer a consult in the shape the validators accept? | Designate a controller, file a `plan` task, run `controller.drain`, read the row: `answered` or `fallback`, and the `fallbackReason` if it fell back | The one M4 path L1 cannot reach. If replies routinely fail validation the prompts are wrong, not the validators — ⛔ never loosen the closed set to make a reply fit |

**R2 and R3 now block the compaction reserve**, which reports `unknown` until one of them lands. R1
and R6 change how the cache clock behaves. R5 needs a second subscription.

## Standing decisions worth not relitigating

- **Daemon, not all-in-Electron.** The premise is unattended progress across quota windows.
- **Deterministic scheduler; the LLM only on judgment events, and never inline.** The free loop
  enqueues a question; a separate loop answers it; every question has a deterministic fallback on a
  timer. A loop running every 10s for weeks must not bill anything, and the fleet must survive the
  controller's own quota running out — including surviving there being no controller at all.
- **The controller is a source of preference, never of instructions.** Unattended judgment has no
  tools and answers as JSON validated against a closed set. Tools go only to the chat session, where
  a person is watching.
- **PTY-hosted CLI, transcript for state.** We own stdin, so `/compact` is a function call. But no
  ANSI parsing ever determines state.
- **The renderer never holds the daemon token.** It renders untrusted agent output.
- **Pooled git worktrees, task-named branches, trunk untouched by agents.**
- **Capabilities and objectives are data.** No `if (adapter === …)`, no `if (mode === …)`.
- **An approval is not a task; cancel is not delete.** Plan §7.3 and §7.4.
