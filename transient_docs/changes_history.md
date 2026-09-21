# agentyard — changes history

What earlier milestones **measured**, and what each measurement cost the design. Moved out of
`HANDOFF.md`, which is current state rather than a changelog. ⛔ Durable facts live in
`docs/cost-model.md`; this file keeps the reasoning and the dates.

## Detecting expired subscriptions and distinguishing them from setup and auth failures (2026-09-02)

When an agent's paid subscription lapses (such as Claude Code subscription access being revoked or expired),
the account previously showed up in Workers as "Setup Unfinished" (with an unhelpful "Finish Setup" button)
and "Held out of Dispatch", and its quota badge displayed "quota unknown".

Investigating `.claude.json` and the process failures revealed:
1. When a subscription lapses, `oauthAccount.billingType` is set to `'none'` (versus `'stripe_subscription'`).
   Because onboarding cannot complete without active access, `hasCompletedOnboarding` is missing and previously caused `firstRunComplete` to return `false`.
2. When a turn is attempted, Claude Code exits immediately with `"Your organization has disabled Claude subscription access for Claude Code..."`.
3. An expired subscription is not an authentication failure (re-authenticating will not fix it) and not a first-run setup failure (onboarding screens cannot be completed).

Fixes:
- Added `subscriptionExpired` capability method to `AgentAdapter` and fields to `WorkerHealth` and `WorkerIdentity`.
- `claude-code` adapter detects `billingType === 'none'` in `.claude.json` during `probeIdentity`, `probeQuota`, and `firstRunComplete` (returning `null` instead of `false` so "setup unfinished" is suppressed).
- `recordDispatchFailure` stamps `subscriptionExpired: true` on suspect health when an adapter identifies an expired subscription failure.
- `eligibility.ts` directly gates accounts with expired subscriptions from dispatch.
- `quotaGap` and `FleetStrip` render "Subscription expired" with a warning/danger indicator instead of "quota unknown" or "no usage data yet".
- `Workers.tsx` displays "Subscription Expired" under Account and Quota with clear guidance to renew and Recheck.

## Two numbers about one account, and nothing to reconcile them (2026-08-31, t70)

t70 was wrapped up at the top of its five-hour window while the fleet card over that account read
**63%**. Both numbers were honestly reported. The trigger was a live `rate_limit_event` riding a turn
already being paid for; the card was the last thing the vendor happened to write to its own cache.
The operator's question — *why did that stop?* — had no answer anywhere in the app.

Pulling on it found four separate faults, and a fifth beside them:

1. **The "5-minute probe interval" was a five-minute re-read of a file somebody else writes.**
   `probeWorker` reads `cachedUsageUtilization`; only `refreshUsage` makes it current, and that was
   behind a two-hour floor for *every* account. The floor was right — 150 probe PTY sessions against
   14 that did work, measured over four days — but it was applied to the one account whose window was
   actually moving. A worker with a run in flight is now refreshed on the active cadence; an idle one
   is not refreshed by any clock at all and gets its own, slower *re-read* setting
   (`idleProbeIntervalMinutes`, 20m). The poller no longer runs on `setInterval`: it asks
   `probeDemand()` what the fleet is doing and computes its next delay.

   ⭐ **This met `main`'s answer to the same problem in the rebase, and the two agree.** 225751c had
   already deleted the sweep's refresh clock outright and moved freshness to `ensureFreshQuota()` at
   the dispatch gate and at the end of a run, backing off on the *attempt* rather than the reading's
   age. That is the same rule from the other end — spend a terminal when something is about to act on
   the number — so the merged code keeps one ledger (`refreshAttempts`) with two entry points:
   `ensureFreshQuota` (fire-and-forget, for the gate) and `refreshNow` (awaited, for the sweep, with
   the caller's own floor under `MIN_FORCED_GAP_MS`). Nothing refreshes on a clock any more; the
   sweep only asks when the fleet has named a reason.
2. **The free live signal was recorded and acted on by nobody.** `recordRateLimit` wrote a row and
   warned to the log. It now also files an urgent probe request, which wakes the poller — so the
   number on the card catches up with the number that made the decision. A quota preemption files one
   too, and the preemption message now quotes the cached reading *and its age* beside the trigger,
   because "63% vs 93%" is only confusing while the two are unattributed.

   ⭐ This gained a second purpose in the rebase. `main`'s later fix (*A caution read as a refusal*)
   stopped an `allowed_warning` preempting on its own — it now needs this fleet's own reading of
   **that window** to agree at ≥80%. Which means the advisory's real job is to make us go and look,
   and going and looking is exactly what `requestUrgentProbe` does with it.
3. **A parked task waited on the poller's interval, not on its own reset time.** A task due back at
   06:39 on a 20-minute cadence was looked at whenever the sweep next came round. The poller now
   schedules a forced refresh 30 seconds past the earliest `not_before` (`RELEASE_PROBE_GRACE_MS` —
   not zero, because the window is emptied *at* the boundary and probing on the dot reads the old one
   one last time).
4. **`not_before` was the only test a park was ever released by**, and it is a *prediction* made at
   the moment of parking — on the overrun path, `now + 5h` by arithmetic when a rate-limit warning
   carries no reset time. Measured by hand: a probe read the window at **0% used** and every task on
   that account stayed parked. `quotaReleaseFor` is the second test, held to exactly the dispatch
   gate's standard (fresh, not from a window that has since rolled, below `QUOTA_HIGH_WATER`); an
   expired window releases on its own terms. Anything looser would release a task the next tick would
   immediately hold again, which is worse than staying parked because it costs a message every time.
5. **`QuotaWindow.group` was dropped on the way into the store.** The per-pool gate — Antigravity
   meters Gemini apart from Claude/GPT — was measured against in-memory windows on 2026-08-27 and has
   been inert for every reader that goes through `quota_samples` ever since, which is every gate:
   `sessionWindowFor` found no group and fell back to the **busiest** pool on the account. Migration
   26 adds the column. Found by a test that seeded a two-pool reading through the store and could not
   reproduce a behaviour the docs said had been measured.

⚠️ **None of it has run in flight.** 52 unit checks cover it — `quotaprobing.test.ts` for the pacing
and the side channel, `quotacycle.test.ts` for a fleet of parked tasks across three agents being
released (or not) by clock, by measurement, by pool and by staleness. The durable facts are in
`docs/cost-model.md`.

## One estimate for six agents, when they differ by 81x (2026-08-30)

`estimateTask` medianed every completed run together, so the fleet had one number for "work like
this" regardless of who would do it. Measured on this install, 73 completed runs: the median run on
`antigravity-cli/gemini-3.7-flash-medium` totalled 12,477,352 tokens against 153,091 on
`claude-code/claude-sonnet-5`. **81x, and 93x after pricing** — so this was not an accounting artefact
of cache reads, it was the work itself.

The single median (2,921,371) sat between the humps and described neither. Two consequences, both
live: every Antigravity run stood at ~4x its estimate before doing anything unusual, against a
runaway watchdog that fires at 3x, while a Sonnet run could not reach 3x by being genuinely wasteful;
and the parent-budget gate admitted Antigravity children against budgets twenty times too small.

The estimate is now `size(task) × factor(adapter, model)`, priced in input-token-equivalents by a new
`CostModel.priceRun`, with `runs.adapter_id` and `runs.model` stamped on the run (migration 23) so the
key outlives the session — 17 of this install's 52 Antigravity runs had already lost their model that
way. Full numbers and the three pieces of arithmetic that turned out to be load-bearing (log-space
shrinkage, a geometric rather than pooled-median centre, warmth divided out first) are in
`docs/cost-model.md` §10 and `transient_docs/agent_cost_scale_2026-08-30.md`.

⛔ **What this does not measure, and cannot yet.** Zero of the 54 tasks with runs has ever run on two
different (adapter, model) keys. Nothing in the data separates *that agent is expensive* from *that
agent gets the big tasks*; shrinkage by sample count and publishing the unshrunk ratio beside every
factor is the honest response, not a fix. ⚠️ Routing was deliberately left alone for the same reason
— the operator's call, taken 2026-08-30. The factors decide estimates and gates, not who gets the
work.

## What M1 measured, and what it cost the design

Three findings changed the code. All are in `docs/cost-model.md`; the short version:

1. ⛔ **`claude -p /usage` is not free and does not report usage.** The slash command is taken as a
   prompt and spends a real turn. The plan inherited the opposite claim from prior art. There is now
   no free live quota probe, so `quota.ts` reports a **level** and an **age**, and stale readings
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

## What M6 packaged, and what CI found in it

**Packaging is the only thing that can fail for reasons no other suite sees.** L0–L4 all run from a
source tree with `node_modules` on disk; a packaged app has its code inside an asar, its natives
outside one, and no system Node at all. `npm run test:pack` builds a real package and then *drives*
it — the four ways to ship something that passed every test and does not start: the native terminal
module unpacked **out** of the archive, none left inside it, the app launching its own daemon by
running its own binary as Node, and a PTY actually opening from the packaged build.

- ⚠️ **The `asarUnpack` glob was wrong and it did not matter.** electron-builder auto-unpacks
  anything containing a `.node`, so it worked by accident. The files are not in `@lydell/node-pty`;
  they are in per-platform siblings (`node-pty-win32-x64`). Naming the scope explicitly is the point
  — relying on the accident is how a version bump breaks a PTY nobody connects to the change.
- A packaged app is slower on a cold start than a development one: Defender inspects a freshly
  written unsigned binary the first time it runs. The suite polls rather than sleeping once.
- **`pull-request` landing wraps `gh`**, not the GitHub API (D7), so Multi Agent Controller never
  holds a token. It pushes first and opens the PR second: if the PR call fails, the work is already
  safe on the remote. ⚠️ It does not rebase and does not run the project's checks — that is what the
  pull request is for.
- **`killTree` verifies identity before it fires.** It killed a pid written down earlier; pids are
  recycled, and a `finally` block running seconds later could kill a stranger. The product has
  guarded this since M2 (`ownsProcess`); the harness had not, and it is the harness that has damaged
  this machine before.

### What the first CI runs actually found (2026-08-26, run 32940163319)

All ten jobs green on all three platforms — the first time macOS or Linux had ever run this code. It
took five runs, and **none of the first three failures were the POSIX bugs the matrix was written to
catch.** They were CI asserting things about the author's machine:

1. **Electron 44 has no postinstall.** It ships `install-electron` as a bin and leaves the ~110MB
   download to the caller. README and AGENTS.md both blamed "your npm blocked the postinstall",
   sending people after a setting that does not exist. `scripts/ensure-electron.mjs` retries
   (`@electron/get` does not) and says whether the release host is reachable, because undici hides
   the cause behind a bare `TypeError: fetch failed`.
2. **Unit tests that needed a CLI installed.** `plan()` resolves the command through `which()` before
   building an argv, so every argv assertion required an agent CLI. Three threw. The fourth — no
   adapter leaks a vendor API key into a commissioned session — *caught the throw, `continue`d past
   all three adapters, and reported green having asserted nothing.* ⛔ A PATH stub fixes both; it
   proves nothing about the CLIs and is not meant to. The argv is a property of this repository.
3. **Three suites asserting where they ran** — a dispatch refusal matching one of three sentences, a
   reserve check counting `=== 2` (true only with a `~/.claude` to adopt), and adapter *counts*,
   which quietly asserted nobody ever declares an external adapter: the thing M6 allows.
4. **`electronBinary()` could never have worked on macOS.** It guessed `dist/electron.exe` or
   `dist/electron`; macOS is `dist/Electron.app/Contents/MacOS/Electron`. It reads `path.txt` now.
5. **Linux runners restrict unprivileged user namespaces**, so Chromium's sandbox cannot start and
   the window never opens. ⛔ Fixed with a sysctl on the runner, not `--no-sandbox` on the app, which
   would turn the square green by testing a configuration nobody runs.

⛔ **And one real product bug, which only Linux could show.** `handleExit` dropped the session from
`live`, `emitData` returned early without an entry, and `backscroll` read `live` — so a process that
wrote and exited in the same tick lost **every byte**, and anything asking afterwards got `''`.
Windows never showed it because conpty delivers data before the exit. ⚠️ The discarded output is the
output most worth keeping: a `login` session that fails prints its reason and exits, and the pane
went blank at exactly that moment. Sessions now retain their last screen after exiting, bounded on
both axes.

⚠️ **The first regression check written for that bug passed against the unfixed daemon.** It waited
for `state === 'running'`, and there is no such state (`starting | live | idle | closed | failed`),
so it was true on the first iteration. Reverting the fix is what exposed it, and is how it is
verified now: 0 bytes without, 91 with. ⛔ A regression test nobody has watched fail is a comment.

**Two suites need a certainly-installed command** — does the PTY native load, does an exited session
keep its output — and no *agent* CLI qualifies. `writeProbeAdapter()` declares an M6 external adapter
pointing at `cmd`/`sh`: it echoes one line and exits, and the generic driver cannot grant it `mcp`,
`metering` or `mintsSessionId`, so it cannot become anything but a probe.

### The lint script that had never run (2026-08-26)

`lint` had been declared in `package.json` and never installed, so `eslint .` had never executed
once. Its first pass found 55 things, of which **four were defects rather than tidiness**: a `ws`
frame put through `String()` (one of its three payload types survives that; the rest were dropped
into a silent catch), two vendor JSON fields that would have printed `[object Object]` as a
rate-limit status, a `JSON.parse` assigned into `Worker.identity` as `any`, and a `Date.now()` in
Doctor's render. ⛔ Rules turned off in `eslint.config.js` carry their reason inline; "it fired a
lot" is not one.

Simulating a bare runner locally failed five checks, and **four of them were one product bug**: the
not-signed-in gate string-matched the probe output for `"loggedIn": false`, and `refreshIdentity` had
been throwing the `loggedIn` field away. A probe that failed because no binary existed returned an
error string instead, the gate passed, and the scheduler dispatched to a worker that could not
possibly work — claiming a workspace to find out. `WorkerIdentity.loggedIn` is now stored and the
gate reads `=== false` (⚠️ `null` still means unknown and is let through, or Antigravity's
keyring-backed workers would be permanently undispatchable), and **`isInstalled()` is a separate hard
gate** on every candidate — a filesystem lookup, so it costs nothing every tick, unlike `detect()`.

### A quota cell that hid its own diagnosis (2026-08-26)

A second account read `unknown` and the Probe button looked dead. Both were one fact: the CLI writes
`cachedUsageUtilization` only after real work on an account, so a freshly signed-in worker has no
usage cache and never will until someone uses it — a thing an operator can fix, but only if told.
`worker.probe` **resolves** with its failure inside the payload rather than rejecting, so the
renderer's `catch` never fired; the cell rendered the same word before and after the click. ⛔ The
probe rows in `quota_samples` had been recording the answer the whole time. `quotaGap()` now names
which kind of nothing it has — never probed, no usage data yet, stale, or a real failure with the
adapter's own error text — and Probe reports its outcome either way.

## The free quota probe that was there all along (2026-08-27)

For three months this project stated, in code comments, in `AGENTS.md` and in `docs/cost-model.md`,
that **there is no free live quota probe**. The measurement behind it was correct: `claude -p /usage`
is taken as a prompt and spends a real turn. The error was one of scope — that is a fact about
**print mode**, and it was written down as a fact about the product. Nobody re-tested the narrower
claim, and everything downstream inherited the broader one.

The owner asked the obvious question — *"when I type `/usage` in the CLI it answers immediately, that
can't be spending tokens"* — and it took one experiment to settle:

| | |
|---|---|
| before | `fetchedAtMs = 2026-08-06T23:35Z`, 20 days stale |
| action | `/usage` and a carriage return, typed into a PTY |
| after | `fetchedAtMs = 2026-08-27T00:16Z` |
| cost | **nothing** — a slash command is handled by the client |
| what it said | weekly **79%** against the stale cache's **98%** |

⭐ The stale number was not merely old; it was wrong in the direction that stops a fleet dispatching
to an account with a fifth of its window free. **R3 closed.**

### Corroboration from an unexpected direction

A third-party monitor on the same machine had an `account_usage` table whose rows read
`error: unparsed: Total cost: $0.0000 …` — print mode's cost summary, stored as a failure. Where it
did have numbers they matched `cachedUsageUtilization` exactly, three weeks stale. It had hit the
same wall and read the same file. ⛔ The other community tools take a route closed to this project on
principle: read `.credentials.json`, call `api.anthropic.com`. It works. This app never reads, stores,
copies or proxies a credential, which is the same rule that makes D7 wrap `gh` rather than hold a
token. `docs/cost-model.md` §5 records every path tried and when to revisit each.

### Two dialogs, one keystroke, and a day

Shipping it took two more corrections, both found only by testing on a **commissioned worker** rather
than on the author's own profile:

1. ⛔ **Signing in is not being set up.** `claude auth login` writes `oauthAccount` and `userID` into
   the isolation root but not `hasCompletedOnboarding`, so the first interactive session there opens
   the theme picker and the login-method chooser. Print mode skips all of it, which is why a worker
   can run scheduled work for days and still be unable to answer `/usage`.
2. ⛔ **The workspace-trust dialog swallows every keystroke.** Asked per account *and* per folder.
   The probe was spawning in the user's **home**, untrusted in that worker's config, so `/usage` was
   typed into the dialog and the Enter after it selected "Yes, I trust this folder" — reporting *no
   fresher reading* every time. `AGENTS.md` had warned about this dialog since M2, in the context of
   worktrees, and it was walked into anyway.

Both are now visible rather than inferred: `WorkerIdentity.setupComplete` is a stored field the
adapter computes, the Workers panel offers **Finish setup**, and sessions with no project run in
`<dataDir>/scratch` — an empty directory this app owns — whose trust question `trustDirectory()`
pre-answers. ⛔ Scoped to that directory alone: never a project, a worktree, or anybody's home, and
the write merges rather than replaces, because that file holds a credential nothing here could
reconstruct.

⚠️ **The error message was the worst part.** The first version named onboarding as "the usual cause"
and kept saying so after onboarding was finished, sending the owner to redo a completed step while
the real cause went unmentioned. It now reads the worker's actual state before it says anything. A
diagnosis nobody verified is a guess wearing a diagnosis's clothes.

## A shell built out of projects (2026-08-27)

Work was split across Tasks / Projects / Controller, so a project was one list view among seven
rather than the axis work belongs to. The sidebar is now Overview / one entry per project / Settings,
with the project page tabbed (Tasks · Sessions · Cost · Settings). Every existing view moved behind a
route object unchanged; nothing was rewritten. Plan and decisions: `transient_docs/ui_overhaul_2026-08-26.md`.

Two bugs fell out of it immediately, both fixed in the daemon rather than papered over in the UI:

- ⛔ **A project-shaped sidebar hides tasks that have no project**, and `tasks.project_id` is
  nullable. An **Unassigned** entry appears only while such tasks exist and removes itself when the
  last one gets a home — which is what the require-a-project migration will do.
- ⛔ **`createTask` emitted no `task.changed` event.** The list that filed the task refreshed itself
  and looked correct, which is exactly what hid it: every *other* pane stayed stale.

Also corrected: the nav test asserted `nav.length >= 5`, a count that says nothing and passed happily
through a rewrite which deleted two of its destinations. It names them now.

## Five bugs an afternoon of real use found, and what each one really was (2026-08-27)

The fleet was ClaudeFirst / ClaudeSecond / ClaudeThird plus Antigravity, and one question-only task.
Every fault below was visible on one screen and invisible to every suite, which is the class this
project is least protected against. None of them was where it looked.

- ⛔ **The fleet strip grew a second `session`/`weekly` pair every five minutes.** `sampled_at` is
  `cachedUsageUtilization.fetchedAtMs` — **the vendor's** fetch time, which is exactly right for
  staleness and fatal as an insert key. Re-reading an unrefreshed cache produced a row identical to
  the last one, and `lastQuota` selects *every* row at `max(sampled_at)`. `store()` is now an upsert
  on (worker, window, sampled_at); a unique index enforces it and migration 6 deletes the duplicates
  an older build wrote.

- ⛔ **The scheduler had no reason to prefer any worker, so it preferred the oldest.** Until R2 lands
  the compaction reserve returns `unknown` for every account, which made `quotaRisk` a constant —
  every candidate scored identically, ties fell to candidate order, and candidate order is
  `created_at`. **The first account ever commissioned therefore won every routing decision on the
  fleet**, and on this machine that was the one nobody had finished setting up. It read as a routing
  bug and was an absence of any input. `unproven()` is a small penalty, deliberately not a gate: a
  signed-in-but-unset-up worker really does run scheduled work fine, because print mode skips every
  first-run screen.

- ⛔ **Signed in is not the same as able to work, and nothing free tells them apart.** That worker's
  organisation had disabled Claude Code subscription access. `auth status --json` answered exactly as
  a live account does. The evidence has to come from a run, so a dispatch that produces **no metered
  turn** is charged to the account (`recordDispatchFailure`) and the task re-queues instead of being
  handed to a person as though their own prompt had failed. ⚠️ The conjunction matters in both
  directions: no turn *and* a short life, because the transcript's final turn is routinely flushed
  after the process is gone, and a run that produced turns and then broke is the task's problem.

- ⛔ **And that session never exited, so `onExit` never fired.** It sent
  `{"type":"result","is_error":true,"terminal_reason":"api_error"}` carrying *"Your organization has
  disabled Claude subscription access for Claude Code"* and then sat on stdin. AGENTS.md had recorded
  since M1 that a `stream` session which cannot authenticate does not exit; what nobody had noticed is
  that the record it sends **first** reached the session pane and nothing else. The run stayed open,
  the task stayed `running`, and the worker's only slot stayed held indefinitely. `onStreamResult()`
  is the fix, and the general lesson is that the terminal `result` record — not the exit — is the
  signal a turn failed.

- ⛔ **A pipeline of correct steps reported a landing that landed nothing.** A question-only task
  changed no file and was announced as *"Landed as a166a6a onto main"*. Every step had succeeded: the
  workspace was clean so `canLand` allowed it, the rebase was a no-op, the checks passed, the push
  moved nothing, and `rev-parse HEAD` returned the commit already there. `landTask` now counts
  `rev-list --count <target>..<branch>` **before** choosing a strategy. ⚠️ Zero commits with a clean
  workspace is a success that touched no trunk; zero commits with a *dirty* one is work about to be
  destroyed by the next dispatch into a pooled worktree, and collapsing those two would replace an
  urgent warning with a shrug.

Three UI faults from the same session, each a case of a true number rendered unreadably:

- A session chip read `c760 57:46 0` — three true numbers led by the least useful, with nothing
  saying what any of them meant. It reads `work · cache 56:49 · no turn yet` now, and a context of
  zero is drawn as an absence rather than a measurement.
- `ready` is the scheduler's word for *eligible*, and beside `completed` and `failed` it reads as a
  resting state — as though the person who filed the task were the one being waited on. The reason a
  task is not moving was already computed every tick and folded into a log line; it now reaches the
  row it is about.
- The Send button was painted on top of the message box, because an unlabelled compose row borrowed
  `.form-row` — a three-column grid built for labelled settings forms, so the input landed in the
  110px label track. The UI suite measures the overlap now rather than trusting a screenshot.

⭐ **What the round added rather than fixed:** a run now carries a quota reading either side of it.
One reading is a state; a cost is a difference, and until this there was no baseline to subtract from
— a first run on a never-probed worker had none at all. The scheduler refreshes a stale reading before
dispatching (in the background, holding the task one tick — never awaiting a 30-second terminal inside
a loop that is supposed to be arithmetic) and reads again once the run has ended. The window delta and
the transcript token count sit side by side in the task pane and are ⛔ never reconciled: their
difference is R1's instrument, and merging them would destroy the only thing they are jointly for.

## The routing input that measured the wrong thing, and four more from t3 (2026-08-27)

A second afternoon on the same fleet, one task: *rename Doctor to Global*. It was dispatched three
times before it worked, and the reasons were all different from how they looked.

- ⛔ **The compaction reserve was being used as a routing input and could not be one.** `reserveState`
  returns `ok` for a worker holding **no live sessions** and `unknown` for one holding any, because
  `remaining` is null on every Claude account until R2 lands. Scoring `unknown` at 0.5 against a
  weight of ~0.9 therefore imposed a **0.45 penalty for having a session at all** — several times
  larger than every term that actually discriminates between candidates. An idle worker beat a busy
  one always, whatever else was true, and on this fleet that handed the first dispatch to an
  Antigravity account nobody had ever signed in to. It failed in 0s. ⚠️ The lesson generalises: a
  term that is identical across the fleet contributes nothing and belongs at zero, and one that
  differs *only* as a side effect of some unrelated state is worse than nothing, because it is a bias
  wearing a measurement's clothes. `quotaRiskOf()` now moves only on checked evidence — `at_risk`,
  or a live rate-limit status the vendor sent.

- ⭐ **And nothing in the score knew which accounts had ever worked.** Antigravity's identity probe
  answers "cannot tell" to every question, legitimately, because its credential is in the OS keyring
  — so it looked exactly like a healthy account with an unhelpful adapter. Whether a single assistant
  turn has ever come out of an account is the one fact that separates those two, it is already in
  `turns`, and it was not being consulted. It is now the largest component of `unproven()`. ⚠️ Still
  a penalty and never a gate: every fleet starts with no proven worker, so a first dispatch has to be
  allowed to happen or nothing ever becomes proven.

- ⛔ **A reply to a finished task went into the void.** *"Please commit to the main branch"* was typed
  at a completed task; `deliverToLiveSession` pushed it straight into the still-warm session and
  returned true, so the daemon believed it had done its job. From the operator's side nothing
  happened at all — no run, so nothing metered, no status moved, no activity appeared, and no landing
  was attempted when the agent finished. The UI meanwhile said the note was "prepended to the next
  run's prompt", which is true of the code and false of the world: a finished task has no next run.
  `continueTask()` re-queues it as a **new run on the same thread**, and routing follows by
  construction rather than by instruction — `warmSessionFor` already scores the session holding the
  task's context highest, so the same worker, workspace and session win because they are cheapest.
  ⚠️ One thing had to be added for it: the warm path now **re-claims a workspace**, because the
  comment claiming a warm session already sits in the workspace its task claimed is true only while
  that task never finished. A continued task is warm in context and homeless on disk.

- ⚠️ **The previous run's last words lingered under the next one.** The daemon cleared its activity
  tail on dispatch and said nothing; whoever was watching held their own copy (they have to — the
  list refreshes on every task event and a pane rebuilt from each fetch would flicker), so a task
  freshly dispatched somewhere healthy still showed the error the last attempt died of.

- ⚠️ **Terminal colour codes reached a table cell.** A benched worker's reason read
  `It said: <esc>[2m— claude-sonnet-5 · auto<esc>[0m Your organization has…`, which looks like
  corruption and buries the sentence that mattered. `stripAnsi` runs on anything from a CLI that
  becomes prose. ⛔ Not a retreat from the ANSI rule: nothing reads *state* out of those bytes, they
  are simply removed on the way to a person.

Also clarified rather than fixed: `52k ctx` beside `1.2M tokens` reads as a contradiction until you
know one is a **level** — how full the window is right now, which falls when a session compacts — and
the other a **total** that only grows because every turn re-reads the whole window. Both now say
which they are, in the chip, the ledger and the run row.

### And a test that was lying

`npm run pack` failed twice with `EBUSY: rmdir release\win-unpacked`, and both times `test:pack`
then reported a confident **17/17** — because it builds nothing and drives whatever is in `release/`.
It was validating a package built before half the work existed.

The EBUSY is not a leak: **orchestratord is detached by design and survives its window closing**,
which is the entire premise of the topology, and it keeps the packaged binary open. So the fix is not
to kill things automatically — that daemon may be somebody's live fleet — it is for the suite to
refuse. `test:pack` now compares the asar's mtime against the newest file in `src/` and fails with
`⛔ STALE` rather than passing. It was verified by watching it go red against the stale package before
the rebuild, which is the only way to know a guard works.

Separately, the pack suite really did leak its *own* daemon on every pass, for the same detached
reason, and now kills it by the pid published in its own endpoint file.

## The status that asked a question and took no answer (2026-08-27)

t3's continuation worked — the agent committed to main by hand and said so — and the task then sat in
`awaiting_human` beside a run marked `completed`, which reads as a contradiction. Two things were
wrong and a third fell out of testing them.

- ⛔ **`awaiting_human` is the one status explicitly about the operator, and it was the only one they
  could not act on.** Every other resting state has a button: Resume, Queue, Cancel, Delete. The state
  meaning *a decision is wanted from you* offered nowhere to record the decision, so the only exits
  from a task whose work had succeeded but not landed were to cancel it or delete the record of it.
  `resolveTask()` is the answer, and it is written into the thread as a **judgement** — nothing
  verified anything, a person was satisfied. `task_complete` remains the only signal that an *agent*
  finished, and the two must not be conflated.

- ⛔ **And it never said what it wanted.** Nine call sites moved a task to `awaiting_human`, each
  having just written the reason into the thread and none of it onto the task. So the row said a
  decision was wanted without saying what about. The reason now moves atomically with the status —
  set by any transition that has one, cleared by any that does not, because a reason that outlives
  the state it explains is read as current.

- ⛔ **A completed task had never unblocked its dependents.** Found by a test written for
  `resolveTask`, which expected a child to become `ready` and watched it stay `blocked`.
  `admitDependents()` lives in tasks.ts, does the right thing — `admit()` each dependent, recomputing
  from the world — and was **called by nobody**. The scheduler carried a private
  `admitDependentsOf()` that called `setStatus(id, dependent.status)`: a no-op dressed as an
  admission. Nothing else re-admits a `blocked` task, since `admitScheduled()` looks only at
  `scheduled` ones. So the DAG — one of the headline features — never advanced past its first edge,
  silently, on both the agent-completion path and every other. The duplicate is deleted.

### Green and wrong, three times in one day

`npm run pack` died with EBUSY twice and `test:pack` reported a confident 17/17 against a package from
before half the work existed; then `test:daemon` passed against an `out/` that predated a one-line
daemon fix, which is how the DAG bug briefly looked fixed when it was not. **Every suite below L1
drives a build product and none of them builds one.**

`checkBuildIsCurrent()` in the harness compares `out/` against `src/` for the daemon and ui suites,
and the pack suite compares the asar. Both were verified by watching them go red against a stale
artefact before trusting them green — which is the only way to know a guard works, and is now a rule.

⚠️ The EBUSY itself is not a leak to fix: orchestratord is **detached by design** and survives its
window closing, which is the entire premise of the topology. It holds the packaged binary — and the
first three answers to that were all wrong, because they all ended in *stop the app*. Running the app
while fixing the app is how this gets worked on, so the packaging moved instead: `npm run pack` now
builds into `release/suite/`, which nothing executes from, and `release/` keeps the installers and
whatever build the operator has open. Verified by packaging and driving the suite with the app
running: 18/18, six of its processes alive throughout.

⛔ The general shape is worth keeping: when a check fights the way somebody works, moving the check is
usually cheaper than moving the person, and a check people learn to skip proves nothing at all.


## The adapter that had never once run, and the probe that was said to be impossible (2026-08-27)

Reported as two complaints: *"Antigravity doesn't seem to work at all, even though it is signed in
correctly"* and *"antigravity's usage quota seems always shown up as unknown"*. Both were true, and
neither had the cause anyone had written down.

**It had never run, and the reason was one argument.** `-p` on `agy` is a *string* flag — `-p` /
`--print` / `--prompt` are one option that takes the prompt as its value, and `agy -p` alone answers
*flag needs an argument: -p*. The adapter passed a bare `-p` before `--input-format`, so the CLI took
`--input-format` as the prompt and exited 2 in zero seconds. The CLI said so itself, in a sentence
nobody had ever read, because it went to a session nobody opened. Evidence from the operator's own
database: **antigravity-cli had 0 metered turns, ever, against 122 on claude-code** — one work
session, `outcome=failed`, `in=0 out=0`, from M5 until this was found.

⚠️ Two things hid it, and both are more interesting than the bug.

The run note said *"The session ended (exit 2) without reporting completion. Nothing here can tell
whether the work was finished, so it is over to you."* That is a launch failure wearing an agent
failure's words, and it sent the reader looking at the agent.

And `unproven()` scored `identity.loggedIn !== true`. Antigravity's `probeIdentity()` returns
`loggedIn: null` **permanently and correctly** — the credential is in the OS keyring and there is no
free way to look — so every Antigravity worker carried +0.4 doubt for ever, on top of +0.5 for being
unproven, and could shed neither: only a metered turn clears `unproven`, and at 0.9 it lost every
dispatch and so never got one. ⛔ The comment directly above that line already said *"`=== false`,
never falsy… must not be penalised"*. It had been applied to `setupComplete` and not to `loggedIn`,
and the test beside it varied `setupComplete` while holding `loggedIn: true` throughout. A rule
stated correctly, applied to one of two fields, with a test that could not see the difference.

**And the quota probe existed all along.** `docs/adapters.md` recorded that Antigravity "exposes
usage only inside an interactive session or a running IDE" and rejected three alternatives. Every
word of that was true and the conclusion was wrong, because an interactive session is precisely what
this app can drive — `refreshUsage()` had been doing it for Claude Code for a day. The operator
pointed at it: *"you need to invoke `agy` and type `/usage` manually."*

⛔ The reason it was missed is a real difference and not an oversight: Claude Code writes the answer
to disk, and `agy` does not. Driving `/usage` in a PTY and diffing every file under `~/.gemini`
showed only `cli.log` (which logs `doRefreshQuota: starting reload` and no numbers) and
`history.jsonl` (which logs the command text) changing. The quota lives in `quota_manager.go` in
memory. So the choice was never screen-versus-file; it was screen-versus-nothing, and the invariant
that forbids parsing a TUI is reasoned from *the transcript is exact* — which holds only where there
is a transcript. It now carries a narrow, declared exception: `usageRefresh.answer: 'screen'` plus
`parseUsage`, permitted to produce **a quota reading and nothing else**.

⚠️ Three things that measuring caught and reasoning would not have:

- The panel reports **remaining**; `QuotaWindow.percent` is **used**. Storing it verbatim would
  report a nearly-exhausted account as nearly empty, in the one direction the gate cannot survive —
  `QUOTA_HIGH_WATER` would never trip.
- The panel **scrolls**. The first live end-to-end run returned three windows of four: at 30 rows the
  last group's five-hour window fell below the fold, silently, and the missing one is a candidate for
  the `5h` id the quota gate reads. The probe now takes its geometry from the adapter (110×60), and
  the parser refuses any group showing one of its two windows rather than under-reporting.
- The **folder-trust dialog ate the first attempt**, and answered *"Yes, I trust this folder"* with
  the Enter meant for `/usage`. That is the same failure AGENTS.md already recorded against Claude
  Code, reproduced on a second CLI while building the thing meant to avoid it. `agy` now implements
  `trustDirectory` too.

⭐ The shape worth keeping: **a capability that was written down as absent is still a claim, and it
decays like any other.** "No free probe here" had been true, was recorded with its evidence, and
stopped being true when a vendor shipped a slash command. The rule *measure, don't assert* was being
honoured for capabilities that exist and not for the ones that do not.

## A compact loop that billed every ten seconds (2026-08-26)

Spotted by the operator in the activity log: thirteen identical `compact` decisions on one session in
two minutes, same reason, same 35k estimate, context stuck at 68001 tokens throughout.

Nothing was wrong with the decision. `decide()` is a pure function of the session row, the scheduler
ticks every 10s, and compaction takes about two minutes — so with nothing recording that the move had
already been made, the same inputs produced the same move twelve more times before the first could
land. ⛔ Each repeat was a real user message pushed into a live session, which makes this a breach of
*the scheduler costs zero tokens* by the one component whose entire purpose is not wasting them.

The fix is state, not a cleverer condition: a move is written down when **issued**, together with the
evidence that would prove it landed. ⚠️ "A turn happened" is not that evidence — an agent replying
*"I don't understand /compact"* is a turn. Compaction is proved by `tokensSinceCompact` falling, a
keepalive by the TTL moving. And the clock **stops asking** after two ignored attempts and hands off
instead, which is what makes R6 survivable rather than urgent: if `/compact` is not honoured on the
`stream` transport, the cost is two wasted turns per session rather than an unbounded spend.

The operator also asked for a switch, and it is global and honest: `settings.autoCompact` gates the
reserve-at-risk compaction as well as the ordinary one. A switch that quietly kept compacting "for
safety" would be false on the one page whose whole claim is that it shows what the scheduler really
does. ⛔ Told-not-to-compact and cannot-compact land in the same place — handoff and close — which is
the fallback that already existed for the second case.

## A build that did everything twice, and the binary nobody was running (2026-08-26)

`scripts/build-win.ps1` ran every step from scratch on every invocation. Steps are now
content-addressed — a SHA-256 over the files each step actually reads, skipped when unchanged and its
outputs are still present. Measured: **92s cold, ~0s warm**, with the two suites that start the app
accounting for two thirds of the cold run (`test:daemon` 50s, `test:ui` 12s).

⛔ Fingerprints are over **content, not mtimes**, and a stamp is written only after the step exits 0.
This repo has already had three green-and-wrong runs; a cache that has to be distrusted is worse than
no cache. Proved by reintroducing each bug and watching the guard go red before trusting it green.

⚠️ A comment-only change correctly rebuilds the bundle and correctly **skips** the suites below it,
because the bundler strips comments and `out/` comes out byte-identical. That is a property of
content-addressing worth knowing rather than a hole.

Two workflow faults surfaced while doing it. The EBUSY guard tested the whole of `release\`, so an app
running from `release\win-unpacked\` blocked the pack step — which writes only to `release\suite\`
and could never have collided with it. The `release/suite/` split existed precisely to make "you
cannot run the app while building" untrue, and an over-broad guard had quietly re-imposed it.

And there are **two packaged apps in the tree, only one of which is ever new**: the pack step rewrites
`release\suite\win-unpacked\` every run, while `release\win-unpacked\` moves only under
`-Installer`. Measured on the operator's machine, the copy they were clicking by habit was **98
minutes and several builds older than the bundle** — indistinguishable from a change that silently did
not take effect. `-Restart` now stops what is running, builds, and starts the result, and the summary
names the stale copy on every run whether or not a restart was asked for.

## A worker that could be switched off, and no way to see it (2026-08-27)

The operator asked for a way to stop using a worker without decommissioning it. `Worker.enabled`
had existed since M1 and **four independent gates already read it** — dispatch, judgment, session
creation, and the quota sweep. What did not exist was a control anyone could find: an unlabelled
checkbox reading `enabled`, in the last column of the Workers table, sharing a cell with
`human-occupied`. Looking at that panel and concluding the feature was absent is a fair verdict on
the affordance.

It is now a switch on each row, `role="switch"` with `aria-checked`, the same component as the
global compaction toggle. The row carries a `DISABLED` tag and dims to 0.55 — the exact opacity the
fleet strip's card has used since M2, because the two views had been disagreeing about the same
fact: the strip said `off`, the table that owned the control said nothing at all.

⛔ **Off is not retirement, and the tooltip says so.** Nothing is deleted, the isolation root and
quota history stay, and switching back on needs no re-commissioning. ⛔ It also does not touch a
session already running — killing live agent work from a settings toggle is the kind of surprise
nobody forgives, so that is stated rather than left to be discovered.

⚠️ The first version of the test asserted the login exemption by calling
`spawnSession({ purpose: 'login' })`. That call does not stop at a check; it spawns the vendor CLI in
a real PTY, so the assertion would have passed for a different reason on CI (no CLI installed) than
on the laptop, and left a process behind on the one where it does. It reads the gate's source
instead.

## The Controller panel that said `ready` about an account nothing could run on (2026-08-27)

ClaudeFirst's subscription had expired. The scheduler knew: a run that produces no metered turn marks
the worker `suspect`, and dispatch had been skipping it since M4. The Controller panel showed it
**ready**, and the consult loop picked it for judgment call after judgment call.

Two faults, and the second is why it never stopped.

**One: two gate lists, kept in step by hand.** `chooseController` had five gates; `chooseTarget` had
six. The missing one was the quarantine. So an account could be held out for work and eligible for
judgment in the same instant. The panel was not lying independently — `available` is
`chooseController()`'s own answer — which is why fixing the chooser fixed the panel.

**Two: the judgment loop could not learn.** A consult that died wrote its failure on the *consult*
and nothing on the *worker*. It fell back to the deterministic answer, forgot, and asked the same
dead account again on the next drain. This is the only loop in the daemon that spends tokens and it
was the only one with no memory of failure.

Both are fixed, and the shape of the fix matters more than either: the account gates now live in one
list, `src/daemon/eligibility.ts`, which both schedulers read. ⛔ Copying the missing gate into
`controller.ts` would have fixed the symptom and left the drift mechanism running.

⚠️ **A trap that would have made the second fix worse than the bug.** The obvious "did a turn
happen?" test is `session.lastRequestStartedAt`, which is what the work path uses. A consult always
runs over `stream`, and the stream metering path deliberately never sets that column — it has no
request id and writes `request_started_at` as null. Reading it would have called every healthy
consult dead and quarantined the entire fleet on first use. It counts metered turns instead.

The panel also stopped inferring each row's status from which worker won: every row now carries its
own reason, so `disabled`, `at 96% of its 5h window` and `held out: subscription expired` are
distinguishable from `ready, another is preferred`.

⚠️ **A wrong premise, caught by re-checking it.** A follow-up task claimed `isReady()` in
`workers.ts` had zero callers and should be deleted. It had two, inside `watchReadiness`, hidden
because the grep that produced the claim excluded same-file matches. Deleting it would have broken
the login pane. The function was correct where it was used; the hazard was the name plus the
`export`, so it became a module-private `isSignedInAndSetUp`. Unexporting is what actually removes
the trap — the failure mode was somebody needing a readiness check, grepping, and importing the
weaker one.

## An expired account probed forever, and a strip that measured two different things (2026-08-27)

Three operator reports, one session.

**The background probe would not stop.** Level 0 is free in tokens and **not** free in processes: it
opens a real interactive session and types `/usage` into it. On an account whose subscription had
expired, that meant spawning a CLI every thirty minutes to watch it fail to authenticate, recording
`unknown`, and doing it again. The sweep now skips any `suspect` worker — effectively the same
standing as disabled, which is what the operator called it. ⚠️ The *background* sweep only: pressing
Probe still refreshes, because that is one of the two things that lift the hold.

**A re-sign-in mode.** `WorkerHealth` gained `needsReauth`, decided by the **adapter**, because the
sentence is its CLI's: an expired subscription, a revoked key and a plain crash all arrive as the
same `api_error` and differ only in the words after it. ⛔ Anchored on the phrases and never on
`api_error` alone — that code also covers the vendor having a bad afternoon, and sending somebody to
re-authenticate through an outage is how a working account gets signed out. It changes presentation
only; the worker is held out either way.

**The fleet strip was drawing two kinds of thing alike.** Above: account quota windows, shared by
every session and outliving all of them. Below: one session's context and cache clock, gone when it
closes. Both are now four-column gauges — which is what makes them comparable — separated by a
labelled rule, which is what stops them reading as four measurements of one quantity.

⛔ **The cache bar is deliberately not in the quota palette.** A quota bar fills as a window fills
up, where more is worse; a cache bar drains as the cache expires, where more is better. Two
identical shapes with opposite polarity in one palette on one card is a misreading waiting to
happen, so healthy cache is the blue this app already uses for `running` and only the warnings
borrow the shared amber and red.

⚠️ **The fill is arithmetic, not a constant.** `remaining / (expiry - requestStart)`, from two
timestamps already on the wire. Five-minute and one-hour TTLs are both real on this fleet, and a bar
hard-coded to one is wrong by a factor of twelve on the other. It returns `null` — an empty track,
not a full one — where there is no clock to read, because claiming a fresh cache is the wrong way to
be wrong.

For the `52k/1M` denominator, `contextWindow` now ships with the session, resolved from the cost
model. ⛔ Never a default: `scheduler.ts` falls back to 200k when *scoring* and that is fine for a
score, but `52k/200k` displayed for a session whose real window is 1M is a wrong number wearing a
measurement's clothes.

## The advice that broke the next build (2026-08-27)

`release\suite\` exists so packaging never fights a running app, and `release\win-unpacked\` is the
copy a person runs. After a stale-package failure, the operator was told the opposite — that the
suite copy was the fresh one to click. They clicked it. The next `npm run pack` died with
`EPERM: unlink dxil.dll`, and the app had to be stopped mid-session to finish a commit.

Both `HANDOFF.md` and `AGENTS.md` had described the split correctly and *only in terms of which copy
was newer*. That is the fact a build script needs and the wrong fact to hand a person. Both now say
which one to run.

## Closing the window, and what that should mean (2026-08-27)

orchestratord is detached by design: closing the UI stopped nothing, which is the entire premise of
the split — quota windows are hours long and progress should not depend on a window being open. The
consequence nobody had chosen was that the *only* way to end it was to find a pid and kill it.

So the operator now chooses, with one switch on Global → *This app*:

- **Tray off** (the default): quitting asks orchestratord to shut down. Nothing is left running.
- **Tray on**: closing the window hides it, the fleet keeps working, and the tray icon brings the
  window back without launching the app again.

⛔ **Off is the default, which is the conservative direction rather than the convenient one.** On
means a scheduler outlives the only window that showed it. A newcomer gets what closing a window
looks like it does.

⛔ **The daemon is asked, never killed.** `daemon.shutdown` makes it run its own wind-down — the
loops, the tailers, the sessions, the lock, the endpoint file, the database. Reading
`orchestratord.json` for a pid and killing it is the thing AGENTS.md forbids outright, and it would
strand a lock file and a half-written database even if the pid were trustworthy. The daemon suite's
last section proves the mechanism: the RPC is accepted, it reports what it was about to end, **the
endpoint file is cleared**, and the process is gone. The endpoint check is the load-bearing one — a
dead process that left its endpoint behind has every client reconnecting to a port nobody is
listening on.

⚠️ **Shutting the daemon down ends every live session**, because `shutdownAll()` kills them. So a
quit with work in flight asks a person first, and the panel states the consequence in *both* switch
positions — each is a surprise in the opposite direction.

⚠️ **The setting is main's, not the daemon's**, and that is not tidiness. It decides whether the
daemon keeps running, so main has to be able to read it when the daemon is unreachable — which is
exactly when it matters. A setting whose enforcement depends on the thing it controls being alive is
not a setting.

## The second packaged app, and why it lasted one day (2026-08-27)

`release\suite\` was introduced in the morning so that packaging could never collide with an app being
run out of `release\win-unpacked\`. It was removed the same evening, at the operator's request, once
the workflow it defended changed: the app to *use* is the one the installer installs, and the repo's
output directory is the build's alone.

It cost 383MB and one permanent ambiguity — two identical executables, only ever one of them new —
and both halves of that bill were paid the day it existed. First, 98 minutes debugging a change that
had in fact taken effect, because the binary being clicked was the other one. Then an `EPERM` in the
middle of a commit, because the docs described the split **only in terms of which copy was newer**:
the fact a build script needs, and the wrong fact to hand a person.

⛔ So packaging *does* collide with the repo's own copy again, and that is now correct rather than a
bug: nothing should be executing out of a directory electron-builder is about to delete. What went
with it: `Assert-OutputIsFree`'s `-Except` parameter, which no caller passes any more — a parameter
nobody passes is a claim that somebody might — and the summary block in `build-win.ps1` whose whole
job was to say which of the two apps was stale. ⚠️ If a second copy ever comes back, that warning
comes back with it.

Cleaned up at the same time: `win-arm64-unpacked` (a stale `dist:win` intermediate) and
`win-unpacked.tmp` (garbage from an interrupted run). ~1.1GB, with the running-process check done
immediately before the delete rather than remembered from a minute earlier.

## Bright scrollbars on a dark app, and a sidebar that would not move (2026-08-27)

The scrollbars were the browser default: bright grey gutters on a dark shell. The cause was not
missing scrollbar CSS but a missing **`color-scheme`** declaration — without it the browser paints
every UA-drawn surface for a light page, the scrollbars most visibly but also over-scroll, form
controls and the caret. Styling `::-webkit-scrollbar` alone would have left all of that.

⚠️ Both scrollbar dialects are declared and they are not redundant. `scrollbar-color` is the
standard and is what an overlay scrollbar honours; `::-webkit-scrollbar` is the only way to change
the width, and declaring it switches that element to the legacy path — so anything that does not
match the pseudo-elements, xterm's own viewport among them, still needs the standard properties.

The sidebar became resizable by writing **one CSS variable**. `--sidebar-w` already drove
`grid-template-columns`, so no component below the shell knows the sidebar can move and no width is
threaded through props to re-render the shell on every mouse move. ⚠️ Pointer *capture* rather than
a window listener: the moment the width clamps, the handle stops following the cursor, and without
capture the next mousemove goes to whatever is underneath and the drag sticks. Bounds are 180–520px
and both are real — below 180 the brand row starts dropping its controls, above 520 it eats the pane
the work is in — with a double-click reset, because a drag that went somewhere unhelpful needs a way
back that does not require guessing.

The width persists in `localStorage`, not the daemon's settings table: it is a per-display
preference, and every row in that table is one more thing to reason about when a session behaves
unexpectedly.

## The New Task form, and the two answers I could not ship (2026-08-27)

The form read prompt-first with three settings rows beneath it, which put the one field somebody came
here to fill in before they had decided anything. Reordered to Project → Policy → Worker → Model, and
the prompt last. ⚠️ Worker sits above Model against the sketch this was built from: a model list comes
from `costModel(adapter.policy.costModelId).modelIds()` and belongs to one CLI, so until an account is
pinned there is no list to draw, and the Model row would have pointed downwards at its own
precondition.

Two of the four controls already worked in the daemon and had never been reachable.
`constraints.workerId` has gated the candidate loop since M2; `constraints.model` has reached
`--model` on all three adapters. ⛔ The control says **pins**, not "preferred" — the scheduler skips
every other candidate outright, and there is no soft form of it. A word that promises less than the
code delivers is the same failure as one that promises more.

**The rejected alternative was effort.** The obvious move was to declare `selectableEffort: true` for
`openai-compatible` and pass codex's documented `-c model_reasoning_effort=`. That adapter's
`verification.level` is `measured` and its note says the flag surface was read from the running CLI;
declaring an unrun flag under that heading would have presented a documented capability with the same
confidence as a measured one, which is the exact trade AGENTS.md forbids. So the constraint, the
`SpawnRequest` field and the scheduler's gate all exist, every built-in declares `false`, and the form
draws **no effort control at all** rather than a disabled one — the same rule the fixed-project row
already followed. The first adapter to gain the flag turns it on by changing one boolean.

⚠️ A test I wrote for this reported green while proving nothing: `[].every()` is true, so "every
offered model is one the daemon accepts" passed while the row it inspected had not been found (the
labels are upper-cased by CSS and the selector was case-sensitive). Non-empty is asserted first now.
Third vacuous-or-stale suite result in two days.

## Two buttons that meant the same thing (2026-08-27)

`awaiting_human` got Mark done and Stop here the day before, and the operator could not tell them
apart. The tooltips were why — *"records that you are satisfied"* and *"stops here and rests the
task"* are two ways of saying **it stops**. The difference was never in how it feels: `admit()`
releases a dependent only when its dependency reaches `completed`, so one of them starts the rest of a
plan and the other leaves it waiting indefinitely. Each button now carries that consequence, with the
count of actually-blocked dependents beside it — a number somebody can check, rather than "unblocks
dependents", which they have to take on trust and cannot see the scope of.

It also moved out of the ledger and next to the composer. All three answers to *a decision is wanted
from you* — finish it, park it, say what is next — are the same kind of thing, and two of them living
in a right-hand column of read-only facts made the third look like the only one.

⛔ **A display field was destroying routing evidence.** The Worker column showed `you` on a task
ClaudeSecond had run, and kept showing it after the task was marked done. Nine hand-off sites set
`assignee` to `'human'` the moment a task starts waiting on a person — honest about who is being
waited on, and it overwrites the one fact that column exists to make visible without a click. The fix
is `Task.ranOn`, derived from the runs in `TASK_SELECT` alongside `first_run_at`, because the runs are
the only place that fact was ever safe; and `resolveTask` restores the account instead of writing the
person over it, so a hand-resolved task and an agent-completed one agree about who did the work. Who
*answered* stays in the thread as a sentence with a reason, which is what a judgement should look
like.

⚠️ The general shape is worth keeping: `assignee` was answering two questions — *who is this with*
and *which account is paying* — and the second one silently lost every time the first changed.


## A pool slot that did not arrive clean, and a watchdog that could not stop firing (2026-08-28)

Two failures, a day apart, that looked nothing alike and were the same shape: **an operation that
takes time, judged by a check that assumes it is instant.**

### The worktree

t4 never started. `git switch -c multi-agent-controller/t4-… origin/main` failed with *"Your local
changes to the following files would be overwritten by checkout"*, naming `App.tsx`, `Doctor.tsx` and
`ui.test.mjs` — three files the task had never touched, in a workspace it had just been handed.

Nothing about the scheduler was wrong. The branch was named after the task, it was created inside the
claimed worktree, the trunk was never switched. What nobody had noticed is that **`switch --detach`
carries uncommitted changes with it.** Parking a pool member frees its *branch* and leaves its
*edits* — so ws1 had been sitting on an earlier run's uncommitted work for a day, and every task that
happened to claim ws1 was going to die on it. Measured: ws1's HEAD was detached at `c77e04f`
(2026-08-26 22:19), and its diff was byte-for-byte the Doctor→Global rename already landed as
`2cd597f`. ws2 and ws3 were clean, which is why it read as random.

It only fires when two things coincide — the slot is dirty *and* the base has moved under it, because
git refuses only a switch that would **overwrite** the dirty file. That is also what made the first
version of the test vacuous: it reproduced the dirt, passed against the unfixed code, and only became
a real test once it advanced the trunk before re-claiming the slot.

⛔ **Stashed, never `reset --hard`.** The one-line reset would have worked in this instance, and it
would have been wrong: a slot is dirty most often because the *last run failed*, which is exactly
when its half-finished edits are worth the most. `rescueDirt` is best-effort — a slot that cannot be
stashed is left alone and the switch fails loudly, as before, because silently deleting somebody's
work to keep the scheduler moving is the one outcome worse than a task that will not start.

### The watchdog

t5 then showed the same shape from the other side. The runaway watchdog decided a run was past its
estimate, sent *"Wrap up now. Commit anything that compiles, then call `handoff`"*, and waited 120s
for that to land — leaving the run open and the task `running`, which is precisely the state
`runWatchdogs` scans for. It fired again on the next tick, and the next: **13 identical notices
between 02:42:52 and 02:44:42**, and with them 13 wrap-up prompts into a session that had already
committed `ea05929` and already called `handoff`. What the operator saw was an agent stuck in a
commit loop; the loop was in the scheduler.

⚠️ And it fed itself in the currency it was policing. Every forced turn was more spend, so the factor
quoted in the notice climbed **3.1× → 3.9×** while no work was happening. A watchdog whose own firing
satisfies its trigger will not stop on its own.

The same 120s window hid a second bug: the timer parked the task unconditionally, so a run that
*did* take the instruction and finish had its status overwritten and its session closed underneath
whatever came next.

### What the numbers say about the trigger itself

Run `98dad387` was called a runaway at 4.0× — 6,271,722 tokens against an estimate of 1,557,974 (the
median of four completed runs). Of those tokens **6,155,066 were cache reads and 27,338 were output**.
Cache reads accumulate with how *long* a session is, not how wasteful, so the trigger as written
fires on duration. Worse, `estimateTask` learns only from `outcome = 'completed'`, so a preempted run
teaches it nothing and the median stays anchored to the short runs that finished.

That is not a bug with a fix in this commit — it is a calibration question — so the trigger became a
switch and the switch ships **off**. The window-boundary preemption beside it ships **on**: it acts
on a measured reset time rather than an inferred one, and the loss it prevents (a run cut off
mid-thought with no commit and no handoff) is unrecoverable. ⭐ Two switches rather than one, because
the two triggers rest on evidence of completely different quality and a single toggle would have
forced the operator to buy both.

## What happens to work the tool will not take (2026-08-28)

Three threads, all downstream of one absence: nothing answered *what becomes of work the tool
declines to land*.

### The survey that reversed the proposal

The first plan had the daemon commit on the agent's behalf when a task finished dirty — `git add -A`
behind a blocklist screening untracked files for credential-shaped names, sizes and paths. The owner
pushed back that a blocklist is a heuristic with a loophole, and asked what other tools do.

Nobody does it. Claude Code's worktree documentation specifies the opposite in detail: a subagent's
worktree is removed automatically only when it finishes *without changes*, and one "with changes
stays on disk until the periodic sweep can remove it without losing work"; the sweep leaves a
worktree alone when it "still holds work: changed or untracked files, or unpushed commits", and
reclaiming one anyway requires `git worktree remove --force` typed by a person. It holds a
`git worktree lock` while an agent runs, writes a provenance marker so it never reclaims a worktree
somebody else made, and resets a reused worktree only when git can prove it is safe. Untrivial's
agent-orchestrator states **"Never force-delete dirty worktrees"** as a load-bearing rule and treats
the agent's pull request as the unit of output. `pi-worktrees` refuses `/wt-cleanup` on a dirty
worktree; `agent-worktree` preserves rather than destroys.

⭐ The convergent pattern: **detect work, never destroy it, and let the agent commit.** The judgement
about what to stage, what to leave and what to test first is what a `/commit` skill encodes, differs
per project and per person, and a daemon applying a name-and-size list at the one moment nobody is
watching is a worse copy of it with less context. The blocklist was deleted before it was written.

⚠️ One adaptation was needed. Every tool surveyed asks a human at the moment of preservation, and
this fleet is unattended by design. So the exit prompt became a list: **Loose ends**, on Overview,
asking the same question afterwards.

### One field where there had been three halves

`project.landing.strategy` answered it per project, `task.verification` answered a different-sounding
version of it per task, and nothing answered it fleet-wide — so *why did this not land?* needed two
fields checked in two files, and neither could be changed while a task was running. `finishPolicy`
replaces both, resolved task → project → fleet with `inherit` as a real value at the lower two tiers.

⛔ `mandate.allowed ⊇ 'land'` stays exactly where it was, and the distinction is the point:
**preference is not authority.** The mandate is inherited down a lineage so an agent-spawned subtask
cannot grant itself more than its parent had. A dropdown may set what *should* happen; nothing in a
UI may widen what *may*. There is a test that fails if that ever stops being true.

`agent-lands` gained a bar it did not have: the project must define check commands and they must
pass. This repo had no `project.json` at all, so it had been landing on an empty check array — which
is to say landing whatever an agent produced, unverified, unattended.

### The one ask

A task finishing dirty gets one instruction — commit these, then report complete again — guarded by
`finish_asked_at`. Between the instruction and the agent's next report nothing about the task
changes, so the same decision would be reached again, and each repeat is a billed turn telling an
agent to do what it just did. ⚠️ That is the third appearance of one shape this week: the cache clock
re-issuing `/compact` thirteen times, the runaway watchdog re-preempting thirteen times, and this.
**A decision that triggers an action, and is re-evaluated before the action lands, is a loop.** It is
now an invariant in AGENTS.md rather than a lesson relearned per component.

### What the log could not tell anybody

The daemon had written `logs/orchestratord.log` since M0 and nothing in the app displayed it; only
`warn` and `error` reached a UI, and no panel rendered even those. So "when did it probe that
account?" had no answer, and a fleet working correctly was indistinguishable from one that had
stopped. The file also rotated at 5MB into a single `.1`, which answers *is the disk safe* rather
than *what happened on Tuesday*.

Now: a file per day pruned by mtime, a ring buffer so a window opened after the interesting minute
still shows it, every level broadcast, and a panel. Plus the lines that were missing — `probeWorker`
logged nothing at all, task status transitions logged nothing, and the dispatch line named the
account without the score that chose it. ⚠️ The tick's conclusion logs only when it *changes*: a
10-second loop logging every pass would push a day of real events out of a 2000-line buffer in six
hours.

### And a smaller one, which is the same lesson

`recordTurn` writes `context_tokens`, `last_request_started_at` and `cache_expires_at` onto a session
and announced none of it — only a `turn` event, which is about the turn. So the fleet strip drew an
empty cache bar, `no turn yet` and `--:--` for session e1419ce6, which was 77 turns and 118,183
context tokens deep, while the task pane one panel over read 82k off a fresher copy of the same row.
`events.ts` already carried the rule that was broken — *a mutation is only half done when the row is
written* — so the announcement moved to the write.

The first thing the finished loose-ends scan found, run against the real repository, was a stash in
ws1 holding the t5 Workers-table work that `rescueDirt` had saved and nothing had ever shown anyone.

---

## The conversation that was thrown away after every turn

The operator asked whether Antigravity was starting from scratch on each reply within one task. It
was — and so was Claude Code, and the evidence was already in the database.

Across the nine (task, adapter) pairs that had ever run on this install, the count of distinct
sessions equalled the count of runs in **every one**. t8 opened four Antigravity conversations to
take four turns of a single task. `warmSessionFor` — the reuse path the whole cost model is built to
make available, `0.1·C` against `2.0·C` — had never matched once, because `completeTask` closes the
session about a second after the turn ends and the next reply arrives minutes later:

```
07:04:46  run starts        sess 94026876
07:19:54  run completes
07:19:55  session closed
07:21:37  next run starts   sess 869d4cfc      ← a process that had never heard of the task
```

Both CLIs could have resumed the whole time. `resumeSession: true` was declared by three adapters and
read by **nothing**; no `--resume` or `--conversation` appeared anywhere outside a sentence in the
glossary. Worse, `antigravity-cli.ts` decoded `conversation_id` off the `init` record into a
`StreamEvent` that nothing consumed — the one handle capable of resuming an `agy` conversation was
parsed and dropped on arrival.

The fix is a `resumeFrom` on the spawn request, which each adapter spells in its own flag, and a
`vendor_session_id` column for the case where the CLI names its own conversation rather than taking
ours. It reuses the **same session row** rather than making a second one: `claude --resume` reuses
the original session id (`--fork-session` is the opt-out), so a second row would be a second name for
one conversation and its transcript would be metered twice.

Three gates decide whether a conversation is worth going back to, and each is a failure that would
otherwise be silent. Same **account**, because a conversation lives in one isolation root. Same
**worktree**, because Claude Code files transcripts under an encoding of the cwd — resuming from
elsewhere finds nothing, starts fresh, and reports success. And at least one **recorded turn**,
because `claude --resume` on an unknown id fails the process outright; every session in this
install's history that exited before saying anything has zero turns and every real one has at least
one, which made the discriminator exact rather than a guess.

`promptFor` also stopped restating the task's brief into a resumed conversation. It had always
restated the first human message, for a reason written beside it: *a fresh session after a preemption
has no idea what it was asked to do*. True — and not true of a session that has the brief in its own
history, where restating it reads as being asked to do the work a second time.

### Measured rather than assumed

One fact planted and asked back on each CLI, 2026-08-28:

| | claude 2.1.250 | agy 1.1.22 |
|---|---|---|
| id returned | same `session_id` | same `conversation_id` |
| recalled the fact | yes | yes |
| cold turn | cache_creation **41,542**, cache_read 0 | input 14,637, cache_read **0** |
| resumed turn | cache_creation **65**, cache_read **41,542** | input 29,556, cache_read **0** |

41,542 cache-creation tokens to say "remember this number" in an **empty directory** is the cold-start
tax every task was paying, and Claude reads the whole prefix back instead of rebuilding it.

⚠️ The same measurement contradicted the obvious generalisation. `agy` restores the conversation but
reports no cache read on either turn while `input_tokens` roughly doubles: it appears to re-send the
history at full input price. Resuming is still right there — the context is what the agent needs —
but it is not a *cache* saving on that vendor, and the design that follows this must not assume one.

Two tests initially passed with their fix reverted. Both were the vendor-id guards, where SQL `NULL`
semantics were quietly doing the work the guard was supposed to do; re-mutating to the naive
`update … where id = ?` a real implementation would have written made them fail correctly, and a
second case — *never replaced by a different one* — was added for the half that mutation exposed.

`openai-compatible` went the other way and now declares `resumeSession: false`. `codex exec resume`
exists and is unwired, and the scheduler drops a cold start on the strength of that flag: a
capability that lies in that direction silently loses the context and reports a warm continuation.

---

## The worktree that was handed back while somebody was still living in it

Phase 1 of resident sessions, and it is one line of intent: **the workspace belongs to the
conversation, not to the run.**

It used to belong to the task, and the claim died when the run did. The scheduler's own comment had
already worked out what that cost, in `dispatchIntoWarmSession`:

> A task **continued by a reply** is therefore warm in context and homeless on disk.

So the reuse path the whole cost model exists to reach had to ask the pool for a tree and *hope* it
was handed the same one back. Anything else meant an agent resuming a conversation about files that
were no longer in front of it - and it had to hope while holding the one thing that made the reuse
worth doing.

Three changes carry it. `reassignClaim` transfers an existing claim rather than releasing and
retaking one, because the ordering forces it: a session's working directory *is* its workspace, so
there is no session to claim on behalf of until there is a workspace to put one in, and a pool with a
free slot for even one scheduler tick is a pool another task can take the slot out of. The in-memory
map is keyed by session rather than by run. And `releaseFor` stopped releasing the workspace at all -
`releaseWorkspaceOf` runs when the conversation ends, reached from the session's own exit.

### The valve that had to come with it

Eviction was planned for phase 4 and moved here, because without it phase 1 is a leak rather than a
feature. The cache clock closes a session whose cache has lapsed - but only on the `compact` and
`close` moves. Its `let_expire` move leaves the session alone, so an idle conversation would sit on a
worktree until somebody restarted the daemon. A pool with nothing free now closes the least valuable
resident and takes the tree.

⛔ Never one with an open run: evicting a conversation mid-turn would kill a run to start another,
which is not a trade this scheduler is allowed to make on its own.

⚠️ The ranking is the part with judgement in it, so it is a pure exported function with its own
tests. A **lapsed cache goes first** - such a session's context is no cheaper to reach than a cold
start, so closing it destroys nothing that had value, and ranking a warm session ahead of a lapsed
one would be the scheduler throwing away the exact thing it exists to preserve. Idleness is only the
tie-break, and it is measured from the **last request** rather than from `startedAt`: a conversation
opened an hour ago that spoke a second ago is the busiest thing in the pool, and ranking by start
time would evict it first, reliably, every time, on a fleet whose sessions are long-lived by design.

When the victim's cache was still warm the log says so in those words - *this pool is too small for
the work in it* - because that is a fact about the operator's configuration, not about the scheduler.

### Two things found on the way past

`completeTask` read the workspace map by run id, and the finish path is gated on the answer: a
missing workspace means no landing, no loose-end scan and no ask to commit. Re-keying the map without
re-keying that read would have turned every completion into a silent no-op.

And `reconcileTasks` carried `workspaces.delete(task.id)`, which had never once matched - the map has
never been keyed by task. Harmless, and it survived precisely because it read like the line that
cleaned up after a restart. Nothing needs to: the map is in memory and starts empty, and
`reconcileClaims` clears the rows beside it.

---

## Lending a conversation, and the letter that went missing from every filename

Phase 2 of resident sessions. Phase 1 gave a conversation its own worktree for as long as it lives;
this is what happens when a second task wants it.

The **lease** is an exclusive Resource held by the task, following the rule the glossary already
states - *if the scheduler owns the claim, the lock is unnecessary*. Two tasks in one conversation is
not discouraged, it is unrepresentable: the second claim is simply not granted. A boolean field
guarded by an `if` would have been a lock with extra steps and a race between the read and the write.
Because the holder is the task, `releaseAllFor(task.id)` already returns it at the end of every run,
on every exit path, with nothing new to remember. That also settles a question the owner asked
directly: a task parked at `awaiting_human` holds no lease, so its conversation *can* be borrowed
while it waits, and it takes the lease again when somebody replies.

Moving the tree is the dangerous half, and the danger is not git. It is that the agent's context is
full of file contents read from the branch being left, and nothing in that context says so. Three
readers need to know, and each needs something different: the parked task's **thread** gets a note,
because from its side the tree silently moved; the **agent** gets a warning at the top of its next
prompt, before the task's own words, because one that reads the work first has already started
planning against a tree that is not there; and the **log** gets the switch, because a worktree
changing branches between two tasks is the most confusing thing this feature does from outside.

⛔ Restoring is the same function in the other direction. When the borrowed task runs again its branch
is the one that differs, so the tree moves back and the note goes to the borrower. There is
deliberately no separate restore path: two functions that must stay each other's inverse are two
functions that will eventually disagree.

⛔ And a tree holding uncommitted work is never lent. The alternative was stashing to make room, which
takes work that is currently *visible* as a loose end and hides it in a stash the next reader has to
know to look for - the t5 failure with extra steps. A dirty tree keeps its task and the borrower
starts cold.

### The bug the tests found on the way past

`switchResidentBranch` refuses a dirty tree and names the files. The test asserted the name was in
the message. It was not: the message said `ept.txt`.

`git status --porcelain` writes a two-column status field, so a file modified but not staged begins
its line with a space - ` M kept.txt`. The `git()` helper in this module **trims its output**. Every
such line therefore arrived one character short of what `slice(3)` assumed, and every modified file
in the codebase was reported with its first letter missing.

⚠️ Untracked files start with `??` and were never affected, which is exactly why this survived: the
loose-ends scan that found the t5 stash had no modified file in it to get wrong. `workspaceState` is
read by the loose-ends list, by the refusal to land, and by the ask-to-commit instruction - so the
same wrong name was being shown in all three, to somebody who would have gone looking for a file that
does not exist.

Parsed by field now, with its own test, verified by putting `slice(3)` back and watching two tests
fail.

---

## Turning it on: three tiers, and a boundary rather than a switch

Phase 3 of resident sessions. Phases 1 and 2 built the machinery; this is the part that decides
whether any of it happens, and to whom.

The setting mirrors `finishPolicy` exactly - task > project > fleet, `inherit` a real value at the
lower two - because an operator who has learnt one has learnt the other, and a second shape for the
same kind of decision is a second thing to remember. What differs is the **default**, and the
asymmetry is the point. `finishPolicy` ships `agent-lands` because finishing has to do *something*
when a task ends. Sharing ships **off at every tier**, because it changes who can see whose work, and
an install that started sharing because it upgraded would be a change nobody asked for made
everywhere at once.

That framing decided the gates. Sharing never crosses a project and never crosses an account - not as
a tuning parameter but because one client's code in another client's conversation is not something a
scheduler gets to decide is acceptable. And it changes nothing about **authority**: `mandate` still
decides what a task may do. Sharing lets a task *read* a conversation; it never lets one act beyond
what it was granted.

### Mechanical gates, on purpose

The owner asked for a topic score and then said, correctly, that there was no good design for one
yet. There still is not, and the reason is worth writing down rather than deferring: a topic score has
**no ground truth**. When it misfires there is nothing to check it against, and being wrong means an
agent has quietly read work it was not given. A rule anybody can predict from the outside - same
project, same account, free, clean, room to grow - is worth more here than one that is right slightly
more often and unexplainable when it is not.

⚠️ Scoring is not ruled out, and the seam is left open deliberately: `rank` returns a **list**, not a
winner, so a score becomes another term in that comparator rather than a new decision somewhere else.

Two gates earned their own reasoning:

- **The context ceiling is a fraction (60%), not a token count.** Windows across this fleet differ by
  an order of magnitude - 200k on some models, 1M on others - and one absolute constant would be far
  too strict on the large ones and useless on the small. A borrowed conversation about to need
  compaction is a false economy anyway: the borrower pays to read a large prefix and then pays again
  to compact it, for context mostly about somebody else's task.
- **Unknown is not full.** A model with no priced window reports none, and reading that as "too full"
  would exclude a whole provider from sharing over a number it does not publish - the same trap as
  treating an unrecorded cache expiry as lapsed, avoided in the same way.

A project config saying something meaningless - `share: true`, `share: "yes"` - falls through to the
tier below rather than being coerced. Guessing which way a nonsense answer leans is how an information
boundary gets widened by a typo.

### What the task control does not do

`FinishPicker` also *acts*: switching a finished task to a landing policy lands it. `SharingPicker`
deliberately does not. Acting on it would mean moving a running agent out of the conversation it is
mid-thought in, which is the single thing this feature must never do. It records a preference and
applies from the next run.

⚠️ **Sharing has never actually run.** Every gate is unit-tested, the tiers resolve correctly, and
`test:ui` drives both controls against the real daemon - but no two tasks have yet shared a
conversation on this machine. That needs two tasks in one project on one account with the switch on,
and it is the next thing to try rather than something these tests have established.

---

## Which conversation served which tasks

Phase 4, and the last of the resident-sessions work. The page exists for exactly one number: **how
many tasks have been in one conversation.**

Everything else was already visible somewhere. A task's own pane names the conversation it is in, and
after phase 0 it says whether that run was warm or new. What nothing said is who *else* had been in
it - and once a session outlives the task that opened it, that is the whole difference between the
cost saving working and two agents having read work nobody meant to show them. From the task list
those two look identical.

⛔ Derived from `runs` on demand, never stored. Which tasks a conversation served is a fact about that
table, and a cached copy would be one more thing to keep in step with it - the class of bug migration
5 already had to repair once, on counters that only ever added.

⚠️ Read-only, deliberately. The only honest actions would be *run a task in it*, which the task pane
already offers, and *close it*, which the cache clock owns. A close button beside a live agent is an
invitation to kill somebody's run by tidying up.

### Two mutations that survived, and what they were hiding

The first pass had twelve tests and all twelve passed with the join broken.

Replacing `group by r.session_id, r.task_id` with `group by r.task_id` changed nothing, because no
test had a task that ran in **two** conversations - and that is not an exotic case, it is what
resuming produces every time a session dies and comes back. Under the mutation those two runs collapse
into one row, so one of the two conversations silently loses the only task it ever served and renders
as unused. The test that claimed to cover this ("keeps each conversation's tasks to itself") only
proved rows are not *invented* across sessions; a second test now proves they are not *lost*, which is
the direction that fails quietly.

Removing the `limit` clamp also changed nothing, because the fixture had twelve rows and the cap is
five hundred. Rather than insert five hundred and one sessions to observe a bound, the clamp is now a
one-line exported function tested directly - including that `0` and `-9` do not reach SQL as "no
limit". ⚠️ The two are indistinguishable until an install has more than five hundred conversations,
and by then it is too late to find out.

### Measured, and honest about what is not

Against the live database on 2026-08-28: **0 conversations have served more than one task**, which is
the correct reading of a feature that ships off. ⛔ That database is also still at schema **v9** while
this build expects **v13** - the daemon has not restarted since any of the last five commits landed,
so migrations 10-13 have never run against real data. Both facts are in HANDOFF rather than implied by
a green suite.

---

## What running it actually found

Four phases of resident sessions shipped green, and then it was run against a real fleet for the first
time. **Two bugs, both invisible to every test, and one of them predated all of this work.**

### The parked conversation that blocked its own reply

The trial: task A commits a note and rests at `awaiting_human`, keeping its conversation warm; task B
is then filed and should borrow it. B never dispatched. The log said
`tick: held: t12: ClaudeSecond at capacity`.

`maxConcurrent` counted **every open work session**, including idle ones, and the gate ran before any
consideration of reuse. So on a one-slot worker - which is what the app creates by default - a task
resting at `awaiting_human` filled the only slot with the very conversation the next task wanted.

⛔ And this was never about sharing. The same gate had been silently blocking **every warm
continuation** on a one-slot worker since long before any of this: a task parked for a human, replied
to, could not be dispatched back into its own warm session - the single most valuable move the cost
model has, `0.1·C` against `2.0·C`, unreachable on the default configuration. Four hundred and fifty
tests, none of which had a worker at capacity holding a session the task wanted to reuse.

The fix is one clause: the session a task will reuse does not count against the cap, because reusing
it starts no process. Safe because `warmSessionFor` only ever returns idle sessions and the lease
stops two tasks being handed the same one.

### The borrower that ran on the lender's branch

With capacity fixed, t13 borrowed t11's conversation, ran `warm`, and answered correctly. It also had
`branch: null` - and ran in t11's worktree, **on t11's branch**.

`dispatchIntoWarmSession` read `task.branch` and never assigned one, because it was written when a
warm session only ever served the *same* task, which already had a branch from its cold dispatch. A
task that has only ever run warm never gets one. So the branch switch was skipped, all three of phase
2's notices were skipped, and the whole of phase 2 was unreachable from the only path that borrows.

t13 only read files, so nothing was mixed. A borrower that committed would have put its work on
somebody else's branch - the exact failure the switch-and-tell was built to prevent.

Both fixes verified by re-running the trial, and the second one asked the agent to prove it: t14
borrowed t11's conversation and was asked *which branch are you on*. It answered
`multi-agent-controller/t14-...`. t11's thread got the notice naming t14 and confirming its own branch
was untouched, and when t11 ran again the tree came back to it.

### What the trial established, with numbers

One conversation, `f9a6bac3`, served **three tasks** - t11 lent it to t13 and t14. Each borrow
reported `warm` and ~**86,000** input-token-equivalents cheaper than a cold start. Migrations 10-13
ran against real data and the backfill gave all twenty pre-existing sessions a project. The
Conversations page showed `tasks=3` on that row and `1` everywhere else, which is exactly the number
it exists to make visible.

⚠️ And a finding about **Antigravity** that is not about sharing at all. Asked to create a file,
commit it, and report the hash, it reported `b680242` - a commit that does not exist. No file was
created and the branch was untouched. With `mcp: false` the first successful `result` record completes
the task, so agy gets exactly one turn and whatever it says in that turn is taken as done. The only
reason this was not recorded as a success is that the finish path asks **git** rather than the agent,
and refused to land a branch carrying no commits. That is the design working; it is also a reason to
be wary of unattended work on that adapter.

### The commit case, which is the one that could have gone wrong

The first trial's borrowers only read files, so nothing could be mixed. The second ran two tasks that
both **wrote and committed** while sharing one conversation.

t15 created `trial-e.txt` and committed it, then parked at `awaiting_human` with its conversation
warm. t16 borrowed that conversation, was given its own branch, created `trial-f.txt` and committed
that. Then t15 was replied to and took the conversation back.

Every check held:

- `t15-commit-trial-e`: **1 commit**, files `trial-e.txt`.
- `t16-commit-trial-f`: **1 commit**, files `trial-f.txt`.
- Neither branch contains the other's file.

⭐ And the agents confirmed it from the inside rather than the daemon asserting it. t16 was asked for
its commit hash *and* its branch, and answered `6724bf8 on multi-agent-controller/t16-commit-trial-f`.
After the tree came back, t15 was asked which branch it was on and which `trial-*.txt` files existed,
and answered `multi-agent-controller/t15-commit-trial-e, trial-e.txt` - its own branch, its own file,
and no sign of t16's.

Both threads were told, by name, each time the tree moved. One conversation ended up serving **five
tasks**, every borrow reporting `warm` at ~86-92k input-token-equivalents saved.

⚠️ One number worth watching: context went 43k → 49k across those five tasks. That accumulation is
what the 60% share ceiling is for, and it has not yet been seen to fire - a conversation shared long
enough will eventually stop being offered, and nothing has observed that happening.


---

## The task view becomes three screens (2026-08-28)

The task list, the task detail and the live output were one screen. That works until a project has
forty tasks, at which point the pane for the task you just clicked renders below forty rows of the
list you clicked it from — further off screen the more work a project has, which is exactly backwards.

### Thread, not Conversation

The owner suggested calling the new tab **Conversation**. It was named **Thread** instead, and the
reason is worth keeping: *conversation* already means something precise here. It is the agent session
you resume with `--resume` or `--conversation`; it has a vendor id, it outlives the task that opened
it, another task can borrow it, and Settings has a page listing them. A task's messages are a
different object with a different lifetime — one thread can be served by several conversations and one
conversation can serve several threads. Naming both "conversation" would have made *"which
conversation is this task in?"* ambiguous on the exact screen that answers it. `docs/glossary.md`
now defines the two against each other.

### The list learned to filter, in the daemon

Six buckets over thirteen statuses, multi-select, with **All as the empty selection** so that
"everything" has one representation rather than two. Every status is in exactly one bucket, which is
what makes a multi-select a plain union — no row returned twice, no count added twice — and a test
pins that in both directions, because a status added later that no bucket names would be invisible in
every view except All.

⛔ The counts on the chips are taken over the project, **never over the current selection**. A count
that followed the filter would read `Needs you 0` while three tasks waited on you, purely because you
were looking at Done — right only for the chip you had already clicked.

Filtering and paging went into `pageTasks` rather than into React, because the list re-fetches on
every `task.changed` the fleet emits. `task.list` was left alone: it has fourteen callers and one of
them is the MCP tool an *agent* calls, and changing an external contract to add a table filter is the
tail wagging the dog.

### Three tests that could not fail

Written, run green, then mutated — and three of them did not notice:

1. **The Thread navigation checks.** Breaking the row → Thread route in the *project* branch changed
   nothing: `test/ui.test.mjs` files every task with no project and drives the **unassigned** route,
   so the mutation was in code the suite never reaches. Mutating the route it does drive failed eight
   checks. The project tab remains uncovered and is recorded in HANDOFF as such rather than counted.
2. **The sort tie-break.** "Asked twice, answered identically" passed with `, t.seq` deleted — SQLite
   falls back to rowid, which is stable *and* is insertion order, so the test agreed with itself while
   pinning nothing. Rewritten to assert the **direction**, which rowid cannot fake because it never
   reverses.
3. **Every message carries a timestamp.** Passed on a thread with **zero messages**. The suite's tasks
   were filed with a title and no prompt, and the row being opened was the stalest one. Fixed by
   seeding a prompt, opening the freshest row, and asserting `msgs.length > 0` as half the claim.

A fourth was retired rather than fixed: a negative-offset clamp cannot be tested, because SQLite
already ignores a negative `OFFSET`. The clamp stays as defence; the test that could not fail is gone.

### The conversation id, and where it could be tested

Runs showed the **run** id and never the conversation's. They now show the id you would paste after
`--resume` — the vendor's where the CLI named its own conversation, ours where it took the one we
gave it — per run, because a task that ran three times may have run in three conversations and the
ledger names only the latest.

⛔ The first UI check for this reported PASS against `{"runs":0}`: the suite's worker has no
credentials, so nothing it files ever dispatches and there are no runs at all. Green, asserting
nothing. The resolution moved into `lib/conversation.ts` as a pure function with its own tests, where
the thing that can actually be wrong — picking a plausible id that resumes nothing — is checkable.

---

## Binding Antigravity to its worktree (2026-08-28)

t17 committed to the trunk with `--dangerously-skip-permissions` while its branch stayed empty. The
containment gap was real; the fix turned out to be one flag, found by reading how somebody else
solves the same problem with the same CLI.

`Untrivial-ai/agent-orchestrator` has an Agy adapter in Go, and its two command builders both append
`--add-dir <WorkspacePath>` — `GetLaunchCommand` and, crucially, `GetRestoreCommand`, where it sits
directly beside `--conversation <agentSessionId>`. They set the process cwd as well; `--add-dir` is
the second mechanism on top, not a replacement for it. Our adapter passed `--conversation` and never
`--add-dir`, and `agy --help` on 1.1.22 — the build we run — lists the flag.

⛔ The resume is the case that matters and it is the one an obvious fix would miss. A cold launch has
no prior opinion about where it lives; a conversation reopened by id arrives pointed at wherever it
was born, because Agy's state outlives the process in `~/.gemini/antigravity/`. An adapter that bound
the workspace only on a fresh spawn would repair the case that was never broken. The mutation test
for this is exactly that: `if (req.cwd && !req.resumeFrom)` still fails.

### The trial

One task, two runs in one conversation — the second resumed, which is the half under test. Both were
asked to report `git rev-parse --show-toplevel`, write it to a file and commit.

| | t17, before | t18, after |
|---|---|---|
| distinct trunk paths in the conversation store | 45 | **0** |
| distinct workspace paths | 0 | **5**, first at step 2 |
| trunk reflog entries added | 3 commits | **0** |
| landed through the branch | no — `nothing-to-land` ×3 | **yes, both runs** |

⭐ The measurement is the conversation store, not what the agent said about itself. t17 was convicted
by that count and t18 is acquitted by it, which is the same instrument pointed at both. The resumed
run reported `C:/Dev/multi_agent_controller_workspaces/ws1` and committed there; the trunk's reflog
was 72 entries before the trial and 72 after.

⚠️ What this is not: containment. `--add-dir` is a request to a CLI. Nothing stops an agent that
decides to write elsewhere, and this adapter still has no isolation root — `envFor()` sets no `HOME`,
so all four workers share one `~/.gemini`. The check that does not depend on the CLI cooperating is a
trunk tripwire, and it is next.

---

## The trunk tripwire (2026-08-28)

`--add-dir` stopped Antigravity wandering, but that is a CLI cooperating rather than a boundary. This
is the check that does not depend on cooperation, and it covers every adapter rather than the one
that happened to be caught.

**The rule needs both halves, and the second is what makes it usable.** Fire only when the task's
branch carries no commits **and** the trunk's landing target moved while the run was in flight.
Either alone is ordinary: an operator commits to their own trunk constantly, and an empty branch is
the normal shape of a task that only had to answer a question. Together they are the exact signature
of t17 — three commits on `main`, a branch that never moved, and `nothing-to-land` logged three times
as though the agent had simply had nothing to do.

⛔ **Null is not innocence.** A run dispatched before migration 14, a projectless task, a target that
does not resolve — all give no reading, and the check declines rather than assuming nothing happened.
A tripwire that read "cannot say" as "all clear" would quietly stop covering the oldest runs in the
database, which are the ones nobody is watching.

⛔ **The second reading is taken before landing.** `landTask` fast-forwards the trunk itself on a
project with no remote, so a reading taken afterwards would report the tool's own push as the
movement it was looking for. A tripwire that fires on its own footsteps is worse than none.

⚠️ **`--verify refs/heads/<target>`, not `rev-parse <target>`.** The bare form is ambiguous when a tag
shares the branch's name, and git resolves the tag — which never moves, so the tripwire would compare
against a constant and never fire again, silently, on the one project unlucky enough to name a tag
after its trunk. That mutation survived the first round of tests; the test that catches it creates
exactly that repository.

The action is deliberately mild: the task goes to `awaiting_human` with the commits named in its
thread, and the run still closes normally. What is refused is the *verdict*, not the work.

⚠️ It has never fired in anger, and cannot easily be made to: the failure it watches for is fixed, so
provoking it means reintroducing the bug on purpose. What is proven is the decision rule (seven
cases, three mutations) and the readings (seven cases against real repositories).

## Two reference points for "landed", and the one that stayed silent (2026-08-29)

A live parallel run with one worker produced two complaints, and neither was the bug it looked like.

**t22 did not fail to land — it landed, and was described wrongly.** `adb7268` was on `origin/main`
before the controller ever looked; the agent had pushed it itself, following this repo's `/commit`
skill, whose step 6 tells a worktree to `git push origin HEAD:main`. What the operator was told was
that the branch *"carries no commits that `main` does not already have"* — and the finish path had in
fact compared against `origin/main`, which their local `main` was two commits short of. So the
sentence was true of the ref it named, false of the ref it used, and read exactly like work that had
evaporated. The timings say the same thing: `finish: land` → `completed` in **109 ms**, against ~27 s
and a `landed tNN … onto main` line for t20 and t21 the same hour.

⛔ **The defect was two definitions of "landed" in one path.** `workspaceState` counted against the
local `<target>`; `landTask`'s early return compared against `origin/<target>` and printed
`<target>`. Both are defensible alone. The fix is that neither is a choice any more: `landedRef()` in
`worktrees.ts` is the one definition — `origin/<target>` when it resolves, the local branch when
there is no remote — and `workspaceState`, `decideFinish` and `landTask` all consume it.

⭐ **`origin/<target>` is the right one because landing is a push.** `landing.ts` runs
`git push origin HEAD:<target>` and never moves a local ref; the operator's trunk is updated by their
own `git pull` and nothing else. `main`'s reflog on this machine contains only `pull: Fast-forward`
entries — not one land — which is the evidence that the local branch was never the thing being
measured.

⚠️ **Which makes an agent that pushes its own work a supported outcome, not a refusal.** Landing
mechanics differ per project and a finishing instruction that ends in a push is common, so every
message now names the ref it compared and, when `targetBehind > 0`, says how far the operator's trunk
trails it and to run `git pull`. ⚠️ `?? 0` on that count, because a base git cannot resolve is not
evidence the trunk is behind.

**The other complaint was a word.** A task held because the only worker was busy sat at `ready` with
`Antigravity at capacity` rendered underneath it, and read as a task waiting on the operator to press
something. ⛔ **It is still `ready` in the DAG.** `setHoldReason` had already argued the case —
inventing a status for "ready but nothing free" puts a lie in the graph to fix a gap in the display —
so `statusLabel()` renames it to **queued** at render time, the same trick `assigned` → `dispatching`
was already using. ⚠️ Driven by `holdReason`, not by the renderer counting workers: the scheduler has
done that arithmetic and written the answer down, and a second opinion would disagree the first time
a gate the UI does not model held a task back.

⭐ **And the branch it leaves behind is now retired, which took finding a second gap.** The obvious
fix — delete on `landTask`'s early return — would have changed nothing: `decideFinish` returns
`nothing-to-land`, and the scheduler takes that verdict straight to `completed` **without ever calling
`landTask`**. Worse, making `landedRef` correct is what routed every agent-pushed task down that path,
so the leak went from occasional to one dead branch per task. `finishWithoutLanding()` is the one
function both callers use, and the licence to use `branch -D` is the caller's own `rev-list` count of
zero — no unmerged work exists to lose, only a name.

⚠️ **Detached at HEAD, not at the base.** Detaching at the base also frees the name, and would
silently change the files under an agent still looking at them.

⭐ **Which makes "continue this task" mean something afterwards.** Both resume paths —
`prepareWorkspace` cold, `switchResidentBranch` warm — already re-cut a missing branch under the same
name; what was never checked is that they cut it from the ref the work actually landed on.
`baseRef` now delegates to `landedRef` instead of repeating its two lines, because they were separate
copies of one rule and that is precisely the shape of the bug this whole entry is about: a resumed
task branching off a trunk two commits behind would open with its own finished work missing.

## Antigravity quota cycling to unknown, and probing disabled workers in the background (2026-08-29)

Two poller bugs discovered during live fleet runs:

- ⛔ **Antigravity quota reading was wiped out every 5 minutes.** Antigravity writes no usage cache to disk
  (`answer: 'screen'`); its quota comes exclusively from driving `/usage` in an interactive PTY session.
  When the background sweep ran, `shouldBackgroundRefresh` was false for 30 minutes after a successful
  refresh, and the sweep fell through to `probeWorker`. Calling `probeWorker` on an adapter without a disk
  cache recorded a sample with empty windows and emitted it over the wire, wiping out the fleet strip's
  badge and replacing it with `quota unknown` for 50% of the time. `QuotaPoller.sweep()` now skips
  `probeWorker` for screen-answered and unprobed adapters when a background refresh is not due.

- ⭐ **A failed probe marks the previous reading stale rather than burying it with unknown.**
  When a probe or refresh fails on an account that already had a successful reading, `lastQuotaReading`
  preserves the older windows, sets `stale: true`, and attaches the error. `quota.changed` events and the
  `worker.probe` RPC now emit and return `lastQuotaReading` so the fleet strip shows the last known numbers
  with the `stale` marker and `last check failed` notice instead of dropping to `quota unknown`.

- ⛔ **Disabled and suspect workers were being probed in the background sweep.** `QuotaPoller.sweep()` was
  iterating over every worker from `listWorkers()` including disabled ones (`!w.enabled`), probing their
  identity and logging `probed <Worker>: session X%`. `sweep()` now skips workers that are disabled,
  retired, or suspect/quarantined.

## One account, more than one task at a time (2026-08-29)

The operator ran two tasks against a single Antigravity worker and watched the second sit behind the
first, and asked whether one worker could hold several sessions the way a person opens several
terminals. It already could. `maxConcurrent` has gated exactly that since M1 — `atCapacity` reads it
before dispatch and `spawnSession` refuses past it — the DB column, the `worker.update` RPC and the
protocol types all carried it, and the workspace pool defaults to three, so worktrees were never the
constraint either.

⛔ **The feature was complete and unreachable.** It commissioned at 1 and the Workers table rendered
it as a read-only `<td>`. Six milestones of a setting nobody could set. Worse than a missing feature,
because the `queued` hold that explained the wait named the account — *"Antigravity at capacity"* —
and so read as a fact about the provider rather than as a number the operator owned.

⚠️ **Every test in the repo pinned it at 1**, which is why nothing caught it. `routing.test.ts`
constructs its worker with `maxConcurrent: 1`; `residency.test.ts` mentions the value only in a
comment. The arithmetic above one had never executed. `concurrency.test.ts` now drives it: a second
task admitted at a width of two, a third refused, and — the guard that matters — the reuse exemption
still holding at the new ceiling, because that same gate once blocked every warm continuation on a
one-slot worker and widening the account must not quietly reintroduce it higher up.

⛔ **A floor of 1, applied at commissioning and on every update.** Zero is not "paused": it leaves the
worker enabled, its quota counted and its role honoured, and silently never taking a task, with
`atCapacity` true on an empty account. The switch for *"do not use this one"* is `enabled`, which says
so on the row; a max of 0 would be the same intent expressed where nobody would look for it.

⚠️ **And no upper bound, deliberately.** The ceiling is the account's own rate limits, and a number
invented here would be a guess presented as a rule. That is also why the control is a number input
rather than a dropdown — a list of options would have to pick a maximum, and there is no measured one
to pick. A `.num-input` style was needed because the stylesheet's input rule lists `text` and untyped
inputs only, so a `number` box inherited none of the app's chrome.

⚠️ **What is still unmeasured is concurrency on Antigravity specifically.** `envFor()` sets no `HOME`,
so every worker shares the operator's `~/.gemini` including its conversation store, and two `agy`
processes writing it at once has never been run here. Claude Code has a real per-worker isolation root
and carries none of that risk. Raising the number is the experiment; the honest thing is to say so
rather than to ship it as proven.

## Choosing a model, and the flag that appeared while nobody was looking (2026-08-29)

The operator asked for a model and effort picker, and for the fleet to be careful about prompt
caching when either changed mid-conversation. Most of the machinery already existed: `model.options`
served the model list from the cost models, `checkConstraints` validated a model against its adapter,
all three adapters pushed `--model`, and the New Task form had a picker behind a pinned worker. The
session row already stored `model` and `effort`, and `transcript.ts` wrote the *observed* pair back on
every turn. ⛔ **None of it was rendered anywhere** — zero references to `session.model` in any
component. The data had been collected since M3 and shown to nobody.

⭐ **`selectableEffort: false` had gone stale, and the comment saying so is what caught it.** All four
adapters declared it false with a reason measured on 2026-08-27, and one of those reasons ended
*"promote this the day a flag exists"*. Re-running the flag surfaces on 2026-08-29 found
`--effort low|medium|high|xhigh|max` on claude 2.1.250 and `--effort low|medium|high` on agy 1.1.22.
A capability recorded as a dated measurement, with the condition for changing it written down, is why
this was a five-minute check rather than an assumption nobody revisited.

⛔ **Promoted on a run, not on `--help`.** A headless `--effort low` came back with `effort: "low"` on
its transcript's assistant record — the field `transcript.ts` already parses — so the flag is set
*and* observable. That run cost $0.166, nearly all of it a 41k-token cache write of Claude Code's own
system prompt, which is itself a useful measurement of what a cold start pays before it says anything.

⭐ **Antigravity stays false, and the CLI is now the one saying so.** agy has the flag and rejects
every combination this fleet dispatches — `gemini-3.1-pro-high` "conflicts with --effort=low",
`claude-sonnet-4-6` "not supported for model", `gpt-oss-120b-medium` conflicts — while a bare family,
`gemini-3.1-pro`, runs. So the vendor has two spellings for one choice and `agy models` reports the
pre-combined one. ⚠️ All three refusals were free: the CLI validates before spending a turn.

⚠️ **`agy models` also listed six models this cost model had never heard of** — all of
`gemini-3.6-flash-*` and `gemini-3.5-flash-*` — so they could be neither picked nor priced. Added with
`context_window: null` and the type widened to match, because the figure has not been read from
anywhere and a `1000000` copied from a sibling would be a guess wearing a measurement's clothes. The
same pass found a `?? 0` that would have rendered *unknown* as *0 tokens*.

⛔ **Two tiers, not three.** Finish policy resolves task → project → fleet; model resolves **task →
worker → the CLI's own default** and stops there. A model id belongs to one CLI — `opus` means nothing
to Antigravity, `gemini-3.1-pro-high` means nothing to Claude Code — so a default held anywhere that
can route to several adapters is invalid for most tasks that read it. The worker is the narrowest tier
that always knows which CLI it is. `resolveModelChoice` lives in `@shared` and is called by the
scheduler *and* both forms, so a form cannot promise an inheritance the dispatch does not perform.

⚠️ **`null` is an answer, and `undefined` is a different one.** Null means the CLI picks — the state
every install ran in before there was a control. Undefined means "not mentioned by this patch". The
worker update writes all seven columns in one statement, so collapsing the two with `??` would make a
default unclearable: every attempt to return to the CLI's own choice would silently re-save the value
being cleared. That is one of the six mutations the tests catch.

⭐ **Requested and observed are shown separately**, because they disagree in the cases that matter: a
CLI that fell back when a model was busy, an operator who typed `/model` inside the session, an alias
resolving to a dated id. Showing one number would pick a side and be wrong half the time. Nothing is
shown at all until a turn has been metered.

⛔ **Both controls apply to the next run and never to a live session** — the operator's own call, and
the cheaper one. Anthropic's invalidation hierarchy (now `docs/cost-model.md` §11) says a model switch
is a full rebuild with no escape hatch, because caches are scoped to one model; an effort change
always drops the message history and on some models takes tools and system with it. The pane prices
the first in this repo's own units — 2.0·C to rebuild against 0.1·C to read — against the session's
live `contextTokens`, rather than warning vaguely. ⚠️ Unverified for Antigravity, which reports
`cache_read_tokens: 0` on every turn measured to date, so the pane says nothing there rather than
guessing.

⚠️ **Two suites failed correctly and were updated rather than patched around.** `constraints.test.ts`
asserted all three adapters were false and carried its own instruction — *"delete a line the day one
is exercised against a real CLI, and not before"*. The daemon suite asserted effort was refused on
Claude Code. Both were right when written; a capability is a fact about a CLI version, so the suite
has to be able to change its mind and say why.

## Two quota pools, and the guess that stopped being necessary (2026-08-29)

The operator said Antigravity meters Gemini apart from Claude/GPT and asked for them to be treated as
separate pools. They already were, twice over: the `/usage` probe had been reading **both groups'
windows** since 2026-08-27 — four windows, two per group — and `docs/cost-model.md` §5 carried the
live table. `parseUsageScreen` emitted them keyed `5h:<group>` and `weekly:<group>`.

⛔ **What consumed them was one line that could not see them.** Three callers ask for the five-hour
window by the id `session` or `5h`, and on this provider neither matches. The adapter had papered
over that by renaming the **busiest** five-hour window to the bare `5h`, with a comment saying
exactly why: *"nothing in a quota snapshot knows which group the next run will use."* That was true,
and it made the pessimistic choice, which is the right one when you cannot know.

⭐ **It stopped being true earlier the same day.** The model picker resolves task → worker → CLI
*before* the spawn, so the dispatch gate now knows which model a run will use and therefore which
pool it draws on. Phase 4 was unblocked by phase 2 rather than by anything about quota. The gate asks
`sessionWindowFor(windows, pool)`; the reset countdown and the reserve's sample query still get the
busiest window, because they genuinely have no model in hand and pessimism is correct there.

⚠️ **The concrete failure this removes**: with Gemini at 96% and Claude/GPT untouched, a Claude/GPT
task was held out against a pool it does not draw on. The pools do not share, so the task would have
run fine — a refusal with no cause, and one that reads as "the account is busy" in the UI.

⛔ **`group` is carried beside the window id, because the id does not survive.** The aliasing
overwrites `5h:gemini` with `5h`, so whichever pool happens to be busiest loses its identity. Keyed
on the id alone, the gate could find every pool except the one most likely to matter.

⛔ **Matched by containment, not equality, and the measured table is why.** The panel's heading in the
2026-08-27 reading is *"Claude and GPT"*, which slugifies to `claude-and-gpt`; `formatGroupLabel`
also handles `CLAUDE & GPT` and `CLAUDE/GPT`, giving `claude-gpt`. A pool token of `claude` or `gpt`
is a substring of all three and of none of Gemini's. Equality against either spelling would have
passed a test written against that spelling and failed on a real panel — the mutation run proves it:
swapping containment for equality fails exactly the case where the group carries the alias.

⚠️ **Which model belongs to which pool is data, not a rule in the scheduler.** `pool` sits on each
model in the cost model file. `gemini-*` and `claude-*` look like a rule until a vendor ships a model
that breaks it, and `scheduler.ts` has no business knowing vendor naming conventions. A test asserts
every model in that file has one, because a model added without a pool silently reverts to the
pessimistic window for that model alone — the failure this replaces, reintroduced quietly.

⚠️ **The file's own `quota` block was a lie and is now merely documentation.** It declared
`kind: "unknown"`, `probe: "none"`, `windows: []` while the adapter declared `quotaProbe: 'cli'` and a
working parser had been reading four windows for two days. It now states the four windows and their
pools. ⛔ Nothing reads it — `CostModel.data` is private and the live windows come from the panel — so
a test asserts it against the shipped JSON rather than through the class, and says in its own comment
that this is documentation whose only job is to stop drifting back into a contradiction.

## The landing lock was right and the caller was wrong (2026-08-29)

t26 and t27 were run in parallel and finished within the same second. One landed. The other was told
*"Landing failed: another task is landing right now. 1 commit(s) are on
`multi-agent-controller/t27-…`, which is intact"*, went to `awaiting_human`, and sat there with a
perfectly good commit on a perfectly good branch.

⭐ **Nothing was broken.** Landing is serialised per project because three workspaces finishing at
once would each rebase onto a target the other two are about to move — that is `resources.ts` doing
exactly what it exists for. The defect was one line above it: `claim()` returning `null` was read as a
*failure* when it means *not yet*. A queue two seconds long became a hand-off.

⛔ **The fix waits inside the run that was already waiting.** The losing task holds its workspace and
its session for the duration either way, so polling costs nothing it was not already spending. The
rejected alternative — release the workspace, mark the task `blocked`, re-dispatch when the blocker
completes — is worse in a way that is easy to miss: `admitDependents` walks a blocked task to `ready`
the moment its blocker finishes, and a *finished* task made ready is a task the scheduler hands to an
agent again. A second run over work that is already committed.

⭐ **The dependency edge is a record, not an instruction.** The operator asked for the second task to
depend on the first, and it does — `t27.dependsOn` contains t26 afterwards, so "t27 landed after t26"
is answerable tomorrow. But the edge is what makes the ordering *legible*; the wait is what makes it
*true*. Keeping those two jobs separate is what lets the edge be best-effort: a holder with no task
row, or an edge that would close a cycle, costs the record and never the landing.

⚠️ **Bounded at fifteen minutes, and it gives up on a cancel.** An unbounded wait inside a completion
is a deadlock with a patient face — the task would hold a workspace for as long as the daemon lived.
Fifteen minutes is sized against what is actually being waited for: a landing runs the project's own
checks, which `runChecks` allows thirty minutes *per command*. On timeout the old hand-off returns,
with one sentence added: *nothing is wrong with the branch, landing it again is all this needs.* A
queue that ran out is a retry, not an investigation, and the message decides which of those the
operator goes looking for.

⛔ **Three of the new tests passed against a build with no queue in it at all.** The fixture took the
landing lock and released it after a fixed 60ms — but `landTask` spends a few hundred milliseconds on
`git status` and `rev-list` before it ever asks for the lock, so the hold was released before the
contention it existed to create, and the test measured an uncontended landing while claiming
otherwise. ⚠️ Found by the mutation run, not by the green tick. They now block on the message the
queue itself posts, which is the only signal that does not depend on how fast git is today. Reverting
the queue now fails ten of the eleven, and the eleventh is the guard that must not fail.

## Two agents, one debugging port, and forty-five minutes of nothing (2026-08-29)

The operator reported t29 and t30 still running half an hour after they should have finished, both
apparently sitting in a test. They were: each had run this repo's own `npm run test:ui` in its own
worktree, and both were blocked forever.

⛔ **It was not a deadlock, which matters because a deadlock detector would have found nothing.**
Neither task held anything the other wanted and there was no cycle. `test/ui.test.mjs` hard-coded
`--remote-debugging-port=9444`, and `waitForPage` asked *that port* for a page rather than asking
*its own app* — a page found on a shared port carries no evidence of whose it is. Four runs started
inside three and a half minutes (12:55:47, 12:56:19, 12:57:11, 12:59:13, one temp data dir each).
One bound the port; the losers attached to a stranger's application, and when the winner finished
and killed its app tree the debugging server went with it.

⭐ **The stall was a second, independent defect, and the more important one.** `send()` resolved and
never rejected: no timeout, and no handler for the socket's `close` or `error`. Every wait *above* it
was bounded — 45s for the page, 30s in `until` and `waitFor` — so the shape of the bug is worth
stating as a rule: **a budget above an unbounded wait can never be reached.** The suites now ask the
OS for a port (`freePort`), and every DevTools request is bounded, as is the socket's opening.

⚠️ **Three tiers of fix, and the reason only two were built.** Isolation-by-construction and bounded
waits are cheap and local. The third — teaching the resource broker about contended things an agent's
shell command touches — is not, because `resources.ts` can only arbitrate what the *scheduler*
claims, and an agent typing `npm run test:ui` claims nothing. `test:pack` still cannot be isolated
(it rewrites one fixed `release/win-unpacked`) and wants a lock with an owner and a timeout, on the
same argument as the landing queue: a queue, never an unbounded wait.

⭐ **The watchdog's own comment named the blocker, and the blocker had stopped being true.** Branch 3
of `runWatchdogs` has logged *"no turn for Nm (reported, not stopped — a long tool call looks the
same)"* since M4. That is exactly what elapsed silence can prove on its own: nothing. But the two
stuck trees had used **0.09 seconds of CPU across forty-five minutes**, which is the measurement that
separates them — work burns CPU and a wait on something that will never arrive does not. `stall.ts`
samples the run's whole process tree after 12 minutes of silence and compares two samples a minute
apart.

⛔ **It reports and never acts, and that is not timidity.** A run blocked on a slow network call burns
no CPU either, so the signal is good enough to ask a person and nowhere near good enough to kill on.
It also deliberately leaves the task's status alone: setting `awaiting_human` under a live run would
let a false positive corrupt a run that was fine, where a false positive now costs one message. The
same reasoning that keeps `autoRunawayStop` off by default.

⚠️ **A falling CPU total is progress, not a stall.** The total covers living processes only, so a
child exiting makes it drop — and reading that as "no progress" would report a stall at the exact
moment a long tool call *completed*. That is one of six mutations the tests catch; another is the
cycle guard in the tree walk, whose absence hangs the walk, which would be a poor quality in a
watchdog looking for hangs.

⚠️ **A per-session TTL was considered and rejected.** Sessions are legitimately long — resident
sessions are a feature and a task waiting on a person can idle for hours — so a TTL there kills
correct work to catch incorrect work. Silence was already measured; what was missing was something to
judge silence against.

## Session bar context fill (2026-08-29)

**Problem:** The `SessionGauge` bar in the fleet strip was permanently empty `[--------]` for Antigravity
sessions even though `671k/1.0M` was displayed in text beside it.

**Root cause:** `cacheRemaining()` needs both `cacheExpiresAt` and `lastRequestStartedAt` to compute a
fill fraction. `creditStreamTurn()` — the path used for all stream-metered sessions (Antigravity) —
intentionally passes `null` for `request_started_at` and does not set `cache_expires_at`, because
these sessions have no steerable prompt cache (D24). So `cacheRemaining()` always returned `null`,
and the `{left !== null && ...}` guard rendered nothing.

**Fix** (`FleetStrip.tsx`): When `session.cacheExpiresAt` is null (no cache clock), the bar now fills
using `contextFill(session)` = `contextTokens / contextWindow`, coloured by `quotaUrgency()` (the
same green→amber→red scale the account quota bars use). PTY sessions with a cache clock are
unchanged — they still show the cache TTL fill in blue. The tooltip branches to describe which
quantity is shown.

**Per-conversation quota polling:** Antigravity's `/usage` panel is a global account reading, not
per-session. Per-session context is already tracked via `creditStreamTurn` → `context_tokens` on
the session row, and the bar now shows it. No new probe is needed.

## A fourth task, three workspaces, and a failure that was only a queue (2026-08-29)

The operator reported t40 failed. It had not gone wrong; it had been unlucky, and the scheduler could
not tell the difference.

```
22:10:18  consult route answered on ClaudeSecond: t40 routed to ClaudeSecond
22:10:23  t40 ready -> assigned on 0bb7355a
22:10:23  dispatch of t40 failed: no free workspace in multi_agent_controller
22:10:23  t40 assigned -> failed
22:10:31  landed t38 (0148aa9d) onto main            ← a worktree freed, eight seconds later
```

⛔ **It was structural, not a race.** The enabled fleet could run five concurrent sessions —
ClaudeSecond at `maxConcurrent` 2, Antigravity at 3 — against a workspace pool of three. Nothing
reconciled those two numbers, so a fourth task was guaranteed rather than possible. `chooseTarget`
asks every question there is about the *worker* and asked none at all about the *project*.

⭐ **The broker was right and the caller was wrong, for the second time in two days.** `claim()`
returning null means *not yet*; `resources.ts` says so in its own comment. The landing queue had the
identical bug on 2026-08-28 and read it as a refusal. Here `dispatch` threw a plain `Error`, the
tick's catch-all marked the task `failed`, and `failed` is in `TERMINAL_OR_HELD` — so the eight
seconds until a tree freed made no difference at all. The routing consult spent five seconds earlier
bought nothing either.

⚠️ **A dependency edge was the obvious fix and the wrong one.** `addDependency(t40, t38)` records a
relationship that does not exist and outlives the contention that created it: a P0 filed a minute
later would still queue behind t38, because the edge does not know it was only ever about a worktree.
A hold is re-decided from `schedulingOrder` every tick, which is what makes priority mean anything.
⭐ The landing queue records an edge *and* waits, and that is consistent rather than contradictory —
there the edge is a true statement about ordering on the trunk, and the wait is what serialises.

Two pieces, and the second is why the first is allowed to be approximate:

 - **`poolPressure`**, a gate in the tick ahead of `chooseTarget`. ⚠️ Ahead of it deliberately:
   routing can spend a controller consult, and t40's was spent on a task that was about to be thrown
   away. Three ways past a full pool, each load-bearing — an undeclared pool (`ensurePool` builds it
   on first dispatch, and a project that has never run must not be held for want of a resource that
   exists to be created), a warm session (reusing a conversation claims nothing, and gating it would
   refuse the cheapest move the cost model has), and an evictable resident (an idle conversation on a
   worktree is a slot `evictResident` can reclaim). `evictableResidents` is now shared by the gate and
   the eviction so the two cannot drift.
 - **`Contended`**, thrown only where a resource said no. The gate reads state that can change under
   it; the claim is the truth. ⛔ The requeue sets `ready` **explicitly**: `dispatch` marks the task
   `assigned` before claiming anything and `assigned` is itself in `TERMINAL_OR_HELD`, so a task put
   back by hand that kept it would sit where `admit` refuses to touch it — a worse bug than the one
   being fixed, because nothing would say why.

⚠️ **The retry stays narrow on purpose.** A retry is correct exactly when the next attempt meets a
different world, and the only thing time reliably changes is who holds what. A `prepare` hook that
exits non-zero will fail identically in ten seconds forever, so everything that is not contention
stays terminal and loud.

⛔ **The pool was named, not grown.** `poolSize` is the operator's cap on disk and on parallel git,
and raising it behind their back would be the scheduler overriding a number somebody chose. Auto-sizing
to fleet width was offered and declined. Instead the shortfall is stated on the row it is about and
logged once per project: *the fleet can run 5 at once but this project has 3 workspaces, so one is
always waiting.*

⭐ **Two of the fourteen tests exist to defend the design rather than the code** — that a held task
gains no `dependsOn` edge, and that a P0 filed after three others are running takes the freed slot
ahead of the task that has waited longest. Both would pass trivially today and both are what the
dependency approach would have broken. Six mutations were caught: the gate never firing, an undeclared
pool reading as full, a projectless task borrowing another project's pool, contention made terminal,
everything made retryable, and the warm-session exemption removed.

## A missing command mistaken for a missing reading (2026-08-29)

The operator commissioned a Codex worker, saw `quota unknown` on its fleet row, and asked whether
that was because the account is free — and if so, for the badge to say so.

It was not. The account *is* free (`chatgpt_plan_type: "free"`, read out of the worker's own
`auth.json`), but free accounts report quota like any other. The badge was empty because
`openai-compatible` declared `quotaProbe: 'none'` with this reason attached:

> Codex has no non-interactive usage command (openai/codex#10233).

Every word of that is true. The issue is real and still open. The conclusion drawn from it — *so
there is no reading* — is what was wrong, and it had been wrong for three months. `quotaProbe: 'none'`
made `quota.ts`'s poller skip codex workers entirely and made `quotaGap()` render the permanent
words *not reported*, so nothing ever went looking.

⭐ **One `codex exec` turn settled it.** The rollout JSONL it wrote carries, on an
`event_msg` / `token_count` record, the server's `rate_limits` verbatim: `primary` at 0% of a
**43200-minute** window, `secondary: null`, `plan_type: "free"`. A file read. No process, no token.

⛔ **The free plan is what made the shape of the fix non-obvious.** Free reports *one 30-day window*
where a paid plan reports a five-hour one — in the same `primary` slot. Reading `primary` as "the 5h
window" would have been correct on a paid account and silently wrong here, and `reserve.ts` and
`controller.ts` both gate on the id `5h`. So a window's id is derived from `window_minutes` and never
from the slot it arrived in. Writing it the obvious way would have produced a bug visible only to
somebody on the plan nobody develops against.

⭐ **Then the operator said they had run `/status` by hand and seen a monthly limit and its reset.**
That was the useful correction: `/status` is not reading the rollout. Chasing where it *does* read
from — `codex app-server generate-json-schema --out <dir>`, which is free and local — turned up
`v2/GetAccountRateLimitsResponse.json` and a JSON-RPC method **`account/rateLimits/read`**, no params.
Driven over stdio it answers in **~600–700ms**, no turn, no token.

⛔ **And it is live, not cached**, which is the whole reason it outranks the rollout: two readings
minutes apart returned `resetsAt` values **1311s apart**. A cache cannot do that. So `probeQuota`
became two levels — app-server first, rollout when it cannot be reached — reporting **different
`source` values on purpose (`'cli'` vs `'config-cache'`)**, because `sampledAt` alone cannot say that
one reading is current and the other is as old as the worker's last turn.

⚠️ **Two spellings, one normaliser.** The app-server answers camelCase (`usedPercent`,
`windowDurationMins`) and the rollout snake_case (`used_percent`, `window_minutes`). Same server
payload, two writers. `windowsFromRateLimits` reads both so no caller has to know which level answered.

⚠️ **`usageRefresh` stays null, deliberately.** That field means *type a command into a PTY session*,
which this is not. This is a local subprocess like `claude auth status --json`, so it belongs inside
`probeQuota` rather than in the refresh ladder built for screen-answered providers.

⭐ **`rolloutQuota` was extracted and exported so the tests do not spawn a CLI.** With codex on PATH
the fixture tests were reaching the live app-server and taking 2.2s instead of 0.4s; worse, their
result would have depended on whether the machine running the suite happened to be signed in. A test
that passes for a reason outside the repository is not a test.

⛔ **The same mistake, twice, on two adapters.** Antigravity carried `quotaProbe: 'none'` until
`/usage` in its TUI was measured free on 2026-08-27; codex carried it until this. Both times the
evidence was a *command* that did not exist, and both times a reading did. `AGENTS.md` already said
"ask the CLI before writing `none`" from the first instance; it now says both, because one example
reads as an anecdote and two read as a pattern.

⚠️ **What is still not known.** `resetsAt` tracked the moment of the call on a window at 0% used,
which is consistent with a rolling 30-day window that has not started — but that has never been seen
on a window with real usage in it, and it is written down as measured behaviour rather than as how
the window works.

## A conflict found two branches too late (2026-08-30)

t39 and t43 both finished, both failed to land, and both had to be resolved by hand: ask the agent to
fix the conflict, then press Land again. The operator asked whether a button that sends *"resolve the
git conflict and retry landing"* into the same conversation would be the fix.

⭐ **That button already existed** — it was just never wired to this. `decideFinish` returns
`ask-agent` for uncommitted work, and the scheduler answers it with `sendPrompt(sessionId, …)`,
guarded by `finish_asked_at` so it can never loop. Everything the proposal needed was built and in
production.

⛔ **The conflict simply never reached it.** `decideFinish` returned `land`; only *then* did
`landTask` fetch, rebase, and fail — two branches past the one path that can hand a problem back to a
live conversation. And on failure it ran `rebase --abort`, so the evidence went too. The manual fix
was re-deriving from scratch a conflict the daemon had just seen and thrown away.

So the fix is a **timing** change, not a feature:

1. **Ask before deciding.** `git merge-tree --write-tree` merges in memory — it writes objects, never
   the index or the working tree — so *would this rebase?* is safe to ask while the agent is still
   working in that workspace. It slots in exactly where `readTrunkMovement` already does: an async
   git read whose result is passed into the pure `decideFinish`, producing a verdict.
2. **Hand the conflict over intact.** On the in-flight path the rebase is started and *left stopped
   at the conflict*, so the agent opens the file and the markers are already there. `landTask` keeps
   its abort, because nobody holds that workspace.

⚠️ **The parser was rewritten after being written twice.** The first version parsed `merge-tree`'s
English (`CONFLICT (content): Merge conflict in x`), which varies by conflict type — modify/delete
and rename/rename produce different sentences. The output's *first* half is an unmerged-index block,
`<mode> <oid> <stage>\t<path>`, machine-readable by design. Captured verbatim as a fixture and read
from there instead.

⛔ **Two bugs in the first draft, both caught by writing it out rather than by a test:**
  - The column was appended to an **existing migration**, which every installed database has already
    run — so no existing install would ever have received it. It is migration 18 on its own now.
  - The self-resolving path fell through the entire `else if` chain. A conflict that another task
    takes away between the probe and the rebase leaves `decision.kind === 'resolve-conflict'`, so
    `if (decision.kind === 'land')` was false and the task landed *nothing*, silently. The chain now
    opens on a `landNow` flag.

⚠️ **A second guard, not a reuse of the first.** `finish_asked_at` means *we asked it to commit*;
`conflict_asked_at` means *we asked it to resolve a rebase*. Sharing one column would have denied a
conflict ask to any task that had already been asked to commit — it would have arrived at
`awaiting_human` carrying a conflict nobody ever asked it to fix.

⛔ **A task whose mandate excludes `land` is never asked to resolve a merge.** That is authoring a
commit on somebody's trunk by a longer route, and the gate goes first — which is why the check sits
*after* `mandateAllows`, not before it.

⚠️ **A workspace left mid-rebase cannot be parked**, because `git switch` refuses. Every path that
gives up aborts first, and `parkWorkspace` now aborts blind as a net for the one case no caller can
cover: a daemon that dies between starting the rebase and sending the prompt. Aborting discards
nothing — `conflict.test.ts` asserts the branch and its commit come back exactly.

⭐ **Tested against a real repository, not a mock.** Every claim here is a claim about git — that
`merge-tree` writes nothing, that it exits 1 on a conflict, the shape of its output, that an aborted
rebase loses no work — and a fake git would prove none of them. The defect being fixed came from
believing something about git that had never been measured.

⚠️ **Unproven where it counts.** The conflict ask has never fired against a live agent. What is
measured is the git half; what is not is whether an agent handed a stopped rebase actually finishes
it.

## Four consults spent on a tie the scorer invented (2026-08-30)

The operator opened t42's routing decision and asked two questions of it: where was CodexFirst, and
how could ClaudeSecond and Antigravity both score `-0.120` when their windows were nothing alike.

⭐ **The first was not a bug.** t42's consult was created at 23:05:06Z; CodexFirst was commissioned at
00:41:45Z, ninety-six minutes later. It passes every gate now, and will place last until it earns a
turn — `turns = 0` against ClaudeSecond's 508, so `UNPROVEN_PENALTY` costs it 0.175. That is the
tie-break working, not a fault.

⛔ **The second was.** The score is `-1.249×1 (cold) + 1.129×1 (capabilityFit)`, and every other term
read zero — including `quotaRisk`, at weight 0.908. Both of its triggers were unreachable here:
`at_risk` requires `remainingTokens` in *tokens*, which is R2 and still open, and the live rate-limit
status only turns after the vendor has already refused. So remaining quota was not an input to
routing at all. It was a **cliff with no slope**: excluded above 92%, and worth exactly nothing below.

⚠️ **This was caused by a previous correct fix.** On 2026-08-27 `unknown` had been scored 0.5, which
made the term measure *does this worker have a session* rather than risk; scoring it zero was right
and left the term with nothing that could ever move it. Honest-zero is where a term rests, not where
it lives. `AGENTS.md` now carries both halves, because the first on its own produced this.

⛔ **What it cost, from the `consults` table.** Four consecutive routing questions — t39, t40, t41,
t42 — each offering `-0.120` against `-0.120`, each answered from the worker *labels*:

> *"Scores are tied, so treated as a coin-flip tiebreak; picking the ClaudeSecond candidate as the
> default since Claude is the assistant running this controller."*

A real billed turn, four times, to break a tie the arithmetic had manufactured. The judgment layer
was working exactly as designed; it had been handed a question with no answer in it.

⭐ **The slope.** `windowRisk = clamp01((percent − 50) / (92 − 50))`, taken as `max(vendor evidence,
windowRisk)` so the vendor's own word still saturates the term. Three choices worth keeping:

- **Zero below 50%.** A term rising from the first token is a load balancer, not a risk model, and it
  would fight the warm-session preference the whole cost model exists to express.
- **Exactly 1.0 at 92%**, which is where the hard gate already excludes the candidate. The slope hands
  over to the cliff with no step, so a worker is never nearly-excluded and cheap at the same time.
- **The window the gate read**, hoisted rather than looked up again. Antigravity meters two pools, so
  the answer depends on which the task's model draws from, and a hard cut and a soft preference
  disagreeing about that is worse than either alone.

On the real readings this separates the two by `0.61` — six times `ROUTE_EPSILON`. None of those four
consults would have been asked.

⛔ **And the reason it went unnoticed: a rendered number explains nothing.** `-0.120` looks exactly
like a working measurement. The first attempt at a fix printed `−1.249×1.00 (cold) +1.129×1.00
(capabilityFit) = -0.120`, and the operator's answer was the right one — that still does not say where
`-1.249` came from, whether higher or lower wins, or what scale it is on. So the derivation now
carries all three: a legend stating **higher wins**, **linear and unitless**, and what ε means; every
weight beside the arithmetic that produced it and the objective vector it came from; and per
candidate every term's value, weight, contribution and the **basis in words** for that value.

⚠️ **Zero rows are printed, not dropped.** A table showing only what contributed reads as *the rest
were weighed and found small*. `quotaRisk` was not small. Its basis line is what says so.

⛔ **The published formulas cannot drift.** `WEIGHT_FORMULAS` lives beside `weights()`, and a test
parses each string and evaluates it against the real weight on all four presets. ⚠️ Written as a
hand-rolled parser rather than `Function(…)`: a test that reaches for implied eval to check a
published constant has traded a real guarantee for a convenient one.

## A prompt nobody sent, and the two walls behind it (2026-08-30)

t52 was filed, routed to CodexFirst, dispatched, and then sat for fifty minutes reporting `running`.
The process was alive the whole time. It had used **62 milliseconds of CPU**.

`codex exec` takes its prompt from **stdin, read to EOF** — `exec --help`: *"If not provided as an
argument (or if `-` is used), instructions are read from stdin."* `sendPrompt` wrote the prompt and
left the pipe open, which is exactly right for Claude Code and Antigravity, both of which hold a
conversation there. Codex blocked on a read that would never return. Reproduced against the real CLI:
18 seconds, 34 bytes of output, all of it `Reading prompt from stdin...`. Closing the pipe instead,
the same command completed a turn.

⛔ **The envelope was the lesser half, and it is the more instructive one.** The codex adapter had
`decodeStream` and no `encodeStreamPrompt`, so `sendPrompt` fell through to a default — and the
default was *Claude Code's* `{"type":"user",…}` shape. Codex has no envelope; stdin **is** the
prompt, so it would have read those characters as the first words of the task. The output half of the
stream transport was documented as having no shared format and enforced by the fact that a missing
decoder visibly produces nothing. The input half had the same problem, no rule, and **no symptom**,
because a default that guesses a vendor fails silently by construction. There is now a drift guard:
any adapter offering `stream` must be able to encode as well as decode.

### The two walls behind it

Fixing stdin alone would have moved the failure rather than removed it.

⛔ **`mcp: true`, on an adapter whose own `plan()` warns it cannot register one.** Codex has MCP;
`codex mcp add` writes into the shared config, so a session cannot carry the per-session identity
`task_complete` needs. The prompt builder reads that field, so every codex prompt ended by naming a
tool that was never registered — and the comment above that branch already described the trap
exactly, having been written for Antigravity. `AGENTS.md` said *"a capability is a fact about a CLI"*;
the fix is that it is a fact about **this adapter**, and the rule now says so.

⛔ **`turn.completed` decoded as a usage record only.** It is the usage record *and* the terminal one,
because `codex exec` runs a single turn and exits. A successful run therefore emitted no terminal
event at all: nothing called `onStreamResult`, nothing completed the task, and the process exit fell
to `onSessionExit`, whose only sentence is *"ended without reporting completion."* Every codex run
would have done the work and then been recorded as having failed to finish.

### What the capability had to say

`streamPrompts: 'conversation' | 'once'`. Not an encoding detail — a limit the scheduler has to
respect. A `once` session has no stdin left after its first prompt, so a wrap-up nudge, a finish
instruction and a conflict-resolution ask all have nowhere to go; `sendPrompt` refuses them with a
sentence saying why, and the eight follow-up call sites already degrade to a human hand-off. It also
means such a session is **never warm**: `warmSessionFor` now declines it, because reuse would have
reported a cache saving that does not exist while delivering the prompt into a closed pipe.

⭐ **The watchdog was right and had already said so.** Thirteen minutes in, the stall watchdog sampled
t52's process tree, found no CPU gained in 70 seconds, called it *"stuck rather than slow"* and posted
the tree to the thread. The diagnosis was sitting on the task before anybody looked at it. What it
could not say was *why* — which is the argument for reporting evidence rather than a verdict.

⚠️ **The orphans were not killed by this session.** Three processes were still holding CodexFirst's
slot at diagnosis time; by the time they were to be stopped they were already gone, because the
operator quit the app and the daemon shut down cleanly and took its children with it. Recorded
because "I killed them" and "they died" are different facts and only one of them was true.


## A question that could only be answered yes or no (2026-08-30)

The tool assumed a task runs from dispatch to completion with nobody in the loop. Two real shapes of
work break that: an agent that needs a decision only a person can make, and an agent that breaks work
into phases and stops between them. Neither is a failure to design out — a complex design prompt
*should* stop and ask.

⛔ **A tool existed for this and could not carry an answer.** `request_human` routed through
`approval.request`, whose answer set is closed at `allow | allow_always | deny`. So an agent asking
*"OAuth, session cookies, or magic link?"* received, literally, `The operator agreed.` The question
travelled the whole way to a person and the reply had nowhere to sit. The operator, meanwhile, was
shown three buttons for a three-way design question.

### What the measurement changed

R14 (2026-08-30, claude-code 2.1.251) was run before building, and it moved the plan twice.

⭐ **Claude Code's own `AskUserQuestion` reaches our permission hook**, carrying `questions[]` with
labels, per-option prose and `multiSelect`. So the highest-fidelity path needs no cooperation from the
prompt at all — the agent does not have to know our tools exist.

⛔ **But allow is not an answer.** Returning `{behavior:'allow'}` yields the tool result *"The user
did not answer the questions."* The hook gates *asking*, not *answering*. A second probe settled the
alternative: `{behavior:'deny', message}` **does** reach the model as the tool result and is acted on.
So a question can be answered in place, in the same turn — at the cost of `is_error: true` and a row
in `permission_denials`, both written down where they happen.

⭐ **And the vendor already says when it is blocked.** `post_turn_summary` carries
`status_category: "blocked"` and a `needs_action` sentence — while the `result` record beside it reads
`end_turn` / `completed` / `is_error: false`, byte-for-byte the shape of success. The reason a run
stopped was on the wire the whole time, decoded as `other` and dropped. That record is now
`StreamEvent.turn_status`, and it turned "the session ended, nothing here can tell whether the work
was finished" into the agent's own sentence about what it wanted.

### Three objects, not two

A **Question** is not an Approval and not a Task. An approval's answer set is closed and its answer
can become a project rule; a question's answer set is written by whoever asked and can never be one.
An approval that goes unanswered **denies** — correct for `rm -rf`, and exactly wrong for *"which
design do you want"*, where the agent is then told the operator refused and builds on that.

So an unanswered question **parks**: `answered_at` stays null, the task rests at `awaiting_human`, and
the question is as answerable an hour later as it was at the start. Answering a parked question writes
it into the thread, where the next run's prompt carries it — without that last hop a park would be a
dead end.

⛔ **A blocked run is not a failed run** (owner's call). It did the work up to the question and metered
its turns. Filing it as `failed` was inferred from nothing but the absence of a completion signal — and
it meant three good questions in a row looked like a task that kept failing, which would have summoned
`maybeTriage` to explain a pattern that was not there.

⚠️ **An open question turned out to be better evidence than the vendor's record.** `post_turn_summary`
is the agent reporting its own state; an open question is something we watched being asked. So the run
outcome keys on either, which means adapters that emit no such record get the right answer too.

### Rejected

**Parsing prose to find a question.** Reading intent out of generated text is the inference this
project refuses to make. An anchored `NEEDS DECISION:` prefix the agent was told to use, and a
vendor's own `status_category` field, are contracts — a different thing.

**Widening `Approval` instead.** Everything that makes an approval good — rules, `allow_always`, glob
matching, deny-wins — is meaningless for a design decision, and each would have had to be special-cased
away.

**A text box in the Attention bar.** A `choice` question with three short labels answers there in one
click; anything larger opens the task, because a decision with three paragraphs of rationale is not a
44px strip.

⚠️ **`escalateStale` is dead code**, found while reading the approval path and not fixed here:
`WAIT_TIMEOUT_MS` (10 min) fires before `DEFAULT_ESCALATE_AFTER_MS` (30 min) and writes `answered_at`,
which is the column `escalateStale` filters on. No approval that actually waits can reach
`awaiting_human`, and the function has no test.

### The rest of it, the same day

Steps 5-10 landed after the first commit, and three of them changed something beyond their own scope.

⛔ **The write-through had to know whether the answer had already been read.** An answer given while
the session is live goes back as the tool result; the same answer written to the thread and left
outstanding would arrive *again* in the next run's prompt, and the agent would be asked to act on one
decision twice. So the thread records both either way, and marks the answer delivered exactly when a
waiting agent consumed it. For a parked question the opposite is true and is the entire mechanism:
undelivered is what makes `buildPrompt` carry it, which is how answering restarts the work.

⚠️ **A latent sort flake surfaced while testing it.** `questionsForTask` ordered by `asked_at desc`
alone, and two questions asked in the same millisecond - which one agent turn can easily do - came
back in whatever order SQLite chose. It only failed once the extra thread writes shifted the timing.
Now ordered by `asked_at desc, rowid desc`.

⭐ **The escalation nobody could reach.** `DEFAULT_ESCALATE_AFTER_MS` was 30 minutes and
`WAIT_TIMEOUT_MS` 10, so the waiter always fired first and wrote `answered_at` - the exact column
`escalateStale` filters on. No approval that actually waited could ever become `awaiting_human`. The
path had been dead since it was written and had no test. Five minutes is not a guess at patience; it
is the only interval that leaves the escalation useful, because it has to fire while somebody can
still answer from the bar. A test now asserts the ordering itself, so a later edit to either constant
cannot quietly restore the bug.

⛔ **`NEEDS DECISION:` is a contract, not prose parsing.** An adapter with no MCP has no `ask_human`,
so it is given a prefix to end with, and a run that ends with it is `blocked` rather than completed -
completing it would file an unanswered question as finished work. The match is anchored to a line
start and to the exact words the prompt asked for. A looser one would fire on an agent *describing* a
decision it had already made, and park a task that was finished.

⚠️ **The usage row was out of date, and the instrument is not.** Claude Code's stream does carry
`usage` on 2.1.251, with `iterations`, correcting the 2026-08-25 reading on 2.1.223. We still meter
from the transcript deliberately: it is exact, it sees the compaction sampling iteration, and decoding
both would double-count every turn. What a CLI emits and which instrument we trust are separate
questions, and only the first one changed.


## A default that spent the CI budget (2026-08-30)

The fleet's default finish policy was `agent-lands`, whose last act was
`git push origin HEAD:<target>`. `ci.yml` triggers on `push: branches: [main]`. So **one completed
task was one push was one CI run**, and a run is ten jobs: one Ubuntu plus a 3x3
`ubuntu/windows/macos` matrix.

Measured on this repository: **103 runs between 2026-08-26 and 2026-08-30** - 16, 11, 14, **39**, 23 -
against 97 commits on `main`. macOS bills at 10x and Windows at 2x, so the three macOS jobs are
roughly three quarters of the weight of every run. The account's CI allowance ran out on
2026-08-29T21:54Z, the day of the 39.

⚠️ Agents commit under the operator's git identity, so agent landings and hand-made pushes
cannot be separated by author and the 103 is not attributed. What is certain is the mechanism.

### The ladder

The replacement is five levels on one axis - how far the work travels - each doing everything the one
below does plus one thing: `await-human`, `commit-only`, `commit-and-verify`, **`commit-and-merge`**
(the new default), `commit-and-push`. `pull-request` and `custom` are deliberately *not* levels and
are documented as such: a PR is a different destination, and `custom` is an instruction to the agent
rather than an action the daemon takes.

⛔ **`commit-after-verified` was asked for and cannot exist.** The daemon never authors a
commit, so verification can only happen once there is one to verify. Gating the commit on the check
would need the tool to write it, or the agent's own word that checks passed, or a second turn to ask
for the commit - which a one-shot CLI cannot give. `commit-and-verify` is the achievable shape: the
commit is unconditional and the *verdict* is what the check decides.

### The constraint that shaped the default

```
fatal: refusing to fetch into branch 'refs/heads/main' checked out at 'C:/Dev/multi_agent_controller'
```

Git will not update a branch a worktree holds, and the operator's own checkout is normally that
worktree. That is why `auto-land` pushed whenever a remote existed, and why its local fallback only
worked against a detached trunk - which the landing fixture arranges deliberately.

So `merge-local` does `git merge --ff-only` **inside** the trunk, and only when the trunk is on the
target with nothing uncommitted in it. Otherwise the branch is kept and the task names which of the
three states was in the way. ⛔ Stashing the operator's work to make room was considered and
rejected: the tool does not reach into a checkout somebody is typing in, and a pop conflict would be
its fault.

⚠️ The honest cost is that `main` stops moving on days the operator is mid-edit in it, and
finished tasks queue as branches. That is the safe default working, not a failure, and it is written
into `docs/landing.md` so it is not discovered as "why is nothing landing".

### A defect found while wiring it

`landTask` chose its strategy from the project's **legacy** `landing.strategy` field, not from the
resolved finish policy. A project set to `finish: 'pull-request'` with no `strategy` would have had
its trunk pushed - the policy resolved task > project > fleet and the action that ran were two
different answers to one question. The policy is the authority now; the legacy field survives as the
fallback for `custom` only.

Three dropdowns each carried a hand-written copy of the policy list, and all three still offered
`agent-lands` after the rename. They are driven from `FINISH_ORDER` now, and a UI check asserts the
stale value is absent - drift there is silent, because a stale option looks fine and sets a value the
daemon no longer understands.

### The check list

The verifying levels are only as good as the commands a project declares, and **an empty list verifies
nothing** - which is every project on its first day. Left alone, `commit-and-merge` would have merged
unverified work and reported it verified, so the emptiness is stated in three places: the settings
panel, the strategy's own result, and the finish decision's reason.

`project.json` had no write path at all before this. It has one now, deliberately narrow: read,
replace one key, write back, and refuse rather than guess when the file will not parse. Checks are
proposed from `package.json` scripts in the order they should run, editable in Project settings, and
there is a button that files an ordinary task for an agent to work them out.

⛔ That last one was the owner's amendment and it resolves the objection to it: an agent
proposing check commands as a task with a reviewable diff is ordinary work, while an agent editing in
place the gate that decides whether its own work is verified is not. The button can only do the first.


## An isolation root that inherited the operator's session (2026-08-30)

The operator noticed a growing list of sessions in the Claude Code desktop app, named like
`shyoo-12700k-humming-hellman`, and asked whether the tool had made them.

⛔ **The name is on no file on this machine.** Searched every Claude Code state file under
`~/.claude`, all five worker isolation roots, and the app's data directory; the only hit was this
conversation's own transcript, where the operator had typed it. The shape identifies it: `claude
--help` documents `--remote-control-session-name-prefix`, *"default: hostname"*, and `shyoo-12700k`
is the hostname. So the list is served from the account, not from disk - which means the tool cannot
sweep it, and saying so was the answer to half the question. Deleting the four local session index
files would have changed nothing visible: `claude agents --json` already filters dead pids, and it
listed only the operator's own session.

### What the tool was actually doing

```
probe    pty     150   (2026-08-27 -> 2026-08-30)
work     stream   14   (2026-08-26 -> 2026-08-29)
consult  stream    7
login    pty       6
```

⚠️ **Ten interactive `claude` processes opened to read a number for every one that touched the
operator's code.** The quota probe types `/usage` into a real PTY, and each such session registers a
`bridgeSessionId` with the vendor. The mechanism was working exactly as designed - at most one refresh
per sweep, only past `REFRESH_AFTER_MS` - the design simply spent more than it bought. Two hours
replaces thirty minutes.

⭐ What makes that cheap rather than merely rarer: the vendor's on-disk cache is refreshed by
**any** use of an account, including this fleet's own work sessions. An account running tasks keeps
its reading current for free, so the interactive refresh only ever mattered for an idle account -
whose quota, by construction, is not moving.

### The leak found on the way

Every adapter built its environment by copying `process.env` wholesale and deleting three or four API
keys. A Claude Code session's environment carries around twenty `CLAUDE*` variables, among them
`CLAUDE_CODE_HOST_SESSION_ID`, `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN` and
`CLAUDE_CODE_BRIDGE_SESSION_ID`. A daemon started from inside such a session would hand every worker
the operator's own session handle and messaging socket - and an inherited `CLAUDE_CONFIG_DIR` would
point the worker at the operator's credentials rather than the ones it was commissioned with.

⚠️ Not currently happening: the worker session files report `entrypoint: "cli"` and `"sdk-cli"`,
not `"claude-desktop"`, so this daemon did not inherit one. It was one launch context away.

### Denying a namespace rather than whitelisting what to keep

The operator asked for a whitelist. `spawnEnv()` denies `CLAUDE*` and `ANTHROPIC_*` by prefix
instead, and the deviation was flagged rather than made quietly. A whitelist has to enumerate
everything a CLI needs on three platforms - on Windows alone `SystemRoot`, `ComSpec`, `PATHEXT`,
`APPDATA`, `LOCALAPPDATA`, `TEMP`, `PROCESSOR_ARCHITECTURE` and more - and one omission is a spawn
that fails in a way nobody can trace. That failure had already happened earlier the same day: a
hand-set `PATH` on an R14 probe made `claude.exe` vanish with `ENOENT`. Denying a vendor namespace is
the opposite trade: the OS environment passes through untouched, and a variable the vendor adds next
month is denied before anybody has heard of it.

⚠️ A test taught one piece of Windows trivia worth writing down: `process.env` is a
case-insensitive proxy while a plain object is not, so `Object.keys` yields `SYSTEMROOT` and
`env.SystemRoot` reads `undefined`. Harmless for a spawn - the OS is case-insensitive when the child
reads it back - but an exact-key assertion tests Windows rather than the function, and the first draft
of the test failed on it.

### Not done

⛔ Whether the bridge registration can be suppressed at all is **unmeasured**. There are
settings keys `remoteControl`, `remoteControlAtStartup`, `remoteControlSessionNamePrefix` and env
vars `CLAUDE_CODE_REMOTE`, `CLAUDE_CODE_FORCE_BRIDGE`, and none of them was tried. Guessing would be
the `mcp: true` mistake again: a capability asserted from a flag's existence rather than from watching
it be true. The measurement is one PTY spawned with the setting and one without, diffed for
`bridgeSessionId`.

## An instruction meant for one CLI, and a test that measured the machine (2026-08-30)

t56 ran on codex, wrote the change it was asked for, and stopped without committing. Two unrelated
faults, both visible only from inside a worker.

### A field that fired under every policy

`landing.finishInstruction` is defined as *what a `custom` finish tells the agent*. `decideFinish`
honours that gate; `resolveFinishPolicy` is where it lives, and it returns an instruction only when
the resolved policy really is `custom`. The one-shot prompt branch — added the same day so that a
`streamPrompts: 'once'` CLI would hear about landing at all — read the raw config field instead:

```ts
const custom = project?.config?.landing?.finishInstruction?.trim()
```

So it fired on every level. This repo runs `commit-and-merge`, and its config still carried an
instruction written for the old default: *"Run /commit and follow every one of its six steps. Do not
stop until the work is committed. Do not push."* Codex was handed a Claude Code skill it does not
have, told to follow all six of its steps, and told not to do the sixth — which is the push. Three
faults in one sentence, in the single turn the agent had.

⚠️ The comment above the bug claimed to prevent exactly this. It said the default was deliberately
*not* `finishInstructionFor` because `/commit` is Claude-only — and it was right about the fallback
and silent about the branch that overrides it. The test agreed with the comment rather than with the
code, because its task had **no project**, so it never reached the override at all. A test that
cannot reach the bug still goes green next to it.

The fix routes through `resolveFinishPolicy`, which already owns the gate. The composed sentence now
also states the remote either way — *"Do not push; the tool takes it from there"* — because silence
is not neutral on a CLI that gets one turn. That silence is why the operator had hand-written *"Do
not push"* into the config, which is what put the contradiction there in the first place.

### A test that asserted the host, not the code

The second fault was the one that actually stopped the work. Codex ran `npm test` itself and hit:

```
× finds the process doing the reading, with CPU time on it
  → expected null not to be null
```

`sampleProcessTree` reads a process tree with `Get-CimInstance Win32_Process`. `codex exec` runs
under `--sandbox workspace-write`, which denies that query. The function handles this correctly and
by design — *"Returns null rather than throwing… **Not being able to measure is not evidence of a
stall**"* — and the test demanded the sandbox not exist.

⭐ The agent's reasoning was better than the suite's. It ran the failure twice, isolated it to a
read-only diagnostic path, judged it environmental, declined to touch unrelated code to make it
green, and asked. Every one of those steps was right. It could not tell a denied query from a
regression it had caused, because from inside the sandbox those look identical.

The fix is not a skip. A skip when a test fails proves nothing, and this one has a real contract to
check in a denied environment — the load-bearing one: `sampleProcessTree` must answer **null**, never
an empty sample, because an empty sample reads as a tree doing nothing, which is the definition of
the stall it exists to find. So the test probes the capability with the platform's own command —
deliberately not through the function under test, which would make it agree with whatever that did —
and asserts the applicable contract. Both branches were exercised: 838ms with the query available,
10ms with it out of reach, green either way, and the pre-fix test red in the second.

⭐ The architecture was already right and nobody had said so. `runChecks` executes the project's
`check` list in the **daemon**, outside any worker sandbox. The agent never needed to run the suite;
it had no way to find that out. The one-shot prompt now names the commands and says who runs them,
guarded so it can only claim it when the policy actually verifies and commands are declared —
otherwise it would be talking the agent out of the only checking anybody does.

### Rejected

⛔ Widening codex's sandbox to `danger-full-access`. It would have made the symptom disappear and
removed the only boundary a CLI with no approval callback has left.

⛔ Dropping `stall.test.ts`'s live sampling. It is the one assertion that proves the platform query
and the parser agree; everything else in that file is arithmetic on strings somebody typed.

### Not done

⚠️ That codex's sandbox is what denied the WMI query is the agent's report plus a mechanism that
fits, **not a measurement taken here**. What was measured is that the test fails whenever the query
is unavailable, for any reason. ⛔ No codex run has been through the corrected prompt: both fixes are
proven by test and unproven in flight.

## A worker that could edit but never commit (2026-08-30)

The prompt fix earlier the same day made codex's landing instruction coherent. It did not help,
because the agent could not have committed under any wording.

> Could not commit: sandbox denies writes to `.git/worktrees/ws1/index.lock`, so sync/rebase and
> staging both failed.

That report is exactly right, and it names a fault in this tool's architecture rather than in the
task. A pooled workspace is a `git worktree`, so `<worktree>/.git` is a **file** holding
`gitdir: <trunk>/.git/worktrees/<slot>`. A commit on that branch writes the index into the slot
directory, the new objects into the common `<trunk>/.git/objects`, and the branch ref into the
common `<trunk>/.git/refs/heads/…`. `codex exec --sandbox workspace-write` makes the working
directory writable and nothing else, and not one of those three paths is inside it.

So every codex run in every pooled worktree could read, reason and edit, and could never commit —
for every task, not only this one. It cost three runs, roughly 1.8M tokens, and took the 30-day
codex allowance from 0% to 34% producing work that had nowhere to go.

⚠️ The failure was legible only from inside the sandbox, which is why it survived so long. From the
outside the agent looks like one that declined to finish: the thread said *"3 file(s) are still
uncommitted… the work is intact"*, which is true, complete, and points at the wrong party.

### The fix, and what it costs

`codex exec` has `--add-dir`, *"Additional directories that should be writable alongside the primary
workspace"*. `gitWritableRoots` reads `<cwd>/.git`; a directory means an ordinary clone and it grants
nothing, a file means a worktree and it resolves the slot directory and, through `commondir`, the
trunk's `.git`. `plan()` passes one `--add-dir` per root.

⛔ The grant is wider than the fault. The common `.git` holds every branch's refs and every task's
objects, so a worker handed it can reach another task's work. There is no narrower grant: two of the
three paths a commit needs are shared between worktrees by construction. The genuinely isolated fix
is a real clone per worker, where `.git` sits inside the workspace and nothing needs widening — an
architecture change, deliberately not smuggled in as part of a bug fix.

⛔ What was **not** done is relax `--sandbox`. `danger-full-access` would have made the symptom
disappear and removed the only boundary a CLI with no approval callback has. Widening the writable
set from a measured requirement and removing the boundary are not the same move, however similar the
green test afterwards looks.

### The fixture had to be real

The tests build an actual repository and an actual `git worktree` rather than writing a `.git` file
by hand. The entire fault is the gap between what a worktree's `.git` *is* and what everyone assumes
it is, and a hand-written fixture would have encoded the assumption instead of testing it. They
assert by containment — that each of the three real paths falls under some granted root — because
which root covers which path is an implementation detail.

⚠️ The first draft guarded each test with `if (!made) return`, so a machine without git would have
passed all four while asserting nothing. That is the same fault as the `stall.test.ts` bug fixed
hours earlier, reintroduced by the person who had just fixed it, in a file whose sibling still
carried the fresh comment about it. The guard is now `expect(made).toBe(true)` and the fixture
builder has no try/catch: git is not optional in a repository whose workspace model *is* worktrees.

### Not done

⚠️ `--add-dir` is proven **on the argv** — `gitWritableRoots` returns the two real paths for `ws1`
and both reach the command line behind the flag. Whether codex's sandbox then honours them is
**unmeasured**; that needs one real run. The three sandbox limits the same agent reported alongside
this — process-command-line inspection, denied network for dependency downloads, and therefore
unrunnable `test:daemon`/`test:ui`/`test:pack` — are untouched, and are the argument for leaning on
the daemon-side `check` list rather than expecting a worker to verify.

## A bet nobody ever collected on (2026-08-30)

t58 finished its work, committed it, and sat in `running` for fifty minutes holding a workspace.
The operator noticed because the session TUI showed an agent that was plainly done.

The daemon's own log has the whole thing:

```
01:51:58  t58 reported complete: run=44ad4938 workspace=held
01:52:00  t58 finish: ask-agent (commit-and-merge)
          -> "You have 9 uncommitted file(s). Commit them ... then report the task complete again."
01:52:08  (agent authors the commit - the exact 9 files)
01:52:17  (commit written: b86f5c1)
02:04:25  WARN  no turn for 12m, 12.3s CPU - working, not stuck
02:05:35  WARN  looks stuck: no turn for 13m, 0.2s CPU in 70s - reported, not stopped
```

The agent obeyed in **seventeen seconds** and then never reported again.

### The bet

`decideFinish` returning `ask-agent` means *tell the still-live agent to commit*, and the scheduler
deliberately returns without ending the run. Its comment says why, and says the assumption out loud:

> ⛔ Returns without ending the run. The agent is still working — it has been handed one more
> instruction and **will report completion again** — so closing the run here would orphan a live
> session and release a workspace out from under it.

Every clause of that is correct except the middle one, and there was no code anywhere for the case
where it is false. `markFinishAsked` writes `finish_asked_at`; a grep for readers finds exactly two,
both inside `decideFinish` — that is, only the second `task_complete` that may never come. No timer,
no tick re-check, no fallback. The run stays open, the task stays `running`, the workspace stays
held, for as long as the daemon lives.

⚠️ The stall watchdog identified it correctly, to the minute, and did nothing — which is right. It
exists to report, because a run blocked on a slow network call is indistinguishable from a stuck one
and nothing may be killed on that evidence. It was the wrong tool for this, not a failing one.

### Why this may act where the stall watchdog may not

The new check re-runs the **same `decideFinish`** against a freshly read tree and takes whatever it
says. That is the difference: it accuses nobody and stops nothing. A clean tree lands. A tree still
dirty rests the task at `awaiting_human` with the work intact. It cannot loop either, because
`finish_asked_at` is set by the time it runs, so the second decision is never `ask-agent` again.

⛔ The trigger is **silence, not elapsed time**, and the two are not the same. Time since the ask
would fire on an agent part-way through a large commit, and deciding a workspace out from under a
working agent is the one way this could do harm. `lastRequestStartedAt` — the signal `reportStall`
already uses, and the reason it worked on a session whose `lastTurnAt` was null — says no call is in
flight. `finishReplyOverdue` requires both clocks past three minutes, generous against the seventeen
seconds the one measured agent needed, and far short of the twelve a stall is given.

### An unresolved reading

⚠️ The last recorded turn for that session was 01:51:42, *before* the ask, yet the commit landed at
01:52:08. So the work done in response to the instruction produced no turn record, and `lastTurnAt`
read null throughout. Either turn-tailing stopped for that session or those turns went somewhere
unexamined. **Not chased down**, and it is the reason the trigger is `lastRequestStartedAt` rather
than turn records: a fix must not rest on a signal that was demonstrably absent during the very
incident it exists to catch.

### Not done

⚠️ The automatic path is **unproven in flight**. t58 itself was landed by hand, because the fix ships
in a build the running daemon had not loaded, and restarting would have sent `reconcileTasks` through
it first — `running` becomes `ready`, which would have re-dispatched a fresh run to redo work already
committed. The next task that goes quiet after being asked is the real test.

### The same shape, one layer up

⛔ Landing t58 by hand exposed the identical fault in `relandTask`: it set the task to `completed`
and left the run open. The task came back `completed` with `run 44ad4938 … ended=OPEN`, a live
session, and ws3 still claimed — and **the status change is what hid it**, because `reconcileTasks`
sweeps `running` tasks and this one no longer was. Only `reconcileClaims` at the next startup would
have freed the workspace, so the pool ran a slot short until then and nothing said why.

That is the same mistake as the one above wearing different clothes: a path that changes a task's
status without ending the run it belongs to. `relandTask` now closes any open run and releases what
it held. ⚠️ Found by doing it rather than by reading the code — the leak was invisible until a
`running` task was landed by hand, which nothing had ever done before today.

## Two answers to one question about a branch (2026-08-30)

t59 raised two complaints. They turned out to be unrelated, and the second had a cause underneath it
that nobody had asked about.

### A task that was waiting on a person and did not say so

`askQuestion` inserts the question, writes it to the thread, emits `question.opened`, and waits. It
never touched the task's status, so the task read `running` for the whole wait — true of the process
and useless to the operator. On t59 the first question was open from 03:08:16 to 03:15:06; seven
minutes in which the one screen anybody checks said the agent was working.

⚠️ The only `setStatus` in that file was in the **park** path, which fires when a question times out
unanswered. So the status became honest precisely when it stopped mattering.

It now rests at `awaiting_human` with the question as its hold reason, and `answerQuestion` puts it
back to `running` when a live waiter takes the answer. ⛔ The run is deliberately not ended and the
workspace not released: the agent is still there holding the tool call, and this is a label on a live
run rather than the end of one.

⭐ A side effect worth having: every check in `runWatchdogs` is scoped to `running`, so a question
open past `STALL_AFTER_MS` used to earn a stall report for a session doing exactly what it was told.

⚠️ Two guards, both tested. Answering a **parked** question leaves the task where it is — nothing is
running there and the reply travels in the next run's prompt. And an operator who pressed *Stop here*
while the question was open is not overruled by an answer arriving afterwards.

### One rule, two copies, and they disagreed

The second complaint was that a failed landing offers *mark done*, *stop here* and *reassign* — none
of which is **fix the conflict and commit again**. Fair, and the missing button is the small half.

The large half is why t59 met that conflict at all. `decideFinish` has a `resolve-conflict` verdict
written for exactly this, whose own comment says a conflict *"used to be discovered inside
`landTask`, which runs after this function has already chosen `land` ... and every conflict became a
dead-end `awaiting_human`"*. That is precisely what happened again, because the pre-flight check was
asking about the wrong ref:

```
merge-tree origin/main HEAD   -> CLEAN
merge-tree main       HEAD    -> CONFLICT
```

`merge-local` rebases onto the **local** target and says so in its own comment — *"never
`origin/<target>`; rebasing onto the remote would quietly make this policy depend on a fetch, which
is the thing it exists to avoid."* `readMergeability` had a second copy of the rule and always
preferred the remote. Both are defensible in isolation; together, on `commit-and-merge` — the fleet
default — the check answered about a different base than the act.

⚠️ It needed a trunk ahead of its remote to show up, which `commit-and-merge` produces by design and
which this repository had been in for hours: two unpushed commits, one of them a migration, against
t59's own migration 22.

`landingBaseFor` is now the single answer, and `readMergeability`, `merge-local` and `auto-land` all
ask it. ⛔ The fix is not "use the local ref" — that would break `commit-and-push`, which really does
rebase onto the remote. It is that there is one function and the strategies cannot drift again.

### The button

`task.resolveConflict` composes an instruction naming the ref from `landingBaseFor`, writes it to the
thread and continues the task — same thread, so the agent keeps the context it has. It appears only
when `holdReason` mentions a conflict, because *fix the conflict* on a task that failed its checks
would send an agent to rebase something that rebases fine.

⚠️ It does **not** pre-start the rebase, unlike the `resolve-conflict` verdict inside
`landCompletion`. That path has the workspace held by a live session and can leave the markers in the
tree. This one runs after everything was released, and the next run may be handed a different
workspace from the pool — so a rebase started here could be started in a directory the agent never
sees. Naming the command is reliable where pre-running it is not.

### Not done

⚠️ None of the three has run in flight. The base fix is proven by a test that builds a repository
whose local `main` is ahead of `origin/main` and asserts both readings, and by the measurement above
against t59's own workspace — but no landing has yet been *saved* by it.

## A question that reached a person with no way to answer it (2026-08-30)

t63 was dispatched to an antigravity worker and came back asking which of three quota-refresh designs
to build. The task rested at `awaiting_human` with the question on its row, and there the operator
stopped: no card, no options, nowhere to type. Claude's questions had been answerable for two days.

### The contract carried the question and lost the interface

An adapter declares `capabilities.mcp`, and only `claude-code` says true. `openai-compatible` and
`antigravity-cli` both say false for the same reason — `codex mcp add` and `agy mcp add` register
into a **shared** config, so a session cannot carry the per-session identity those tools need. Neither
can call `ask_human`, so `promptFor` gives them a prompt contract instead: end with a line beginning
`NEEDS DECISION:` and stop rather than guessing. `onStreamResult` matches that line, refuses to
complete the run, ends it `blocked`, and quotes the sentence into `hold_reason`.

⛔ Every part of that worked, and it was still unanswerable. The card, the option buttons, the text
box and the answer that lands on the thread are **all rendered from a `Question` row**, and no row was
ever written — the sentence was matched, quoted and thrown away. Two paths existed to ask a question
and only one of them created the object the interface is built on.

⚠️ Worth stating plainly, because it is the shape of the bug rather than a detail of it: this was not
a missing feature. It was one missing INSERT between a working detector and a working UI.

### Filed already parked, because that is what it is

`fileParkedQuestion` shares its insert with `askQuestion`, so a question asked through a tool call and
a question asked in prose are the same object. It is born with `parked_at` set, and that is the truth
rather than a shortcut: the turn that asked is already over by the time the text can be read, so there
is no waiter, no tool result to return into, and nothing to hold a process open for. **Parked** is
precisely the state for a question whose asker has gone — the existing park path reaches it by
timeout, this one starts there.

### The options come from a contract, never from the sentence

t63 wrote its three choices inline: *"keep the current just-in-time refresh (Option A), add a gate
(Option B), or hold tasks (Option C)?"* ⛔ Nothing recovers those. Pulling an answer set out of
generated prose is the inference this project refuses to make, and it would fire on an agent merely
describing alternatives it had already rejected.

So the prompt now asks for the choices the way the UI needs them — one `- <option> — <what choosing it
means>` bullet per line directly under the question — and `needsDecisionIn` reads them only from
there, stopping at the first line that is not such a bullet. ⚠️ The em dash is required for a detail;
splitting on a bare hyphen would cut hyphenated labels in half. A question with no parsed options is
still perfectly answerable, because every card has a text box.

### The half that would have made the rest inert

A live question resolves into the tool call the agent is holding, and the work carries straight on. A
parked answer only lands on the thread — and **nothing was scheduled to read it**. The operator
answered, watched nothing happen, and had to send a second message to start the work again.

For a Claude question that was a wrinkle, because parking is the exception there. For an MCP-less
adapter it is the only path there is, so every question would have ended that way. `question.answer`
now re-queues a parked question's task: same task, same thread, a new run, with the answer left
**undelivered** so `buildPrompt` carries it — which is the mechanism the park docstring had claimed
for months without anything implementing it.

⚠️ Guarded on `awaiting_human`. An operator who paused or stopped the task while the question was open
has put it somewhere deliberate, and an answer is not a request to overrule that.

⚠️ Codex gets all of this for free — it is the same `!mcp` branch, not a second implementation — and
neither adapter has exercised it in flight. t63 itself predates the fix and has no row; its question
lives on in its hold reason and is answered as an ordinary note.

## A pause with no clock behind it (2026-08-31)

t60 sat at `paused_quota` long past the reset it was waiting for, on a worker whose window the
operator could see had already rolled over. The reported suspicion was staleness. It was not.

### Three doors, all shut

`preempt` parks a task as `paused_quota` carrying `not_before = resetsAt`, and its own comment says
*"it carries `not_before = resets_at` and resumes itself"*. Nothing did:

- `admitScheduled()` selects `status = 'scheduled'` and nothing else.
- `admit()` returns early for every status in `TERMINAL_OR_HELD`, which lists `paused_quota` — and
  correctly, since those are *"reached deliberately and not derived"*.
- `resumeTask()` accepted `paused_user` and `cancelled` only.

So `not_before` on a `paused_quota` row was read by **no code at all**. Measured from the live daemon
on 2026-08-31: paused 05:09:25Z with `not_before` 06:40:00Z, still `paused_quota` at 06:44:50Z, 291
seconds past its own resume time.

⛔ Three places said otherwise, one of them to the operator's face: the docstring above, the thread
message *"Resuming automatically after the reset"*, and Settings copy reading *"so it restarts
itself"*. The UI offered Resume for `paused_user` and `cancelled` only, so the task had no button
either — the sole way out was `continueTask`, i.e. typing a note at it.

⭐ `resumeQuotaPaused()` now runs in `tick()` beside `admitScheduled()`, deliberately beside rather
than inside: the two read different statuses, and folding a held status into the derived-status pass
would let any `admit()` call anywhere un-pause a task. It goes to `ready`, not to a worker — the
dispatch gate re-reads quota and may still decline, which is both honest and *visible*, because a
task held at `ready` carries its reason where `paused_quota` for ever carried nothing.

### The staleness was real, and was not the cause

The reported symptom pointed at the reading, so it is worth writing down why that was the wrong
suspect: the gate is `if (quota && !quota.stale)`, so a stale reading never gates anything — it
dispatches with `quotaUnverified` set. And nothing reads a worker's quota on behalf of a
`paused_quota` task in the first place, fresh or stale, because such a task never re-enters the
candidate list.

⭐ But the suspicion found a second defect one layer down. `stale` is an **age** test, and age is not
the only way a percentage stops being true. Measured on the same account at the same moment:

```
sampledAt  05:04:47Z   ageMs 6,099,261   source config-cache
5h window  percent 88   resetsAt 06:39:59Z   ← already passed
```

A reading taken two minutes before a reset is as fresh as a reading gets, and every number in it
expires with the window it counted. `windowExpired()` now says so, and the dispatch gate treats an
expired window as **unknown rather than zero** — `quotaUnverified`, not free capacity, because what
the new window holds cannot be derived from the old one. `windowResetsAt` had discarded a reset in
the past since it was written; this is the same rule applied to the percentage sitting beside it.

⚠️ Narrow on purpose. Only a reading that existed and ran out is marked unverified; a pool with no
window at all keeps its previous answer, and a provider that sends no `resetsAt` — codex's 30d window
— is untouched by any of it.

### And a button, because a clock is not always fast enough

`resumeTask` and the task menu now accept `paused_quota`. That status is reached by the machine, so
it had no manual route at all, and an operator looking at a window that has visibly rolled over
should not have to wait for a clock they can already read. Resuming by hand clears `not_before` with
it: pressing the button *is* the statement that the wait is over, and a resume time left behind would
let `resumeQuotaPaused` argue with the person who pressed it.

---

## A tier with a reader and no writer (2026-08-31, t68)

Three settings in this app resolve **task → project → fleet**: the finish policy, session sharing and
completion mode. `resolveFinishPolicy`, `resolveSessionSharing` and `resolveCompletionMode` have
consulted the project level since M2, the task pane has offered `inherit (…)` beside each of them, and
Settings › Global has always been able to set the fleet's answer.

The middle level had no writer at all. The only way to make a project decide anything was to edit
`.multi_agent_controller/project.json` by hand — a committed file, in a repository the app knows the
path to, from a page that was already open. So the app shipped a dropdown whose most interesting
value pointed at a tier the operator could not reach from inside it.

### The page it was on

The project's **Settings** tab opened with **Verification** — a textarea of shell commands — and then
embedded `Projects`, the *fleet-wide* project list, filtered to one row by an `only` prop. That
filter shrank the table and nothing else: the panel kept the fleet's heading, and under it the whole
install's resource list, every project's workspace pool and landing lock together. A page called
Project settings answered *what is this project* third and *what do other projects contend for*
last.

It is now four panels in the order somebody reads them: **Project settings** (what it is, where its
config came from, what its policy currently resolves to, with Reload and Write config), **Policy**,
**Verification**, and **what this project contends for** — which is filtered on
`resource.projectId` and disappears when there is nothing. The fleet-wide table stays on Settings ›
Global, where a fleet-wide list belongs, and now says what a resource *is for*: a task that cannot
claim one **waits**, and is never failed for want of it.

### What the writer had to be

`project.setPolicy` writes the keys the resolvers already read, in the spellings `project.json`
already uses — `landing.finish`, `landing.target`, `landing.finishInstruction`, `session.share`,
`session.completion`, `workspaces.poolSize` — so a project configured from the app and one configured
in an editor are the same file. Three properties are load-bearing, and each has a test:

- ⛔ **A patch, not a save.** It reads the file, changes exactly the keys it was asked about, writes
  it back. A key from a newer version of the tool, or one somebody added by hand, survives having a
  dropdown changed. `setProjectChecks` — the only previous write path — was already built this way
  and both now share `editProjectConfig`.
- ⛔ **`inherit` is written as a value, never as a deleted key.** Identical to every resolver, and not
  identical to a person: *this project deliberately follows the fleet* is a decision worth keeping
  when the fleet default later changes.
- ⛔ **It refuses rather than guesses.** A `project.json` that does not parse is not overwritten, and
  a finish policy the resolvers could only read as silence is rejected at the RPC rather than stored
  and silently ignored. Setting `landing.finish` also drops the legacy `landing.strategy`, so the
  file never carries two answers to one question.

### The box that was not a box

The check-command editor used `.ask-input`, whose entire design is to be *invisible*: `border: 0`,
`background: transparent`, because it lives inside the already-bordered message composer. Dropped
onto a panel it read as body text that could somehow be typed into, and on the light theme it was
indistinguishable from the paragraph above it — a field holding the commands that gate every landing.
It now uses `.text-input`, which is drawn as a field.

The same borrowing explained the dead space under the panel: `.ask-input` carries
`field-sizing: content` while the textarea also had a `rows` attribute, so the box grew to its
content and the row count still reserved height beneath it. The panel ended in a band of empty
surface that looked like a section which had failed to load.

⚠️ Not proven in flight. `projectpolicy.test.ts` (7) covers the writer against real files on disk;
`ui.test.mjs` (+7) drives the real page — panel order, that no other project's row is on it, that the
textarea computes a visible border and background, and that choosing a finish policy from the control
lands in the repository's `project.json` and comes back reading *from the project*. No agent has yet
run under a policy set this way.

## A caution read as a refusal, and a window read as another window (2026-08-31)

t71 was preempted three times in six hours, each within seconds of being dispatched, each throwing
away a resumed 278k-token session. The daemon's log gave the same reason every time:
`rate-limit allowed_warning`. Its own probes, minutes either side, read the five-hour window at
**17%**, **0%** and **19%**.

Three separate confusions produced that, and they are worth keeping apart because each would have
survived a fix to either of the others.

**A warning was wired to the branch built for a refusal.** `allowed_warning` rides a turn the vendor
*served*. It says quota is moving; it does not say the next call fails. It was tested with
`status === 'allowed_warning' || status === 'rejected'`, and those are not the same kind of fact.

**One window's advisory was read as another's.** `rate_limit_event` carries a `rateLimitType`, and a
Claude account emits `five_hour` and `seven_day` on the same stream. `lastRateLimit` selected
`order by sampled_at desc limit 1` across all of them. At 22:00:50Z the `five_hour` sample read
`allowed`; twelve seconds later a `seven_day` advisory arrived and became, as far as every caller was
concerned, the account's status.

**And then it parked against the wrong clock.** `windowResetsAt` preferred the live sample's
`resetsAt` — from whichever window that sample happened to describe. So a five-hour concern wrote
`not_before = 2026-09-07T01:00Z`. ⛔ The task was still sitting there, parked for a week, when this
was written.

A fourth hole surfaced only under test: because the samples are one stream shared by several windows,
a `seven_day` advisory landing a second after a `five_hour` **refusal** made the refusal invisible to
anything reading the newest row. A refusal is the strongest thing a vendor says, so it is now looked
for on purpose rather than found by luck.

⛔ **The rule that came out of it: a refusal may end a run alone; a caution has to be seconded.**
`rejected` needs no corroboration — the turn did not happen, and nothing downstream gets to talk that
down. `allowed_warning` now has to be agreed with by this fleet's own reading of *the same* window
before it stops anything, at a bar (80%) deliberately lower than the one a reading clears by itself
(95%): two independent signals are worth more than one, and the warning lowers what the evidence must
show rather than replacing it.

⚠️ **This also closes R7, and the answer is more interesting than the question.** The live status
*does* pass through a warning before a refusal — so it is an early warning, not an obituary. But it
does not track the utilisation this tool measures: warned on `five_hour` at 17%, and on `seven_day`
while `/usage` read the weekly at 25%. Whatever the vendor is warning about, a per-model sub-limit
being the likeliest guess, it is not the number on the fleet strip. That is exactly why it may inform
a routing score and may not, by itself, end a run.

Verified by replaying the real `rate_limit_samples` at all three preemption timestamps: under the new
rule, none of the three fires.

## The compaction that had never once happened (2026-08-31)

The operator turned `autoCompact` on at 07:48Z and asked, at the end of the day, whether it had done
anything. It had not. The newest row in `clock_events` was dated **2026-08-27** — the last day the
fleet had been completely idle.

Two independent causes, and the second is the one worth remembering.

**Preemption closes the session.** The clock only considers sessions in `live` or `idle`, and every
long break t71 had was a break created by a preemption that had closed the session first. Fixed by
the section above, not by anything in the clock.

**Move 4 was arithmetically unreachable.** `expectedIdleMs` answers *when will this session be
wanted*. Four of its five branches derive that from something real — a median over answered
approvals, a queue that is non-empty now, a `not_before` somebody set, an empty fleet. The fifth,
"some other task is in flight", derives it from nothing, and returned **exactly the two-hour
break-even**. `compactThresholdMs` is that same break-even plus an objective adjustment — 2.02h on
the shipped default, 2.38h under `velocity`. So the placeholder lost every comparison it was ever in,
and compaction was reachable only when `idle.ms` was infinite.

⛔ **Substituting the break-even for the estimate is a category error, not a conservative default.**
Answering "when will this be wanted?" with "where the decision flips" hands the entire decision to
whichever way the comparison happens to be written. The estimate now carries `confident: false`, and
a guess no longer buys a keepalive on a context past the compaction break-even — holding a 278k
prefix costs about 28k an hour to sit still, which is the most expensive thing this loop can choose.
⚠️ A small context still keepalives: there the hourly cost is small and a compaction would buy
almost nothing.

**And none of it was visible.** The clock sent `/compact` down a session's input and wrote one line
to a log file. The boundary record zeroed `tokens_since_compact` — a side effect, not a receipt.
Migration 24 adds `compactions`, which records the **ask** as well as the outcome, because the
interesting row is the one that never lands: that is HANDOFF R6, whether `/compact` is honoured as a
user message on the `stream` transport at all, and a success-only ledger would have answered it with
silence for ever. The thread posts a system message; the task pane draws before → after.

⚠️ `post_tokens` is null until a turn measures it and renders as `--`. The boundary carries a
pre-size and no counterpart, so the compacted size is genuinely unknown until something reads it
back. Inventing it by subtracting an estimate would make it the one number on the row nobody
measured.

## A gate nobody could overrule, and a queue that priced itself as busy (2026-09-01)

**t71, 00:31:06Z.** Re-run, and immediately held: *"ClaudeThird at 92% of its Claude 5h window"*,
against a reading whose `resets_at` was **2h29m** away. The operator's question was why the fleet
had *routed* it to a full account.

**It had not routed it anywhere.** `constraints_json` on that row is
`{"workerId":"…","adapterId":"claude-code"}` — a **pin**, set by hand in the task thread's worker
picker. `chooseTarget` skips every other worker on the first line of its loop, so ClaudeThird was
the only candidate there ever was; the score, the tie-break and the routing consult never entered
into it. ⚠️ Worth keeping straight, because the fix for "the scheduler chose badly" and the fix for
"a pin met a full window" are different fixes. The quota term *is* in the score — `windowRisk`
slopes to the water mark and saturates there — and it discriminates nothing on a candidate set of
one. The reading itself was fine: 76% at 00:22, 92% at 00:31, refreshed at the dispatch gate exactly
as intended.

Two things were genuinely wrong, and both come from **one number being formatted into a sentence and
then discarded**.

**1. There was no way to say "92% is enough for this".** `QUOTA_HIGH_WATER` is a caution of ours
computed over a reading — the vendor had served every turn up to it — and it is a cliff with nothing
on the far side. A pinned task cannot route around it by definition, so it waits for the window. A
person can see what the arithmetic cannot: that 8% of a window is more than one commit needs.
`task.overrideQuota` is that sentence, and **migration 25**'s `quota_override_until` is where it
lives — a deadline taken from the reset of the very window being overruled, so the permission
expires with its own reason whether or not anything ran.

⛔ **It lifts one gate, and the gate it lifts is the only one built purely out of a percentage.** The
dispatch cliff, and the matching mid-run preempt at 95% — dispatching under an override and
preempting three points later would buy a cold start and nothing else. It lifts *nothing* about a
disabled or signed-out account, a worker at capacity, the window boundary itself, or a turn the
vendor actually **refused**. There is no version of this that says "keep asking an account that is
saying no". ⚠️ It also does not touch `windowRisk`, so an overridden account still scores last: a
fleet with a free account elsewhere must keep preferring the free one.

**2. A queue that could not move for 2h29m was the argument that no session had time to compact.**
`expectedIdleMs` read `status = 'ready'` and answered *"work queued now"* — `ms: 0`, confident —
which skips moves 2, 3 and 4 for **every live session in the fleet**. But `ready` is the scheduler's
word for *eligible*, not for *dispatchable*: a task it passes over on every tick keeps that status.
So the correct reading was the exact opposite of the one taken. 2h29m is comfortably past the ~2h
compaction break-even, and a large context should be compacted *because* nothing can arrive.

`hold_until` (migration 25) is the machine-readable half of `hold_reason`: written by the gate that
refused, from the sample that refused it. ⛔ Deliberately **not** `not_before` — `admit()` reads that
field and would have turned an explanation into a status change. Nothing gates on `hold_until`; the
hold is still re-decided from the world every tick. ⭐ Beside it, `paused_quota` tasks are counted as
upcoming work at last: a fleet whose entire queue had been parked by a closing window used to read
as *"nothing queued"*, the branch that returns infinity and lets every warm prefix lapse.

⭐ And the operator finally gets the clock: the row and the thread read *"… — earliest retry in
2h 29m"*, which is the difference between a wait worth sitting through and one worth overriding.

## The reserve that could never be at risk (2026-08-31, t73)

The compaction above still did not run. On the 17:31 tick a run was routed to ClaudeThird and
immediately held — its five-hour window read **92%**, which is `QUOTA_HIGH_WATER`, and the gate
refuses a dispatch there. Meanwhile session `ef5e90dc` had been open on that same account since
10:38 holding **401,341** tokens of context and **1,401,019** since its last compaction. No
`/compact` was sent. The `compactions` table was empty.

The clock has a move for exactly this — move 5, *the compaction reserve is at risk, compact now
regardless* — and it is checked before every TTL condition, so a prefix with an hour left is no
excuse. It had never fired, and could not:

```
reserveState -> remainingTokens -> tokensPerPercent -> select from calibration  -- zero rows
```

`remainingTokens` returns null without a learned `tokens_per_percent` (R2), a null `remaining`
returns `unknown`, and `unknown` is not `at_risk`. Every worker holding a session had reported
`unknown` since the reserve was written, so the branch was dead code with a test suite around its
arithmetic. Move 4 could not cover for it either: it is gated behind `DECIDE_BEFORE_EXPIRY_MS`, and
this session's cache had hours to run.

⭐ **The reading that refuses the dispatch is the reading that asks for the compaction.** The gate
already had a trustworthy percentage in hand at that tick — fresh, and for the pool the session
actually draws on. `windowPressure()` reads the same one and calls the reserve `at_risk` at the same
`WINDOW_HIGH_WATER`, now a single shared constant rather than three copies of `92` in three files. A
stale sample and a window whose reset has already passed are both refused, exactly as the gate
refuses them.

⚠️ **No percentage is promoted to a token count.** `remainingTokens` stays null and the reason names
the level. The formula in cost-model.md §5 asks whether what is left covers what saving costs, and a
percentage cannot answer that; it answers the other question, which is the one that matters here —
this account is at the mark where the fleet has already stopped giving it work, so what it is still
holding should be saved while there is window left to pay for saving it. R2 is still owed.

⛔ **And the trigger now has a stopping condition, because a full window is not an instant.** A token
breach is resolved by the compaction that answers it; 92% stays 92% for hours. The old move-5
condition — `at_risk` and any context at all — would therefore have sent `/compact` every four
minutes until the window reset, which is the 2026-08-26 thirteen-sends loop with a new trigger. Move
5 now requires `worthCompactingNow`, whose growth half a landed compaction zeroes.

Measured against the real rows: at 92% the reserve is `at_risk` and a 401k context compacts; at 76%
nothing happens; a reading 20 minutes old or a window that reset a minute ago is `unknown`, never
full; `autoCompact` off still means off.

⚠️ **This and the section above it meet on the same tick and are not the same fix.** That one taught
`expectedIdleMs` that a held task is not imminent work, which makes **move 4** reachable — the timed
trade, "nobody wants this for 2h29m, so shrink it". This one makes **move 5** reachable — the
untimed one, "this account is full, save what it holds". A session on a full account now has two
independent reasons to be compacted, and neither had ever produced one.

## Active 5h session limit overrun mid-run (2026-08-31, t75)

Task t75 hit a 5-hour quota hard exhaustion mid-run on Claude Code (ClaudeThird), resulting in an
unrecoverable 429 `api_error` (exit 1) and wasting the entire in-flight context.

Two interacting root causes produced the overrun:

1. **The 80% watermark threshold on a frozen baseline:**
   t75 started with a pre-dispatch quota reading of 76%. During the headless stream run, Opus-5 spent
   heavily and Claude Code emitted in-stream `five_hour` `allowed_warning` records starting 9.5 minutes
   before the crash. However, `cachedUsageUtilization` in `.claude.json` is not updated on disk during
   stream runs, so `percent` remained at the baseline (76%). Because 76% < 80%
   (`QUOTA_WARNED_PREEMPT_WATER`), `overrunVerdict` rejected the preemption ask and returned `null`.
2. **Mid-run quota staleness (>15m) dropping `percent` to `null`:**
   After 15 minutes of run time (`STALE_AFTER_MS`), `quota.stale` became `true`, causing `runWatchdogs`
   to set `percent = null`. In `overrunVerdict`, `percent === null` unconditionally returned `null` for
   all non-refusal warnings, blinding the scheduler to in-stream `five_hour` warnings for the rest of
   the run until the hard 429 crash occurred.

Fixes:
- Set `QUOTA_WARNED_PREEMPT_WATER` to `QUOTA_RISK_FLOOR` (50%): warnings on low usage (<50%, measured
  at 0%, 17%, 19% on t71) continue to be ignored, while elevated baselines (>=50%, e.g. 76% on t75)
  paired with an in-stream session warning preempt cleanly before hard exhaustion.
- `runWatchdogs` falls back to `run.quotaBefore` when `lastQuota` becomes stale mid-run (>15m),
  preserving the known baseline lower bound.

## Local LLM (OpenAI-compatible / llama.cpp) as a commissioned worker (2026-09-01)

Added built-in support for self-hosted / local LLM workers running OpenAI-compatible servers (such
as Qwen3-Coder-30B-A3B via llama.cpp).

Key architectural decisions:
1. **Bridge script (`local-llm-bridge.ts`) as a spawned child process**:
   Maintains the architectural invariant that a session is a child process with stdin/stdout,
   avoiding any bifurcation in `sessions.ts`. The bridge reads NDJSON prompts from stdin and
   streams requests to `/v1/chat/completions` (SSE), translating between the local server and
   Multi Agent Controller's stream event protocol.
2. **OpenAI tool-calling integration in the bridge**:
   Registers `task_complete` and `ask_human` tools in OpenAI function format. When called by the
   model, the bridge executes the tools inline and emits corresponding Multi Agent Controller
   stream records (`result`, `tool_result`).
3. **Endpoint URL as isolationRoot**:
   No credential directory exists for local LLMs; workers are identified by endpoint URL
   (e.g., `http://127.0.0.1:8080`), permitting unlimited parallel workers pointing to distinct
   or shared local endpoints (`maxAccounts: null`).
4. **Compiled-in cost model (`local.llm.2026-09.json`)**:
   Token pricing is `null` (local compute/electricity), context window defaults to 32,768, and quota
   is unconstrained.
5. **Commissioning UI**:
   The Add Worker dialog in Settings switches to an Endpoint URL input when Local LLM is selected.

## Four places that never looked past the workspace (2026-09-01)

The operator asked whether t91 had landed. The task pane said it had; the trunk had a `git stash list`
with `t91` in it. Both were true, and neither meant what it looked like.

**t91 and t92 had both landed, and neither stash was the landed work.** `9278841` and `df7fb0c` are on
`main`; the stashes were what two *earlier* runs of the same tasks had lost. The `runs` table lines up
to the second: t91's first run was preempted at 21:27:49Z and `stash@{1}` is dated 21:27:49; t92's
second run was preempted at 21:35:59Z and `stash@{0}` is dated 21:35:59. Both stashes were based at
`4a64708`, which is to say **both branches had no commits of their own** — the entire output of both
runs was uncommitted when the workspace was taken away.

⛔ **A stash is not a handoff, and that is the whole defect.** `rescueDirt` was written to be careful:
it stashes rather than `reset --hard`, on the reasoning that a dirty slot usually means the last run
failed and its edits are worth the most. All true. But a stash is a **local ref** — it belongs to a
repository, not to a branch — so it does not travel to whichever pool member the next run claims, it
is not in `promptFor`, and nothing in the app ever mentioned it. The resumed runs checked out empty
branches and started again. t92 spent **13.3M tokens** re-deriving work that was in `stash@{0}` the
whole time; t91 shipped a narrower fix than the one it had already written.

⚠️ **It was not the agent, and it was not one vendor.** The two runs that lost work were both
`claude-code`/Opus 5; the `openai-compatible` run is the one that recovered t91. Landing never learns
which CLI produced a branch. What differs between adapters is only the repository state they leave.

**The fix is that the branch is the carrier.** `rescueDirt` reads `HEAD`: on a branch it commits, with
a `Multi-Agent-Controller-Rescue` trailer; detached — which is what a parked pool member is — it
stashes as before. The next run inherits the work by doing nothing but checking the branch out, and is
told in its first prompt what the commit is and that the tool wrote it.

⛔ That immediately created its own hazard, which is the more interesting half: **a rescue leaves a
perfectly clean workspace.** `isClean` would have waved it through, `rev-list` would have counted it as
a commit to land, and every step after that would have succeeded — a half-written afternoon pushed to
the trunk by a pipeline in which nothing went wrong. So a rescue at the *tip* is now condition 6 of the
landing bar. Only the tip: work finished on top of a rescue is ordinary history, and the project checks
are what judge it.

## A clean workspace is not evidence, and a branch at rest is invisible (2026-09-01)

The same question asked a second way — *does the tool double-check the stash list and the branches after
an agent claims it landed?* — found two more holes of the same shape.

**"Nothing to land" was unfalsifiable.** A task that answered a question and changed no file leaves a
clean tree on a branch level with the trunk. So does a task whose whole afternoon was stashed out from
under it. The verdict read the first, was equally true of the second, and returned `ok` — *"the trunk
was not touched — work that answers a question rather than changing a file is finished here"*. It now
asks `git stash list` first.

⚠️ Attributed **by branch**, not counted globally, and the distinction is not fussiness. Stashes live in
the repository's shared object store and every pool member reports the same list, so a global count
would let one unrelated leftover hold every future task in the project at `awaiting_human`. Git's own
`On <branch>:` prefix is what ties an entry to the run that made it.

**And the loose-ends scan could not see a branch.** Every row it produced came from reading a *pooled
workspace* and reporting the branch that workspace had checked out. A branch at rest is checked out
nowhere — and a branch at rest is exactly what a finished task leaves. So the one leftover this tool
creates on every single task was the one leftover it could not see.

Two were sitting in this repository when it was looked at:

  - **t23**, finished 2026-08-29, agent-pushed to `origin/main`. `finishWithoutLanding` had landed at
    08:50 that morning and the task finished at 16:05, so the delete *was* attempted and returned
    false. ⛔ Why is unknowable from the record, and that is the finding: `retireBranch` catches
    everything, `finishWithoutLanding` deliberately stays quiet when it fails, nothing retries, and the
    only trace t23 left was an **absent sentence** in a finish message.
  - **t79**, cancelled 2026-08-31 after asking two questions and writing nothing. Branch retirement
    lives only on the **finish** path, and a cancel goes nowhere near it.

Both carried zero commits. `taskBranches()` now enumerates `refs/heads/multi-agent-controller/` per
project, counts each against `landedRef` and reads which worktree holds it; contained ones appear as a
**branch left behind** with a **Retire it** button. ⛔ `retireStrandedBranch` re-derives its own licence
rather than trusting the panel — unlike `retireBranch`, whose callers have just produced the proof in
the same breath, this one is reached from a click on a scan that is minutes old, and a branch that
gained a commit in between must not be deleted because a stale row said it was empty.

⚠️ Cancel now gives an empty branch back too, and the narrowness is deliberate: only from `cancelled`
— *not at all* — never from `paused_user` or `draft`, which resume into their branch, and never when
the branch carries a commit. The rule at the top of `cancel.ts` still holds; what is given back is a
name. ⚠️ Best-effort, because a task cancelled while *running* still holds its workspace and git
declines — which is why the sweep above was built first, and is the net.

⭐ The two live branches were deleted by hand after the same proof: `rev-list --count origin/main..` was
zero for both, and neither was checked out anywhere.
## A survey that was mistaken for a feature (2026-09-01)

The report was that pasting an image into New Task or a thread note did nothing, "still, after t65
landed". t65 did land. It is `445ac52`, *"Survey image input across the three CLIs, and plan a paste
path"* — one file, `transient_docs/image_attachments_2026-08-31.md`, 220 lines, and its own commit
body says **"Plan only; no behaviour changes."** There was no `onPaste` anywhere in `src/`. The paste
was doing exactly what the code told it to, which was nothing.

Worth recording because the failure was not in the code and would not have been found by reading it:
a plan written in the same voice as the codebase, filed under the task number that would have
implemented it, reads like an implementation to anybody who remembers the task and not the diff.

⭐ The survey itself was good, and none of it needed re-deriving. What follows was built against its
measurements.

### `multimodalInput` was an aspiration with no mechanism

`true` on all three built-in adapters since M5, and read by **nothing** — five grep hits, three of
them the declarations. It was also wrong. Sent the same base64 image block Claude Code answers
correctly, agy 1.1.22 returns `"status":"ERROR","num_turns":0,"error":"stream input content block
type \"image\" is not supported (only \"text\")"`. ⛔ It does not drop the image; the whole turn
fails, zero turns run, and an operator reading that run would blame the agent.

So the capability was replaced with the question the code actually has — not *can it*, but **how**:

- `inline` — a content block in the stream envelope. Claude Code, whose `{"type":"user",…}` envelope
  took an image block with no change to its shape.
- `spawn-flag` — argv on the process that runs the turn, so **initial prompt only**. Codex has no
  stdin conversation at all (`streamPrompts: 'once'`), so `-i <file>` is the only channel it has.
- `none` — Antigravity, and `external.ts`'s default. A declarative adapter that has not said
  otherwise must not be sent bytes that could kill its turn.

⛔ The gate lives in `sendPrompt` (`inlineImagesFor`), not in each adapter's encoder. An encoder that
merely ignores what it is handed is a promise every future adapter has to remember to keep; a
capability read one layer up is a rule.

### The absolute path travels on every adapter, including the two that get the bytes

~20 tokens, and all three CLIs read a PNG off disk with their own view tool — agy via `view_file`,
measured on the same image the same day. On Antigravity it is not a fallback, it is the whole
channel. On the other two it is what rescues a run whose inline block a vendor update quietly stopped
accepting, which is a failure with no symptom.

### Which prompts an image rides on

`promptFor` now returns `{ text, attachments }` rather than a string, and the attachments that travel
are the attachments of the messages that travel. That is not a new rule — the delivery bookkeeping
already decides exactly which messages are outstanding, and the images simply follow it.

⚠️ **The plan and the code disagreed here, and the code was right.** §5.5 said an image should not
travel twice. True of a *warm* continuation, and false of a cold one: a cold prompt restates the
task's own first message by design, because a fresh session after a preemption has never seen it —
and an agent handed that prompt without the picture is being asked to look at something it was not
given. Suppression is keyed on `resumed`, which is the flag that already means *this conversation
has the prompt in its own history*. The first version of the test asserted the plan's rule and
failed; the test was wrong.

### The spawn moved below the prompt

`spawnSession` used to run ~50 lines above `promptFor`. A `spawn-flag` adapter needs the file list
before the process exists, so the call moved down. Everything between the two was workspace and
conversation bookkeeping that the session plays no part in, which is what made it a move rather than
a restructure.

### Bytes on disk, and a migration that has to survive being run twice

`attachments` (**migration 31**) holds metadata; the bytes live under `<dataDir>/attachments/`. A
pasted screenshot is 1-3 MB and this database is opened by the daemon on every tick, so a blob column
would bloat the WAL for data only ever read whole, by path, and mostly by a CLI rather than by us.

⛔ The row is nullable on `message_id` and `task_id` because an attachment exists *before* the message
that carries it — it is uploaded while somebody is still typing. `prunePending` collects the ones
whose form was abandoned, at startup and daily.

⚠️ The migration needed `create table if not exists`, and finding out cost seven test failures in
`sessionstate.test.ts` — a file about a repair three migrations earlier. `versionBefore` lets a test
rewind `user_version` and reopen to replay one migration, which replays **every** migration after it
too. Migration 28 already carried `if not exists` for the same reason and did not say why; migration
31 now says why.

### One image per upload, so a limit keeps meaning something

`MAX_BODY_BYTES` stays at 4 MB. `attachment.create` takes one image per call, so eight pasted
screenshots are eight requests of ~2 MB rather than one of 16. The renderer downscales to **1568px**
on the longest edge before uploading — the vendor's own recommendation, and for a full-screen grab
the difference between roughly 1.1k and 4k input tokens on every run that carries it.

⛔ The declared media type is never trusted. `createAttachment` sniffs the magic number, because the
file it writes is one an agent is separately instructed by name to open, and a `.exe` renamed `.png`
is the payload that check exists for. A mismatch between two real image types is not an error — the
clipboard mislabels routinely — and the sniffed type wins, since that is what the CLI will be told.

### Still owed

⚠️ **No image has reached a real dispatched run.** The survey measured the three CLIs directly, not
the daemon driving them; one Claude task filed with a screenshot settles it cheaply (R16). ⚠️ Whether
an MCP tool result carries an image back to the model is still unmeasured (R16b), which is why
question answers remain out of scope — a parked question's answer is an ordinary thread message and
got images for free.

## The app that was already running, and the frame that never came (2026-09-01)

The operator reported that clicking Multi Agent Controller did nothing, and that a *second* click
opened it. That reads like a first-run initialisation, and it is not one: **the first click had
already started the app.** It simply had no window.

⛔ **`ready-to-show` is not a guarantee.** Chromium emits it after the renderer's first *frame*, and
a window created with `show: false` has never been composited — so on a GPU path that declines to
paint an unshown window, the event never arrives and a `win.once('ready-to-show', () => win.show())`
is the app's only way onto the screen. Measured against an isolated data directory so the operator's
own instance was never involved, first on the packaged app and then on an instrumented build:

| | GPU on (this machine's default) | `--disable-gpu` |
|---|---|---|
| `dom-ready` | 69ms | 63ms |
| `did-finish-load` | 72ms | 65ms |
| `ready-to-show` | **never** — not at 8s, not at 20s | 66ms |
| window on screen | **never** | 90ms |

⚠️ **The second click is the tell, and it explains itself.** The process was alive and healthy the
whole time — the renderer had loaded, the event loop was fine, a `t+8000` timer fired on schedule —
and it was holding the **single-instance lock**. So the second launch failed to take that lock,
which fires `second-instance` on the first instance, whose handler calls `showWindow()` — and
`showWindow()` calls `win.show()` unconditionally, because it was written for the tray's *Open*
item. The recovery path was doing the job the launch path could not.

**The fix is that no single event is load-bearing.** `showwindow.ts` keeps `ready-to-show` as the
preferred trigger — it means the frame exists, which is the ideal — and backstops it with
`did-finish-load` (loaded but unpainted), a **main-frame** `did-fail-load` (an error somebody can
see beats a process they cannot; a subframe is not a reason to show a half-built window), and a 5s
timer for a load that neither finishes nor fails. First one wins, and it disarms the rest.

⚠️ Showing before the first paint is safe here rather than ugly only because `backgroundColor`
already matches `--color-bg`: the window is the app's own dark ground for a frame or two before
React lands, not a white flash. That property was already in `createWindow` for a different reason,
and it is what makes the backstop acceptable.

⛔ **No suite covers this, and none can.** `test:ui` and `test:pack` both set
`MULTI_AGENT_CONTROLLER_HEADLESS=1`, which skips the show entirely — and must, or every run would
open a 1440x900 window on the operator's desktop and take their focus. So the module deliberately
imports nothing from Electron and takes the window's four events as injected callbacks: 8 unit
checks assert that each of the four paths reveals, exactly once, and that a window closed before
anything painted is never touched. ⭐ The compositor itself was proven the only way it can be — by
launching the thing: **217ms** to a window on one launch of the freshly packaged app, against never.

## Two skills, because one of them was reaching origin (2026-09-01)

`/commit` did the docs, the suites, the package, the commit **and the push**, and agents were
reading a request to commit as a request to publish. Splitting it was the operator's call; what the
split had to preserve was that neither half is a lesser version of the other.

So `/push` is the pipeline as it was, and `/commit` is the same six steps stopping after the commit,
with a ⛔ banner under the title and `⛔ none` in both columns of the trunk/worktree table. ⚠️ The
banner points at `/push` by name rather than forbidding the idea, because an agent that has just
finished a green run and been told *no* needs somewhere to put the impulse.

⭐ **A new step 0.5 in both: catch up with origin before writing anything.** Not pushing is not the
same as not fetching — reading from origin is always allowed — and a commit written on a base that
moved hours ago is a conflict deferred, not avoided.

⛔ **It refuses to stash, and the ordering follows from that.** `git pull --rebase` needs a clean
tree; the usual answer is `git stash`, and on the trunk that sweeps up whatever any other tool or
agent left in the working tree — which is precisely how t91 and t92 lost an afternoon a day
earlier. So the dirty path commits first, rebases second, and **re-runs the suites third**, which is
also what catches a semantic conflict git merged cleanly. A clean tree pulls first, as expected.

⚠️ And one claim in the file was false and is now measured: CI is **seven** jobs across Windows and
Linux, not *ten across Windows, macOS and Linux*. There is no macOS runner at all (counted against
run 33578997956), so a green tick has never ruled out a macOS-only regression.

## Five rows of questions in front of one field (2026-09-02, t128)

The New Task form was ordered on a claim that reads well and turned out to be wrong. Settings narrow
what a task *is*; the prompt says what it is *for*; so the prompt went last, under **Project**,
**Policy**, **Waits for**, **Schedule**, **Worker** and **Model** — six labelled rows, three of them
carrying a `<select>` whose first option read `inherit (commit, verify and merge locally)`.

The claim's flaw is the frequency. Almost every task answers all six the same way, so what somebody
met on the way to the one field they came here to fill in was six controls they were about to leave
alone — and the two rows that were not decorative (Worker, Model) sat below four that were.

⛔ **And the defaults were computed from the wrong place.** Every `inherit` option resolved
task → project → fleet *on each open*, which is right for a value the project owns and wrong for a
person who has just answered the same question. Overriding the finish policy on one task bought you
nothing on the next one; the fleet's answer to *what do you usually want* was "whatever the project
says", which is the one answer that is never about the operator.

**What replaced it.** The prompt is first and largest, the way every chat composer has converged on
and the way this app's own task-thread composer already worked one screen away. Draft, Send and a
clock live inside the box. The settings are a row of pills underneath, each showing an **answer**
rather than a label:

```
[No project] [P1] [Task] [Dep]   [Reuse] [Commit·Verify·Merge]   [Auto] [Model] [Effort]
```

⛔ **Not `<select>`.** Eight native pickers are sized by their widest option, draw their own chrome
and open an OS menu wherever the platform decides — which is the clutter being removed, not a
smaller version of it. `Pill.tsx` owns the button, the dismiss behaviour and the arrow keys, and
takes its menu as a render prop: two of these controls are not one-of-many (prerequisites are a
multi-select with a filter over every task in the fleet, and the clock has a `datetime-local` in it).

⭐ **Last-selected, with inheritance as the seed.** `composerprefs.ts` keeps priority, kind, both
policies and the pinned account in `localStorage`, on the precedent every other per-display
preference here sets. Inheritance supplies the first value a control ever shows and nothing after
that. ⛔ What is inherited is drawn **dimmed** rather than labelled: `(inherited)` is eleven
characters, it was on three controls at once, and the distinction is worth showing on every pill
while the word is worth the width on none of them. The tooltip still names the tier.

⛔ **Model and effort are remembered per account, not once.** A model id belongs to exactly one CLI,
which is why the old form cleared the field on every worker change — correct, and it threw away a
choice somebody had made every time they looked at another account. `byWorker` keyed on the worker id
keeps both properties. ⚠️ A remembered id is re-checked against `model.options` before it is used and
falls back to inherit if the cost model no longer offers it; it is left in storage rather than
cleared, because a picker that has not loaded yet is not evidence that a choice was wrong.

⚠️ **Two things are deliberately not remembered.** A prerequisite is a fact about one piece of work,
and a schedule is a moment that has usually passed by the next time the form opens — a composer that
quietly re-armed *in 4 hours* would file a task that goes nowhere and say nothing about it.

⚠️ **The kind pill lists `Task` and `Plan` only.** Multi-task and Conversation are coming and are not
stubbed: an option that files nothing is worse than a missing one, because somebody picks it. `Plan`
is the existing `task.plan` decomposition path under its own name, and choosing it hides the pills a
plan does not carry rather than showing them and ignoring them, which is what the old Policy row did.

⚠️ **`FINISH_SHORT` and `SHARING_SHORT` are second copies of a closed set**, which is exactly the
shape that let `agent-lands` survive a rename in three dropdowns at once. They are allowed to exist
only because `src/shared/tasks.test.ts` asserts they cover `FINISH_ORDER` exactly, in both directions.

⛔ **Two React rules bit on the way through**, both real. `Date.now()` in a function defined during
render is flagged by `react-hooks/purity` — a re-render would quietly re-answer *when was this
filed* — so the clock is read through a `useCallback` and the schedule arithmetic is a pure
module-level function taking `now`. And returning focus to the pill inside the closing call reads a
ref during render; it happens in an effect once the menu has gone, which is also the only way the
next Tab starts from the pill you were on rather than from the top of the page.

⚠️ **And the first version of the UI test was green for the wrong reason.** `element.click()` fires
no pointer event, so the menus it opened were never dismissed, and a document-wide query for
`[role="option"]` then answered the Worker pill's question with the schedule presets still on screen
— picking `now` as a worker id. Every read is scoped to its own pill's wrapper and every dismissal
is a real `pointerdown`. 15 checks in `ui.test.mjs`, 17 unit checks across `composerprefs.test.ts`
and `tasks.test.ts`.

## Peer quality review — grading an agent's work, and storing the grade (2026-09-03, t153 → t170)

t153 asked for an **implementation plan** and produced one: `transient_docs/quality_review_2026-09-03.md`,
796 lines, whose own commit message ends *"Plan only. Nothing in `src/` implements any of this."* The
task then read as **completed and landed**, which it was — the plan landed. t170 is the implementation,
and the first thing it confirmed is that the operator's suspicion was right: nothing in `src/` did any
of it.

⛔ **Step 1 of the plan's order of work had an expiry date, and that is why it shipped first.**
`mergeLocal` fast-forwards the trunk and then calls `retireBranch` → `git branch -D`. After that a
task's commits are in the trunk's history with **nothing identifying which ones they are**:
`LandingResult.commit` was logged and discarded and the base was never captured at all. Every task
that landed before `landed_base_sha`/`landed_head_sha` existed is permanently unreviewable, and there
is no backfill — `runs.trunk_sha_before` is read at *dispatch*, before the rebase, so it is not a
parent of what landed and diffing from it would produce somebody else's changes. The resolution
ladder therefore has three levels and the third is a **refusal**: a review of the wrong commits is
worse than no review, because it produces a number indistinguishable from a real one.

⛔ **`runs.kind` was the riskiest part, and it was risky by breadth rather than depth.** 25 `from runs`
references across seven files meant *work*, because work was the only thing a run could be. A review
is a `runs` row — that is how `creditTurn` meters it and how the thread numbers it `#N Quality
Review`, both of which already existed — so each site had to be visited. Three of them would have
been quietly wrong: the estimator would have learned a task's cost from one-turn grades, `activeMs`
would have counted grading as working, and `TASK_SELECT` would have reported the **reviewer's** model
as the task's own on every reviewed row. Each has its own test now; that, not the column existing, is
the acceptance criterion. ⚠️ `creditTurn` splits its two writes on `kind`: the run is charged (the
operator asked for a review's price to be book-kept) and the task's budget is not, because that
budget gates the task's own admission and a grade must not push the work over it.

⚠️ **Blinding is exact on structured fields and best-effort on prose, and says which.** Measured over
the last 60 commits on this branch: **37** carry a `Co-Authored-By:` trailer naming the model and
**20** name an agent in the message body. Trailers, model ids, worker labels and vendor dotfile
directories come out mechanically. A commit body explaining a codex-specific sandbox bug does not —
redacting it produces a paragraph that no longer means anything, and the reviewer would score the
redaction. So `blinding_leak` is stored, and a cross-agent comparison that has not excluded leaked
reviews is not a clean comparison. ⚠️ The git author is *not* a leak: all 60 commits are authored by
the operator.

⭐ **The composite is the daemon's, never the judge's.** Holistic scoring is where LLM judges are
least reliable on long agentic outputs, so no holistic number is asked for; the weighted mean is
computed from the stored dimensions, which means changing a weight re-scores history instead of
orphaning it. The 10-point scale ships with written anchors at 2/4/6/8/10 — the documented mitigation
for the score-range drift a bare 10-point line invites — and the hand-calibrated worked example
(`d31b2e9`, 8.6) is a test, so a weight change that moves it has to be deliberate.

⛔ **Step 10 of the plan is not done and cannot be done from here: no review has ever been run.**
Every cost figure in §9.1 of the plan is an estimate, and whether a small model can hold a
seven-dimension rubric and produce non-clustered scores is unmeasured (R17). The experiment is one
field on every record: review the same five tasks on the small and the large model of one provider
and compare the spread. If the small model clusters everything at 7–8 it is not a judge and
`REVIEW_MODELS` moves up a level.

## M6 — session narratives displaced from HANDOFF.md (archived 2026-09-09)

⚠️ Moved here verbatim when `HANDOFF.md` was rewritten for the Warmstart rename. They are the
per-session records for t310, t326, t332, t337 and the t293-t298 maintainability batch, kept for
reasoning rather than status.

**Current check:** typecheck · lint · `npm test` (**2,909 passed, 2 platform skips**) · build clean (t337, measured 2026-09-09). ⭐ **t337 made the phone open off the home network.** The installed PWA worked on the LAN and showed a spinner then the browser's error page from cellular — diagnosed from stored evidence, not reproduced: the daemon answered `https://…ts.net:8787/` in **7.8ms** locally and MagicDNS was correct (A, no AAAA), but `tailscale ping` to the phone reported *"direct connection not established"* and **324ms–1.0s** round trips over a DERP relay. ⛔ The fault was the service worker, not the network: its navigation branch was a bare `await fetch()` with no deadline, no `catch` and no fallback, so a slow path put a **rejected promise** into `respondWith` and the cached shell was never consulted — over `index.html`, **1,170 bytes**, while the 224KB bundle beside it was already cache-first. Navigation now races the network against **2.5s** and falls back to the cached shell on timeout, rejection *or* a non-`ok` answer, still refreshing the cache for the next open. `src/mobile/src/lib/sw.test.ts` is new and holds the four outcomes of that race (nothing covered `sw.js` before); reverting the branch fails 4 of its 9 and hangs the first to a test timeout. ⚠️ A relay **is** the normal off-LAN path — both ends behind carrier NAT — so the fix belongs in what the phone does with a slow path, not in chasing a direct connection. ⚠️ The phone still runs the old worker until it can fetch once, which may need home WiFi. ⭐ t335 restores the Workers card's fourteen-field label sequence after Summary model and separates the routable-model value from its edit button; `test/ui.test.mjs` now reads the rendered label sequence so a later inserted field cannot silently shift the rest. ⭐ **t336 stopped the Tasks list naming a model the router had not chosen.** The Worker column predicted with `resolveModelChoice` for any task that had not run, so an account with a `routableModels` allowlist showed its *default* for the whole of `dispatching` and then flipped to whatever `chooseTarget` actually scored — *GPT 5.6 Sol* then *GPT 5.6 Terra*, reported as a model switching by itself. The thread pane already refused to predict there; the list now asks the *same* predicate (`routerPicksModel`, `taskview.tsx`, used by both) and draws **router picks** with the routable count in the tooltip, while `ranModel`, a task pin and `modelPolicy: 'inherit'` all still name a model. ⚠️ Not fixed by *persisting* the pick: `choice.model` is known one line before `setStatus(…, 'assigned')` in `scheduler.ts`, so a column could carry the truth instead of a hedge — a migration, and worth it only if the hedge annoys somebody.

**Current state + what to do next, not a changelog.** **Under 200 lines** — adding one means cutting the line it obsoletes. ⭐ **t310 landed phone access** (t312-t316 built it, this task reviewed the seams and closed them). Remote access is a **second listener** on a **second credential**: off by default, its own port, a per-device token stored as a hash and revocable, and an allowlist (`src/daemon/remote/policy.ts`) that is a *total map over `RpcMethod`* so a new method is denied until someone decides. Two switches gate it — global, then per project — and the per-project one is in the daemon DB, never in the committed `project.json`. Tailscale HTTPS is the intended address (installable, can notify); plain LAN works and says plainly that it cannot. ⭐ Re-check waits for a fresh, serialized Tailscale probe so an earlier HTTP listener cannot overwrite its HTTPS result; it reports both local-service and certificate-issuance errors instead of leaving the screen unchanged. The QR is a real pairing URL, and the address says it is tailnet-private: the phone also needs Tailscale. The phone app is `src/mobile`, built to `out/mobile` and served by the listener. ⚠️ **The five pieces each passed their own tests and the seams between them were where every real bug was**, which is why `test/daemon.test.mjs` now drives the listener over real HTTP (17 checks, random port). Closed here: `task.list`/`task.page` demanded a `projectId` the app never sends, so **two of five screens 404'd on every call**; `question.forTask` was scoped by `id` and it carries `taskId`; `approval.list`/`question.list` and `session.backscroll` **ignored the per-project switch entirely**; the renderer rebuilt a pairing URL the daemon had already built, doubling it; the QR code was the URL as *text*; static serving compared paths with `startsWith` and no separator; the LAN bind offered the tailnet certificate, whose name can never match an IP. ⛔ **Web Push was documented but never built** — `docs/remote.md` described notifications with no code behind them. It is now real: VAPID + RFC 8291 in `remote/webpush.ts`, the decision in `remote/alerts.ts` (question, approval, `awaiting_human`, quota gate, preempt — nothing else, coalesced 10 min), and the service-worker half. Both it and `renderer/lib/qr.ts` are written against the spec rather than pulled in, and **both tests decode their own output independently** — which is what caught the QR generator polynomial being built lowest-degree-first: it round-tripped perfectly and no scanner would have read it.

**Latest check:** typecheck · lint · `npm test` (**2,891 passed, 2 platform skips**) · build clean (t332, measured 2026-09-09). ⭐ **Two faults an operator was seeing, both diagnosed from stored evidence rather than reproduced from the description.** (1) *"Error invoking remote method 'daemon:rpc': TypeError: fetch failed"* during a batch: `quality.queue` asked `isTaskGradable` for all **322** finished tasks, which built the reviewer *menu*, whose `typicalReviewMs` is a `runs` scan **per worker** — 2,576 scans, **5.0s of a 5.1s** call, for a menu no caller read. `QualityReview.tsx` fired it from a 3s interval *and* every `task.changed`/`run.changed` with no in-flight flag (the comment there argued one was unnecessary; measured false), so the calls queued against a single-threaded daemon. Reproduced by stacking 40: `/health` took **78s** and a poll came back `ECONNRESET`, because node's 5s `keepAliveTimeout` fires *late* in a batch when the loop clears, killing a socket the client was told was fresh. Four fixes, each measured: `isTaskGradable` asks `reviewRange` (the diff half only); **migration 59** indexes `runs(worker_id, kind, outcome, started_at desc)` — 5,225ms → **91ms** for the same 2,576 calls; `applyLoopbackTimeouts` gives the 127.0.0.1 listener a 75s keep-alive and no header/request reaper (⚠️ **never** `daemon/remote/`, which faces a tailnet); the page drops a poll that finds one in flight. `daemon.rpc` now names the method, the cause and the wait instead of three words. (2) codex reviews: a `result` with `isError` was handed to `extractJson`, so the vendor's own refusal envelope was parsed as the verdict — **2** reviews stored as *"the reply omitted required `rubric_version`"* (the real reason: **`gpt-5.4-mini` is not supported when using Codex with a ChatGPT account**) and **31** as *"the reply contained no JSON object"* (the real reason: a usage limit, with its reset time in it). Every one blamed a model's formatting for a fleet fact. ⭐ OpenAI’s current Codex documentation retired `gpt-5.4-mini` for ChatGPT sign-in on 2026-08-31 and directs it to `gpt-5.6-luna`: the supported ChatGPT list and default reviewer now do so too, while **migration 60** upgrades persisted ChatGPT workers and deliberately preserves API-key Codex.

**t326** (2026-09-08): typecheck · lint · `npm test` (**2,874 passed, 2 platform skips**) · build clean (t326, measured 2026-09-08). The phone now has fixed Attention / Quota / Tasks / Settings navigation; enabled-only quota gauges with reset countdowns; ten-row local task pages with summary-first labels, worker/model/active-time/price/update/status/action; a Tasks `+` composer; and a read-only server/project/fleet information screen. `project.list` is filtered by the same remote-project switch as `task.list`, proven across the real listener. `test:daemon`: **197/202 passed**; all remote checks passed, while five earlier `agent.*` checks failed after node-pty's `conpty_console_list_agent` could not `AttachConsole` in this sandbox (the documented host-capability class, not inferred as a product regression). Remote access also distinguishes three Tailscale certificate failures that all used to read as one: an HTTPS/policy refusal, Windows' protected local-service-pipe denial (needs a Tailscale update and a working normal-user `tailscale status`), and — the one the operator actually hit twice — **our own 10s timeout killing a cold issuance**, measured at **36.1s** on 2026-09-08 against a real tailnet where the cached re-run took **0.16s**; the budget is now 120s and a kill we performed says so instead of blaming a tailnet setting (t322). A Plan & Split planner now closes its run at the successful split transition, rather than letting agent time tick until its CLI eventually exits — and **migration 57 moved the four planners that ran before that back onto their splits** (t191, t226, t292, t310, each carrying **47.3-47.9 minutes** of one session idle timeout as work; t191 now reads 30.0m rather than 77.4m, t226 126.9 not 174.7, t292 12.2 not 59.6, t310 67.8 not 115.4), anchored on the newest child filed inside the run's own span and leaving a run with no such child exactly as it found it. Manual user reviews now store an explained 0–10 overall rating separately from the peer rubric and contribute to quality aggregates without fabricated dimensions or a reviewer run.

**Maintainability batch landed and finished (t293-t297, reviewed as a whole by t292, closed out by t298, 2026-09-08).** Nine of the eleven rows of `transient_docs/maintainability_plan_2026-09-07.md` §4 are in: `scheduler.ts` 6,745 → 3,780 across five new modules (`prompt` `scoring` `residency` `turnend` `resolutions`), `shared/policy.ts` owns the preference resolvers, `testkit.ts` seeds L1 rows, the six `agent.*` RPCs have L2 checks, and `cancel.ts` reaches exactly `split.ts`’s canonical children. ⛔ **`api.ts` and `shared/policy.ts` came back marked done having done something else, and were redone during review**: `api.ts` is now 28 lines and the 118 handlers live in `src/daemon/api/{workers,projects,tasks,quality,agent}.ts` over a shared `api/support.ts`, each domain returning `Pick<Api, ItsMethodUnion>` so the mapped type still fails the build by *name* on a method nobody claims (re-proved by deleting one). ⭐ **The two rows the batch never attempted are now in too (t298)**: `TaskThread.tsx` is **1,973 lines / 12 components**, from 4,086 / 34. The seven `*Picker`s are one `components/TaskSettingPicker.tsx` reading pure menu functions in `renderer/src/lib/threadview.ts` — 19 L1 checks on what an operator is *offered*, where the renderer had none — and the rest sit in `components/thread/{Facts,Decide,RunRow,Disclosure}.tsx`; every one of the 25 moved function bodies was compared byte-for-byte against its parent commit. ⚠️ `Disclosure.tsx` is not in the plan and exists to keep the graph acyclic. ⛔ `test/ui.test.mjs` now drives the settings themselves (355 checks): writing those five exposed a ledger section that had been asserting against **whichever thread was still on screen** and passing only while the timing held. ⚠ The new scheduler modules import back from `scheduler.ts`, so nothing in them may read a scheduler binding at module-eval time (`14f7155` fixed one that did). CLIs here: claude 2.1.252 · agy 1.1.25 · codex 0.151.0 · local-llm 1.0.0 (qwen3-coder live tested) · muse 1.0.3 (in WSL2, live tested). ⚠️ With none installed — the CI state — the daemon suite skips 5 checks, each with a stated reason.

## A slot that `git status` called clean and `git switch` refused (2026-09-11, t353 → t355)

t355 was filed to debug why t353's Codex run "failed to make edit to the file"; assigning it failed
first, on `git switch -c warmstart/t355-… main` → *Your local changes to the following files would be
overwritten by checkout* naming eleven files. Read from the daemon log and the Codex rollout (outside
the Claude container — `docs/development.md` §4 *Paths*): the same refusal had already killed the
park of `ws1` for t353's retry at 07:46:23.

**Cause.** Codex's sandbox refused to write `prefs.ts`. The agent wrote the content to `%TEMP%`,
`git hash-object -w` + `update-index --cacheinfo` staged it, committed `a246ae7`, and then ran
`update-index --assume-unchanged` on all eleven files so `git status` would stop showing the working
tree — which still held the *old* content — as modified. `status --porcelain` honours the bit and
read empty; `rescueDirt` rescued nothing; `switch` compares the real stat and refused.

**Fix.** `unhideIndexEntries` (`worktrees.ts`) clears `assume-unchanged` and `skip-worktree` from
`ls-files -v` before the rescue looks. Anything that was hidden is **stashed, never committed**: the
working tree lagged the commit, so a `wip:` of it would have been a revert of the agent's own work at
the tip of its branch, and the next run would have landed it. Regression test against real git in
`worktrees.test.ts`. `ws1` repaired by hand — bits cleared, ten files byte-identical to `main` and
`Tasks.tsx` a strict subset of the commit, all stashed under a label.

**Beside it.** `cleanWorkspaceAcls` ran `icacls /reset` with `stdio: 'ignore'`. Measured: 171 of
19,321 files are owned by `CodexSandboxOffline` and refuse the reset (the unelevated daemon has
Modify, not WRITE_DAC), keeping a stale capability SID; and the pass takes 7.2 s against a 5 s cap,
so it is killed on every prepare. Both now `warn`. **Not proven**: why the sandbox refused that one
file — by its ACL it was writable, and a `codex sandbox` probe hung without a console. Delete-and-
checkout of sandbox-owned files is the untried fix. Rejected: raising the cap (a per-dispatch cost,
the owner's call) and committing hidden dirt on the branch (the revert problem above).

## Two macOS runners spent on a password that was right (2026-09-14)

The five Apple secrets went in and `platforms=macos` was dispatched twice. Run 34909163579 died on
`security import … -P` with *MAC verification failed during PKCS12 import (wrong password?)* — and
that one was a wrong password; a local `security import` into a throwaway keychain reproduced it in
seconds and a re-export fixed it. Run 34910069869 got past the import and died one command later,
`security set-key-partition-list … -k ***`, with *SecKeychainUnlock: The user name or passphrase you
entered is not correct.*

**Cause.** The `***` was the clue: GitHub masks an argument only when it equals a secret, so the
value being passed as the *keychain* password was `MAC_CSC_KEY_PASSWORD`, the certificate's. Read out
of `app-builder-lib` 26.15.3 `macCodeSign.js`: `createKeychain` makes the keychain with
`randomBytes(32).toString("base64")` and never hands that to `importCerts`, which reuses the p12
password for `-k`. An upstream regression present in 26.15.3–26.16.0 and fixed in 26.16.1 (published
2026-09-07, the fix's own comment names the mistake). npm's `latest` still pointed at 26.15.3.

**Fix.** `electron-builder` `^26.15.3 → ^26.16.1`; lock delta confined to its own family. Proven
locally by `./scripts/build-mac.sh` on 26.16.1 — signed, `flags=0x10000(runtime)` — which exercises
the new version's signing but not the temp-keychain path, since a local build finds the identity in
the login keychain and never calls `createKeychain`. ⭐ What generalises: the local build and the CI
build take **different code paths to the same certificate**, so a green `build-mac.sh` says nothing
about `CSC_LINK`. Rejected: pre-importing the certificate in a workflow step and pointing
`CSC_KEYCHAIN` at it, which would have worked on any version but duplicated what the library does.

## Two landings the trunk refused, and the `git init` that wrote it (2026-09-14, t446 → t447)

t446 (Muse Code, ws3) and t447 (Claude Code, ws1) both finished their work and both went to
`awaiting_human` with *the work is done but did not land: the trunk could not be read: Command
failed: `git.EXE rev-parse --abbrev-ref HEAD` — fatal: Invalid path '/mnt': No such file or
directory*. The operator's own shell in the trunk answered the same. The trunk's `.git/config` had
grown `[core] worktree = /mnt/c/Dev/warmstart_workspaces/ws3`, mtime 20:41:25 — during t446's run.

**Cause.** Read out of t446's session log. The daemon exports `GIT_DIR`/`GIT_WORK_TREE` into a
WSL-bridged agent's whole environment so WSL git can open a Windows-made worktree (the 2026-09-06
fix, whose comment already called the stickiness "the accepted cost"). At 03:30Z the agent ran
`npm test` in ws3. Every `git init` the L1 fixtures run in a temporary directory then re-initialised
*ws3's admin directory* instead — and `git init` under a foreign `GIT_DIR` writes
`core.worktree = $GIT_WORK_TREE` into the repository's **common** config, which for a linked worktree
is the trunk's `.git/config`, spelled the way WSL spells it. Fixture commits landed on the task
branch ("junk commits", the agent called them) and a fixture's `user.name` in the trunk config; the
agent noticed (`env -u GIT_DIR -u GIT_WORK_TREE npm test` passed), reset the branch, and at 03:41:25
ran `git config --file /mnt/c/Dev/warmstart/.git/config --unset user.name` to clean up — the write
that stamped the mtime, and one that could not see `core.worktree`. Reproduced in a scratch
repository with a single `git init`. The macOS PATH commits of the same evening were suspected
first and were not the cause; `which('git')` had resolved `C:\Program Files\Git\cmd\git.EXE`
correctly, which is why the error names it.

**Fix.** Three parts, each with a real-git test. (1) `gitEnvFor` exports nothing for a relative
pointer — measured the same day that WSL git 2.53 in ws3 with no environment reads toplevel,
git-dir, common-dir, branch and status right and its commit is visible from Windows — and keeps the
pair only for a pointer that cannot be made relative (a pool on another drive). (2)
`repairTrunkConfig` removes a `core.worktree` naming anywhere but the trunk before every base
lookup, prepare, park and landing, as text, because `git config --unset` refuses the same
repository; only that key, and only when the trunk's `.git` is a directory. `trunkBaseRef` used to
answer `HEAD` to such a trunk as if it were a fact, since every `gitOk` was false. (3) On Windows
`ensureWorktreePointer` now runs `git worktree repair --relative-paths`, which also makes the admin
directory's back-pointer relative: WSL had listed every pool member as *prunable*, one `git worktree
prune` from that side away from deleting the pool's admin directories. Git records that as
`extensions.relativeWorktrees` in the trunk config, which a git older than 2.48 refuses, so it is
win32-only and falls back to the hand rewrite.

**Beside it, a real Windows regression from the macOS work, found while looking.** `spawnEnv()` did
`env.PATH = augmentPath(env.PATH)` on an `Object.entries` copy of `process.env`; a Windows block
started from Explorer or `cmd` spells it `Path`, so the copy got `PATH=''` beside `Path`, and a child
spawned with it saw an empty PATH (`cmd.exe` ENOENT). The installed app was spared only because main
re-spells the key when it starts orchestratord. `pathKey`/`withAugmentedPath` write under the key
that is there; `which.test.ts` pins it against a plain `{ Path }` object on every platform.

**Not proven.** That Muse's own `edit_file` accepts the relative pointer (inferred since t410).
**Rejected**: keeping the environment and scrubbing `GIT_DIR` from `npm test` (the leak reaches
every git the agent runs, not only tests); `git config --unset` for the repair (fails on the
poisoned repository); `worktree.useRelativePaths` in the trunk config (a config edit the flag makes
unnecessary). The trunk's config was repaired by hand this session; t446 and t447 are still
`awaiting_human` with their branches intact and can be re-landed as they are.

## t446: the compaction that failed twice, once visibly (2026-09-14)

**What the operator saw.** t445's timeline showed a compaction reading *failed*. The ledger told a
two-row story: preemption asked `/compact` at 17:14:37 (row 88, `pre_tokens` 174,732) and the clock
asked again at 17:18:37 (row 89, `pre_tokens` 180,273), which landed at 17:21:31 — but row 89
carried `task_id` null, so no thread ever showed it and row 88 read as failed forever.

**Why the first ask died.** The 17:14 `/compact` went down a mid-turn `stream` session
(claude-code, Opus 5) as a user message. The agent answered with prose — *"Pausing here for the
compact"* plus a state dump — and ended its turn; the task went `awaiting_human`, the run closed
`completed`, and `preempt()`'s `park()` saw the run already ended and returned early: no
*Compaction did not land* message, no `paused_quota`, session left open. This is HANDOFF R6 in the
wild — `/compact` honoured or not is model behaviour the daemon cannot force; what it can do is
record the verdict, which it did not.

**Why the second ask was invisible.** The clock compacts between runs, when `runForSession` (open
runs only) finds nothing. `executeMove`'s `compact` case attributed with it, so the ask recorded
null — while `reviveAndCompact`, two screens down in the same file, already used
`lastRunForSession`. One-word inconsistency, eleven orphaned asks fleet-wide.

**Fix.** The clock attributes to the session's latest run; migration 72 backfills the eleven
orphans (verified against a copy of the live database: row 89 lands on t445, zero nulls left).
`preempt()` keeps its ask id and `park()` posts *Compaction did not land before the run ended*
when the run died on its own — but only while its ask is still the latest outstanding one
(`latestOpenCompactionId`), so a superseding ask owns the story instead of getting a stale
obituary. The timeline reads a dead ask with a landed younger sibling as *superseded*
(`lib/compactionstatus.ts`), because "failed" alone said the session was never compacted when it
was — just not by that ask.

**Beside it.** The new-task workspace pill (which hid trunk/worktree in a menu) is a joined
`SegmentedControl` group — `Project · …` | `Worktree` | `Trunk` — with the answer pressed; the
project default avoids the word "inherit" on the row, per the pill convention and the UI check
that pins it. Global settings panels keep a 920px measure: the 1371px/120% capture showed a
hand's width of dead space between each label and its control.

**Incident inside the incident.** The agent's shell exported `GIT_DIR`/`GIT_WORK_TREE` for the
workspace, and three full-suite runs inherited them — so `testkit`'s `git init/config/add/commit`
ran against the worktree repo: three junk `initial` commits on the task branch, the repo config
rewritten to the test identity, and 228 red suites all failing at `git commit`. Recovery was
`git reset --mixed` to the base with the worktree intact (content verified identical), the branch
ref restored, the config identity removed, and two skill files a foreign stash pop had deleted
checked back out. Recorded in `docs/testing.md` §3: strip the workspace git env before any
git-shelling suite, and read `git log` before `git stash`.

## 2026-09-20 — the Commit button that committed and never landed (t581 ← t578)

**What was reported.** An operator pressed **Commit** on t578, a seventeen-turn `muse-code`
conversation, expecting the tool to run the checks and land. Instead the tool asked the agent to
prepare a commit and told it explicitly not to land — and then nothing landed. The operator pressed
Commit again and the identical instruction went into the same session twelve seconds later. Their
guess was that the agent had not been told to call an MCP tool that would trigger the landing.

**What the thread actually held.** Half right, and there were three faults rather than one. From the
live database: Commit at 15:31:16 on `commit, verify and merge into main`; the agent replied at
15:41:40 with one squashed commit `829b3dc`, nine files, both project checks green, and the sentence
it had been instructed to write — *"the commit is ready to land"*; a second identical human message
at 15:41:52; cancel at 15:41:54. `C:\Dev\inkland_workspaces\ws3` then read `?? …_backup_2026-09-20/`,
`?? …/1080p_backup_2026-09-20/`, one commit ahead of `origin/main`.

1. **Nothing in the tool carried the level.** `muse-code` declares `mcp: false` — deliberately, since
   muse reads `mcpServers` out of the isolation root and a per-session identity token has nowhere to
   live — so `commitConversationInstruction` took its `canLand: false` branch, whose whole plan was
   the sentence *"the person will press **Land**"*. The level the operator chose reached nobody.
2. **There was no Land button to press.** `unlandedNow` was `!hasDiff && unlandedCommits > 0`. The
   operator had asked for backups of the renders being replaced; the agent made them and rightly kept
   those binaries out of the commit. `hasDiff` was therefore true for ever, so the card drew Commit
   and only Commit — and pressing the one control on the card re-sent the one instruction.
3. **And it would have refused anyway.** `decideFinish` step 1 and every strategy's `canLand` read
   `git status --porcelain` whole, so the same two untracked directories refused the landing with
   *"2 file(s) are uncommitted"* — about files nobody wanted committed.

**The measurement the fix rests on.** Two scratch repositories: `git rebase` with untracked files
present succeeds and leaves every one of them where it was; `git rebase` with one tracked
modification refuses — *"cannot rebase: You have unstaged changes"*. So the two halves of
`git status` are not one fact, and only one of them can break a landing.

**What changed.** `LandingContext.keepsWorkspace` / `FinishInputs.keepsWorkspace` — set by
`landConversationWork` and by nothing else, because a *finish* releases the worktree to the pool and
there the untracked half is exactly the work the gate protects. `tasks.land_after_turn` (migration
78) records the level before the turn so a restart cannot drop it; `landAfterCommitTurn`, called from
`endConversationTurn`, re-reads the workspace and lands, stands down in silence where the agent
already landed it through `land_work`, or says once why it could not. `endUnfinishedRun` forgets the
promise, so a failed or cancelled turn never lands on the far side of an unrelated reply. The
MCP-less instruction now says what happens instead of naming a button. `settleControls` in
`lib/finishlevel.ts` draws Commit and Land independently, and Commit refuses a press that would
re-ask for a commit that already exists.

**Not flown on a real run.** The evidence above is a live database, two git probes and 21 L1 checks
across three suites; four separate mutations turn them red. What has not happened is an operator
pressing Commit on a muse conversation and watching the tool land it.

## t597 ? the fleet card's in-running number lied twice (2026-09-21)

## t597 — the fleet card's in-running number lied twice (2026-09-21)

Measured on the live fleet: ClaudeSecond read `1 / 1` with nothing running on it, and CodexFirst
read `2 / 1` beside a single task on a one-slot worker. A spike against the real functions
(`sessionsForWorker` + `retainedReservations` + the card's `open + held`) reproduced both from
ordinary rows. First, a running task whose open run does not reference its live session was counted
twice — once in `open` for the session, once in `held` for the task — because both reservation
counters excuse only tasks whose runs name a live session id. A live `work` session no run
references (`unclaimedLiveWorkSessions`) now covers one sessionless running task each, computed
once per `retainedReservations` call and shared so one session never covers two; parked tasks never
consume cover, and probes/consults/reviews are not cover at all. Second, a task parked at
`awaiting_human` and then reassigned kept reserving its old worker (`ranOn`), so the old card read
occupied though the reply would run elsewhere; `awaitingHumanReservations` now skips tasks whose
assignee names a different worker, while a task waiting on a person still holds its slot. 15 L1
checks in `slotcount.test.ts` pin the card number end to end, plus 2 in `fleetcard.test.ts` for the
held-only and over-max shapes; the t117 warm-hold, the landing hold and the genuine `2 / 1` are
pinned unchanged. Not flown beyond the suites: the live rows that produced the screenshot are not
available to a test, so the two defects are reproduced from equivalent seeded rows.
