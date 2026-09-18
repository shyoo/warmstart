# Warmstart — Session Handoff

## Current state — 2026-09-16

Warmstart M0–M6 is implemented, including debate mode, quota-aware scheduling, pooled worktrees,
model-aware routing, quality review, remote access, packaging, and atomic worker/model reassignment.
The maintained reference in [`docs/`](docs/README.md) is the authority on each subsystem; dated
design and incident history belongs in `transient_docs/`, not here.

Baseline (2026-09-17, **Windows 11**, measured over `0.1.1+21.g3cbf882.dirty`): typecheck, lint and
build pass; L1 **3,710 passed, 5 skipped** (221 files). L2 **203 checks** (5 skipped) and L4 **19
checks** against `release/win-unpacked` were at `0.1.1+1.g1fff656`. L3 not re-run on this tip (a
renderer change, but `test/ui.test.mjs` never opens a project tab — see t500 below); it was **474
passed, 4 skipped** at `0.1.0+8.gb642d0e`. macOS 13 arm64, 2026-09-14: L3 434 (6 skipped), L4 17 on a
signed, hardened-runtime bundle. CI is **enabled**, and so is the **Release** workflow.

**`v0.1.1` is released and `latest`** (tag build 35165991396, 2026-09-17, attested; five installers
+ `SHA256SUMS.txt`). It was verified as `v0.1.1-rc.1` (tag build 35161851026) and promoted onto that
rc's own commit `1d2c714`, so `v0.1.1` and `v0.1.1-rc.1` name the same bytes. ⭐ **The whole
tag-is-the-version flow has now carried a release end to end** — `/release rc`, verify, `/release
promote`, `release.yml`'s verify step included — in two turns and no "Prepare vX" commit.
⚠️ `main` is *ahead* of the released tag: the two fixes below landed after the rc was cut, so the
0.1.1 installers do not contain them. ⏭ Next is Phase 3/4 (write-up, demo GIF, landing page,
channels), all off-repo.

## Closed in this cleanup
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

- **A codex run can reach the network; it still cannot push (t494 ← t493, 2026-09-16).** codex's
  `workspace-write` shipped with `network_access: false`, failing the *fetch first* clause every
  worktree agent gets. `plan()` now passes `-c sandbox_workspace_write.network_access=true`; `envFor`
  appends `http.sslBackend=openssl` on Windows. ⛔ No credential reaches the sandbox — landing pushes
  outside. `docs/adapters.md`, `docs/security.md`.

- **`scripts/version.mjs` printed nothing when *run* on Linux or macOS, and that decided a
  release's visibility (2026-09-16).** It tested direct invocation by comparing `import.meta.url`
  against a hand-built `file:///${process.argv[1]}` — right on Windows, never true on POSIX. ⭐ So
  `release.yml`'s `version=$(node scripts/version.mjs)` was empty, and **`v0.1.1-rc.1` published as a
  full release and became `/releases/latest`** — corrected on GitHub with `gh release edit
  v0.1.1-rc.1 --prerelease` before promotion. `pathToFileURL` now; `release-tag.mjs` and
  `check-release-base.mjs` carried the same line and are fixed too; the workflow refuses a version
  that is not version-shaped. ⚠️ `scripts/build-mac.sh` reads the same command into
  `.build-cache/version.txt`; unmeasured on macOS, worth a look on the next Mac.

- **A release is one turn, and the tag is the version (t485, 2026-09-16).** The version was a source fact
  costing four turns and two commits per release. `scripts/version.mjs` derives it from git
  (`WARMSTART_VERSION` or `git describe`); `scripts/pack.mjs` passes `extraMetadata.version`; `package.json`
  keeps `0.0.0`. `/release rc` plans, notes and cuts one annotated tag; `/release promote` tags the rc commit.
  Verified with `v0.1.1-rc.1` / `v0.1.1`. Design: [`transient_docs/release_flow_2026-09-16.md`](transient_docs/release_flow_2026-09-16.md).

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
