# agentyard — Session Handoff

Multi-agent controller: a scheduler that routes coding-agent tasks to the worker, session and moment
where they are cheapest. Electron shell + `orchestratord` daemon. Windows now; macOS/Linux written
for, untested.

**This file is current state + what to do next. It is not a changelog.** Keep it **under 200 lines** —
if you add a line, find the one it obsoletes and cut it in the same edit. Finished work moves to
`transient_docs/changes_history.md`; a *rule* to `AGENTS.md`; a durable *fact* to `docs/`.

**Baseline (2026-08-25, M5):** `npm run typecheck` clean · `npm run build` clean · `npm test` 97/97 ·
`npm run test:daemon` 96/96 · `npm run test:ui` 21/21 · L4 (opt-in) landed a real agent commit on
origin/main. Electron 44.0.0, Node 24.18.1 under Electron, 0 npm vulnerabilities.
CLIs on this machine: claude 2.1.223 - agy 1.1.20 - codex 0.149.1.

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
| **M6** packaging | ⬜ next |

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
  adapters/            claude-code - antigravity-cli - openai-compatible; capabilities as data
                       (+ adapters.test.ts). Read docs/adapters.md before changing one
src/mcp/               the MCP server the agent CLI spawns. Two tiers, chosen by the daemon:
                       worker (task_complete, task_create, request_human, handoff) and controller
                       (fleet/task/approval/estimate). Target of --permission-prompt-tool. No delete.
src/main/              window host + the daemon's only client (holds the token)
src/renderer/          fleet strip, approvals bar, tasks, projects, workers, doctor, xterm pane
costmodels/            anthropic.* - google.antigravity.* - openai.codex.*; compiled in, not read
                       from disk, so a packaging slip cannot leave the scheduler unable to price
docs/                  cost-model.md, glossary.md, adapters.md - maintained; read before reasoning
                       about cost, vocabulary, or what a given CLI can actually do
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

## What M4 built

The controller: a judgment layer that is **never in the critical path**. The free scheduler enqueues a
question and carries on; a separate 30s loop answers it on a controller account; and every question
has a deterministic fallback that fires on a timer. ⛔ The fallback is the *normal* path — with no
controller account at all, the fleet behaves exactly as it did before M4.

Four events, each with its fallback: `decompose` (ask a person), `triage` (park it), `gate` (leave it
a draft), `route` (highest score). Unattended judgment has **no tools** and answers as JSON validated
against a closed set; tools go only to the chat session, where a person is watching. Full detail in
`transient_docs/changes_history.md`.

⚠️ **No consult has ever been answered by a real model** — every L1 check runs with nobody able to
answer, which proves the fallbacks but leaves the answer path exercised only against synthetic
answers in L0. R8 below.

## What M5 built, and what measuring cost the design

**Two adapters, and the milestone's real lesson.** `antigravity-cli` and `openai-compatible` were
written from vendor documentation, then both CLIs were installed and run — and **several documented
claims were wrong in ways that would have failed on the first spawn.** `docs/adapters.md` has the
full table; the ones worth carrying in your head:

- ⛔ **`--ask-for-approval` does not exist on `codex exec`.** Interactive-only. Every scheduled spawn
  would have died on an argument error.
- ⛔ **`-p` is `--profile` on codex and `--print` on agy.** Same letter, opposite meanings.
- **`agy` has `--mode accept-edits|plan`** after all — exactly what plan §9.1 predicted for a
  classifier-less CLI, and now its default.
- ⛔ **`cmd /d /s /c <shim>` breaks on any path containing a space**, and the Windows default home
  contains one. Latent since M1; never fired because `claude` resolves to a `.EXE` here. `codex`
  installs as `codex.cmd`, which exposed it.

**Capability-driven routing, proved four times over** — the plan expected two. None is a branch in
scheduling code:

| Gap | Consequence |
|---|---|
| no `/compact` | cache-clock moves 4 and 5 unavailable; `wrapUpProtocol: handoff` |
| no classifier | narrower allowlist written into the worker's config before each spawn |
| ⛔ no credential isolation | `maxAccounts: 1` — Antigravity keeps credentials in the **OS keyring** with no config-dir variable, so there is one identity per OS user. Commissioning refuses the second and says why |
| ⛔ no mintable session id | transcript discovered after the fact, and **orphans are never killed** — identity cannot be proved, and agentyard kills only what it can |

**A cost model may now say it does not know.** `cache.kind: "unpriced"` is a real state:
`canPriceCache()` returns false and the clock declines to spend on keepalive or compaction rather
than acting on an invented number. Google bills cache *storage per token-hour*; OpenAI caches
server-side with no client-controlled TTL. ⛔ Neither was converted into a write multiplier, because
an invented number is indistinguishable from a measured one at the point of use.

**Two holes M5 found in earlier work, both fixed:**

- A **reserve breach on a no-compact adapter did nothing** — the one case the reserve exists to
  catch. It now hands off and closes.
- **Commissioning left a window in which a signed-in worker was dispatchable** before it could be
  disabled, and the scheduler ticks every ten seconds. `worker.create` now takes `enabled: false`.
  Found by the M4 controller checks failing after M5 commissioned a real signed-in codex account.

⚠️ **Not verified, and the boundary is sharp:** everything above was measured for free. Everything
below needs a signed-in account and a real turn — the `stream-json` event shapes for both new
adapters, whether codex rollouts carry meterable usage, and whether `agy -p /usage` is the first free
quota probe agentyard has ever had. R9–R12 below.

## Next: M6 — packaging

1. **electron-builder**, and the natives that have to survive it. `node:sqlite` was chosen at M1
   precisely so there is no ABI rebuild here; `@lydell/node-pty` is the one that still has to.
2. **macOS/Linux path and PTY verification.** Written for, never run. `which.ts`, `launchable()` and
   every isolation-root default are where platform assumptions hide — and M5 just found a Windows one
   that had been latent for four milestones.
3. **Adapter loading from a directory**, so a community adapter needs no release.
4. Additional landing strategies (`leave-branch`, `pull-request`) and a public README pass.

## Open questions

- **Refreshing the quota cache without spending a turn.** Nothing found refreshes
  `cachedUsageUtilization` — not an interactive start, not a `-p` run. Until something does, M3 must
  build token accrual from the transcripts agentyard already meters exactly, calibrated against
  whatever readings do arrive. This is the biggest hole in the cost model — **R3** below is the
  experiment that closes or confirms it.
- **Auto-mode classifier cost on a subscription** (`docs/cost-model.md` §9). Documented as billable on
  Enterprise and API-billed accounts, unstated for Pro/Max/Team, and agentyard defaults Claude workers
  to `auto`. ⛔ Do not assume it is free — **R1** below measures it.
- **Vertex / Antigravity cache pricing.** Still not guessed, and now recorded as such: both new cost
  models declare `cache.kind: "unpriced"`, which the clock reads and declines to act on. Closing this
  needs a published figure, not an experiment.
- **Antigravity `ask`-hit shape — answered, and the answer is "there isn't one".** Headless `agy` has
  no approval callback at all: anything not pre-allowed is **soft-denied** while the run continues.
  That is why the allowlist is written into the worker's config before every spawn.
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
| **R9** | Does `agy -p /usage` run the slash command for free? | Run it on a quiet signed-in worker; compare against `/usage` typed into an interactive session | ⚠️ `--disable-slash-commands` is documented as disabling expansion *in print mode*, implying print mode expands them - the opposite of Claude Code. Would be **the first free quota probe agentyard has ever had** |
| **R10** | Does the codex rollout JSONL carry per-turn usage `transcript.ts` can meter? | Run one small task on a codex worker; open `$CODEX_HOME/sessions/**/rollout-*.jsonl` and look for per-turn token counts | If not, `meteredFromTranscript` is wrong and codex runs are invisible to the cost model - a bigger hole than pricing |
| **R11** | The `stream-json` / `--json` event shapes for agy and codex | One turn each, capture stdout verbatim | `stream.ts` parses Anthropic's records only. Until this lands, neither new adapter contributes rate-limit signal or result text |
| **R12** | Is headless compaction reachable on codex? | Try to drive compaction from `codex exec`; watch for a compaction record | If yes, `manualCompact` flips true and two cache-clock moves become available on that provider |
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
