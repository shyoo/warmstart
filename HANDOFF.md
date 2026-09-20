# Warmstart — Session Handoff

## Current state — 2026-09-20

Warmstart M0–M6 is implemented, including debate mode, quota-aware scheduling, pooled worktrees,
model-aware routing, quality review, remote access, packaging, and atomic worker/model reassignment.
The maintained reference in [`docs/`](docs/README.md) is the authority on each subsystem; dated
design and incident history belongs in `transient_docs/`, not here.

Baseline (2026-09-20, **Windows 11**, on `0.3.0+10` — t581): typecheck, lint and build pass;
L1 **3,822 passed, 5 skipped** (227 files), in **56s**. ⚠️ The `%TEMP%` figure is t579's, not re-measured
here. L2 **204 checks** (5 skipped); L3 **486 checks** (4
skipped), both last measured on t577 and not re-run since. L4 **19 checks** against `release/win-unpacked` was measured on `7b5f6e1`, the commit
`v0.3.0` ships, and has not been re-run since. ⚠️ L3 flaked twice under back-to-back suite load
(*timed out waiting for All filter to restore 3 rows*, a tier it does not touch) and was green on a
clean run. macOS 13 arm64, 2026-09-14: L3 434 (6 skipped), L4 17 on a signed,
hardened-runtime bundle. CI is **enabled**, and so is the **Release** workflow.

**`v0.3.0` is `latest`** (2026-09-19, tag build 35482566845), promoted onto `v0.3.0-rc.1`'s own
commit `7b5f6e1` — verified installed on **both Windows 11 and macOS**, the first release with no
unverified platform. It carries t559–t565 (trunk-only projects, the mid-conversation worker recap,
session reuse on by default) over `v0.2.0`, with no migration. The 0.3.0 series is open, so the next
`/release rc` continues it at `0.3.0-rc.2`; a new series is a patch unless `--bump minor|major` is
asked for. ⛔ All four tiers are run before a push, not after: rc.2 of the last series went red on
CI because six commits were pushed together without `test:ui`.
Phase 3/4 (write-up, landing page, channels) remains off-repo.

**Routing Model v1.2 preserves expiry urgency (t552, 2026-09-19).** `prepaid` is field-normalized
remaining prepaid dollars per hour to reset (`prepaid.ts`): the same $3.68 allowance scores 1/24 at a
24h reset and 1 at 1h — exactly 24×. `docs/routing.md` §3.3a.

## Closed in this cleanup
- **The Commit button asked for a commit and then nothing landed it (t581 ← t578, 2026-09-20).**
  Three faults, each enough on its own. (1) Commit tells the agent *not* to merge or push; on an
  adapter with `mcp: false` — muse-code, codex — there is no `land_work` to close the loop and
  **nothing in the tool acted on the rung the operator chose**. t578 rested with one squashed commit
  and an agent that had said *"the commit is ready to land"*. The rung is now recorded on
  `tasks.land_after_turn` (migration 78) *before* the turn and taken up by `landAfterCommitTurn` from
  `endConversationTurn`, which **re-reads the workspace** rather than trusting it — silent where the
  agent landed it itself, one thread line where it is refused, and the promise spent either way
  (`endUnfinishedRun` forgets it). (2) **Land was gated on a pristine tree** (`!hasDiff`), so the two
  untracked backup directories the operator had *asked* for meant it was never drawn — Commit was the
  card's only control and re-sent its instruction on every press. `settleControls`
  (`lib/finishrung.ts`) draws both when both are true. (3) `decideFinish` and every strategy's
  `canLand` refused the landing over the same untracked files; a conversation landing keeps its
  workspace, so `keepsWorkspace` now counts only the **tracked** half — ⭐ measured 2026-09-20: a
  rebase over untracked files succeeds untouched, one tracked modification refuses outright.
  Commit also refuses a press that would re-ask for a commit that exists. 11 + 7 + 3 L1 checks; four
  mutations go red. **Not flown on a real run.** `docs/landing.md`, `ui.md`, `data-model.md`.
- **A Muse worker set to "Full user authority" now runs `--yolo` (t580, 2026-09-20).** `muse-code` declares `bypassPermissionMode: 'yolo'` (vendor: *disable approval and sandbox and trust this workspace*), chosen by `permissionModeFor` exactly as Codex's bypass is; otherwise headless stays `never`. Unit-tested; **not flown on a real run**. `docs/adapters.md`.
- **Phone Overview activity is one line per event, and Tasks are tappable cards (t584, 2026-09-20).** Activity rows read age, `t{seq}`, event in the desktop pill language (starts blue, completions green, a human wait violet); task cards carry a `t{seq}` header with jump mark, the fact grid, then age beside the status pill. Every row and card opens its task. `docs/remote.md`.
- **Phone task page overhauled (t585, 2026-09-20).** Header is `t{seq} | title` at full ink with status pill and branch on their own row; the detail box holds Status, cur → next worker/model, Price, Tokens, Took, and Priority as a row; the thread is a bare chat log with no card or label. The Status card drops Stop (kept on desktop) and gains Commit (`task.commitConversation` allowlisted as project-scoped write); `parity.test.ts` pins phone decisions to desktop `settleControls`, rung defaults, and the allowlist. `docs/remote.md`.
- **L1 orphaned 24,322 fixture directories and ~161 GB of `%TEMP%`; 94% was one suite spawning a
  vendor CLI (t579, 2026-09-19).** `runfailure.test.ts` settles 69 metered runs, each reaching `void
  captureQuotaAfter` → `refreshNow` → `refreshIdentity`, which for `openai-compatible` runs **`codex
  doctor --json` with `CODEX_HOME` in the fixture root**; a fresh Codex home bootstraps by `git
  fetch`ing `openai/plugins` (23 MB, network, ×16 at once). Those processes outlived the suite, so
  `afterAll` hit `EBUSY` and **discarded the error** — ~250 MB/run, ~151 GB. ⛔ Invisible on CI, which
  has no vendor CLI to find. `vitest.config.ts` now gives each run **one temp root** (catching the
  `${root}_workspaces` siblings and `prompt.test.ts`'s per-`it` dirs too) and a **`PATH` where
  already-installed vendor CLIs resolve but cannot execute**, leaving every `isInstalled()` answer as
  it was; `l1sandbox.test.ts` guards both. ⚠️ The 2026-09-09 note on this said *delete them by hand*;
  advice is not a mechanism. `agy-usage.test.ts`'s `if (isInstalled())` guard (vacuous on CI) now
  asserts `detect()`'s contract. 140.26 GB reclaimed. `docs/testing.md` §3.
- **"Quota probe when idle: every 20 minutes" refreshed nothing, so idle cards read 41m, then hours,
  old (t577, 2026-09-20).** The idle interval only ever re-read a cache file the vendor writes when the
  account is *used*, and screen-answered adapters (Muse Code, Antigravity) were skipped outright — the
  refresh clock retired 2026-08-31 had taken the only path with it. `forcedRefresh` now refreshes any
  enabled, signed-in account whose newest attempt nears the interval, one terminal at a time and after
  every account with a run in flight; the poller wakes every 5m (`IDLE_SWEEP_TICK_MS`) instead of once
  per interval, since an early sweep skipped a cycle and doubled the age. Bound on terminals: the
  operator's own number (3/hour/account at 20m). ⚠️ `quotaprobing.test.ts` simulates 12h per cadence;
  the mutation (rule off) turns 11 red. **Not run on a real fleet.** `docs/cost-model.md` §5.
- **A fresh Muse window could not be read at all, and now one turn buys the reading (t570,
  2026-09-19).** The vendor publishes a window only once something has been spent in it, so every
  free probe on a just-reset account answers `Currently unavailable`. `usageRefresh.warmup` declares
  a tiny turn; `worker.warmUsage` sends it in the probe session already open, then re-drives
  `/usage `. ⛔ Operator press only (`RefreshOptions.warmUp` defaults false — the scheduler still
  spends nothing), drawn on the `no usage data yet` gap alone, priced in the note shown at
  commissioning. ⚠️ **Inferred, not yet watched working.** `docs/adapters.md`, `architecture.md`, `ui.md`.
- **Three thread fixes (t564, 2026-09-19).** *Muse Code's icon* was one open stroke that read as an
  earring; `AgentIcon` now draws the Meta mark — two wings crossing through a shared stem, traced
  from the 64px favicon at dev.meta.ai, brand blue, `viewBox 0 0 64 64` — and `agenticon.test.ts`
  asserts two strokes reaching both edges. *The ledger* shows `cur worker` / `next worker` and
  `cur model` / `next model` as separate rows (a never-run task reads plain `worker` / `model`);
  the *last run on* caption, *(Current)* suffix and `next` pill are gone. *Reassign* on both the
  `awaiting_human` card and the quota card gained `ReassignNote`: an optional message sent as the
  person's own turn on the same press (`task.message` in place of `Continue.` / `task.resume`).
  Six L3 checks; `docs/ui.md`.
- **Switching a task's worker mid-conversation sent the successor the opening prompt and nothing
  since (t562 ← t557, 2026-09-19).** `outstanding` carries the first message plus whatever is
  undelivered; everything between them had gone to a session that no longer exists, so it never
  travelled. Measured on t557: the worker was switched twice and the incoming codex run got the
  opening request verbatim — neither revision it was being asked to make, nor the draft it was being
  asked to revise — and `openai-compatible` is `mcp: false`, so `task_read` was no route back
  either. `recapTurns` (`prompt.ts`) now interleaves those turns into a **cold** prompt in thread
  order, labelled `[earlier turn — …]` and stated to be context, not instructions to carry out
  again. Cold means the *session*: a resumed one holds them, a compacted one a paid-for
  summary. Bounded (~12,000 total, oldest dropped and counted, every trim marked *abridged* —
  nothing silent, t529); ends at `task_read` where there is MCP, *re-read the files* where not.
  17 L1 checks (11 go red with the recap off, 6 more on a resumed session). `docs/sessions.md`, `docs/architecture.md`.
- **A from-scratch install shared no sessions and showed mock welcome-tour images (t559,
  2026-09-19).** `DEFAULT_FLEET_SHARING` was `off`; a clean install now ships `on` (reuse) —
  `sharing.ts`'s gates (same project/account/model/effort, clean, room to grow) keep it narrow, and
  debate seats still force `off`. The tour's SVG mockups are now real crops of the UI, captured into
  `src/renderer/src/assets/welcome/*.png` by `scripts/generate-tour-assets.mjs` (reuses
  `scripts/showcase.mjs`); regenerate after a wizard/Workers/composer change. `docs/sessions.md`, `docs/ui.md`.
- **`/release rc` bumps patch, not minor, when it opens a new series (2026-09-19).** With no rc above
  the last final it used to jump `0.2.0 → 0.3.0-rc.1`; a minor is now something the operator asks for
  (`--bump minor|major`), and the first release of all is still `0.1.0`. Same commit fixed t554's L3
  check, which asserted an option label a closed popover never renders — `docs/testing.md` §3.
- **The Workers card layout labelled every field after Role one place late (t545 → rc.2, 2026-09-19).**
  t545 added the *Unattended* header without a `<col>` or a positional card label, so `test:ui` failed `[14,15]` on CI and blocked the rc; `Workers.tsx` now has fifteen `<col>`s, and `app.css` labels the new cell.
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
- **A lapsed oversized session was revived instead of starting clean, and a completion prompt told sandboxed agents to fetch (t536 ← t518/t534, 2026-09-19).** Resume now starts a fresh session when the measured cache has lapsed after passing the compaction break-even; compaction remains reserved for its cheap pre-expiry window. The agent completion clause checks the checkout's target and leaves remote refresh to landing, avoiding needless SSH/grant requests. `cacheclock.ts`, `scheduler.ts`, `prompt.ts`, `docs/sessions.md`, `docs/cost-model.md`.
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
- **Projects can run trunk-only (t563, 2026-09-19).** `workspaces.poolSize: 0` runs every task on the trunk
  lease; wizard/settings offer Trunk + worktrees (default) vs Trunk only, changeable either way with confirmation; `project.pruneWorktrees` removes idle trees, keeps occupied/dirty ones. `trunkonly.test.ts`.
- **A quality-review batch grading in the background was invisible outside the Quality Review page
  (t572, 2026-09-19).** The sidebar's Analytics → Quality Review link now carries the same pulsing
  `Working` dots a running task shows, driven by a new `useQualityBatchRunning` poll of
  `quality.batch` (the batch lives in daemon memory, so nothing emits when it starts or finishes).

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
