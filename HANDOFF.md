# Warmstart — Session Handoff

## Current state — 2026-09-15

Warmstart M0–M6 is implemented, including debate mode, quota-aware scheduling, pooled worktrees,
model-aware routing, quality review, remote access, packaging, and atomic worker/model reassignment.
The maintained reference in [`docs/`](docs/README.md) is the
authority on each subsystem; dated design and incident history belongs in `transient_docs/`, not here.

Baseline (2026-09-15, **Windows 11**, after t452): typecheck, lint and build pass; L1 **3,498 passed,
5 skipped** (202 files + 2 platform skips); L2 **203 checks** (5
skipped); L3 **436 passed, 4 skipped** at the pinned 1024×720 window; L4 **19 checks** against
`release/win-unpacked`. The same day on **macOS 13 arm64**: L1 3,475 / L3 434 (6 skipped) / L4 17
against a signed, hardened-runtime bundle. Last CI green on all seven jobs: `c909c4c`, run 34883661692, with t445.2's fix for
`3489bc0`'s red `ui · windows-latest` (run 34872370257). CI is **enabled**, and so is the
**Release** workflow: it has been dispatched twice with `platforms=macos` (item 6 below), so a `v*`
tag now builds both platforms.

## Closed in this cleanup

- **Active child processes defer idle turn parking, completion detects resting sessions, and Decide offers Land (t452, 2026-09-15).**
  Claude Code waiting on background tests (`test:all` in t451) ended its turn without `task_complete`; the watchdog previously
  checked elapsed time alone (>3m) and parked the task at `awaiting_human` while tests were still burning CPU under `session.pid`.
  `runWatchdogs` now reads the tree via `sampleProcessTree` and defers parking when child processes or CPU progress are active.
  For tasks resting at `awaiting_human`: `resumeIdleConversation` now resumes work tasks unprompted when words or tool calls arrive;
  `completeTask` resumes resting sessions to allow `landCompletion`; `Decide` reads `pendingWork` across all tasks and renders
  `Land ▼` whenever unlanded commits sit on the branch; and the composer's Worktree | Trunk `SegmentedControl` highlights selected
  options in `--color-accent` consistently regardless of project default.

- **Statistics' trade-off scatters read "higher is better" on every axis, and hovering no longer
  pushes the chart down (2026-09-14).** `axisPosition` inverts cost's and active time's plotted
  position (`max - value`, ticks/tooltip unchanged) so a mark further from the origin is always
  better; the hover legend moved from `.scatter-plot-head` into a reserved-height
  `.scatter-plot-legend` strip below the chart instead of growing the head on hover.
- **Reassigning a failed landing lost the message that said why it failed (t448, 2026-09-14).**
  `promptFor`'s thread filter kept only `human`/`controller` messages and the first `agent` one, so
  a `landing.failed`/`finish.held` `system` entry — written by the daemon *after* the agent's turn
  ended — never reached a reassigned run; `resolveRetryOnTask` covers four named causes with its
  own corrective message, but anything else (no commits produced, work in a stash, a refused
  `canLand`…) fell through to a plain reassign with nothing carried over. Undelivered outcome
  messages now travel on the next prompt, cold or resumed. ⭐ `worktreeArrivalNotice` (the worktree
  twin of `trunkArrivalNotice`) names both directories and the branch that connects them on every
  cold dispatch — t446's agent worked that out by trial. `dispatchDetail` now carries
  `compactOnResume`'s own reason on the *Conversation: resumed* line, so a lapsed-cache resume
  (t447) states its basis rather than leaving it to be re-derived — declining to compact a lapsed
  prefix is deliberate (`cacheclock.ts`, measured t130/t231). The composer's workspace control
  collapsed from three segments to two (`Worktree`, `Trunk`), the project's default one selected
  and muted rather than shown as its own option.
- **A clean profile now explains its first three actions and reports missing host tools (t449,
  2026-09-14).** A once-per-display welcome tour opens Add Project, Workers, and New Task directly;
  Dashboard and Global → Status report Git (required), `gh` (pull-request delivery), and Tailscale
  (remote access) from the daemon's actual PATH resolution. The README states the same dependency
  boundaries. [`docs/external-task-debugging.md`](docs/external-task-debugging.md) gives an outside
  agent read-only SQLite queries to resolve `t<number>` through its task, messages, runs, sessions,
  workspace, branch, and logs without treating a live database as an API.
- **t446 and t447 could not land: a leaked `GIT_DIR` had re-initialised the trunk (2026-09-14).**
  Both stopped on *the trunk could not be read … Invalid path '/mnt'*: the trunk's `.git/config`
  carried `core.worktree = /mnt/c/…/ws3`, written by every `git init` an `npm test` ran inside the
  WSL-bridged muse run, because `GIT_DIR`/`GIT_WORK_TREE` reached the agent's whole environment.
  ⭐ A relative pointer needs neither (measured against WSL git 2.53), so `gitEnvFor` exports nothing
  for one; `repairTrunkConfig` takes a foreign `core.worktree` back out before every base lookup,
  prepare, park and landing; on Windows `worktree repair --relative-paths` fixes the back-pointer
  WSL called *prunable*. ⚠️ Found beside it: `spawnEnv()` handed Windows children an **empty PATH**
  when the block spelled it `Path` — a real regression from the macOS PATH work, masked in the
  installed app by main's re-spelling. `pathKey`/`withAugmentedPath` fix it; all four pinned with
  real git in `worktrees.test.ts`, `landing.test.ts`, `muse-code.test.ts`, `which.test.ts`.
  t446 landed in that commit; t447 rebased onto the repaired trunk and lands in this one.
- **t445's "failed" compaction was a dead ask beside a landed one nobody could see (t446, 2026-09-14).**
  Preemption's 17:14 `/compact` reached a mid-turn stream session as prose; the agent wrapped up
  instead of compacting and the run ended on its own, so `park()` returned early with no verdict.
  The clock's 17:18 retry landed at 17:21 but recorded `task_id` null and never appeared on the
  thread. Now: clock asks name the session's latest run (migration 72 backfills eleven orphans);
  the wrap-up posts *did not land* while its ask is still outstanding; a dead ask a landed sibling
  supersedes reads *superseded*. Beside it: a `SegmentedControl` workspace group, 920px settings.
- **The Routing Model page reads as a summary, not a paper's abstract, and its section headers no
  longer look like body text (t447, 2026-09-14).** The "Abstract" heading is now "Summary" — this is
  a product page, not a paper — and every `.doc-section h3` / summary `h4` is set in
  `--color-accent` instead of the paper ink, so a column of otherwise-uniform serif prose shows its
  own structure at a glance. ⭐ **Statistics' three-way trade-off is now three flat 2D scatters**
  (`TradeoffPlots`, replacing `ThreeAxisPlot`) — (quality, velocity), (quality, cost) and
  (velocity, cost) — reported confusing to read and hard to interact with as a rotatable 3D plot.
  `lib/plot3d.ts` is deleted; each scatter is a plain x/y projection with the same `AgentIcon` marks,
  the same `MIN_TRUSTED_SAMPLES` (5) floor and the same per-display "Exclude API rate & mixed" filter
  the old plot had.
- **The local macOS deploy launcher works through its scripts-directory symlink (t14, 2026-09-14).**
  `BASH_SOURCE` names the symlink, so repository discovery accepts both entry points; stopping never
  force-kills, and landing checks use `spawnEnv()` / `augmentPath()` so Finder-launched daemons find
  Homebrew tools like `npm`. **A minimal GUI launch PATH hit `xcrun`'s broken git shim (t12/t13):**
  `which.ts`/`spawnEnv()` prepend extraDirs and skip broken xcrun shims; `git.ts` routes through `which('git')`; `trunkOccupiedBy` resolves session holders via `taskOfSession` and sweeps stale claims.
- **`ui · windows-latest` went red on two checks the local suite could not see (t445.2, 2026-09-14).**
  ⭐ `test:ui` now pins its window to CI's 1024×720 via `ui/window-state.json`, and reproduced the
  reorder-arrow failure locally on the first run. The arrows were fine: at that height the row sat
  below `.content`'s fold and `elementFromPoint` hit-tested an off-screen point, so the check scrolls
  first; mutating the cell's `z-index` away still turns it red. ⛔ The second was a product bug:
  `task.message` on a `ready` task emitted nothing, so no other view saw the note. Locally the task
  was `running` (a CLI on `PATH`) and run events hid it. Now emits `task.changed`, pinned by
  `taskmessage.test.ts`. [`docs/testing.md`](docs/testing.md) §3 and the headless section.
- **macOS signing is configured, and the build says which of three things it did (t445,
  2026-09-14).** `identity: null` had silently disabled signing, notarisation and the hardened
  runtime in one line; `scripts/build-mac.sh` and the release workflow now read the bundle back with
  `codesign`. ✅ The owner's Mac built it **signed with the hardened runtime** (electron-builder
  26.16.1); not notarised, nothing yet run under it. [`docs/development.md`](docs/development.md) §3.
- **Muse could not grade anything, and the app would not say why (t436, 2026-09-14).** Muse Code 1.1.1 exits 1 against this repo's `.codex` symlink, which was a seven-byte **file** on a `core.symlinks=false` checkout rather than a directory; `.codex` is now local-only (`scripts/link-agent-skills.mjs`, gitignored, junction on Windows). ⛔ The second half generalises: a `stream` session's non-protocol stderr was dropped by `StreamParser`, so both the reviewer and `onSessionExit` reported an unexplained death; `sessionDiagnostics` keeps a bounded tail and both now quote it.
- **Three settings faults the operator hit driving a remote machine (t431, 2026-09-14).** The
  workers table's reorder arrows could not be clicked (order cell and worker cell shared one grid
  area; now `position: relative; z-index: 1`, caught only by `elementFromPoint` since `.click()`
  bypasses hit-testing — [`docs/testing.md`](docs/testing.md) §3); a sign-in run while driving
  another computer opened the vendor's OAuth browser on *that* screen (`SignInLocationWarning` now
  names the machine); a host taking work could sleep mid-run (`preventSleep`, default on, holds a
  `powerSaveBlocker`). None of the three driven in the packaged app.
- **t408–t436, landed and documented in docs/ (2026-09-13–14)** — probe PTY answers, live quota probe, remote settings fixes, CI table checks, Diff pane, split Session TUI.

## Remaining work — ordered by payoff

These are deliberately not marked complete: each needs either a real signed-in account, a macOS
machine, release credentials, or a human product judgement. Do not replace the missing evidence with
a unit test.

1. **Run a real trunk task beside worktree tasks.** File a trunk task that pulls `main` and resolves a
   conflict while a worktree task finishes under `commit-and-merge`; confirm the worktree task sits at
   `landing_queued` and lands by itself when the trunk frees, and drive the Flow trunk row, composer
   pill and Project Settings row in the packaged app. None of the UI is covered by `test/ui.test.mjs`.
2. **Run one more live Plan & Split.** Exercise a `merge-branch` landing while a sibling is genuinely
   mid-run, and an organizer resolution turn where some pieces fail. This is the highest-value
   scheduler integration check.
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
