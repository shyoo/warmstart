# Warmstart — Session Handoff

## Current state — 2026-09-15

Warmstart M0–M6 is implemented, including debate mode, quota-aware scheduling, pooled worktrees,
model-aware routing, quality review, remote access, packaging, and atomic worker/model reassignment.
The maintained reference in [`docs/`](docs/README.md) is the
authority on each subsystem; dated design and incident history belongs in `transient_docs/`, not here.

Baseline (2026-09-15, **Windows 11**, after t470): typecheck, lint and build pass; L1 **3,558 passed,
5 skipped** (206 files + 2 platform skips); L2 **203 checks** (5 skipped); L3 **452 passed, 4 skipped**
at the pinned 1024×720 window; L4 **19 checks** against `release/win-unpacked` (after t451, not re-run
since). The same day on **macOS 13 arm64**: L1 3,475 / L3 434 (6 skipped) / L4 17 against a signed,
hardened-runtime bundle. Last CI green on all seven jobs: `c909c4c`, run 34883661692, with t445.2's fix for
`3489bc0`'s red `ui · windows-latest` (run 34872370257). CI is **enabled**, and so is the
**Release** workflow: it has been dispatched twice with `platforms=macos` (item 6 below), so a `v*`
tag now builds both platforms.

## Closed in this cleanup

- **`warmstart-site`'s task diagrams mark landing green, Debate now draws its rounds, and `#proof`
  adds a bad cache-expiry case (t471, 2026-09-15).** The done/check state in every `TaskDiagram.astro`
  kind now reads `--color-ok` (green) instead of the accent blue, so it reads apart from in-flight
  agent nodes; Plan & Split's middle label is now "executors" to match the composer's own wording.
  Debate's diagram draws three seats exchanging positions over rounds (an X marks the exchange
  between rows) before converging through an organizer to done, instead of a single merge. The reuse
  example in `#proof` now pairs its measured good case (green) with a bad one (red: resumed after the
  cache expires, paying `cacheWrite1h` instead of `cacheRead`), built only from facts already in
  `site.ts`, and links Anthropic's prompt-caching documentation as a source. `--color-ok`/`--color-danger`
  (and their `-dim` variants) were added to `global.css`, mirroring the app's `--state-ok`/`--state-danger`.
  ⚠️ **Committed in that repo, not pushed** — a push to its `main` deploys Cloudflare Pages.

- **Rephrase all user-facing UI copy and analytics descriptions into direct, concise developer style (t464, 2026-09-15).**
  Cleaned up all user-facing sentences, tooltips, placeholders, section intros, and flavor text across 21 components
  in `src/renderer/src/components` (Tasks, LooseEnds, Flow, NewTask, NewProject, FleetSettings, CostModel, RoutingOverview,
  RoutingModel, QualityModel, VelocityModel, ModelsModel, Statistics, QualityReview, Questions, Workers, and thread components
  DebateBoard, Decide, DiffPanel, Facts, RunRow). Eliminated Claude-specific idioms ("comes to rest", "load-bearing", "prose",
  "rung", "dearest model") and pseudo-academic paper jargon while strictly preserving test-invariant assertions and RPC contracts.
  Net reduction of 112 lines of verbose text. Verified: typecheck, lint, `npm test` (3,548 passed), `npm run build`, and `ui.test.mjs`
  (all 452 checks passed).

- **`warmstart-site` drops "routing" for automatic assignment, draws the five task topologies, and
  proves context reuse with one measured example (t469, 2026-09-15).** The `#how` heading is now the
  pitch ("The right agent and the right model, without thinking twice"); step 1 is *Pick your task
  type*; the kinds table became cards, each with a dispatch diagram in the composer's own schematic
  language (`TaskDiagram.astro`, mirroring `PlanShape` in `NewTask.tsx`); `#proof` carries the
  2026-08-28 cold/resume figures (41,542 → 65, 99.8% fewer; 0.1× read against a 2.0× rebuild, 95%
  lower), compaction, and the cache-expiry worst case. ⚠️ **Committed in that repo, not pushed** —
  a push to its `main` deploys Cloudflare Pages.

- **`warmstart-site`'s `tasks.png` had no backdrop; the generator now refuses to write a shot that
  looks like it is missing one (t468, 2026-09-15).** t465's failed regeneration was worked around by
  hand-copying in a raw, backdrop-less substitute (258,589 bytes), which shipped unnoticed. Replaced
  with the real, sha256-verified composited file. `generate-readme-assets.mjs` now has
  `MIN_SHOT_BYTES` (400,000): `shot()`/`shotElement()` throw below that floor. See `docs/development.md`.

- **Finishing a conversation no longer races Retire it (t467, 2026-09-15).** Read-only evidence from
  the live database showed t466 `completed` with its run closed while session `753261d2` remained
  `live` and still claimed `C:\Dev\warmstart_workspaces\ws2`; Loose ends therefore offered its empty
  branch, then retirement refused the checkout. `resolveTask` now waits for the session process to
  exit and parks/releases its workspace before the Finish RPC returns. A process that misses the
  bounded 15-second wait keeps its claim and is never reused. Retirement still switches only a
  clean, unclaimed pool member. Refusals say **Could not retire/delete/clean up** and tell the
  operator whether to switch a checkout, finish work, or handle uncommitted files. Pinned by
  `runfailure.test.ts` and real-git `landingcorners.test.ts`.

- **A granted directory can now be committed in, and an agent can ask for one that works (t470,
  2026-09-15).** ⛔ The t469 grant was *not* dropped: `--add-dir C:\Dev\warmstart-site` was on the
  argv of both runs (daemon log, 02:14:44 and 02:23:16). Codex's elevated Windows sandbox grants each
  `--add-dir` root a write ACE and then writes an explicit **deny** ACE on that root's `.git` — its
  own audit log, `granting write ACE to …warmstart-site` then `applied deny ACE to protect
  …warmstart-site\.git` — so every edit landed and `git commit` died at `.git/index.lock: Permission
  denied`. ⭐ Probed against codex-cli 0.151.0: passing `<dir>/.git` as a root of its own draws a
  grant and **no** deny, and the commit succeeds. `gitMetadataRoots` (was `gitWritableRoots`) returns
  it now, for the workspace and every granted folder; `externalGitRoots` keeps the `icacls` reset to
  worktrees this fleet made. ⚠️ It silently hit any plain-clone workspace too — a `trunk`-mode task
  could not commit at all. ⭐ New MCP tool **`request_directory`**
  (`daemon/dirgrants.ts`): the operator's **Grant** attaches the folder to the task, ends the run and
  requeues it, so the grant arrives on a warm resume — the card says the restart costs tokens, and
  the agent's `state` becomes the handoff. Refusals never end a turn. ⚠️ `claude-code` only (the one
  adapter with MCP); the rest name the path after `NEEDS DECISION:`. See `docs/mcp.md`, `adapters.md`.

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

- **t408–t455, landed and documented in docs/ (2026-09-13–15).** Earlier cleanup items now fully
  covered by the docs/ pages they owed; see git history for t408–t449 (probe PTY answers, live quota
  probe, remote settings, Statistics axes, landing messages, welcome tour) and t451–t455 (gate panel,
  idle-turn deferral, Quality Review's N+1 fetch, phone `ask_human` decision card, tour navigation).

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
   the grant (t462/t470): attach a second repository to a **planner**, let it file one piece that
   must edit there, and watch a sandboxed codex **commit** in it — the `.git` grant is proven by a
   throwaway-repo probe and has not yet carried a real task's work. Then, on `claude-code`, have an
   agent call `request_directory` for a folder nobody attached and confirm the restart resumes warm.
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
