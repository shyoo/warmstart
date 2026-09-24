# Warmstart — Session Handoff

## Current state — 2026-09-22

Warmstart M0–M6 is implemented, including debate mode, quota-aware scheduling, pooled worktrees,
model-aware routing, quality review, remote access, packaging, and atomic worker/model reassignment.
The maintained reference in [`docs/`](docs/README.md) is the authority on each subsystem; dated
design and incident history belongs in `transient_docs/`, not here.

Baseline (2026-09-23, **Windows 11**): typecheck, lint and build pass; L1 **3,918 passed, 3 skipped** (230 files) in **108s**;
L2 **204 checks** (7 skipped — the two POSIX-only cursor-position checks skip here); L3 **486
checks** (4 skipped); L4 **19 checks** against `release/win-unpacked`. ⚠️ The `%TEMP%` figure is
t579's, not re-measured here. macOS 13 arm64, 2026-09-14: L3 434 (6 skipped), L4 17 on a signed,
hardened-runtime bundle. CI is **enabled**, and so is the **Release** workflow.

**`v0.3.2` is `latest`** (2026-09-22), promoted onto `v0.3.2-rc.1`'s commit `6ddf8093`. The next
`/release rc` opens the patch series at `0.3.3-rc.1` unless `--bump minor|major` is asked for.
⛔ All four tiers are run before a push, not after: rc.2 of the 0.2.0 series went red on CI because
six commits were pushed together without `test:ui`.
Phase 3/4 (write-up, landing page, channels) remains off-repo.

**Routing Model v1.2 preserves expiry urgency (t552, 2026-09-19).** `prepaid` is field-normalized
remaining prepaid dollars per hour to reset (`prepaid.ts`): the same $3.68 allowance scores 1/24 at a
24h reset and 1 at 1h — exactly 24×. `docs/routing.md` §3.3a.

## Closed in this cleanup

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
- **Tasks wait visibly for their first page (t612, 2026-09-22).** `Tasks` no longer renders its
  actionable **No tasks yet** state from its initial empty array while `task.page` is in flight;
  it draws two spinning marks and *Loading tasks…* until the first completed answer. `docs/ui.md`.
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
- **The ladder word is gone; a finish step is a level (t587, 2026-09-20).** `finishlevel.ts`,
  `COMMIT/LAND_LEVELS`, `landingLevelFor` et al.; `agent.land`/`land_work` take `finishPolicy`.
- **A conversation's landing conflicted for ever, because two halves of the tool disagreed about
  which `main` (t586 ← t578, 2026-09-20).** An open conversation resolves its finish policy to
  `await-human` *from its kind* — that is what stops it landing by itself — but **no landing ever
  runs that level**: `landConversationWork` hands `decideFinish` the project's own. `await-human` maps
  to `leave-branch`, whose base is `origin/<target>`, so every reader that asked `resolveFinishPolicy`
  got the remote while the Land press rebased onto the local target. ⭐ Measured off the daemon log
  and store for t578 (inkland): the project finishes `commit-and-merge`, local `main` stood **9
  commits ahead of `origin/main`**, Land ran `git rebase main` and conflicted at 20:01:54, the
  *Resolve & retry* instruction said *"does not rebase cleanly onto `origin/main`"*, the agent rebased
  there and reported it clean at 20:10:52, and the next press failed at 20:11:12 on the identical
  commit — **a loop with no converging state**. `baseRef` had the same reading, so the branch had also
  been *cut* nine commits behind where it had to land. One authority now: `landingLevelFor`
  (`shared/policy.ts`), read by `baseRef`, `resolveConflictOnTask`, `resolveTrunkMovedOnTask`, the
  pre-flight `readMergeability` and `landConversationWork`'s own `levelFor`. `localBaseNote` adds the
  measured gap to both recovery prompts — *"⛔ … and **not** onto `origin/main`: … 9 commits ahead"* —
  because naming the right ref never stopped an agent reaching for the habitual one. 11 L1
  checks across four files; four separate mutations go red. **Not flown on a real run.** `docs/landing.md`.
- **Reassign's effort picker could only ever appear for one exact, named model (t619,
  2026-09-22).** `offeredEfforts` looked `effortLevels` up by the literal selection value, and
  neither Auto Model (`'__auto__'`) nor the blank account-default choice is a real model id — so
  the effort control vanished in both of the two states an operator actually leaves the model in,
  and only reappeared once they had also picked one specific model by name. `effortLookupModel`
  (`renderer/lib/taskview.tsx`) now resolves effort against the model that would actually run —
  the inherited default — in both of those states; the blank effort option itself is relabelled
  `Auto effort (…)` to read the same way Auto Model does. Fixed in both reassign rows
  (`QuotaDecide`, `Decide`) and mirrored on the phone card. 5 new L1 checks in `taskview.test.ts`.

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
| Does a warm-up turn end a `Currently unavailable` streak? | Press **Warm up** on a Muse worker inside a silent window and record whether the next panel publishes. | The feature rests on an inference; if it is wrong the button costs a turn and buys nothing. |
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
