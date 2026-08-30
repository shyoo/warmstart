# Multi Agent Controller — Agent Workspace Guide

Conventions, layout and pitfalls for AI agents working on this codebase. **This file is loaded into
every session's context, so its length is a real cost.** A fact belongs here only if it will still be
true and still be needed next month.

## Which doc to read, and when

| Before you… | Read |
|---|---|
| do anything at all | **`HANDOFF.md`** — current state, what to pick up next |
| reason about cost, caching, quota or compaction | **`docs/cost-model.md`** — the measured numbers and where each came from. ⛔ Do not re-derive these from memory; several are counter-intuitive |
| use a domain word (worker, session, workspace, resource, mandate, objective) | **`docs/glossary.md`** — these terms are load-bearing and mean specific things |
| understand *why* the design is shaped this way | **`transient_docs/implementation_plan_2026-08-24.md`** — the design of record, with every decision (D1–D18) and its reasoning |
| change pricing or add a provider | `costmodels/` — data, never code. See `docs/cost-model.md` § Cost models are data |
| add or change an **adapter** | **`docs/adapters.md`** — what each CLI can actually do, measured, with the date and version. ⛔ Read it before writing a capability from a vendor doc; M5 found several documented claims that would have failed on the first spawn |

## Rules

- **Two names, and which one goes where.** The public name is **Multi Agent Controller**: anything a
  user or an agent reads — UI copy, docs, PR bodies, prompt text, `productName`, the MCP server name.
  **`agentyard`** is the internal name and stays that way: source comments, `window.agentyard`, test
  fixture prefixes, `LEGACY_APP_DIR`. ⛔ On-disk identifiers were migrated, not left alone —
  `.multi_agent_controller/project.json`, the data directory, `MULTI_AGENT_CONTROLLER_*`,
  `multi-agent-controller/t<seq>` branches. A pre-rename install is carried across by
  `adoptLegacyDataDir` in `paths.ts` plus `repointIsolationRoots` in `db.ts`; both halves are
  required, and `paths.test.ts` fails if either is removed.
- **No subagents.** Do the work yourself with direct tool calls. A subagent pays a fresh context cost
  to re-derive what this file and `HANDOFF.md` already give you.
- **Measure, don't assert.** This project is built on things that were checked. When you state a
  number, say where it came from and when. When you cannot measure something, label it *inferred* and
  say what the inference rests on. A confident unsourced sentence is worse than no sentence, because
  it gets trusted.
- **Prefer running the cheap experiment over hedging in prose.** Several design decisions here were
  settled in minutes by a two-command spike. If a question is empirical, answer it.

### Architecture invariants

These are not preferences; breaking one breaks the product.

- ⛔ **The TUI is for humans; the transcript is for the machine.** Never parse ANSI output to
  determine state. Usage, context size, idle time and effort all come from the agent's own transcript
  JSONL, which is exact. Terminal bytes go to xterm.js and nowhere else.
  ⚠️ **One exception exists, it is narrow, and it is declared rather than assumed.** An adapter may
  set `usageRefresh.answer: 'screen'` and implement `parseUsage`, which may produce **a quota
  reading and nothing else** - never a session's state. It exists because Antigravity keeps its
  quota in `quota_manager.go` in memory and writes it nowhere: measured 2026-08-27 by driving
  `/usage` in a PTY and diffing every file under `~/.gemini`, only `cli.log` and `history.jsonl`
  moved and neither carries a number. The invariant's reasoning is *the transcript is exact*, and
  it holds wherever there is a transcript; here the choice is screen-versus-nothing. ⛔ Such a
  parser must fail the way a rendering fails - return null rather than a partial reading. The
  first live run proved why: at 30 rows the panel scrolled, a whole window fell below the fold,
  and three of four came back looking complete.
- ⛔ **The scheduler costs zero tokens.** Dependency resolution, quota gates, cache countdowns,
  retries and auto-resume are arithmetic. The LLM controller is consulted only on discrete judgment
  events. A loop running every 10 seconds for weeks must not bill anything.
- ⛔ **A cache-clock move is a *request*; whether it landed is a separate question, and the answer
  needs move-specific evidence.** `decide()` is a pure function of the session row, the tick is 10s,
  and compaction takes ~2 minutes — so a move with no memory of having been made is re-issued every
  tick until its effect shows up. Measured 2026-08-26: session c17ce7, 68001 tokens, sent `/compact`
  **thirteen times in two minutes**, each one a billable user message written by the loop whose
  entire purpose is not wasting tokens. `markClockMove` records the ask with the evidence that would
  prove it landed; `moveOutcome()` reads it back. ⚠️ "A turn happened" is **not** that evidence — an
  agent replying *"I don't understand /compact"* is a turn. Compaction is proved by
  `tokensSinceCompact` falling; a keepalive by the TTL moving. And the clock **stops asking** after
  `MAX_MOVE_ATTEMPTS`: whether `/compact` is honoured on `stream` has never been measured (R6), so an
  unbounded retry is an unbounded spend on an unverified assumption.
- ⛔ **A global switch is off everywhere or it is a lie.** `settings.autoCompact` gates the
  reserve-at-risk compaction as well as the ordinary one — a switch that quietly kept compacting "for
  safety" would be false on the one screen whose whole claim is that it shows what the scheduler
  really does. Told-not-to-compact and cannot-compact land in the same place: handoff and close.
- ⛔ **A decision that triggers an action, and is re-evaluated before the action lands, is a loop.**
  Three components learned this separately: the cache clock re-issued `/compact` thirteen times
  (2026-08-26), the runaway watchdog re-preempted one run thirteen times (2026-08-28), and the finish
  path would have re-asked an agent to commit on every completion. In each case the decision is a
  pure function of state the action has not changed yet. **Record the ask, with the evidence that
  would prove it landed** — `clock_move`, the `preempting` set, `finish_asked_at` — and owe a re-read
  before acting on the far side of the wait, because minutes are long enough for the subject to have
  moved on. ⚠️ Re-asking is never idempotent when the asking itself costs a turn.
- ⛔ **No pricing arithmetic inline.** Ask the cost-model object (`costOfKeepalive`, `costOfCompact`,
  `costOfColdStart`, `cacheExpiryFor`). Providers price caching in structurally different ways and
  all of them move.
- ⛔ **Never branch on an adapter or mode name.** No `if (adapter === 'claude')`, no
  `if (mode === 'economy')`. Adapters declare `capabilities` and `policy`; objectives are a weight
  vector consumed in exactly two places. Antigravity lacking `/compact` — or lacking a classifier-backed
  `auto` mode — must express itself as a missing capability, not a special case.
- ⛔ **Nothing about one machine may be hard-coded.** No absolute path from your own disk, no account
  directory names, no assumption that any CLI is installed. Everything is discovered or configured.
  The app must open on a clean profile with zero workers, say so, and offer the wizard.
- ⛔ **The daemon is *asked* to stop, never killed.** `daemon.shutdown` makes orchestratord run its
  own wind-down - loops, tailers, sessions, lock, endpoint file, database - and the app's quit path
  uses it when the tray is switched off. Reading `orchestratord.json` for a pid and killing it would
  strand a lock file and a half-written database even if the pid were trustworthy, which it is not.
  ⚠️ **Shutting it down ends every live session**, so anything that asks must ask a person first when
  work is in flight. The tray switch lives in main's own `ui-settings.json`, not in the daemon's
  settings table: main has to be able to read it when the daemon is *not answering*, which is when
  it matters.
- ⛔ **Never kill a process by image name.** Not in code, not in a shell, not "just this once" in a
  test. `taskkill /IM electron.exe` and `pkill -f node` take out the user's editor, their other agent
  windows, and anything else that happens to share a binary. Multi Agent Controller kills **only PIDs it recorded
  itself**, and stops when the pid it stored no longer matches the process it started.
- ⛔ **Native modules live in the daemon, never the renderer.** An Electron upgrade must not be able
  to break a running fleet.
- ⛔ **The renderer never holds the daemon token.** It calls the main process over IPC, and main is
  orchestratord's only client. The renderer displays untrusted agent output; it does not get a
  credential to a service that can spawn processes.
- ⛔ **A quota reading is never shown without its age, and a stale one is never shown as a current
  number** - a stale percentage makes the compaction reserve look satisfied when it is not. ⚠️ But
  "unknown" is not the whole answer either: never probed, no usage cache yet, stale, and a failed
  probe are four different states with four different things to do about them, and collapsing them
  into one word is what made a working Probe button look broken. See `quotaGap()`.
  ⚠️ **There is a fifth: `quotaProbe: 'none'`, a provider that reports usage to nothing outside
  an interactive session.** The other four describe a reading somebody can go and get, so
  "unknown" invites them to press Probe again; there it reads *not reported*. ⛔ **Do not write
  `none` from an absent command; ask the CLI.** Both built-ins that carried it were wrong -
  Antigravity until `/usage` in its TUI was measured free (2026-08-27), and codex until
  `account/rateLimits/read` and its rollouts were (2026-08-29). Twice is a pattern, not bad luck.
- ⛔ **Every cost belief carries its basis.** `remainingTokens` returns a number *and* how it was
  arrived at; the reserve returns a verdict *and* its reason; the cache clock records every decision
  including the ones that did nothing. A scheduler that spends money and cannot say why is one you
  will either over-trust or switch off.
- ⛔ **`unknown` is a verdict, not a synonym for `ok` — and not a synonym for "half as bad" either.**
  The reserve has three states for a reason, and scoring `unknown` as 0.5 looked cautious and was
  not: `reserveState` returns `ok` for a worker holding **no** live sessions and `unknown` for one
  holding any, so the routing term stopped measuring risk and started measuring *does this worker
  have a session*. At weight ~0.9 that penalised being busy by 0.45 — several times every term that
  actually discriminates — and an idle worker beat a busy one always. Measured 2026-08-27: a
  never-signed-in account won a dispatch over two working ones on exactly this. ⚠️ A term identical
  across the fleet contributes nothing and belongs at zero; one that differs *only* by session count
  is worse than nothing. Only checked evidence may move a score.
- ⛔ **`awaiting_human` must say what it wants and offer somewhere to answer.** It is the one status
  explicitly about the operator and it was the only resting state with nothing to press — a task whose
  work was done but had not landed sat there beside a run marked `completed`, and the only exits were
  to cancel work that had succeeded or delete the record of it. Every hand-off to a person now writes
  its reason onto the task, and `resolveTask()` records the answer. ⚠️ A **judgement**, written down
  as one: `task_complete` remains the only signal that an *agent* finished.
- ⛔ **A run is one attempt; whether the task is done is a separate question.** `completed` on a run
  beside `awaiting_human` on its task is not a contradiction, and the UI has to say so — that pair is
  what somebody reads as broken.
- ⛔ **`admitDependents()` in tasks.ts is the only thing that re-admits a `blocked` task.**
  `admitScheduled()` looks at `scheduled` ones and nothing else touches them. A second copy of it in
  scheduler.ts re-set each dependent to the status it already had, so for months **no completed task
  ever unblocked anything and the DAG never advanced past its first edge**. Never reimplement it.
- ⛔ **A contended resource is a hold, never a failure.** `claim()` returning null means *not yet*,
  and a caller that reads it as *no* throws away work for being unlucky. Measured 2026-08-29: the
  enabled fleet could run five sessions against a pool of three, so `dispatch` threw
  `no free workspace`, the tick's catch-all marked t40 `failed` — which is terminal — and a worktree
  freed **eight seconds later**. Contention is now a `Contended` error the tick returns to `ready`
  with a reason on the row, and `poolPressure` holds the task before `chooseTarget` can spend a
  routing consult on it. ⚠️ **A hold, not a dependency edge.** An edge onto whoever holds the
  resource outlives the contention that created it, so a P0 filed a minute later still queues behind
  it; a hold is re-decided from `schedulingOrder` every tick, which is what makes priority mean
  anything. ⚠️ Keep the retry narrow: only contention meets a different world on the next attempt,
  and a `prepare` hook that exits non-zero will fail identically in ten seconds forever.
- ⛔ **A reply to a task that has stopped is a new run on the same thread, never a note that waits.**
  `deliverToLiveSession` pushed the text into the still-warm session and returned true, so the daemon
  believed it had done its job while the operator saw nothing at all: no run, no metering, no status,
  no landing. Work needs a **run** to be visible, gated and billed. `continueTask()` re-queues it and
  the scheduler routes it — the same worker, workspace and session win because `warmSessionFor`
  scores them highest, not because anything hard-codes them.
- ⛔ **Signed in is not the same as able to work, and only a run can tell you which.** An account with
  a lapsed subscription answers `auth status` exactly as a live one does, so no free probe separates
  them. The evidence is a dispatch that ends with **no metered turn**: that is charged to the worker
  (`recordDispatchFailure`), never to the task, and the task re-routes rather than being handed to a
  person as though their own prompt had failed. ⚠️ Both halves of the test are load-bearing — no turn
  *and* a short life — because the transcript's last turn is routinely flushed after the process is
  gone. Never gate on a vendor's plan string; it is recorded and shown, and nothing here has measured
  what an expired one says.
- ⛔ **Every gate on whether an *account* may be handed a turn lives in `eligibility.ts`, in one
  list.** Work and judgment both read it. They each kept their own copy until 2026-08-27 and the
  copies drifted: the scheduler had the `suspect` quarantine and the controller did not, so an
  account already held out of dispatch was reported *ready* on the Controller panel and asked for
  judgment call after judgment call - in the one loop in the daemon that spends tokens. A gate that
  needs to know *what is being asked* belongs at the call site; anything true of the account itself
  goes in the shared list. ⚠️ A held-out account is also not probed in the background: a usage
  refresh opens a real session, so an expired one otherwise fails to authenticate every thirty
  minutes forever. Pressing Probe still works, because that is one of the two things that lift it.
- ⛔ **The objective vector is consumed in exactly two places:** `weights()` for scheduler scoring and
  `policy()` for the cache clock, the model selector and preemption. A third consumer means one of
  those two is missing a field.
- ⛔ **An approval is not a task.** A permission prompt blocks one live session, has a closed answer
  set and a deadline set by that session's cache expiry. It goes on the Approvals bar, is answered by
  policy or one keystroke, and becomes an `awaiting_human` task only if it goes unanswered past
  `escalate_after`. Approvals are captured through a structured channel — never by reading the screen.
- ⛔ **A landing that landed nothing must not say it landed.** Measured 2026-08-27: a question-only
  task changed no file and was reported as *"Landed as a166a6a onto main"* — every step had
  succeeded (clean workspace, no-op rebase, passing checks, a push that moved nothing, and
  `rev-parse HEAD` returning the commit already there) and the sentence was still false. Count
  `rev-list --count $(landedRef)..<branch>` **before** choosing a strategy. ⚠️ Zero commits with a
  clean workspace is a *success* that touched no trunk; zero commits with a dirty one is work about
  to be destroyed by the next dispatch into a pooled worktree, and collapsing the two replaces an
  urgent warning with a shrug.
- ⛔ **"Landed" is measured against `origin/<target>`, and `landedRef()` in `worktrees.ts` is the only
  place that decides.** Landing is a push; the tool never moves a local ref, so the operator's trunk
  is behind until they pull. Measured 2026-08-29: `workspaceState` counted against local `main` while
  `landTask` compared against `origin/main` and *printed* `main`, and a task whose agent had pushed
  its own work was reported in words indistinguishable from work that had vanished. ⚠️ Any message
  about landing must name the ref it compared.
- ⛔ **`decideFinish` returning `nothing-to-land` never calls `landTask`.** `completeTask` takes that
  verdict straight to `completed`, so anything owed at the end of a finish — retiring the branch, and
  whatever comes next — belongs in a function *both* paths call, not in `landTask`'s early return.
  Measured 2026-08-29: the fix that only touched the early return changed nothing, because correcting
  `landedRef` is exactly what routed every agent-pushed task down the other path.
- ⛔ **Cancel is not delete.** Cancel winds a run down through the preemption protocol into a resting
  state (`paused_user` / `draft` / `cancelled`) and destroys nothing. Delete is separate, human-only,
  soft by default, and **never removes runs** — they are the estimator's training data and the record
  of real spend.
- ⛔ **The controller is never in the critical path.** The scheduler *enqueues* a judgment question and
  carries on; a separate, slower loop answers it; and **every question has a deterministic fallback
  that fires on a timer** whether or not the controller ever replies. Nothing in a scheduler tick may
  wait for, retry, or depend on an answer. When you add a judgment event, write the fallback first —
  it is the normal path, not the error path.
- ⛔ **Unattended judgment gets no tools.** A consult is asked a question and replies with JSON that is
  validated against a **closed set** and applied by the daemon. A worker id must be a candidate that
  was offered; a model must be one the cost model can price; a dependency index must point backwards.
  If a real reply keeps failing validation, the *prompt* is wrong — never widen a closed set to make a
  reply fit. Tools go only to the chat session, where a person is watching.
- ⛔ **A `plan` task is decomposed, not dispatched**, and its children land as `draft` with titles and
  acceptance criteria only. **The prompt is written at promotion**, from what the preceding work
  actually learned. A prompt written at creation is a guess, and a stale prompt is worse than none
  because somebody follows it.
- ⛔ **A capability is a fact about a CLI, and it needs provenance.** `AdapterInfo.verification` says
  whether the block was *measured* against a running binary or only *documented*. M5 wrote two
  adapters from vendor documentation and then installed both CLIs: `--ask-for-approval` does not exist
  on `codex exec`, `-p` means `--profile` there and `--print` on `agy`, and `agy` has an
  `accept-edits` mode the docs never mentioned. Every one would have failed on the first spawn.
  ⛔ Never promote a claim to `measured` without having watched it be true.
- ⛔ **Conservative is the cheap direction on a capability.** Claiming one that turns out to be absent
  strands a session at a window boundary; omitting one that is present costs a missed optimisation.
  When a capability is uncertain, declare the pessimistic answer and record the question.
- ⛔ **A cost model may say it does not know.** `cache.kind: "unpriced"` makes `canPriceCache()` false
  and the cache clock declines to spend rather than acting on an invented number. Do not convert one
  provider's pricing shape into another's to fill the field — at the point of use, a converted number
  is indistinguishable from a measured one.
- ⛔ **Never kill a bare pid, in product code *or* in a test.** Pids are recycled: a process you
  spawned can exit, the OS can hand its number to something else, and a `finally` block firing
  seconds later then kills a stranger. Read the command line and check it is yours first - both
  `ownsProcess()` and the harness's `killTree()` do. If the command line cannot be read, the answer is
  **no**: a leaked process costs a stale port, killing the wrong one costs somebody their work.
- ⛔ **Code is never loaded from the data directory.** Declarative adapters are JSON and are driven by
  a generic driver. The daemon holds the RPC token, spawns agents and knows every credential root;
  executing a file that anything on the machine can write would put all of that behind a file
  permission. A declaration also cannot grant itself MCP tools, a mintable session id, metering or a
  quota probe - each is refused with a test.
- ⛔ **The tool never writes a commit, and never destroys work.** Committing is the agent's job: what
  to stage, what to leave, what to run first is judgement that differs per project and per person, and
  a daemon applying a heuristic at the one moment nobody is watching is a worse copy of it. Work the
  tool declines to land is preserved exactly where it is and surfaced under **Loose ends** — ⚠️
  preserving it silently is only half a fix, because invisible preservation is indistinguishable from
  loss. `docs/landing.md` is the user-facing spec.
- ⛔ **Preference never widens authority.** `finishPolicy` (fleet → project → task) says what *should*
  happen; `mandate.allowed ⊇ 'land'` says what *may*. The mandate is inherited down a lineage so an
  agent-spawned subtask cannot grant itself more than its parent had, so nothing settable in a UI may
  touch it. A dropdown that could would be a privilege escalation with a nice label.
- **Agents work in a pooled worktree, never the trunk.** The branch is named after the *task*
  (`multi-agent-controller/t123-…`), never after the workspace it happened to land in. ⛔ **A slot
  does not arrive clean.** `switch --detach` carries uncommitted changes with it, so parking frees a
  member's *branch* and leaves its *edits* for whoever claims it next; `prepareWorkspace` stashes
  them first — **stashed, never `reset --hard`**, because a dirty slot usually means the last run
  failed. Recover with `git stash list` inside the workspace.

### Doc hygiene — these files shrink as often as they grow

- **`HANDOFF.md` = current state + what to do next.** Target **under 200 lines**. Adding a session's
  work means *replacing* the part it finished, not stacking a dated section on top. When something is
  done, delete its entry; if the reasoning is worth keeping, move it to
  `transient_docs/changes_history.md`.
- **`AGENTS.md` = durable rules, layout, pitfalls.** When a pitfall stops being possible, delete the
  entry. Keep the rule; the story of the bug belongs in `changes_history.md`.
- **`docs/` = permanent, maintained reference.** Kept current. If it is wrong, fix it.
- **`transient_docs/` = dated plans and design-of-record.** They go stale by design and are kept for
  the reasoning. Never read them for status — that is `HANDOFF.md`.
- **`internal_docs/` = the owner's private notes. Gitignored. Do not commit it, do not cite it.**
- ⚠️ **If you are about to append, ask what you can remove in the same edit.**

### Git

- Private repo, single developer, no PR review. Commit on `main` directly, and **only when asked**.
- Never commit `internal_docs/`, `node_modules/`, `out/`, `release/`, or anything matching
  `.gitignore`.
- **`/commit` is the shipping path** (`.claude/skills/commit/SKILL.md`): docs, suites, packaged
  build, commit, push. It knows the trunk/worktree difference and which suites must run.

## Layout

```
src/main, src/preload   Electron shell. A window host and nothing more.
src/renderer            React UI. Tokens in src/renderer/src/styles/tokens.css.
src/daemon              orchestratord: scheduler, PTYs, store, MCP server
src/shared              types crossing a process boundary
costmodels/             versioned pricing data
.claude/skills/         project skills. /commit is the shipping path
```

## Things that will bite

- ⛔ **Never compare two paths with `===`.** Windows filesystems are case-insensitive and Windows
  *paths* are not, so `c:\Dev\x` and `C:\Dev\x` are one directory and two strings. This install
  held one pooled worktree under both spellings in `sessions.cwd` — the source was `policyFor`,
  which derives an unconfigured workspace root by concatenating onto `project.root` while a
  configured one comes back from `resolve` in the config's own case. Use `samePath` from
  `fspath.ts`; it folds case on win32 only, because `/Dev` and `/dev` are genuinely two directories
  everywhere else. ⚠️ Both failures are silent: a missed match costs a cold start, and in the
  workspace pool it hands the task a **different worktree** than the one its conversation describes.

- ⛔ **A worktree is where an agent *starts*, not a boundary it is held inside.** For
  `antigravity-cli` the workspace must be named with `--add-dir <cwd>` on **every** spawn, resume
  included — cwd alone let t17 edit and commit in the trunk on 2026-08-28. ⚠️ Any new adapter should
  be asked the same question before it is trusted with `--dangerously-skip-permissions`: *what,
  other than the cwd, tells this CLI where it may work?* If the answer is nothing, the flag is
  bounded by nothing.
- ⛔ **The history of that, kept because the failure was silent:** t17 ran with `cwd` set to its pooled worktree and
  edited and committed in `C:\Dev\multi_agent_controller` instead: 45 distinct trunk paths in its
  conversation store, zero workspace paths, three commits straight onto `main`. Its branch never
  moved, so the finish logged `nothing-to-land` and every gate that runs *before a branch merges* was
  simply skipped — the work was already on the trunk. Nothing in the daemon detects this. If a task
  finishes with `nothing-to-land` and the work plainly happened, check `git reflog` in the trunk
  before assuming the agent did nothing.
- ⛔ **`antigravity-cli` has an isolation root that nothing writes to.** `envFor()` copies the
  ambient environment and unsets three API keys; it sets no `HOME` and no Gemini directory, and
  `trustDirectory`/`writePermissions` ignore the `_isolationRoot` they are handed.
  `<dataDir>/workers/antigravity/` is empty; credentials, conversations and a persistent
  cross-session "brain" all live in the operator's own `~/.gemini`. That brain carries absolute paths
  from previous sessions, which is how an agent arrives already pointed somewhere other than its
  workspace. ⚠️ Anything reasoning about *"one account per isolation root"* or *"a conversation lives
  inside one isolation root"* is false for this adapter.

- ⛔ **`test/ui.test.mjs` never opens a project.** Every task it files has `projectId: null`, so it
  drives the **Unassigned** route and nothing under `components/Project.tsx`. A mutation to a project
  route will run green there — it did on 2026-08-28, three checks passing with the row-click
  navigation deliberately broken. When you change anything on a project tab, mutate the code and watch
  the suite go red *before* believing it; if it stays green, the suite is not reaching your change.
- ⛔ **The UI suite's worker has no credentials, so nothing it files ever runs.** There are no rows in
  `runs` and no sessions during that suite. Any check written against `.side-run`, a session id, a
  token count or a quota delta will report **PASS against an empty list**. Assert the collection is
  non-empty as half the claim, or test the logic as a pure function instead — `lib/conversation.ts`
  exists for exactly that reason.

- **Electron does not download itself.** Electron 44 ships **no postinstall** — it exposes
  `install-electron` as a bin and leaves the ~110MB download to you — so `npm install` finishes with
  `node_modules/electron/dist` empty and every suite here needs that dist. Run
  `node scripts/ensure-electron.mjs`, which retries and says whether the release host is reachable.
  The failure looks like a broken build, not a missing download. ⚠️ This is not your npm blocking a
  script; there is no script to block, so there is no npm setting that fixes it.
- **A sandboxed preload must be CommonJS.** `package.json` sets `"type": "module"`, so the preload is
  built to `index.cjs` via an explicit rollup output override in `electron.vite.config.ts`. If you
  see *"Cannot use import statement outside a module"* from the preload, that override was lost.
  ⛔ Do not "fix" it by dropping `sandbox: true`.
- ⛔ **Every suite below L1 drives a build product and none of them builds one.** `test:daemon` and
  `test:ui` start the app out of `out/`; `test:pack` drives `release/`. Running any of them without a
  fresh build silently tests code that is no longer in the tree **and reports a confident pass for
  it** — three times on 2026-08-27. `checkBuildIsCurrent()` and the pack suite's asar check refuse
  instead. ⚠️ When you add a guard like that, watch it go red before you trust it green.
- ⛔ **Two agents run these suites at once, so a suite that cannot run twice at once is a bug in the
  suite.** `test/ui.test.mjs` held a hard-coded debugging port until 2026-08-29: four runs started
  inside three and a half minutes, and because the suite asked *the port* for a page rather than
  asking its own app, the losers drove a stranger's application and then blocked forever when it was
  killed. Anything shared is asked for at run time — `freePort()`, `mkdtempSync()` — never written
  down as a constant. ⚠️ Prove it the only way that counts: run the suite twice at once and require
  both to pass. Reverting that one constant fails 8 of 125 in one run and 33 of 81 in the other.
- ⛔ **Bound the wait nearest the resource.** In that same incident *every* wait above the blocking
  call had a budget — 45s for the app to appear, 30s in `until` and `waitFor` — and the DevTools
  request underneath them had none, so no budget above it could ever be reached. Each suite now
  declares a ceiling with `startDeadline`, whose `onExpire` must stop what the suite started because
  `process.exit` does not run `finally`.
- **There is exactly one packaged app in the tree, `release\win-unpacked\`, and it is the
  build's.** ⚠️ A second copy under `release\suite\` existed from 2026-08-27 so packaging could
  not collide with an app run from the repo; it was removed the same day, because **the app to use
  is the one the installer installs** and two identical executables with only one ever new cost
  more than they saved - 98 minutes debugging a change that had in fact taken effect, then an
  `EPERM` that stopped a commit. So packaging *does* collide with the repo's own copy now, and that
  is correct rather than a bug.
  ⛔ When it collides, **find out whose the process is before reaching for a kill**: a command line
  matching the packaged binary matches the operator's own app just as well as a test's. And note
  orchestratord is **detached by design**, so it holds the binary after its window closes - the
  topology working, not a leak. ⚠️ Guard the directory actually being rewritten, nothing wider.
- **A quota sample is keyed on the vendor's fetch time, which does not move when you read it.**
  `sampledAt` is `cachedUsageUtilization.fetchedAtMs` — exactly right for staleness and fatal as an
  insert key, because re-reading an unchanged cache produces a row identical to the last one and
  `lastQuota` returns *every* row at `max(sampled_at)`. The fleet strip grew a second `session` /
  `weekly` pair every five minutes until `store()` became an upsert on (worker, window, sampled_at).
- **A cost is a difference, so a run gets two quota readings or none.** One reading is a state, and
  showing "the account is at 41%" beside a run invites it to be read as the run's price. The
  scheduler refreshes a stale reading **before** dispatching — holding the task one tick rather than
  blocking the loop, since `refreshUsage` opens a terminal for half a minute — and takes the closing
  one once the run has ended and nothing is waiting. ⚠️ Never reconcile the two with the token
  counts: transcript metering is exact for assistant turns while quota covers everything the CLI
  spent, and the gap between them is the instrument.
- **Idle time is measured from the request *start*, not the response record.** A four-minute response
  has already spent four minutes of the cache TTL. Measuring from the last assistant turn is
  optimistic by one response length.
- **Changing tool definitions invalidates the entire prompt cache prefix.** A session's MCP config is
  frozen for its lifetime. This is why workers on one project get identical MCP configs.
- **`claude -p /usage` spends a real turn** — but that is a fact about **print mode only**, and for
  three months it was written down as a fact about the product. ⭐ Typed into an *interactive*
  session, `/usage` is a client-side command: it costs nothing and rewrites `cachedUsageUtilization`
  on disk. `refreshUsage()` drives it. `docs/cost-model.md` §5 has the ladder, what else was tried,
  and when to revisit each. A stale reading must still never be rendered as a current one.
- **`claude auth status --json` exits 1 when not logged in**, but still prints valid JSON. Read
  stdout, not the exit code, or every un-commissioned worker reports as "probe failed".
- **node-pty does not search PATH.** On Windows it goes straight to CreateProcess and fails with a
  bare *File not found* for a command that runs fine in a shell. Everything spawnable goes through
  `src/daemon/which.ts`, which also routes `.cmd`/`.bat` shims through the command processor.
- **`node:sqlite`, not better-sqlite3.** It ships inside the Node that Electron already carries, so
  there is no native module to rebuild against Electron's ABI. better-sqlite3 publishes no Electron 44
  prebuild and would need a toolchain on every contributor's machine.
- **`--permission-mode auto` must be passed explicitly.** `auto` is the built-in start mode only for
  a *terminal* session on Pro/Max/Team; `claude -p` and the Agent SDK start in `default`, and an
  `"auto"` value for `defaultMode` in a project settings file is ignored. Forget the flag and every
  scheduled run is silently Manual, stalling on its first shell command with nobody watching.
- **Auto mode discards broad allow rules** — blanket `Bash(*)`, wildcarded interpreters,
  package-manager run commands, `Agent` and `Monitor` rules. Narrow rules like `Bash(npm test)`
  survive, so generated allowlists must be written narrow or they vanish where they were needed.
- **`--print` will not start under a PTY.** It exits immediately with *"Input must be provided either
  through stdin or as a prompt argument"*, because a pseudo-terminal is not piped stdin. The `stream`
  transport uses real pipes; only `pty` uses node-pty.
- **The workspace-trust dialog blocks a fresh worktree**, and ⚠️ **it blocks far more than that**: it
  is asked per account *and* per folder, and until it is answered the CLI **swallows every keystroke
  sent to the session**. It cost a day in 2026-08: the usage probe was typing `/usage` into the
  dialog and pressing Enter on "Yes, I trust this folder", reporting no reading and blaming
  onboarding. Skipped only in non-interactive mode - the second reason scheduled work runs on
  `stream`. ⛔ Sessions with no project now run in `<dataDir>/scratch`, an empty directory this app
  owns, and `trustDirectory()` pre-answers the question **for that directory only**. Never for a
  project, a worktree, or anybody's home.
- **`task_complete` is the only signal that a task succeeded.** A process exiting cleanly says nothing
  about whether the work was done. A session that ends without it goes to `awaiting_human`, and that
  is the honest answer rather than a guess.
- ⛔ **A failing `stream` session announces it and then does not exit**, so waiting for `onExit`
  waits forever. Measured 2026-08-27: an account whose organisation had disabled Claude Code sent
  `{"type":"result","is_error":true,"terminal_reason":"api_error"}` and sat on stdin — the run stayed
  open, the task stayed `running`, and the worker's only slot stayed held. The terminal `result`
  record is the signal (`onStreamResult`); the exit is not. ⚠️ And a failed *result* is not always a
  failed *run* — an agent that hits a tool error has still worked and still metered turns, so who is
  blamed is decided by the metering, never by the wording.
- **`MULTI_AGENT_CONTROLLER_TIER` decides the MCP tool set, and only the daemon writes it.** It comes from the
  config file the daemon generated for that session; an agent cannot promote itself by exporting it.
  Two tiers means **two cache prefixes** on an install — adding a tier adds a third, so do not add one
  casually.
- **`sessions.purpose` is load-bearing, not a label.** A `consult` is exempt from `maxConcurrent`
  (bounded separately at one per worker) and skipped by the cache clock; a `chat` session is very much
  the clock's business; a `probe` opens a TUI for fifteen seconds, spends nothing, and holds no
  prefix worth keeping warm. Changing a purpose changes what a session costs.

- **`cmd /d /s /c <shim>` splits any path containing a space.** `/s` makes cmd strip the outer quotes
  and take the rest literally, and the Windows default home has a space in it. Use `/d /c` and let
  Node quote the argument; do **not** add quotes yourself. Latent since M1 and invisible until a CLI
  installed as a `.cmd` rather than a `.exe`. Everything that starts a CLI goes through
  `launchable()` / `launchArgs()`, **including detection** - `execFile` on a `.cmd` without a shell
  fails with a bare `spawn EINVAL`, and detection that fails for an installed CLI reports it missing.
- ⛔ **`-p` on `agy` takes the prompt as its VALUE.** `-p` / `--print` / `--prompt` are one
  string flag, not a boolean: `agy -p` alone answers *flag needs an argument: -p*. The adapter
  passed a bare `-p` before `--input-format`, so the CLI took `--input-format` as the prompt and
  exited 2 in zero seconds - **every Antigravity dispatch from M5 to 2026-08-27 failed this way**,
  and the run note blamed the *agent* for ending "without reporting completion" on an account that
  was signed in the whole time. ⚠️ Same letter, three meanings across three CLIs: `--print` on
  `claude`, `--profile` on `codex`, and a string-valued `--print` here. Never carry a flag's shape
  across adapters; run it.
- **`agy` installs under `%LOCALAPPDATA%` and is not on PATH until `agy install` runs.** The
  adapter looks there anyway; reporting "not installed" would send somebody to reinstall what they
  already have.
- ⛔ **A Windows path written into a file through a shell heredoc loses a backslash.** `'C:\\ws1'`
  arrives as `'C:\ws1'`, which TypeScript reads as `C:ws1` — a path that matches nothing. ⚠️ The
  damage is not a crash: a gate keyed on that path returns "no match" for the *wrong reason*, so a
  test asserting `toBeNull()` passes while proving nothing. Four did, in `resume.test.ts`, on
  2026-08-28. Write such literals with the **Edit tool**, which does not go through a shell, and put
  the path in a named constant so there is one occurrence to get right rather than nine.
- ⛔ **Any test that calls `plan()` needs the CLI on PATH, and CI has none installed.** `plan()`
  resolves the command before it builds an argv, so an argv assertion passes on a developer machine
  and throws `'claude' is not on PATH` in CI. Stub the names onto PATH the way `adapters.test.ts`
  and `resume.test.ts` do - empty files, both with and without `.exe`. ⚠️ This has now been found
  twice, the second time in a brand-new test file written by somebody who had read the first one's
  explanation. Check a new suite against a stripped PATH before pushing:
  `env -u LOCALAPPDATA PATH=/c/Windows/System32:/c/Apps/nodejs:/usr/bin node node_modules/vitest/vitest.mjs run <file>`
- **A native module cannot be loaded from inside an asar.** `dlopen` needs a real path and the
  archive is virtual, so `.node` files are unpacked beside it. ⚠️ The `.node` files are **not** in
  `@lydell/node-pty` - they are in per-platform siblings like `node-pty-win32-x64`, so a glob naming
  the parent matches nothing. `npm run test:pack` is what catches this; it is the only suite that runs
  against a real package.
- **`gemini-cli` is dead.** Google stopped serving individual accounts 2026-06-18; the Google adapter
  is **Antigravity CLI (`agy`)**. Do not write against `gemini`.
- **Compaction takes about two minutes.** Any deadline that ends in a compaction has to budget for
  it — see `docs/cost-model.md`.

## Design vocabulary

`docs/glossary.md` is the authority. The one distinction worth stating here because everything
depends on it: **a worker is not a session.** Quota lives on the worker (an account); context lives on
the session (a live process). Routing has to satisfy both, and conflating them makes the scheduler
incoherent.
