# Warmstart — Session Handoff

## Current state — 2026-09-15

Warmstart M0–M6 is implemented, including debate mode, quota-aware scheduling, pooled worktrees,
model-aware routing, quality review, remote access, packaging, and atomic worker/model reassignment.
The maintained reference in [`docs/`](docs/README.md) is the
authority on each subsystem; dated design and incident history belongs in `transient_docs/`, not here.

Baseline (2026-09-15, **Windows 11**, after t462): typecheck, lint and build pass; L1 **3,548 passed,
5 skipped** (205 files + 2 platform skips); L2 **203 checks** (5 skipped); L3 **452 passed, 4 skipped**
at the pinned 1024×720 window; L4 **19 checks** against `release/win-unpacked` (after t451, not re-run
since). The same day on **macOS 13 arm64**: L1 3,475 / L3 434 (6 skipped) / L4 17 against a signed,
hardened-runtime bundle. Last CI green on all seven jobs: `c909c4c`, run 34883661692, with t445.2's fix for
`3489bc0`'s red `ui · windows-latest` (run 34872370257). CI is **enabled**, and so is the
**Release** workflow: it has been dispatched twice with `platforms=macos` (item 6 below), so a `v*`
tag now builds both platforms.

## Closed in this cleanup

- **A folder an operator attaches is now granted to every task downstream of it, and on every run
  (t462, 2026-09-15).** ⭐ **The measurement this exists for:** on t460 → t461 the operator attached
  `C:\Dev\warmstart-site` to a *planner* whose single piece was to edit that repository. The piece
  was a new task with no attachments of its own, so codex was spawned in its worktree under
  `--sandbox workspace-write` with no `--add-dir` for the site and came back *“separate-site changes
  were blocked by filesystem permissions”* having done everything else — the grant did not travel the
  one hop the plan itself created. It also did not survive a *second run of the same task*: an
  attachment travels only while its message is undelivered, which is right for an image that costs
  tokens to replay and wrong for a flag that costs none. `grantedDirsFor` (`daemon/attachments.ts`)
  now resolves every folder attachment on a task **and on its ancestors**, filtered to what is a
  directory on disk; `SpawnRequest.grantDirs` carries it, and `spawnSession` falls back to the task
  behind a resumed or forked conversation so the cache clock cannot drop a grant. The three
  sandboxing adapters spell it `--add-dir` (on codex, ahead of the `resume` subcommand, where the
  flag is declared); the cold prompt names the directories, because a grant nobody is told about is
  one the agent never uses. ⚠️ **Argv- and unit-proven only** (item 4). Pinned:
  `attachments.test.ts` (inheritance down, not up; survives delivery; drops a folder that moved),
  `adapters.test.ts` (all three adapters, the codex ordering, no duplicate grant), `prompt.test.ts`.

- **README and first-run documentation lead with Warmstart's subscription-CLI control-room pitch
  (t461, 2026-09-15; screenshots finished in t462).** The root README has the public links and
  badges, feature-led sections, task-kind table, pricing language and roadmap; the six-step
  walkthrough lives in `docs/getting-started.md` and is indexed. Public badges will show “not found”
  until the repository is public and a `v*` tag exists.

  ⛔ **t461 wrote the generator's new code but never ran it, and `docs/images/tradeoffs.png` was
  committed as a byte-identical copy of `statistics.png`.** All ten images are now regenerated from
  one real run and total **7.5 MB** (600–870 kB each; the backdrop's gradients are what PNG
  compresses worst, and `MAX_SHOT_WIDTH` caps the raw DPR-1.5 capture at 1,800 px). Three things had
  to be fixed before a run produced anything: the **welcome tour** opens on the always-clean scratch
  profile and landed in all ten captures; the `thread` scene still clicked a task title t461 had
  renamed; and the `tradeoffs` section did not exist at all, because the quality axis folds
  `quality_reviews` rows and the seed only wrote `tasks.quality_review_score` — it now seeds two real
  peer grades per finished task, from a *different-vendor* reviewer, with dimension scores whose
  weighted mean is the stored composite. ⚠️ Anything jittered by `n % WORKERS.length` is constant per
  worker, so the grades were identical within each model and the quality whiskers drew a point.

- **warmstart.dev carries the same story, committed locally in `C:\Dev\warmstart-site` and not
  pushed (t462, 2026-09-15).** New *Five ways to file a task* and *Roadmap* sections, a seven-block
  feature grid, the trade-off scatters in place of the retired Routing Model shot, and `.shot img`
  loses its border and drop shadow because each PNG now carries its own frame. Measured at 1,280 px
  and at a real 390 px phone viewport: nothing extends past the viewport. ⚠️ `--window-size=390` is
  **not** a phone — headless Chrome on Windows will not go below ~500 px and crops instead, which
  reads exactly like an overflow that is not there. That repo's own `HANDOFF.md` has the rest.

- **Quality Review's gradable totals now exclude tasks the same page says cannot be graded (t459,
  2026-09-15).** `reviewQueue` previously calculated the non-gradable count from live eligibility but
  left the 0/1/2+ tiles as raw finished-task counts, so every refusal appeared on both sides of the
  summary (reported as 61 gradable tasks even though none remained). All five counts now come from
  one eligibility map; refused rows remain visible unless the operator's filter hides them.

- **The quota-preemption card's wrap-up buttons, and hand-off with a destination (t458,
  2026-09-15).** Every option with more than one button now wraps them in `.decide-buttons`, one
  grid item in `.decide-option`'s two-column grid, so a second button stops auto-placing into the
  description's column. ⭐ A hand-off chosen during the warning can now name where the work goes:
  `quotaPreemptWarning.reassignWorkerId`, set by `task.overrideQuota` (refused beside
  `preemptionAction: 'compact'` — a compacted context belongs to the session that built it) and read
  by `preempt()` at expiry, which reassigns the constraints, clears `not_before`, and falls back to
  pausing if the chosen worker is gone. Pinned in `quotaoverride.test.ts`, `preemption.test.ts` and
  `test/ui.test.mjs`. ⚠️ **Not run against a real preemption**; the scenario is seeded through the
  store, as the other quota states in that suite are.

- **Plan & Execute, and the composer pill's teaching order (t456 / t458, 2026-09-15).** Plan & Execute
  is the same `plan` kind with the fan-out capped at one and no integration turn; the shape is
  *derived*, never stored — `planModeOf` (`shared/tasks.ts`) reads
  `min(mandate.maxChildren, childDefaults.maxChildren) <= 1` and everything follows, including the
  executor landing onto the **project's** target rather than the planner's branch. The pill now reads
  Single Task, Conversation, Plan & Execute, Plan & Split, Debate, from the single `KIND_OPTIONS`
  order. Design, measurements and the two operator decisions:
  [`transient_docs/plan_and_execute_2026-09-15.md`](transient_docs/plan_and_execute_2026-09-15.md).
  ⚠️ **Not run against a real agent**, and the cost claim is unmeasured on this fleet (item 2).

- **t451–t455, landed and documented in docs/ (2026-09-15).** The Changes-in-this-task panel no
  longer springs open on its own at the gate (t451, `atGate`); active child processes now defer idle
  turn parking and a resting session with unlanded commits offers **Land ▼** (t452,
  `sampleProcessTree`, `pendingWork`); the Quality Review page's N+1 `getTask`-per-row load became one
  bounded `getTasksByIds` fetch, plus the `tasks_status` index the report asked about (t453, migration
  73); a phone-visible `ask_human` question draws in full beside a **What now** decision card instead
  of one bare **Resolve** row (t454, `components/QuestionCard`, `components/Decide`); and the
  first-launch welcome tour gained SVG mockups per step and Back/Next/Esc navigation instead of a
  single action button that jumped away mid-tour (t455).

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
4. **Run human-in-the-loop, `commit-and-merge`, cross-task reuse and an inherited directory grant
   with a real agent.** The code and L1–L3 checks exist; none has been demonstrated in flight. For
   the grant (t462): attach a second repository to a **planner**, let it file one piece that must
   edit there, and watch a sandboxed codex actually write and commit in it.
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
