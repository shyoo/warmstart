# Warmstart — Session Handoff

## Current state — 2026-09-24

Warmstart M0–M6 is implemented, including debate mode, quota-aware scheduling, pooled worktrees, model-aware routing, quality review, remote access, packaging, and atomic worker/model reassignment.
The maintained reference in [`docs/`](docs/README.md) is the authority on each subsystem; dated
design and incident history belongs in `transient_docs/`, not here.

Baseline (2026-09-25, **Windows 11**, t701): typecheck, lint and build pass; L1 **3,992 passed, 3 skipped** (235 files) in **136.83s**.
Earlier Windows baseline: L2 **204 checks** (7 skipped — the two POSIX-only cursor-position checks skip here); L3 **493
checks** (4 skipped); L4 **19 checks** against `release/win-unpacked`. ⚠️ The `%TEMP%` figure is
t579's, not re-measured here. macOS 13 arm64, 2026-09-14: L3 434 (6 skipped), L4 17 on a signed,
hardened-runtime bundle. CI is **enabled**, and so is the **Release** workflow.

**`v0.3.3` is `latest`** (t682, 2026-09-24), promoted onto `v0.3.3-rc.1`'s commit `8cf5d301`.
The next `/release rc` opens the patch series at `0.3.4-rc.1` unless `--bump minor|major` is asked for.
Phase 3/4 (write-up, landing page, channels) remains off-repo.

**Routing Model v1.2 preserves expiry urgency (t552); dispatches explain the pick (t691).**
`prepaid` is field-normalized $/h to reset (same $3.68 scores 1/24 at 24h, 1 at 1h); the winner's
`reason` names pin, comparison, or override, and a compared Auto field records `score`. `docs/routing.md` §§3.3a, 4.9.

**Plan & Execute dispatches carry the full instruction (t691).** The planner's brief is what the executor receives; see below (t693) for what the operator sees before it runs.

## Closed in this cleanup

- **No phantom worker capacity holds from idle, paused or settled sessions (t702, 2026-09-25).**
  ClaudeThird was held 2/2 when no runs were active: (1) t667 switched from Claude to Codex; when resolved, only the latest session closed, leaving Claude's session live; (2) t626 sat at `paused_user` with a lapsed cache while `slotsInUse` counted every open session. Now `slotsInUse` ignores sessions with no open run whose task is settled, `paused_user`, or whose cache lapsed; `resolveTask` closes all live sessions of a task across workers; `onTaskSettled` closes live sessions on settlement; `sweepStaleSessions` reaps dead/idle sessions on the tick; and `cacheclock` returns `handoff_close` on lapsed prefixes to free slots and workspaces immediately. L1 in `residency.test.ts`, `cacheclock.test.ts`, `conversationcapacity.test.ts`. `docs/routing.md`.
- **The Tasks table shows a sortable Type column (t701, 2026-09-25).** It uses the same five labels as the composer and task thread, including the two plan shapes. Existing saved column layouts gain Type once; a later choice to hide it remains saved. The derived sort orders the whole filtered set before paging. `docs/ui.md`.
- **The Attention bar's Answer… opens the task on its own project thread (t699, 2026-09-25).** It always routed to `{ kind: 'unassigned' }`, stranding project tasks under `← Unassigned`; `routeForTask` (`renderer/lib/taskview.tsx`, 2 L1) picks the project thread, `openTaskById` (`App.tsx`) asks the daemon when the cached list has not caught up. `docs/ui.md`.
- **The Plan & Execute approval shows the whole executor instruction (t693 ← t690, 2026-09-25).**
  The handoff card approved a one-line label while the piece's title ran as the executor's prompt verbatim. `splitApprovalFor` (`src/daemon/split.ts`) now builds the card text with the full instruction; `ApprovalBody` (`Questions.tsx`) renders `task_split` bodies in the thread's markdown subset, collapsed past twelve lines behind *Show full instruction*. Split-mode cards stay one-line labels. L1 in `split.test.ts` + `ApprovalBody.test.tsx`. `docs/ui.md`.
- **A resumed session no longer holds as *no routable models in 'med' class*, and a busy machine no longer fails a landing (t697 ← t691, 2026-09-25).**
  (1) The class check for a candidate named by model alone (a resumed or warm session, or a pin) read the model's *first* row. MuseFirst lists `xhigh` (high) above `medium` (med), and t691's session had run at `medium`, so the retry held for ever. `pairInClass` (`shared/modelroutes.ts`) now checks every row, the session's effort first, and carries the matching effort. The mutation reproduces the exact hold text.
  (2) t691's landing was **not** handed an outdated workspace: the run started on `e657e74` = `main`, and the branch was one commit on it. The checks ran beside t694's (inkland) suite, and six git-heavy L1 tests timed out at 15s. Reproduced: two L1 runs started together fail 4 tests each, and one alone passes (3,976, 101s). Muse *had* run the full suite before completing. `runChecks` now runs one landing's checks at a time machine-wide. The failure notice's "4 commit(s)" counted `main`'s 3 unpushed commits; it now excludes the local target.
  (3) 127 of 234 L1 files named no data dir and wrote ~32 lines per `npm test` into the live daemon log; `globalSetup` now sets `WARMSTART_DATA_DIR`. `docs/routing.md`, `docs/landing.md`, `docs/testing.md`.
- **Long task threads skip the one-second ledger rerender (t684, 2026-09-24).** `Thread` is memoized and its empty activity tail is stable, so old markdown is parsed only when thread data changes. t667's recorded thread was inaccessible through this task's cross-project `task_read`; this is a renderer-path diagnosis, not a direct profile. `docs/ui.md`.
- **Muse can use the host's `gh` login (t683 ← t682, 2026-09-24).** Its private XDG root hid
  `gh`'s config even with Full user authority. A Windows reproduction showed auth fail with that XDG
  root and succeed when `GH_CONFIG_DIR` named the host config. The adapter now pins that path while
  keeping Muse's own XDG roots private. `docs/adapters.md`, `docs/security.md`.
- **An expired question no longer sticks on the banner (t680 ← t679, 2026-09-24).** t679 guarded the renderer against stale `question.list` responses, but the banner's row was a daemon orphan: t667's native `AskUserQuestion` carried two questions, the second was asked 110ms after the first parked and 27 min after the run ended, so `insertQuestion` stored `task_id = null` — out of reach of every task-keyed sweep. Now a question binds to `taskOfSession`, one asked with no open run is filed parked at once (⚠️ only if the session *had* a task — a task-less session's `ask_human` is live, and parking it voided it; L2 caught that), a task-less park is voided, and the startup sweep voids existing orphans — ⛔ now called from `index.ts` after `openDb`: it ran at module load, where `db()` throws and its `try/catch` reported *swept 0*, so it had never swept anything in the shipped daemon (verified on a copy of the live DB: the orphan cleared). 4 L1. `docs/glossary.md` *Parked*.
- **Sidebar project counts omit empty buckets (t678, 2026-09-24).** `ProjectTaskCount` renders only positive running/awaiting/parked counts, slash separated; colours and hover remain. Six combinations plus empty pinned at L1. `docs/ui.md`.
- **The `land_work` receipt states previous → next, each named once (t677 ← t667, 2026-09-24).**
  It named only the new branch, which reads as a restatement of the one just landed.
  `landConversationWork` now returns the landed `branch`; `conversationLandingResultText`
  (`shared/tasks.ts`, one writer) renders `Landed <sha> from <old> onto <target>… continues on
  <new>`. Formatter + return + thread-detail order pinned at L1. Protocol gains `branch`.
- **A transcript-reported model can no longer hijack the next dispatch (t675 ← t667, 2026-09-24).**
  t667 displayed `claude-opus-4-8`, which no worker lists; sessions spawned for `5-5` reported
  `4-8` mid-run (t659 too, same process). Session rows are first-writer-wins and reuse/resume
  candidates must be routable (`isRoutableModel`), falling back with a log line. Composer
  exonerated. 3 L1. `docs/routing.md` §2.4.
- **The reassign pills name what the task is on, not *Auto model* (t674, 2026-09-23).** Where the pin leaves worker, model or effort to the scheduler, the pills under the composer show the latest run's account, model and session effort (`pillLabels`, `thread/Reassign.tsx`; 6 L1 checks). A reassignment to another account that has not run yet still reads Auto. `docs/ui.md`.
- **The send-outcome hint no longer sticks, and the reassign pills line up with the box (t673, 2026-09-23).** `outcomeHintStale` clears the hint once `task.status` moves past the send; `.compose-assign` starts where the box does. L3 asserts both. `docs/ui.md`.
- **Sidebar conversations drop the 💬 glyph (t671, 2026-09-23).** A conversation row is marked by its indent alone — the title starts one `--sp-3` past the project name — because the glyph was loud in dark mode and competed with the project's status dot. L3 now asserts the indent. `docs/ui.md`.
- **No *your call* card on every conversation turn (t669, 2026-09-23).** Stop now sits beside Send at `awaiting_human`; once stopped (`paused_user`) Complete sits there instead, arming once over uncommitted files, and an empty box reads Resume (the Paused-by-operator banner is gone). Worker · model · effort are pills under the box (`thread/Reassign.tsx`); a changed pick turns Send into Reassign and sends the typed text (or `Continue.`). What remains above the composer is a frameless strip drawn only when Commit/Land/Resolve & retry/Retry landing or a work-protecting note applies. `QuotaDecide` unchanged. L3: 8 pre-existing fleet/worker-settings failures reproduce on the base commit. `docs/ui.md`, `docs/landing.md`.
- **Status colours say who a task waits on (t668, 2026-09-23).** Blue = agent working, yellow = human action needed (`awaiting_human` only; was purple), grey = parked and needs nobody (`paused_user`, `paused_quota` were yellow). Status pills carry a hover saying so; the sidebar count is now `running/awaiting/parked` in those colours and the project dot follows the same buckets (supersedes t655/t661's two-number count and purple/yellow dots). Flow lanes unchanged. `docs/ui.md`.
- **Codex stream decoder emits tool calls and separates commentary from final answers (t666 ← t665, 2026-09-23).**
  In `openai-compatible.ts`, `codex exec --json` dropped tool calls (`command_execution`, MCP tools, file changes, reasoning) and emitted `turn.completed` with `result.text: null`, causing `turnend.ts` to scrape `backscroll`. That raced with `renderStream`'s scrollback append, truncating final answers and leaving initial planning commentary in thread messages before switching to `awaiting_human`. The decoder now decodes tool calls, tracks pre/post-tool agent messages, extracts the final answer into `result.text`, and `sessions.ts` appends to scrollback before event dispatch. 7 L1 checks in `stream.test.ts`. `docs/adapters.md`.
- **Worker model edits now apply their returned row immediately (t664, 2026-09-23).** The model table no longer waits for or causes a fleet-wide `fleet.list` reload after each click; `worker.changed` keeps other windows current. Events still re-read the fleet when eligibility, capacity, or ordering changes; `docs/ui.md`.
- **Worker model rows now have independent summary selection and explicit effort (t663, 2026-09-23).** Summary persists a model/effort pair, so toggling Gemini 3.8 Flash selects only that row and leaves other efforts removable. Migration 83 converts legacy selectable blank efforts to `medium` and de-duplicates any pairs that conversion exposes. `docs/ui.md`.
- **Conversation selection and Antigravity default rows repaired (t660, 2026-09-23).** A listed conversation now owns the sidebar highlight while its thread is open; other project tabs and unlisted threads still highlight the project. Antigravity's per-pool default now identifies one model/effort pair rather than every effort row of its model, so non-default Gemini rows can be removed, and selecting a default also updates its no-quota fallback pair. `docs/ui.md`.
- **Statistics trade-off scatters put quality on *y* and active time on *x* (t651, 2026-09-23).**
  `SCATTER_PAIRS` now draws Quality vs Cost, Quality vs Active time and Cost vs Active time, titled
  *y* vs *x*; `docs/images/tradeoffs.png` regenerated. `docs/ui.md`.
- **Trunk conversations were told to commit on a task branch that never existed (t649 ← t648,
  2026-09-23).** Commit instruction, conversation contract and `land_work` reply now have trunk
  variants (no branch, no squash); pull-request refused up front; `pendingWorkFor` reads the root.
  `docs/landing.md` §Working in the trunk.
- **Settings > Workers model matrix is concise and removable (t647, 2026-09-23).** Removed legacy Work/Judgment/Grading role switches in favour of the purpose columns; Default is now a one-choice radio control per quota pool; `Class` is now the user-defined `Label`, with guidance for refining Auto Model. Rows are rendered only when configured or needed by a purpose, so removing a stored model actually removes it; every remove control remains visible and explains when a purpose prevents removal. The help text now says these choices configure Auto Model and purpose models, while task authors can still select model and effort themselves. `docs/ui.md`, `docs/routing.md`.
- **Antigravity model effort unblended and Summary model moved into routable matrix (t645, 2026-09-23).**
  (1) Unblended reasoning effort from Antigravity model identifiers (`gemini-3.8-flash-high` → `gemini-3.8-flash`) in `costmodels/google.antigravity.2026-08.json` and benchmarks, enabling `selectableEffort: true` in `antigravity-cli.ts` with `--effort low|medium|high` instead of blending effort into model IDs.
  (2) Moved `Summary model` into a checkbox column of the inline `ModelTable` routable model matrix, removing the outer table column and setting selector from `Workers.tsx` (12-column layout).
  (3) Added database migration 82 in `db.ts` to unblend existing Antigravity worker rows in `workers` table (`model_routes_json`, `default_models_json`, `default_model`/`effort`, `grading_model`/`effort`, `summarising_model`, and `judgment_model`/`effort`). `docs/data-model.md`, `docs/adapters.md`, `docs/ui.md`.
- **`/release rc` publishes the trunk itself rather than handing the refusal back (2026-09-22).**
  The base gate is unchanged and still refuses all three unsafe bases; what changed is the skill.
  New step 0.5 runs `check-release-base.mjs` *before* the notes are written, and when the only
  problem is a trunk ahead of origin it invokes `/push` and re-plans against the commit that lands
  — a dirty trunk or a behind branch still stops and asks, because those edits may not be the
  agent's. Alongside it, L3's *offers exactly the two answers that are not a model* still expected
  two policy answers on the unpinned Model pill; t620 had added three class-scoped Autos, so the
  check asserted a count rather than its claim and would have gone red on CI. It now asserts what it
  means: no model ids before an account is pinned. `docs/development.md`.
- **Preemption compaction now survives Claude's interrupt acknowledgement (t640 ← t638 ← t628, 2026-09-23).**
  t628's wire-shape check missed the reply: t638 ended **596ms** after preemption on `aborted_tools`, the
  interrupted old turn, not a failed session. The generic error handler closed the pipe before queued `/compact`
  could run; the adapter now declares the acknowledgement and the handler preserves the queued prompt. L1 covers
  it and a real `api_error` non-match. `docs/adapters.md`.
- **Codex Sol 6, Claude Opus 5.5, and single loading spinner in Tasks (t627, 2026-09-22).**
  (1) Upgraded `@openai/codex` to 0.156.0. Supported `gpt-6-sol` (1.05M context window, low..ultra effort levels) in `costmodels/openai.codex.2026-08.json` and benchmarks. Supported `claude-opus-5-5` (1M context window, $4/$20 MTok, low..max effort levels) in `costmodels/anthropic.subscription.2026-08.json` and benchmarks. Added `high` capability class defaults in `modelclass.ts`, power ordering in `statistics.ts`, and display names in `modelname.ts`.
  (2) Replaced the dual-spinner loading indicator in `Tasks.tsx` with a single spinner mark, removing the delayed secondary spinner. `docs/adapters.md`, `docs/ui.md`.
- **The Tasks board blipped blank every 10-20s (t624 ← t612, 2026-09-22).** t612's loading state
  (spinner + *Loading tasks…* until `task.page` first answers) reset on *every* `refresh`, not only
  the first. A `loadedOnce` ref in `Tasks.tsx` gates the reset to the page's first-ever fetch; later
  refreshes swap data in without a loading flash. `docs/ui.md`.
- **Worker routable model picker overhauled to inline table (t638, 2026-09-23).**
  Replaced separate popovers and standalone default/grading model dropdowns in Settings > Workers with an inline `ModelTable` component displaying every available model with columns: `Model`, `Effort`, `Default`, `Auto-Routable`, `Class`, `Grading`, and `Judgment`, plus `+ Add model/effort` for multiple effort levels of the same model. Replaced "CLI default" with concrete effort levels whenever the model supports reasoning effort. Stored unified per-worker routes in `workers.model_routes_json` (migration 81) folding legacy routable/class/effort maps. `docs/routing.md`, `data-model.md`, `ui.md`.
- **Codex CLI per-session MCP support and Debate fallback for non-MCP agents (t618, 2026-09-22).**
  (1) Measured and enabled per-invocation MCP for Codex CLI (`openai-compatible` adapter) using
  `-c mcp_servers.<name>...` and auto-approval mode `-c mcp_servers.<name>.default_tools_approval_mode="approve"`
  without modifying global user config; `capabilities.mcp` is now `true`.
  (2) Supported Debate mode for non-MCP agents via a structured terminal contract fallback
  (`DEBATE ROUND CONTINUE:` and `DEBATE ROUND CONVERGED:`), removing the `needs: ['mcp']` constraint
  and allowing any agent to serve as organizer or seat. Turn-end handles round continuation and parses
  verdict agreements, pausing for operator confirmation on debate choices.
  (3) UI clearly surfaces organizer and seat MCP capabilities (`native MCP` vs `terminal fallback`) in
  task creation and debate notices. L1 tests updated across adapters, debate, prompt, questions,
  and debatenotice. `docs/adapters.md`.
- **No MCP Questions API on Muse (t676, 2026-09-23).** t665 ran on Codex, not Muse — but the answer
  stands: `mcp: false`, so no `ask_human`. Measured on 1.3.0 that `settings.json` stdio+env entries
  ARE honoured, yet the file is per-account against per-session identity (concurrent pool sessions
  would share one), and `exec` has no per-run MCP flag — the t618 codex escape has no muse
  equivalent. Muse asks via `NEEDS DECISION:` text, parsed back by `turnend`. `docs/adapters.md`.
- **An Antigravity account whose token died mid-run went back into the fleet unmarked (t610/t611,
  2026-09-22).** t601 (a debate seat) was a false lead — the real report was t610, `/videoaudit
  region 4`, which failed 55 minutes and 28k output tokens in with `UNAUTHENTICATED (code 401):
  Request had invalid authentication credentials. Expected OAuth 2 access token…`. Not a warmstart
  bug: a genuine expired/revoked Google OAuth credential — **yes, sign back in to the Antigravity
  worker.** Two real gaps closed alongside the diagnosis: `antigravity-cli` had no `needsReauth`
  classifier at all (`claude-code` and `muse-code` both do), so this adapter could never mark an
  account as needing re-sign-in; and `endUnfinishedRun`'s "who failed" rule (a run that produced
  turns is charged to the work, not the account) wrongly applied to an unambiguous auth refusal —
  the same dead credential will fail the *next* turn too, whether or not this one produced 28k
  tokens first. `scheduler.ts` now benches the worker on a `needsReauth` match regardless of turns
  produced; `antigravity-cli.ts` classifies the measured phrase. 3 L1 in `agy-usage.test.ts` +
  `runfailure.test.ts`. `docs/adapters.md`.
- **Preemption reassign layout fixed and turn refusal honored (t604, 2026-09-22).** (1) `t592` compaction
  investigation: compaction shrank context 80% (528k → 107k tokens), but 5h rolling quota was already at 88%
  and `claude-opus-5` with `effort: xhigh` consumed the remaining 12% in seconds, triggering Anthropic's session
  limit. (2) `Decide.tsx` & `app.css`: itemized wrap-up choices (`Compact & pause`, `Hand off & pause`, `Hand off & reassign`),
  attached a labeled destination dropdown (`Destination:`) specifically to `Hand off & reassign`, defaulted to
  Auto (or non-current worker), and excluded the preempting worker. (3) `scheduler.ts`: when a turn fails with
  vendor quota refusal during warning or wrap-up, `reassigningNow` immediately applies the reassignment rather
  than stranding the task parked on the exhausted account until `parkAt`. Unit tests in `preemption.test.ts`. `docs/ui.md`.
- **Fleet cards double-counted and phantom-held slots (t597, 2026-09-21).** ClaudeSecond read
  `1 / 1` empty; CodexFirst read `2 / 1` beside one task. An unlinked live session now covers one
  sessionless running task (`unclaimedLiveWorkSessions`); a parked task reassigned elsewhere frees
  its old worker. 15 L1 in `slotcount.test.ts` + 2 in `fleetcard.test.ts`. `docs/routing.md` §2.2.
- **Codex upgraded to 0.155.1 with GPT-6 Astra access on ChatGPT Plus (t594, 2026-09-20).** Upgraded
  `@openai/codex` to 0.155.1 (0.151.0 refused `gpt-6-astra` on a vendor version error); verified live
  that `gpt-6-astra` executes and completes tasks on a ChatGPT Plus subscription with reasoning effort
  low through ultra. Added `gpt-6-astra` to `costmodels/openai.codex.2026-08.json` (1.05M context
  window, priority 1 in `models_cache.json`), `benchmarks/coding-agents.2026-09.json` (0.885 agentic),
  and `statistics.ts` model power sorting. `docs/adapters.md` updated.
- **A conversation's landing conflicted for ever, because two halves of the tool disagreed about which `main` (t586 ← t578, 2026-09-20).** Policy readers saw `origin/<target>` (a conversation kind resolves `await-human` → `leave-branch`) while Land rebased onto the local target — measured 9 commits apart on t578, a loop with no converging state. One authority now: `landingLevelFor` (`shared/policy.ts`), read by `baseRef`, both recovery prompts, the pre-flight and `landConversationWork`; `localBaseNote` names the measured gap. 11 L1, four mutations go red. **Not flown on a real run.** `docs/landing.md`.
- **Statistics asks whether conversations count (t695, 2026-09-25).** *Include conversations*
  beside the Window control folds conversation-kind tasks out of all three tabs when off (t667 billed
  a whole evening of chat to its model); on is the old answer, remembered per display. `docs/ui.md`.

## Remaining work — ordered by payoff

Each needs a real signed-in account, a macOS machine, release credentials, or a human product
judgement. Do not replace the missing evidence with a unit test.

1. **Run a real trunk task beside worktree tasks.** File a trunk task that pulls `main` and resolves a conflict while a worktree task finishes under `commit-and-merge`; confirm the worktree task sits at `landing_queued` and lands by itself when the trunk frees, and drive the Flow trunk row, composer pill and Project Settings row in the packaged app. None of the UI is covered by `test/ui.test.mjs`.
2. **Run one more live Plan & Split, and the first live Plan & Execute.** Exercise a `merge-branch` landing while a sibling is genuinely mid-run, and an organizer resolution turn where some pieces fail. Then file the same job as a Plan & Execute with a cheaper executor: confirm the planner's card completes at the handoff, the executor lands on the project's target, and record both tasks' total run cost side by side — the one measurement t456's design rests on and does not have.
3. **Run a real debate and record its measurements.** Compare total tokens/cost against a strong single-agent answer; record cache reads, resolved/unresolved citations, and whether the organizer changed the operator's decision. The evidence format is in [`transient_docs/debate_mode_2026-09-12.md`](transient_docs/debate_mode_2026-09-12.md) §7.
4. **Run human-in-the-loop, `commit-and-merge`, cross-task reuse and an inherited directory grant with a real agent.** The code and L1–L3 checks exist; none has been demonstrated in flight. For the grant (t462/t470): attach a second repository to a **planner**, let it file one piece that must edit there, and watch a sandboxed codex **commit** in it — proven only by a throwaway-repo probe so far. Then, on `claude-code`, have an agent call `request_directory` for an unattached folder and confirm the restart resumes warm.
5. **Pair two real machines over Tailscale (t419).** Generate a desktop code on one, pair from the other, then drive a terminal, add a worker and file a task remotely. Confirm notifications from both computers, a revoke on the host cutting the client off, and the ±1 version warning.
6. **Post-launch, in the order the t392 debate ranked them:** a first-class OpenCode adapter (the generic declarative adapter cannot meter, gets no MCP tools and cannot reap orphans); CI watch after `gh pr create` ([`src/daemon/landing.ts`](src/daemon/landing.ts) ~l.1391); an update-available check that keeps `publish: null`; a full data-directory export (isolation roots, attachments); and a clone-per-worker or container backend, the only thing that closes both the host-authority gap and the shared common-`.git` grant. ⚠️ Not on this list: GitHub/Linear/Slack intake, agent messaging, kanban, voice, cross-machine sync.
7. **Give Antigravity a real per-worker isolation root.** It shares `~/.gemini` today; changing `HOME` must first be proven not to disturb the OS-keyring credential. See [`docs/adapters.md`](docs/adapters.md).
8. **Finish the metering and calibration measurements.** Meter PTY-hosted Codex from rollout data; compare small and large quality-review models on the same five tasks; verify the Claude credits gauge against one real invoice; decide whether preempted runs should contribute to estimates.
9. **Increase thread UI coverage where behaviour changes.** Most thread interactions remain hand-tested; extract pure decisions into `src/renderer/src/lib/` first.
10. **Continue the scheduler split only when touching it.** `scheduler.ts` remains about 3,780 lines against a ~1,500 target; no extracted module may read a scheduler binding at module evaluation time.
11. **Drive t423's live views in the packaged app, with a real run behind them.** Watch a dispatched Claude task narrate its tool calls into the thread peephole and the Session TUI; open **Open a real terminal** on it and confirm the fork holds the context while the run carries on; turn `liveNarration` to `streaming` and see whether the typing is worth ten times the stream lines. ⚠️ None of it is covered by `test/ui.test.mjs`, which never opens a project tab.

## Open questions and quiet-worker measurements

| Item | Evidence needed | Consequence |
|---|---|---|
| R1: Claude auto-mode classifier cost | Run the same shell-heavy task on a quiet subscription worker in `auto` and `default`; compare quota delta with transcript tokens. | If billed, `auto` cannot remain a free default. |
| R2: tokens per quota percent | Sample `/usage` around known transcript work for each worker/model/tokenizer. | Lets quota gates work in tokens rather than percentages. |
| R4: end-to-end compaction cost | Record a known-size compaction's transcript delta and duration. Six samples exist; `post_tokens` is still null. | Tunes the T+53-minute deadline. |
| Does a warm-up turn end a `Currently unavailable` streak? | t689: press **Warm up** on a Muse worker inside a silent window — the prompt now goes after an Escape that dismisses the drawn panel — and record whether the next panel publishes. | The feature rests on an inference; if it is wrong the button costs a turn and buys nothing. |
| R8: controller reply shape | Designate a controller, file a `plan`, drain once, then record whether the validator accepted an answer or used its fallback. | Proves the one M4 path L1 cannot reach. |
| Vertex/Antigravity cache price | Find a published vendor price; do not infer it experimentally. | Keeps `cache.kind: "unpriced"` honest. |
| Expected-idle estimator | Gather real queue data first. | No honest design exists without it. |
Record results, CLI versions and dates in [`docs/cost-model.md`](docs/cost-model.md), then remove the row.

## Durable constraints

- A worker is an account; a session is a live process. Quota belongs to the worker, context to the session. [`docs/glossary.md`](docs/glossary.md) is authoritative.
- The scheduler spends zero tokens; model judgment is asynchronous and has a deterministic fallback.
- Agents use pooled worktrees, never the trunk — unless the task's workspace mode is `trunk`, which
  holds the single trunk lease. Nothing kills a process by image name or bare PID.
- The renderer treats agent output as untrusted text; no raw HTML. Do not trust an agent-session view of `%APPDATA%`: packaged hosts can redirect it. See [`docs/development.md`](docs/development.md) §4.
