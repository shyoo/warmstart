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
