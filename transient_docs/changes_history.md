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
