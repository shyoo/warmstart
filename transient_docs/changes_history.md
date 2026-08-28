# agentyard — changes history

What earlier milestones **measured**, and what each measurement cost the design. Moved out of
`HANDOFF.md`, which is current state rather than a changelog. ⛔ Durable facts live in
`docs/cost-model.md`; this file keeps the reasoning and the dates.

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

**The background probe would not stop.** Rung 0 is free in tokens and **not** free in processes: it
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
