# agentyard — Session Handoff

Multi-agent controller: a scheduler that routes coding-agent tasks to the worker, session and moment
where they are cheapest. Electron shell + `orchestratord` daemon. Windows now; macOS/Linux written
for, untested.

**This file is current state + what to do next. It is not a changelog.** Keep it **under 200 lines** —
if you add a line, find the one it obsoletes and cut it in the same edit. Finished work moves to
`transient_docs/changes_history.md`; a *rule* to `AGENTS.md`; a durable *fact* to `docs/`.

**Baseline (2026-08-26, M6 + a green CI matrix):** `npm run typecheck` clean · `npm run build` clean ·
`npm test` 126/126 · `npm run test:daemon` 100/100 · `npm run test:ui` 21/21 · `npm run test:pack`
15/15 · L4 (opt-in) landed a real agent commit on origin/main. Electron 44.0.0, electron-builder
26.15.3, 0 npm vulnerabilities. CLIs on this machine: claude 2.1.223 - agy 1.1.20 - codex 0.149.1.

⚠️ **On a machine with no agent CLI the daemon suite reports 95 passed and 6 skipped**, with a stated
reason each. That is the CI state, and it is why `summary()` prints skips beside the result instead of
folding them in. Simulated locally with a PATH of System32, node and git and an empty `HOME` — worth
doing before pushing, since it is what found several of the failures below.

**All ten CI jobs pass on all three platforms** (run 32940163319, 2026-08-26). ⚠️ That is the first
time macOS or Linux has run any of this. What it does *not* cover is below.

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
    external.ts        declarative adapters from <dataDir>/adapters/*.json  (+ external.test.ts)
    generic.ts         the driver behind one. ⛔ JSON only, never JavaScript
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

## What M5 built

Two more adapters - `antigravity-cli` (agy 1.1.20) and `openai-compatible` (codex 0.149.1) - written
from vendor documentation and then **corrected by running the CLIs**. Several documented claims were
wrong in ways that would have failed on the first spawn, which is why `AdapterInfo.verification`
records whether a capability block was measured or merely read.

Capability-driven routing proved four times over rather than the two the plan expected: no `/compact`,
no classifier, ⛔ **no credential isolation** (Antigravity keeps its credential in the OS keyring, so
one machine holds one account) and ⛔ **no mintable session id** (so orphans are never killed - identity
cannot be proved). A cost model may now declare `cache.kind: "unpriced"` and the clock declines to
spend rather than acting on an invented number.

A follow-up using real accounts measured the stream formats: ⛔ **there is no such thing as "the
stream-json format"** - agy keys on `event`, not `type`, and a parser keyed on the wrong envelope
reads *nothing*, silently. Decoding now belongs to the adapter. Both new CLIs report usage in the
stream, so `metering` is three-valued and their runs are billed from the wire.

Full detail, including every corrected claim, in `transient_docs/changes_history.md` and
`docs/adapters.md`.

## What M6 built, and what packaging exposed

**It packages, and there is a suite that proves it.** `npm run dist` produces an installer;
`npm run test:pack` builds a real package and then *drives it* — which is the only suite that can
fail for reasons none of the others can see. L0–L4 all run from a source tree with `node_modules` on
disk; a packaged app has its code inside an asar, its natives outside one, and no system Node at all.

The four things it checks are the four ways to ship something that passed every test and does not
start: the native terminal module was unpacked **out** of the archive, none was left inside it, the
app can launch its own daemon by running its own binary as Node, and a PTY actually opens from the
packaged build. 14/14.

**What packaging exposed, which nothing else would have:**

- ⚠️ The `asarUnpack` glob was **wrong and it did not matter** — electron-builder auto-unpacks
  anything containing a `.node`, so it worked by accident. The `.node` files are not in
  `@lydell/node-pty`; they are in per-platform siblings (`node-pty-win32-x64`). Now explicit, because
  relying on that silently is how a version bump breaks a PTY nobody connects to the change.
- A packaged app on a cold start is slower than a development one — Defender inspects a freshly
  written unsigned binary the first time it runs — so the suite polls rather than sleeping once.

**Also landed:**

- **Declarative adapters** from `<dataDir>/adapters/*.json`. ⛔ JSON, never JavaScript: the daemon
  holds the RPC token, spawns agents and knows every credential root, and loading code from a
  directory anything can write to would put all of that behind a file permission. A declaration
  cannot grant itself MCP tools, a mintable session id, metering, or a quota probe — each is a
  refusal with a test, and each refusal is what stops a typo becoming trust.
- **`pull-request` landing**, wrapping `gh` rather than the GitHub API (D7), so agentyard never holds
  a token. It pushes first and opens the PR second, deliberately: if the PR call fails the work is
  already safe on the remote. ⚠️ It does **not** rebase and does **not** run the project's checks —
  that is what the pull request is for.
- **`killTree` now verifies identity before it fires.** It killed a pid it had written down earlier;
  pids are recycled, and a `finally` block running seconds later could kill a stranger. The *product*
  has guarded against this since M2 (`ownsProcess`); the harness did not, and it is the harness that
  has damaged this machine before.

⛔ **The honest limit of this milestone: macOS and Linux have never been run.** The targets are
configured, the platform branches exist, `test:pack` is written to work on all three — and it has only
ever executed on Windows. M5 found a Windows path bug that had been latent for four milestones; there
is no reason to believe the other two platforms are cleaner. Treat them as unbuilt, not as untested.

## CI, and the dispatch bug it found

`.github/workflows/ci.yml` runs four jobs, none of which can spend a token: `check` (ubuntu),
`daemon`, `ui` and `pack` (all three platforms). ⛔ `test:e2e` is the only suite that spends and is
never invoked there.

Teaching the suites to run without a CLI was the cheap part. Simulating a bare runner locally failed
five checks, and **four of them were one product bug**: the not-signed-in gate string-matched the probe
output for `"loggedIn": false`, and `refreshIdentity` had been throwing the `loggedIn` field away. A
probe that failed because no binary existed returned an error string instead, the gate passed, and the
scheduler dispatched to a worker that could not possibly work — claiming a workspace to find out.

Now: `WorkerIdentity.loggedIn` is stored and the gate reads `=== false` (⚠️ `null` still means unknown
and is let through, or Antigravity's keyring-backed workers would be permanently undispatchable), and
**`isInstalled()` is a separate hard gate** on every candidate — a filesystem lookup, so it costs
nothing every tick, unlike `detect()`.

### What the first runs actually found (2026-08-26)

**All ten jobs green on run 32940163319.** macOS and Linux have now run this code. It took five runs,
and none of the failures were the POSIX bugs the matrix was written to catch — the first three were
CI asserting things about the author's machine:

1. **Electron 44 has no postinstall.** It ships `install-electron` as a bin and leaves the ~110MB
   download to the caller. README and AGENTS.md both blamed "your npm blocked the postinstall", which
   sent people looking for a setting that does not exist. `scripts/ensure-electron.mjs` retries
   (`@electron/get` does not) and reports whether the release host is reachable, because undici hides
   the cause behind a bare `TypeError: fetch failed`. CI caches the runtime so one job downloads it.
2. **Unit tests that needed a CLI installed.** `plan()` resolves the command through `which()` before
   building an argv, so every argv assertion required an agent CLI. Three threw. The fourth — no
   adapter leaks a vendor API key into a commissioned session — *caught the throw, `continue`d past
   all three adapters, and reported green having asserted nothing.* A PATH stub fixes both. ⛔ The
   stub proves nothing about the CLIs and is not meant to; the argv is a property of this repository.
3. **Three suites asserting where they ran.** A dispatch refusal that matched only one of three
   sentences; a reserve check counting `=== 2`, true only with a `~/.claude` to adopt; and adapter
   *counts*, which quietly asserted nobody ever declares an external adapter — the thing M6 allows.
4. **`electronBinary()` could never have worked on macOS.** It guessed `dist/electron.exe` or
   `dist/electron`; macOS is `dist/Electron.app/Contents/MacOS/Electron`. It reads `path.txt` now.
5. **Linux runners restrict unprivileged user namespaces**, so Chromium's sandbox cannot start and
   the window never opens. ⛔ Fixed with a sysctl on the runner, not `--no-sandbox` on the app, which
   would turn the square green by testing a configuration nobody runs.

⛔ **And one real product bug, which only Linux could show.** `handleExit` dropped the session from
`live`, `emitData` returned early without an entry, and `backscroll` read `live` — so a process that
wrote and exited in the same tick lost **every byte**, and anything asking afterwards got `''`.
Windows never showed it because conpty delivers data before the exit. ⚠️ The discarded output is the
output most worth keeping: a `login` session that fails prints its reason and exits, and the pane went
blank at that moment. Sessions now retain their last screen after exiting, bounded on both axes.

⚠️ The first regression check written for that bug **passed against the unfixed daemon.** It waited
for `state === 'running'` and there is no such state (`starting | live | idle | closed | failed`), so
it was true on the first iteration. Reverting the fix is what exposed it, and is how it is verified
now: 0 bytes without, 91 with. ⛔ A regression test nobody has watched fail is a comment.

**Two suites need a certainly-installed command** — does the PTY native load, does an exited session
keep its output — and no *agent* CLI qualifies. `writeProbeAdapter()` in the harness declares an M6
external adapter pointing at `cmd`/`sh`: it echoes one line and exits, and the generic driver cannot
grant it `mcp`, `metering` or `mintsSessionId`, so it cannot become anything but a probe.

⚠️ Still unproven on macOS and Linux: everything that needs a real agent CLI. The runners have none,
so those checks skip there exactly as they do on a bare developer machine.

## Next

M0–M6 are done. What is left is not a milestone but a list, in the order it would pay off:

1. **Run the suites on macOS or Linux with an agent CLI installed.** CI proved the three platforms
   build, start, package and schedule; it cannot prove a single thing about spawning a real agent
   there, because a runner has no CLI and may not sign in to one. Every adapter capability in
   `docs/adapters.md` was measured on Windows only.
2. **The measurement runs still owed** — R2/R3 unblock the compaction reserve, which is the largest
   piece of the cost model still reporting `unknown` on a real worker.
3. **Signing and notarisation**, without which the installers warn or refuse.
4. **Warm-session reuse across tasks in one project** — the biggest remaining cost win, and the
   reason it is not done is in the scheduler's own comment: the workspace claim has to move from the
   task to the session first.

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
- **D7** stands, and M6 is its second instance: `gh` is wrapped for pull-request landing rather
  than agentyard talking to the GitHub API and holding a token. **D5 is closed** (plan §9.1).
- **An icon.** electron-builder ships the default Electron one. Cosmetic, but it is the first thing
  anyone sees.

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
- **Capabilities and objectives are data.** No `if (adapter === …)`, no `if (mode === …)`. M5 tested
  this against three real CLIs and it held; M6 extended it to adapters an operator declares in JSON.
- **Measure, then write it down.** Every adapter says whether its capabilities were *measured* or
  *documented*, because M5 wrote two from vendor docs and several claims were wrong enough to fail on
  the first spawn.
- **⛔ Kill only what you can prove is yours.** The product has checked a pid's command line since M2;
  M6 made the test harness do the same, after a question about a Claude Code window that restarted.
- **An approval is not a task; cancel is not delete.** Plan §7.3 and §7.4.
