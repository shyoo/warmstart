# Warmstart — Session Handoff

## Current state — 2026-09-13

Warmstart M0–M6 is implemented. The current branch contains debate mode, quota-aware scheduling,
pooled worktrees, model-aware routing, quality review, remote access, packaging, the completed
Warmstart rename, and the three pre-public blockers a three-seat debate on t392 converged on:
**in-app diff review**, an **honest security model with a per-project containment setting**, and
**desktop notifications**. The maintained reference in [`docs/`](docs/README.md) is the authority on
each subsystem; dated design and incident history belongs in `transient_docs/`, not here.

Last full local validation on this branch (2026-09-13): `npm run typecheck`, `npm run lint`,
`npm test` (**3,337 passed, 2 skipped**), `npm run build`, and the L3 UI suite (**416 checks**) passed.
Expected test warnings exercise refusal and recovery paths; they are not failures.

## Closed in this cleanup

- **The Tasks table responds to its actual panel width (t415, 2026-09-13).** Its history and
  secondary columns now yield through a named CSS container as either the window or the resizable
  sidebar narrows the panel; the old viewport queries kept every fixed-width column in a roughly
  960px table and let headers paint across their neighbours. The L3 regression recreates that shape
  by widening the sidebar while leaving the viewport wide. Task validation: typecheck, build, and
  **3,338 passed / 2 skipped** at L1; the local L3 host could not start Chromium because its GPU
  process repeatedly exited with `-1073741515`, before any renderer check ran.
- **Show retained workspace locks in Flow (t413, 2026-09-13).** An `awaiting_human` ticket stays in
  Awaiting and names the workspace it still locks, rather than pinning under Running or hiding the lock.
- **Three UI changes across task composer, sidebar pending PRs, and thread bubbles (t414, 2026-09-13).**
  ⭐ *Workspace mode pill order*: `Workspace` (`worktree` / `trunk`) is placed before Conversation reuse
  and Finish policy in `NewTask` composer. ⭐ *Purple pending PR dot and alert badge*: A project with
  unlanded open PRs (`delivery.pending` RPC) shows a purple dot (`--state-pr`) in the sidebar; clicking
  it displays an alert badge indicating unlanded PRs with a link to Overview Dashboard (`{ kind: 'overview', page: 'dashboard' }`).
  ⭐ *Mid-flight user response thread split*: When a user replies to an active task, earlier thinking
  activity (before user message timestamp) is rendered in an agent bubble with timestamp `when(lastLine.ts)`,
  followed by the user message bubble on the right, followed by the continuing live thinking tail with `<Working />`
  (`lib/threadbubble.ts`).
- **Five UI reports off t410 (2026-09-13), each measured in the built app.** ⭐ *The code diff view is
  gone*: `DiffPanel` was drawn on `status === 'awaiting_human'` alone, so the change vanished the moment
  a task finished — which is when a thread is most often read. It is drawn wherever the change resolves
  (rung 1 of `resolveRange` is the recorded commits, which outlive the branch), opens itself only at the
  gate, and is silent where nothing resolves rather than putting a refusal under every draft. Retitled
  **Changes in this task**. ⭐ *Each commit links to its own diff with its own ± totals*:
  `task.commitDiff` / `task.commitFile` read `<sha>^!`, never a range across it, behind the same double
  gate as the branch pair — the sha must be one this task recorded **and** the path one that commit
  changed. ⭐ *Both diff layouts*: `lib/sidebyside.ts`, remembered per person. Single-column and split views
  checked on rendered DOM. ⭐ *Bars under the 3D plot's marks*: isometric scatter mark stands on a bar over its
  floor position (`lib/plot3d.ts`). ⭐ *TOOK folded to two rows at 100% zoom*: allocated width widened across
  table headers (`FROM`, `DEP`, `QUALITY`).
- **Credits off is four situations, and the row now says which one (t408, 2026-09-13).** ⭐ Measured on
  `ClaudeFirst` off Claude Code 2.1.270: usage credits were **on** at the vendor
  (`hasExtraUsageEnabled: true`, `user_disabled: false`) and the row still read *Vendor reports credits
  off.* — because `used_credits` ($20.57) had passed `monthly_limit` ($17.30), so the vendor cut them
  until the refill (`spend_limit_reached: true`, `org_level_disabled_until`). The parse was never wrong:
  **one sentence covered four causes**, and the only actionable one here is a date.
  [`src/shared/credits.ts`](src/shared/credits.ts) now holds the single judgement — `creditsMismatchKind`,
  `creditsMismatchNote`, `creditGaugeVisible`, and `creditsPurseEmpty` moved out of `workers.ts` so the
  row and the dispatch gate cannot disagree — and `CreditStatus.spendLimitReached` outranks the
  `used >= monthlyLimit` arithmetic. Two hidden faults fell out of the same reading: ⛔ `spendMeters`
  dropped **every** meter on `enabled === false`, ending overage metering at the moment of maximum spend
  (now only the zero-shaped counter is suppressed), and ⛔ the fleet card drew no credit gauge for the
  account with the largest bill on it (now drawn, labelled `spent`). The Doctor warning is raised once
  per *cause* (`CreditsIntent.reportedKind`), which is why the changed cause had gone unsaid.
  ⚠️ L1 only; the new wording and the `spent` gauge have not been driven in the packaged app. See
  [`docs/adapters.md`](docs/adapters.md) for the payload.
- **Two dispatch faults measured off t408 and t410 (2026-09-13).** ⭐ *A sandboxed Codex run cannot
  write a file a sandboxed run wrote*: files owned by `CodexSandboxOffline` keep a dead run's DACL and
  the operator lacks WRITE_DAC on them, so the next run gets *Failed to write file*. `sweepAcls`
  ([`acl.ts`](src/daemon/acl.ts)) replaces every path `icacls /reset` refuses (on **stderr**, which the
  old call discarded) with an operator-owned copy, async — 7.2 s for 19.7k files. ⭐ *A Muse run bridged
  through WSL rewrote ws3's `.git` pointer*, because muse's edit tools cannot follow `gitdir: C:/…`;
  pool pointers are now **relative** and `ensureWorktreePointer` runs `git worktree repair` before every
  park and prepare. ⚠️ Whether muse's `edit_file` accepts the relative pointer is inferred, not measured.
- **Loose ends offers an explicit Delete it, for a branch the operator has decided is not needed.**
  `deleteUnlandedBranch` ([`worktrees.ts`](src/daemon/worktrees.ts)) is `retireStrandedBranch`'s
  destructive sibling: it skips the `ahead === 0` proof, since the point is discarding real commits,
  and keeps the same refusal when a worktree holds the branch.
- **The database backs itself up.** `backup.ts` copies `warmstart.db` into `<dataDir>/backups/` daily
  via `node:sqlite`'s online backup API (WAL-safe), pruning past fourteen days by mtime.
- **Trunk mode: a task can work in the project checkout itself** (t401). `workspaceMode`
  (`worktree` | `trunk`, migration 70) resolves task → project → `worktree`; the composer, the task pane
  and Project Settings set it. Five decisions, each in code and pinned in
  [`trunkmode.test.ts`](src/daemon/trunkmode.test.ts): one trunk task at a time (`claimTrunk`); a
  worktree landing into a busy or dirty trunk goes to **`landing_queued`** and `retryQueuedLandings`
  lands it from the tick; a trunk task is dispatched onto whatever the checkout holds and told
  (`surveyTrunk`); `pull-request` is refused in the trunk; a resting trunk task keeps its lease and
  `sweepTrunkLeases` frees a settled one. ⛔ `parkWorkspace` refuses the project root, and a trunk
  conversation's `land_work` never cuts a next branch. ⚠️ **Not yet driven in the packaged app or with
  a real agent**, and a worktree task with an empty branch can still trip the trunk tripwire while a
  trunk task commits — see [`docs/landing.md`](docs/landing.md#working-in-the-trunk).
- **Repeated compaction and quota tipping loops are prevented (t401, t404).** `decideRevive`
  ([`cacheclock.ts`](src/daemon/cacheclock.ts)) checks `accountRefusal`, `refusalRateLimit` and
  `poolVerdict` before waking a closed conversation to compact, honouring an active task's quota
  override unless the window is fully exhausted; `reviveAndCompact` carries `clock_move_attempts`
  across revives so failures back off instead of looping. Preemption wrap-up falls back to handoff
  where the vendor is refusing, the window is spent without credits, or compaction is off. Suites stub
  CLI presence via `forceInstalled`.
- **macOS build script and test parity.** [`scripts/build-mac.sh`](scripts/build-mac.sh) has the same
  flags and step cache as [`scripts/build-win.ps1`](scripts/build-win.ps1); see
  [`docs/development.md`](docs/development.md) §1. Fixed with it: a probe-lifetime race in
  `test/daemon.test.mjs`, table centring under macOS serif fonts, and child reaping in `test/lib/harness.mjs`.
- **The thread shows the change before you land it.** `task.diffSummary` / `task.diffFile`
  ([`taskdiff.ts`](src/daemon/taskdiff.ts)) read the *same* commits the grader reads. ⛔ Two measured
  git facts are pinned in [`taskdiff.test.ts`](src/daemon/taskdiff.test.ts): `--numstat` without `-z`
  returns non-ASCII paths **C-quoted**, and a bare pathspec **over**-matches — `-- '*.tsx'` returned
  two files where `:(literal)*.tsx` returned none. ⚠️ The `rangeCache` stale-head trap reported during
  the debate **is not real**: rung 3 never calls `rangeCache.set`, so a moving branch is re-resolved.
- **The security model is written down, and the permissive default is now a choice.**
  `permissionModeFor` ([`sessions.ts`](src/daemon/sessions.ts)) puts unattended work on
  `bypassPermissions` — full OS user authority, no approvals raised. Adapters declare
  `policy.headlessAuthority`, projects carry `permission.unattended`, and a `sandboxed-only` project
  **refuses** a bypassing candidate in `scoring.ts` rather than downgrading it into the t250 stall.
  README's **Security model** section says what the two promise-shaped lines actually mean.
- **OS notifications.** Three transitions only (`awaiting_human`, `completed`, `failed`) as changes (`lib/notify.ts`).
- **Debate seats see current code and stay in their role.** `report-only` starts from local landing target; prompts treat submitted text as a question.
- **Squash-merged PRs and report-only tasks under Loose ends.** Retired correctly without leaving false unlanded loose ends (`task_deliveries.retire_blocked`, `commitsOnlyOn`).

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
5. **Run on macOS with a real CLI; this is the launch gate — and now the last one.** The other
   three pre-public blockers (diff review, security model, notifications) landed above; this and
   item 6 are what is left between here and a public release. Local build (`scripts/build-mac.sh`),
   packaged execution, and all test suites (L1–L4) pass cleanly on macOS arm64. Packaged app execution
   and daemon startup are verified locally, but more thorough testing driving real agent tasks in flight
   is needed later. Still to verify in flight: detached daemon startup without system Node under hardened
   runtime, Application Support isolation, Antigravity's Keychain interaction, and Gatekeeper. The signed
   arm64 release cannot be called ready before it.
6. **Execute the signing/release pipeline.** macOS signing and notarisation are decided; required
   secrets are not configured and `.github/workflows/release.yml` has never run. Windows is
   intentionally unsigned initially. Release notes must tell upgraders to uninstall the old app,
   because the `appId` changed.
7. **Record one clean single-account first run.** Install the packaged app on a clean profile, add
   one account, add one project, file a task, review its diff, land it, and write down what
   happened. ⛔ A demonstration, not a feature, and the purest form of the pre-public question —
   items 1–3 mean the basic loop has never been shown end to end against a real agent. Now
   unblocked: there is finally something to look at at the gate.
8. **Post-launch, in the order the t392 debate ranked them:** a first-class OpenCode adapter (the
   generic declarative adapter cannot meter, gets no MCP tools and cannot reap orphans); CI watch
   after `gh pr create` ([`src/daemon/landing.ts`](src/daemon/landing.ts) ~l.1391); an
   update-available check that keeps `publish: null`; a full data-directory export beyond the
   database itself (isolation roots, attachments); and a clone-per-worker or container backend,
   which is the only thing that properly closes both
   the host-authority gap and the shared common-`.git` grant. ⚠️ Deliberately **not** on this list:
   GitHub/Linear/Slack intake, agent-to-agent messaging, kanban, voice, cross-machine sync.
9. **Give Antigravity a real per-worker isolation root.** It shares `~/.gemini` today; changing `HOME`
   must first be proven not to disturb the OS-keyring credential. See [`docs/adapters.md`](docs/adapters.md).
10. **Finish the metering and calibration measurements.** Meter PTY-hosted Codex from rollout data;
   compare small and large quality-review models on the same five tasks; verify the Claude credits
   gauge against one real invoice; and decide whether preempted runs should contribute to estimates.
11. **Increase thread UI coverage where behaviour changes.** Most thread interactions remain
   hand-tested. Extract pure decisions into `src/renderer/src/lib/` first.
12. **Continue the scheduler split only when touching it.** `scheduler.ts` remains about 3,780 lines
   against a ~1,500 target; no extracted module may read a scheduler binding at module evaluation time.

## Open questions and quiet-worker measurements

| Item | Evidence needed | Consequence |
|---|---|---|
| R1: Claude auto-mode classifier cost | Run the same shell-heavy task on a quiet subscription worker in `auto` and `default`; compare quota delta with transcript tokens. | If billed, `auto` cannot remain a free default. |
| R2: tokens per quota percent | Sample `/usage` around known transcript work for each worker/model/tokenizer. | Lets quota gates work in tokens rather than percentages. |
| R4: end-to-end compaction cost | Record a known-size compaction's transcript delta and duration. Six samples exist; `post_tokens` is still null. | Tunes the T+53-minute deadline. |
| R8: controller reply shape | Designate a controller, file a `plan`, drain once, then record whether the validator accepted an answer or used its fallback. | Proves the one M4 path L1 cannot reach. |
| Vertex/Antigravity cache price | Find a published vendor price; do not infer it experimentally. | Keeps `cache.kind: "unpriced"` honest. |
| Expected-idle estimator | Gather real queue data first. | No honest design exists without it. |

Record measurement results, CLI versions and dates in [`docs/cost-model.md`](docs/cost-model.md), then
remove the corresponding row here. R5 is dropped: cross-account transplant needs a second subscription.

## Durable constraints

- A worker is an account; a session is a live process. Quota belongs to the worker, context to the
  session. [`docs/glossary.md`](docs/glossary.md) is authoritative.
- The scheduler spends zero tokens; model judgment is asynchronous and has a deterministic fallback.
- Agents use pooled worktrees, never the trunk — unless the task's workspace mode is `trunk`, which
  holds the single trunk lease. Nothing kills a process by image name or bare PID.
- The renderer treats agent output as untrusted text. No raw HTML.
- Do not trust an agent-session view of `%APPDATA%`: packaged hosts can redirect it. See
  [`docs/development.md`](docs/development.md) §4.
