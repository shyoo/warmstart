# Warmstart — Session Handoff

## Current state — 2026-09-15

Warmstart M0–M6 is implemented, including debate mode, quota-aware scheduling, pooled worktrees,
model-aware routing, quality review, remote access, packaging, and atomic worker/model reassignment.
The maintained reference in [`docs/`](docs/README.md) is the
authority on each subsystem; dated design and incident history belongs in `transient_docs/`, not here.

Baseline (2026-09-15, **Windows 11**, after t456): typecheck, lint and build pass; L1 **3,530 passed,
5 skipped** (205 files + 2 platform skips); L2 **203 checks** (5
skipped, after t451); L3 **446 passed, 4 skipped** at the pinned 1024×720 window; L4 **19 checks** against
`release/win-unpacked` (after t451). The same day on **macOS 13 arm64**: L1 3,475 / L3 434 (6 skipped) / L4 17
against a signed, hardened-runtime bundle. Last CI green on all seven jobs: `c909c4c`, run 34883661692, with t445.2's fix for
`3489bc0`'s red `ui · windows-latest` (run 34872370257). CI is **enabled**, and so is the
**Release** workflow: it has been dispatched twice with `platforms=macos` (item 6 below), so a `v*`
tag now builds both platforms.

## Closed in this cleanup

- **Plan & Execute: the same `plan` kind with the fan-out capped at one and no review turn (t456,
  2026-09-15).** Plan & Split pays a third planner turn to integrate pieces built by agents that could
  not see each other; with one piece there are no seams, so that turn is a second full read of work
  already done to the planner's own instruction. The shape is derived, never stored: `planModeOf`
  (`src/shared/tasks.ts`) reads `min(mandate.maxChildren, childDefaults.maxChildren) <= 1`, and
  everything follows from it — `validateSplit` wants exactly one piece, `applySplit` writes no
  `settled` edge and leaves the planner's status alone, `agent.split` completes the planner through
  `completeTask` (⛔ not by asking the agent to call `task_complete`, t226), and the executor is cut
  from the planner's branch but lands onto the **project's** target (`integratesChildren`, so
  `strategyFor` picks from data). The composer's fifth kind pill draws a small inline SVG of each plan
  shape (`PlanShape`) and, in execute mode, two advisory notices (`executornotice.ts`) — decision D2
  was *inherit the executor model as today, plus a notice that states the trade*; neither is a gate.
  Design, the published measurements and the two operator decisions:
  [`transient_docs/plan_and_execute_2026-09-15.md`](transient_docs/plan_and_execute_2026-09-15.md).
  ⚠️ **Not run against a real agent**, and the cost claim — that removing the third turn is the
  measurable win — is unmeasured on this fleet (item 2 below). Pinned: L1 in `split.test.ts`,
  `prompt.test.ts`, `tasks.test.ts` (shared), `executornotice.test.ts`, `composerprefs.test.ts`,
  `taskview.test.ts`; L3 in `test/ui.test.mjs` (fifth option, both diagrams, the absent fan-out and
  planner-finish pills, the two notices) — that suite reaches the composer from the title bar, so the
  composer never needed a project tab. Diagrams checked by eye in the built app on 2026-09-15.

- **The new user tour modal now includes SVG mockups and prev/next onboarding navigation (t455, 2026-09-15).**
  The first-launch welcome tour previously displayed only text with an action button that closed the modal to jump away mid-tour. It now displays vector SVG mockups of the Add Project inspection, Workers & Quota fleet, and Task Composer for each onboarding step, and provides Back / Next / Get Started controls alongside keyboard navigation (Left/Right/Esc) and clickable progress steps without navigating away early.

- **Changes in this task no longer springs open on its own (t451, 2026-09-15).** The panel used to
  set `open` whenever the task sat at `awaiting_human` with files to show, which read as a surprise
  rather than a nudge; `<details className="diff-panel">` now carries no `open` prop at all, so the
  open/closed state is only ever the person's own and survives the task settling under them.
  `atGate` still decides one thing — whether an unreadable change says so — and nothing else.
  Pinned in `test/ui.test.mjs` (L3, the renderer's tier): collapsed at the gate with a file listed,
  and still open after a resolve if that is how it was left. ⚠️ Beside it, that suite now dismisses
  t449's welcome tour up front — on a clean profile it is a modal shade over everything the suite
  then clicks, which surfaced as unexplained `elementFromPoint` misses rather than as itself.

- **The phone could see a question was waiting and had nowhere to answer it (t454, 2026-09-15).**
  An `ask_human` question rests its task at `awaiting_human`, so Attention drew the *same* wait twice
  — once as the question, once as a task row whose only offer was **Resolve**, which marks it done
  and throws the question away — and the task page repeated that single Resolve. The resting row is
  now suppressed where an open question already covers the task, every Attention card carries an
  **Answer…** door, and `screens/TaskDetail` draws each open question in full
  (`components/QuestionCard`: the asker's own `detail` per option, a single/multiple toggle, an
  **Other** row, a text box on every kind) beside a **What now** card (`components/Decide`):
  Override & continue, Send back to an agent, Retry landing, Resume, Mark done, Stop and an atomic
  worker/model/effort **Reassign**, drawn from what the task permits and showing the daemon's
  refusal rather than a success. ⚠️ No new RPC — every call was already on the remote allowlist;
  `lib/question.ts` holds the rules `question.test.ts` pins.

- **The Quality Review page's slow load was an N+1 query, not a missing index (t453, 2026-09-15).**
  `reviewQueue` called `getTask` once per finished task (up to 1,000, every 3s poll); `getTask` runs
  `TASK_SELECT`'s five correlated subqueries plus its own single-row `timingForTasks` call, so the
  batching that function exists for never engaged. `getTasksByIds` (`tasks.ts`) fetches the whole page
  in a bounded number of queries; `reviewQueue`/`batchCandidates` now use it. ⭐ Migration 73 also adds
  the index the report asked about — `tasks_status` covered `status` but not `order by updated_at
  desc`, so those reads sorted with a temp b-tree — a real but smaller win, confirmed with `explain
  query plan` at 8,000 synthetic rows, not the real fleet.

- **Active child processes defer idle turn parking, completion detects resting sessions, and Decide offers Land (t452, 2026-09-15).**
  Claude Code waiting on background tests (`test:all` in t451) ended its turn without `task_complete`; the watchdog previously
  checked elapsed time alone (>3m) and parked the task at `awaiting_human` while tests were still burning CPU under `session.pid`.
  `runWatchdogs` now reads the tree via `sampleProcessTree` and defers parking when child processes or CPU progress are active.
  For tasks resting at `awaiting_human`: `resumeIdleConversation` now resumes work tasks unprompted when words or tool calls arrive;
  `completeTask` resumes resting sessions to allow `landCompletion`; `Decide` reads `pendingWork` across all tasks and renders
  `Land ▼` whenever unlanded commits sit on the branch; and the composer's Worktree | Trunk `SegmentedControl` highlights selected
  options in `--color-accent` consistently regardless of project default.

- **t408–t449, landed and documented in docs/ (2026-09-13–14).** Statistics' scatters read higher-is-better
  on every axis (`axisPosition`); a reassigned failed landing now carries the `landing.failed`/`finish.held`
  message that said why (t448, `worktreeArrivalNotice`, `dispatchDetail`); a clean profile gets a welcome tour
  and reports Git/`gh`/Tailscale from the daemon's PATH (t449, [`docs/external-task-debugging.md`](docs/external-task-debugging.md));
  a leaked `GIT_DIR` re-initialising the trunk is repaired before every base lookup (`repairTrunkConfig`) and
  `spawnEnv()` no longer hands Windows children an empty PATH (`pathKey`); a compaction ask names the
  session's latest run and a dead ask a landed sibling supersedes reads *superseded* (t446, migration 72);
  plus t445–t447 (`TradeoffPlots`, macOS `xcrun` shim, `test:ui` window pin, signed hardened-runtime build)
  and t408–t436 (probe PTY answers, live quota probe, remote settings, Muse `.codex` symlink, CI table
  checks, Diff pane, split Session TUI). Detail is in the docs/ pages each one owed.

## Remaining work — ordered by payoff

These are deliberately not marked complete: each needs either a real signed-in account, a macOS
machine, release credentials, or a human product judgement. Do not replace the missing evidence with
a unit test.

1. **Run a real trunk task beside worktree tasks.** File a trunk task that pulls `main` and resolves a
   conflict while a worktree task finishes under `commit-and-merge`; confirm the worktree task sits at
   `landing_queued` and lands by itself when the trunk frees, and drive the Flow trunk row, composer
   pill and Project Settings row in the packaged app. None of the UI is covered by `test/ui.test.mjs`.
2. **Run one more live Plan & Split, and the first live Plan & Execute.** Exercise a `merge-branch`
   landing while a sibling is genuinely mid-run, and an organizer resolution turn where some pieces
   fail. Then file the same job as a Plan & Execute with a cheaper executor: confirm the planner's
   card completes at the handoff, the executor lands on the project's target, and record both
   tasks' total run cost side by side — the one measurement t456's design rests on and does not have.
3. **Run a real debate and record its measurements.** Compare total tokens/cost against a strong
   single-agent answer; record cache reads, resolved/unresolved citations, and whether the organizer
   changed the operator's decision. The evidence format is in
   [`transient_docs/debate_mode_2026-09-12.md`](transient_docs/debate_mode_2026-09-12.md) §7.
4. **Run human-in-the-loop, `commit-and-merge`, and cross-task reuse with a real agent.** The code
   and L1–L3 checks exist, but this has not been demonstrated in flight.
5. **Run the *signed* app on macOS with a real CLI; this is the launch gate.** The owner confirmed
   an unsigned build compiles, runs and pairs in remote mode, and `./scripts/build-mac.sh` now
   reports a build signed with the hardened runtime, and `npm run test:pack` passes on the Mac (all
   2026-09-14). Remaining: launch *that* bundle, open a PTY, and drive one real task. Still unverified either way: detached daemon startup without system Node
   under the hardened runtime, Application Support isolation, Antigravity's Keychain, Gatekeeper.
6. **Execute the release pipeline for macOS.** The five Apple secrets are set (2026-09-14) and
   `platforms=macos` has run twice: 34909163579 (a wrong `.p12` password) and 34910069869, which
   imported the certificate and then died in electron-builder 26.15.3's own keychain unlock — the
   bump to 26.16.1 is the fix ([`docs/development.md`](docs/development.md) §3). ⏭ Re-dispatch;
   notarisation is the first step nothing has reached yet. Windows stays unsigned. Release notes
   must tell upgraders to uninstall the old app, because the `appId` changed.
7. **Pair two real machines over Tailscale (t419).** Generate a desktop code on one, pair from the
   other, then drive a terminal, add a worker and file a task remotely. Confirm notifications from
   both computers, a revoke on the host cutting the client off, and the ±1 version warning.
8. **Record one clean single-account first run.** Install the packaged app on a clean profile, add
   one account, add one project, file a task, review its diff, land it, and write down what
   happened. ⛔ A demonstration, not a feature, and the purest form of the pre-public question —
   items 1–3 mean the basic loop has never been shown end to end against a real agent. Now
   unblocked: there is finally something to look at at the gate.
9. **Post-launch, in the order the t392 debate ranked them:** a first-class OpenCode adapter (the
   generic declarative adapter cannot meter, gets no MCP tools and cannot reap orphans); CI watch
   after `gh pr create` ([`src/daemon/landing.ts`](src/daemon/landing.ts) ~l.1391); an
   update-available check that keeps `publish: null`; a full data-directory export (isolation roots,
   attachments); and a clone-per-worker or container backend, the only thing that closes both the
   host-authority gap and the shared common-`.git` grant. ⚠️ Deliberately **not** on this list:
   GitHub/Linear/Slack intake, agent-to-agent messaging, kanban, voice, cross-machine sync.
10. **Give Antigravity a real per-worker isolation root.** It shares `~/.gemini` today; changing `HOME`
   must first be proven not to disturb the OS-keyring credential. See [`docs/adapters.md`](docs/adapters.md).
11. **Finish the metering and calibration measurements.** Meter PTY-hosted Codex from rollout data;
   compare small and large quality-review models on the same five tasks; verify the Claude credits
   gauge against one real invoice; and decide whether preempted runs should contribute to estimates.
12. **Increase thread UI coverage where behaviour changes.** Most thread interactions remain
   hand-tested. Extract pure decisions into `src/renderer/src/lib/` first.
13. **Continue the scheduler split only when touching it.** `scheduler.ts` remains about 3,780 lines
   against a ~1,500 target; no extracted module may read a scheduler binding at module evaluation time.
14. **Drive t423's live views in the packaged app, with a real run behind them.** Watch a dispatched
   Claude task narrate its tool calls into the thread peephole and the Session TUI; open **Open a real
   terminal** on it and confirm the fork holds the context while the run carries on; turn
   `liveNarration` to `streaming` and see whether the typing is worth ten times the stream lines.
   ⚠️ None of it is covered by `test/ui.test.mjs`, which never opens a project tab.

## Open questions and quiet-worker measurements

| Item | Evidence needed | Consequence |
|---|---|---|
| R1: Claude auto-mode classifier cost | Run the same shell-heavy task on a quiet subscription worker in `auto` and `default`; compare quota delta with transcript tokens. | If billed, `auto` cannot remain a free default. |
| R2: tokens per quota percent | Sample `/usage` around known transcript work for each worker/model/tokenizer. | Lets quota gates work in tokens rather than percentages. |
| R4: end-to-end compaction cost | Record a known-size compaction's transcript delta and duration. Six samples exist; `post_tokens` is still null. | Tunes the T+53-minute deadline. |
| R8: controller reply shape | Designate a controller, file a `plan`, drain once, then record whether the validator accepted an answer or used its fallback. | Proves the one M4 path L1 cannot reach. |
| Vertex/Antigravity cache price | Find a published vendor price; do not infer it experimentally. | Keeps `cache.kind: "unpriced"` honest. |
| Expected-idle estimator | Gather real queue data first. | No honest design exists without it. |

Record results, CLI versions and dates in [`docs/cost-model.md`](docs/cost-model.md), then remove the
row. R5 is dropped: cross-account transplant needs a second subscription.

## Durable constraints

- A worker is an account; a session is a live process. Quota belongs to the worker, context to the
  session. [`docs/glossary.md`](docs/glossary.md) is authoritative.
- The scheduler spends zero tokens; model judgment is asynchronous and has a deterministic fallback.
- Agents use pooled worktrees, never the trunk — unless the task's workspace mode is `trunk`, which
  holds the single trunk lease. Nothing kills a process by image name or bare PID.
- The renderer treats agent output as untrusted text; no raw HTML. Do not trust an agent-session view of `%APPDATA%`: packaged hosts can redirect it. See [`docs/development.md`](docs/development.md) §4.
