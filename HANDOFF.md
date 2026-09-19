# Warmstart — Session Handoff

## Current state — 2026-09-16

Warmstart M0–M6 is implemented, including debate mode, quota-aware scheduling, pooled worktrees,
model-aware routing, quality review, remote access, packaging, and atomic worker/model reassignment.
The maintained reference in [`docs/`](docs/README.md) is the authority on each subsystem; dated
design and incident history belongs in `transient_docs/`, not here.

Baseline (2026-09-19, **Windows 11**, measured over `0.2.0-rc.2+3.g6b3362c.dirty`): typecheck, lint
and build pass; L1 **3,739 passed, 5 skipped** (224 files); L2 **203 checks** (5 skipped); L3 **480
passed, 4 skipped**; L4 **19 checks** against `release/win-unpacked`. All five measured 2026-09-19. macOS 13
arm64, 2026-09-14: L3 434 (6 skipped), L4 17 on a signed, hardened-runtime bundle. CI is **enabled**, and so is the
**Release** workflow.

**`v0.1.1` is `latest`** (tag build 35165991396, 2026-09-17), promoted onto its own rc's commit.
**`v0.2.0-rc.2` is cut as a pre-release** (2026-09-19), superseding `v0.2.0-rc.1` (`c42ae06`): it adds
t536–t549 and migration 77. The 0.2.0 series is still open, so the next `/release rc` continues it
(`0.2.0-rc.3`) rather than bumping. ⏭ **Next: install the newest rc, verify it, then `/release promote`.** Its CI first went red on the t545 Workers-table
regression below: six commits had been pushed together, and `test:ui` was not run on them first.
Phase 3/4 (write-up, landing page, channels) remains off-repo.

**Routing Model v1.2 preserves expiry urgency (t552, 2026-09-19).** `prepaid` is field-normalized
remaining prepaid dollars per hour to reset (`prepaid.ts`): the same $3.68 allowance scores 1/24 at a
24h reset and 1 at 1h — exactly 24×. `docs/routing.md` §3.3a.

## Closed in this cleanup
- **`/release rc` bumps patch, not minor, when it opens a new series (2026-09-19).** With no rc above
  the last final it used to jump `0.2.0 → 0.3.0-rc.1`; a minor is now something the operator asks for
  (`--bump minor|major`), and the first release of all is still `0.1.0`. Same commit fixed t554's L3
  check, which asserted an option label a closed popover never renders — `docs/testing.md` §3.
- **The Workers card layout labelled every field after Role one place late (t545 → rc.2, 2026-09-19).**
  t545 added the *Unattended* header without a `<col>` or a positional card label, so `test:ui` failed
  `[14,15]` on CI and blocked the rc. `Workers.tsx` now has fifteen `<col>`s, and `app.css` labels the new cell.
- **The fleet card counts parallel slots instead of listing `+N more` sessions (t549, 2026-09-19).**
  The sessions divider now reads `1 / 2 running` (narrow `1 / 2`), slots in use against Max parallel
  instances by `slotsInUse`'s arithmetic — the daemon serves the half the renderer cannot see
  (`fleet.list` → `reservedSlots`) — amber when full, with a working / idle / held tooltip. Always
  drawn; the last three session gauges follow, and the `+N more` line is gone. `docs/ui.md`.
- **Muse Code runs natively on Windows; the WSL bridge is gone (t547, 2026-09-19).** Muse Code 1.3.0
  ships a Windows build (`irm https://dev.meta.ai/install.ps1 | iex`). `clihost.ts` now knows `posix`
  and `windows` hosts only; `museBinary` starts the installer's `muse-bin-<version>.exe` (never the
  `muse.cmd` shim, whose PowerShell launcher fails under pwsh 7), and `WINDOWS_DRAIN` — the daemon's
  own Node — replaces `cat > file` because Windows muse has no stdin prompt channel either. Images
  flow again (the WSL-only `0700` gate is gone), and `trustKey` spells a trusted folder `\\?\<resolved
  path>`, the only key the Windows TUI honours. Measured live through `spawnSession`/`refreshUsage` on
  MuseFirst: the WSL-written credential worked unchanged, a turn was metered, `/usage` read 3%/23%.
  On this machine the Ubuntu distro was unregistered and WSL uninstalled the same day (operator's
  call; Virtual Machine Platform left on for the Claude desktop VM). ⏭ **MuseFirst cannot run until
  the installed app is rebuilt with this change** — the old build still looks for `wsl.exe`.
  `docs/adapters.md`.
- **Only Plan & Split and Plan & Execute drew the composer's dispatch diagram; Single Task,
  Conversation and Debate were left to a sentence (t546, 2026-09-19).** `PlanShape` is now
  `WorkflowShape`, one of five schematic topologies keyed on the kind pill instead of two: Single
  Task draws one accented node running straight to "verifies & lands"; Conversation draws two nodes
  trading turns with a dashed, unreached "commit" node, since nothing lands automatically; Debate
  draws independent seats converging on the organizer, the mirror of Plan & Split's fan-out (no
  initial planner, because a debate's seats never come from one). Every diagram keeps the existing
  rule: schematic only, no mockup of a screen, `--color-*` tokens so it reads in both themes.
  `NewTask.tsx`, `docs/ui.md`.
- **Unattended authority moved from the project to the worker, and Codex can opt into it (t545,
  2026-09-19).** The choice between sandboxed and full-user unattended dispatch used to live on
  `ProjectConfig.permission.unattended`, gating every adapter a project's tasks could reach alike; an
  account's own reach into the machine is a fact about that account, not the project, so it is now
  `Worker.unattendedAuthority` (Settings → Workers → **Unattended**), read by `scoring.ts`'s
  eligibility gate and by `sessions.ts`'s `permissionModeFor` alike. Codex also gained a real
  `bypassPermissionMode`: a worker set to `full-user` runs `--dangerously-bypass-approvals-and-sandbox`
  (measured 2026-09-19 against codex-cli 0.151.0 — it runs cleanly, so `plan()` omits `--sandbox` and
  the network override by choice, not because the CLI refuses them together) instead of the
  `workspace-write` sandbox, matching the permissive default Claude Code and Antigravity already use.
  Migration 77 backfills every existing worker to the mode it has always actually run in — Codex to
  `sandboxed-only`, everything else to `full-user` — so no existing account's dispatch behaviour
  changes on upgrade; a Codex worker only gets the bypass after an operator explicitly asks for it.
  `docs/security.md`, `docs/adapters.md`.
- **Attaching a folder to a codex task could never grant `~\.ssh`, because read and write are
  decided by two different mechanisms (t538 ← t537, 2026-09-18).** `--add-dir C:\Users\<user>\.ssh`
  was on three consecutive t537 runs' argv, never appeared in `<CODEX_HOME>/cap_sid` →
  `writable_root_by_path` (39 roots codex *had* granted, `AppData\Local\*` among them) and produced
  no audit line — codex declines that root silently, so the agent asked a person for something no
  attachment could give it. Measured with `codex exec` and nothing on the argv: a sandboxed command
  runs as `CodexSandboxOffline`/`Online`, so **read** is an ordinary NTFS ACE
  (`icacls <dir> /grant "CodexSandboxUsers:(OI)(CI)(RX)"`, permanent and flagless) while **write**
  needs the per-path capability SID only codex mints — the same ACE at `(M)` was still refused.
  `sandbox_workspace_write.writable_roots` in the isolation root's `config.toml` mints it on every
  run and survives `-c sandbox_workspace_write.network_access=true`. ⛔ No code change: Warmstart
  must not write either grant on the operator's own directories. `docs/adapters.md`, `grants.ts`.
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
