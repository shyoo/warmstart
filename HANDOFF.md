# Warmstart — Session Handoff

## Current state — 2026-09-16

Warmstart M0–M6 is implemented, including debate mode, quota-aware scheduling, pooled worktrees,
model-aware routing, quality review, remote access, packaging, and atomic worker/model reassignment.
The maintained reference in [`docs/`](docs/README.md) is the authority on each subsystem; dated
design and incident history belongs in `transient_docs/`, not here.

Baseline (2026-09-18, **Windows 11**, measured over `0.1.1+32.g183b45c.dirty`): typecheck, lint and
build pass; L1 **3,723 passed, 5 skipped** (221 files); L2 **203 checks** (5 skipped); L3 **474
passed, 4 skipped**; L4 **19 checks** against `release/win-unpacked`. macOS 13 arm64, 2026-09-14: L3
434 (6 skipped), L4 17 on a signed, hardened-runtime bundle. CI is **enabled**, and so is the
**Release** workflow.

**`v0.1.1` is `latest`** (tag build 35165991396, 2026-09-17), promoted onto its own rc's commit.
**`v0.2.0-rc.1` is cut and published as a pre-release** (tag on `c42ae06`, Release run 35407248705,
2026-09-18: Windows + macOS builds, attested, five installers + `SHA256SUMS.txt`). It carries
everything under *Closed* below plus migration 76. ⏭ **Next: install `v0.2.0-rc.1`, verify it, then
`/release promote`.** Its first CI pass took four fix commits (`6ddbba5`..`c42ae06`) — 22 commits
had accumulated unpushed and three suites had been passing only on this machine's git identity,
installed CLIs and fonts; `docs/testing.md` records each. Phase 3/4 (write-up, landing page,
channels) remains off-repo.

## Closed in this cleanup
- **A lapsed oversized session was revived instead of starting clean, and a completion prompt told sandboxed agents to fetch (t536 ← t518/t534, 2026-09-19).** Resume now starts a fresh session when the measured cache has lapsed after passing the compaction break-even; compaction remains reserved for its cheap pre-expiry window. The agent completion clause checks the checkout's target and leaves remote refresh to landing, avoiding needless SSH/grant requests. `cacheclock.ts`, `scheduler.ts`, `prompt.ts`, `docs/sessions.md`, `docs/cost-model.md`.
- **The thread conversation input box gained the `[+]` file and folder attachment menu (t527 ← t525, 2026-09-18).**
  t525 gave question cards the task composer's `[+]` attachment menu, but left the thread's bottom compose box without
  it. `Compose` in `TaskThread.tsx` now renders the same `[+]` Pill button (`COMPOSE_ATTACH_OPTIONS`: file, image, folder),
  allowing operators to attach files or grant local folders directly to live or resting task turns. `docs/ui.md`.
- **An idle agent's hand-off discarded everything after character 400 of its final message (t529 ←
  t521, 2026-09-18).** `runWatchdogs` wrote the only durable Thread record for an MCP agent that
  ended a turn without a terminal signal, but formatted it with `idle.said.slice(0, 400)`. The
  hand-off now carries the complete final message; `idleturn.test.ts` proves a message longer than
  that boundary reaches the thread intact. `docs/architecture.md`.
- **An Antigravity run that ran out of quota went to a person as a bare `ERROR` (t528 ← t527,
  2026-09-18).** agy's own `cli.log` showed `RESOURCE_EXHAUSTED (code 429): Individual quota reached
  … Resets in 52h16m45s` after eight retries, but the decoder read the result's `response` (the
  whole narration) before its `error`, and the adapter had no `outOfQuota`. Now a non-`SUCCESS`
  result prefers `error`, `antigravityCli.outOfQuota` recognises the refusal, and `quotaFailurePark`
  asks for the refused model's own pool's reset, as the watchdog does. `docs/adapters.md`.
- **Concurrent worktree pool expansion failed on `index.lock`, and capacity reduction blocked held tasks (t524 ← t523, 2026-09-17).**
  Dynamically increasing workspace pool size (`ws4`) unblocked queued tasks, but dispatch raced with in-flight
  `git worktree add` (which takes ~41s on large repositories) because `.git` was created early; `prepareWorkspace`
  ran `git switch -c` while `git worktree add` still held `index.lock`. `ensurePool(project)` is now serialized per
  project, and `cleanStaleGitLocks` cleans orphaned `.lock` files before preparing or switching worktrees. In reverse,
  reducing pool size is now graceful: idle extra workspaces are parked off held branches, while occupied ones finish
  undisturbed; and `poolPressure` in `scoring.ts` checks held workspaces and warm sessions before capacity check so held
  tasks are never blocked by pool narrowing. `worktrees.ts`, `scoring.ts`, `docs/architecture.md`.
- **Relocating a moved project meant typing the new path by hand (t517 ← t514, 2026-09-17).** The
  `RelocateBanner`'s text input had no OS picker, unlike every other path field in the app. It now
  renders `NewProject`'s `PathField` (newly exported), so relocation gets the same **Choose…** button
  that opens `dialog.showOpenDialog`, and still falls back to typing on a remote target where there is
  no local disk to browse. `docs/ui.md`.
- **An idle Muse account lost every unpinned routing contest, and it was `prepaid`, not the quota
  gate (t516, 2026-09-17).** MuseFirst went a long stretch never auto-routed; the quota gate itself
  was already proven not to block a worker with no reading (t309). Measured against MuseFirst's own
  11-day `quota_samples` history: Muse Code blanks `/usage` to "Currently unavailable" until a
  window's first turn completes, every such streak begins right at that window's `resetsAt`, and the
  first real reading after one is always low — so "vendor silent" means *fresh window, nothing spent*,
  not *broken probe*. `trustedWindows` used to stay empty on that state, so `prepaidTermFor` never
  found a billing window and parked at its 0.25 standing value through the exact idle, quota-rich
  stretch `prepaid` exists to reward. `QuotaSnapshot.vendorSilent` (migration 76, set only where the
  adapter's own `usageUnavailable` matched) now lets `scoring.ts`'s `inferredFreshWindows` synthesize a
  0%-used window at the projected next reset from the last trusted reading, feeding `prepaid` (and
  `quotaRisk`, harmlessly) like a real one. `docs/routing.md` §3.3a, `docs/data-model.md`.
- **A project whose directory moved outside Warmstart had no error of its own (t514, 2026-09-17).**
  `Project` now carries `rootExists` (`existsSync` on every `toProject`); the Project header banners a
  missing path and `project.relocate` points the same project id at its new directory, keeping tasks
  and history. Doctor's Projects section flags it fleet-wide too, like `isolationRootExists` for a
  worker. `projectrelocate.test.ts`, `docs/ui.md`.
- **Project reordering no longer needs its own drag handle (t515 ← t512, 2026-09-17).** The `⠿`
  marker before each project name ate sidebar width for no reason. `draggable` moved from a dedicated
  `.nav-project-drag` span onto `NavItem`'s `<button>` itself — the whole row is now the drag source
  and still fires its ordinary `onClick`. Dropped the handle's `cursor: grab`/`grabbing` rules, so dragging shows no hand cursor.
- **Thread auto-follow no longer traps a taller right pane (t513, 2026-09-17).** Pinning begins only at the whole page's bottom and follows that bottom, never the shorter chat anchor. `docs/ui.md`.
- **A `pull-request` task with an already-open PR could get stuck failing forever, and the retry
  button that should have fixed it disappeared after the first attempt (t509, 2026-09-17).** The
  closing contract only forbids rewriting commits already on the *landing target*, so a later run
  legitimately squashes commits an earlier run already pushed as this task's own open PR — and the
  plain `git push` in `pullRequest.land` then rejected as non-fast-forward, reported misleadingly as
  "…may already be pushed" when nothing had landed. It now retries once with `--force-with-lease` on
  that specific rejection (a compare-and-swap, still refused if the remote moved for another reason).
  Second half of the cascade: `canRelandTask` (`taskview.tsx`) hid **Retry landing** for good after the
  first `Retry landing failed: …`, a blanket exclusion meant for an empty branch that also caught every
  retriable cause — only the genuinely unfixable ones do now. `landing.md`.
- **A Plan & Split task could be routed to an adapter with no `task_split` tool at all, and just
  landed code instead of splitting anything (t507 ← t505, 2026-09-17).** `promptFor`'s MCP-less
  branch never checked `planPhaseOf`/`debatePhaseOf`, so a plan or debate task landed there fell
  straight through to the ordinary "do the work and say `TASK COMPLETE`" contract. `createTask` now
  writes `needs: ['mcp']` into a `plan` or `debate` task's own constraints — the per-worker capability
  gate `scoreCandidate` already enforces — in the one place both kinds are created. `prompt.test.ts`.
  Also fixed: **"Waiting on" sat near the bottom of the status pane despite following "status" in the
  DOM**, because the `Fact` carrying it had no CSS `order` class and fell to the unstyled default.
  `.fact--waiting` now orders it directly below `.fact--status`.
- **A freshly onboarded project could start with a dirty trunk that blocks its first landing (t506 ←
  t505, 2026-09-17).** `.warmstart/project.json` is documented as committed, but `writeStarterConfig`
  only wrote it — it sat untracked until a queued landing found the trunk dirty and refused to merge.
  `createProject` now commits the scaffolding it just wrote right after writing it; an existing,
  uncommitted config the operator wrote by hand is left alone. `projectsetup.test.ts`.
- **Pending pull requests get a dedicated Tasks banner and dot-clearing reconciliation (t503, 2026-09-17).**
  A project with open PRs displays a `.tasks-pr-banner` with task links, PR URLs, branch info and an
  instant **Check merged PRs** action; tasks with pending deliveries show a `PR #N` pill. The daemon
  now emits `project.changed`/`task.changed` on PR recording, sweep reconciliation and branch cleanup,
  so a merged PR check updates the sidebar dot from purple (`pending_pr`) to idle immediately.
  `docs/ui.md`, `docs/landing.md`.

- **A route consult held a task for 4m49s instead of 90s, and ran tools on Antigravity (t502 ← t501,
  2026-09-17).** t501 sat at *"waiting on a routing decision"*. Two causes, from the daemon log and the
  consult's agy conversation store: `CONSULT_TTL_MS` was checked only before a consult *started*, so a
  route started 49s in waited the full `ANSWER_TIMEOUT_MS`; and a consult took the adapter's default
  permission mode, which on `antigravity-cli` is `dangerously-skip-permissions` — it listed the data
  dir, ran python against `warmstart.db` and read `controller.ts` for four minutes, never answering.
  Now `answerTimeoutFor` bounds a running consult by its window, the queue drains soonest deadline
  first, `permissionModeFor` gives a consult `readOnlyPermissionMode` (a command attempt is
  auto-denied in ~1.1s, measured), and a consult cut short by its window no longer marks the account
  dead.


- **A held conversation's worker slot never came back (t498 ← t497, 2026-09-17).** ClaudeThird held a
  conversation resting at `awaiting_human`; a second task pinned to it queued at capacity, exactly as
  designed — but closing the conversation never freed the worker. `resolveTask` (Finish) and
  `cancelTask`'s `windDown` (Stop) both found "the session to close" through `sessionOf`, which answers
  "is a run open right now" — `endConversationTurn` finishes that run the instant the turn ends and
  keeps the session live for the reply, so neither ever found it. `restingSessionOf` (scheduler.ts)
  finds the most recent run's session whether or not it is open; both call sites use it now. ⛔ Fixing
  this exposed a second bug in the same function: `decideSessionFate` read a stale pre-write
  `task.cancel?.restingState`, so an ordinary human Stop always closed a warm session instead of
  deciding whether to keep it — now passed in explicitly. `conversationcapacity.test.ts`.

- **Routing prefers subscription quota that would otherwise be forfeit at reset (t499, 2026-09-17).**
  `quotaRisk` used to *penalise* an account resetting soon with money already spent on it (90% of a
  7d window, 10h to reset, scored `−0.491`). New signed term `prepaid` (`scoring.ts`, routing model
  **v1.1**): `+0.25 + 0.75×forfeitValue` for a forfeiting subscription window (`forfeitShare`'s pace
  projection), `0` for local/free/unknown billing, `−1` for money spent now (credits past a blocking
  window, or a priced API rate with no subscription window). Always on, not behind
  `modelRoutingActive()`. `windowRisk` lost its reset-horizon factor (it could exceed 1.0); `quotaRisk`
  now skips a billing window `prepaid` finds forfeiting, including a fresh non-session
  `allowed_warning` on it. `docs/routing.md` §3.3, §3.3a.

- **Three thread-page UI fixes (t500, 2026-09-17).** The thread no longer needs a manual scroll to
  follow a running agent: a reader already at the bottom is kept pinned there as messages and the
  live activity tail grow, the same pinned-tail pattern `SessionStream` already used for its own pane
  (`isNearThreadBottom`, `lib/threadscroll.ts`). `.detail-head` — the back button and the `t<seq> ·
  title` heading — is now `position: sticky` at the top of `.content`, so a long thread no longer
  scrolls the way out off the page; the title truncates to one line rather than wrapping the pinned
  header taller. The composer's ordinary pill row (`.composer-bar`) no longer wraps to a second line
  at an unpredictable point — it scrolls horizontally instead, the same answer already used for the
  Plan & Split and Debate tables; `.composer-send` buttons no longer wrap their own label either.
  `docs/ui.md`.

- **Typing a project name in the Add-a-project wizard lost focus mid-keystroke (t504, 2026-09-17).**
  Its mount-focus effect was keyed on `onClose`, a prop `App.tsx` hands it as a fresh closure every
  render — App re-renders often (dashboard polling), re-firing the effect and refocusing the modal
  mid-type. Split in two: Escape still depends on `onClose`; the one-time focus now runs on mount only.

## Remaining work — ordered by payoff

Each needs a real signed-in account, a macOS machine, release credentials, or a human product
judgement. Do not replace the missing evidence with a unit test.

1. **Run a real trunk task beside worktree tasks.** File a trunk task that pulls `main` and resolves a conflict while a worktree task finishes under `commit-and-merge`; confirm the worktree task sits at `landing_queued` and lands by itself when the trunk frees, and drive the Flow trunk row, composer pill and Project Settings row in the packaged app. None of the UI is covered by `test/ui.test.mjs`.
2. **Run one more live Plan & Split, and the first live Plan & Execute.** Exercise a `merge-branch` landing while a sibling is genuinely mid-run, and an organizer resolution turn where some pieces fail. Then file the same job as a Plan & Execute with a cheaper executor: confirm the planner's card completes at the handoff, the executor lands on the project's target, and record both tasks' total run cost side by side — the one measurement t456's design rests on and does not have.
3. **Run a real debate and record its measurements.** Compare total tokens/cost against a strong single-agent answer; record cache reads, resolved/unresolved citations, and whether the organizer changed the operator's decision. The evidence format is in [`transient_docs/debate_mode_2026-09-12.md`](transient_docs/debate_mode_2026-09-12.md) §7.
4. **Run human-in-the-loop, `commit-and-merge`, cross-task reuse and an inherited directory grant with a real agent.** The code and L1–L3 checks exist; none has been demonstrated in flight. For the grant (t462/t470): attach a second repository to a **planner**, let it file one piece that must edit there, and watch a sandboxed codex **commit** in it — proven only by a throwaway-repo probe so far. Then, on `claude-code`, have an agent call `request_directory` for an unattached folder and confirm the restart resumes warm.
5. **Verify `v0.1.1` as installed from the Releases page**, on Windows and on a Mac — the promoted build is a rebuild of the rc, not the same artefacts.
6. **Pair two real machines over Tailscale (t419).** Generate a desktop code on one, pair from the other, then drive a terminal, add a worker and file a task remotely. Confirm notifications from both computers, a revoke on the host cutting the client off, and the ±1 version warning.
7. **Post-launch, in the order the t392 debate ranked them:** a first-class OpenCode adapter (the generic declarative adapter cannot meter, gets no MCP tools and cannot reap orphans); CI watch after `gh pr create` ([`src/daemon/landing.ts`](src/daemon/landing.ts) ~l.1391); an update-available check that keeps `publish: null`; a full data-directory export (isolation roots, attachments); and a clone-per-worker or container backend, the only thing that closes both the host-authority gap and the shared common-`.git` grant. ⚠️ Not on this list: GitHub/Linear/Slack intake, agent messaging, kanban, voice, cross-machine sync.
8. **Give Antigravity a real per-worker isolation root.** It shares `~/.gemini` today; changing `HOME` must first be proven not to disturb the OS-keyring credential. See [`docs/adapters.md`](docs/adapters.md).
9. **Finish the metering and calibration measurements.** Meter PTY-hosted Codex from rollout data; compare small and large quality-review models on the same five tasks; verify the Claude credits gauge against one real invoice; decide whether preempted runs should contribute to estimates.
10. **Increase thread UI coverage where behaviour changes.** Most thread interactions remain hand-tested; extract pure decisions into `src/renderer/src/lib/` first.
11. **Continue the scheduler split only when touching it.** `scheduler.ts` remains about 3,780 lines against a ~1,500 target; no extracted module may read a scheduler binding at module evaluation time.
12. **Drive t423's live views in the packaged app, with a real run behind them.** Watch a dispatched Claude task narrate its tool calls into the thread peephole and the Session TUI; open **Open a real terminal** on it and confirm the fork holds the context while the run carries on; turn `liveNarration` to `streaming` and see whether the typing is worth ten times the stream lines. ⚠️ None of it is covered by `test/ui.test.mjs`, which never opens a project tab.

## Open questions and quiet-worker measurements

| Item | Evidence needed | Consequence |
|---|---|---|
| R1: Claude auto-mode classifier cost | Run the same shell-heavy task on a quiet subscription worker in `auto` and `default`; compare quota delta with transcript tokens. | If billed, `auto` cannot remain a free default. |
| R2: tokens per quota percent | Sample `/usage` around known transcript work for each worker/model/tokenizer. | Lets quota gates work in tokens rather than percentages. |
| R4: end-to-end compaction cost | Record a known-size compaction's transcript delta and duration. Six samples exist; `post_tokens` is still null. | Tunes the T+53-minute deadline. |
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
