# Warmstart — Session Handoff

## Current state — 2026-09-12

Warmstart M0–M6 is implemented. The current branch contains debate mode, quota-aware scheduling,
pooled worktrees, model-aware routing, quality review, remote access, packaging, the completed
Warmstart rename, and the three pre-public blockers a three-seat debate on t392 converged on:
**in-app diff review**, an **honest security model with a per-project containment setting**, and
**desktop notifications**. The maintained reference in [`docs/`](docs/README.md) is the authority on
each subsystem; dated design and incident history belongs in `transient_docs/`, not here.

Last full local validation on this branch (2026-09-12): `npm run typecheck`, `npm run lint`,
`npm test` (**3,251 passed, 12 skipped**), and `npm run build` all passed.
Expected test warnings exercise refusal and recovery paths; they are not failures.

## Closed in this cleanup

- **Trunk mode: a task can work in the project checkout itself** (t401). t400 had an agent pull
  `main` and resolve a conflict by way of a task branch, which confused it and left a branch to clean
  up. `workspaceMode` (`worktree` | `trunk`, migration 70) resolves task → project → `worktree`; the
  composer, the task pane and Project Settings set it. Five decisions taken with the operator, each in
  code and pinned in [`trunkmode.test.ts`](src/daemon/trunkmode.test.ts): one trunk task at a time
  (`claimTrunk`, a one-member resource separate from the pool); a worktree landing into a busy or dirty
  trunk goes to the new **`landing_queued`** status and `retryQueuedLandings` lands it from the tick; a
  trunk task is dispatched onto whatever the checkout holds and told (`surveyTrunk`,
  `trunkArrivalNotice`); `pull-request` is refused in the trunk; a resting trunk task keeps its lease and
  `sweepTrunkLeases` frees a settled one. Its finish is `decideTrunkFinish` and its landing the `trunk`
  strategy (verify in place, push if asked). ⛔ `parkWorkspace` refuses the project root, and a trunk
  conversation's `land_work` never cuts a next branch. Flow draws the trunk as the first row, labelled
  `main`. Separately, bare `http(s)` URLs in thread messages are now links, so a PR headline opens in
  the browser. ⚠️ **Not yet driven in the packaged app or with a real agent**, and a worktree task with
  an empty branch can still trip the trunk tripwire while a trunk task commits — see
  [`docs/landing.md`](docs/landing.md#working-in-the-trunk).
- **Repeated compaction and quota tipping loops are prevented (t401, t404).** `decideRevive`
  in [`src/daemon/cacheclock.ts`](src/daemon/cacheclock.ts) now checks `accountRefusal`, `refusalRateLimit`,
  and `poolVerdict` blocking thresholds before waking a closed conversation for compaction. When quota
  is blocking, an active task quota override is honored unless the window is 100% exhausted.
  `reviveAndCompact` preserves and increments `clock_move_attempts` across revive cycles so failed
  compactions back off after `MAX_MOVE_ATTEMPTS` instead of looping indefinitely on cleared attempts.
  Preemption wrap-up in [`src/daemon/scheduler.ts`](src/daemon/scheduler.ts) falls back to handoff when
  the vendor is refusing turns, the window is exhausted without credits, or compaction is disabled, and
  an unlanded preemption compaction preserves the clock move record. Suites stub `claude-code` presence
  via `forceInstalled` in [`revivecompact.test.ts`](src/daemon/revivecompact.test.ts) and
  [`taskcompact.test.ts`](src/daemon/taskcompact.test.ts) so tests evaluate compaction logic without
  requiring vendor CLIs on disk.
- **A running Antigravity model cannot inherit another model pool's preemption.** The watchdog now
  reads the session's actual model and `windowResetsAt` prefers its stored pool boundary over an
  unqualified worker record, so a low-use Gemini run does not offer **Override preemption** because
  Claude/GPT is near its own reset. Regression coverage pins both the closing-window and high-water
  cross-contamination cases, including a task edited for a future Claude/GPT run.
- **Debate positions expose their stated confidence.** `task.debateState` uses the same conservative
  prose extractor the organizer prompt uses and the board leads each response with an accented
  metadata table. Missing confidence says **Not stated**; arbitrary formats remain the seat's own
  text rather than being converted into a number Warmstart cannot justify.
- **The abandoned t397.2 worktree was reclaimed without losing work.** On 2026-09-12,
  `warmstart/t397.2-t389-was-completed-with-making-pull-requ` resolved to `f522c5e`, the same
  commit as `origin/main`; it had no branch-only diff or commits, no stash entry, and a reflog
  containing only its creation. There was therefore nothing to land or discard.
- **macOS build script and test parity.** [`scripts/build-mac.sh`](scripts/build-mac.sh) delivers parity with
  [`scripts/build-win.ps1`](scripts/build-win.ps1) (content-addressed step cache in `.build-cache/`, process
  safety checks, `--restart`, `--quick`, `--installer`, `--skip-tests`, `--fresh`, `--stop-daemon`, `--stop-agents`).
  Fixed probe lifetime race in [`test/daemon.test.mjs`](test/daemon.test.mjs) (`AGENT_PROBE_ARGV` keeps probe open
  until explicit close), table centring overflow under macOS serif fonts in [`src/renderer/src/styles/app.css`](src/renderer/src/styles/app.css)
  (`--paper-measure: max(80ch, 780px)`), and child process reaping / architecture detection in
  [`test/lib/harness.mjs`](test/lib/harness.mjs) and [`test/pack.test.mjs`](test/pack.test.mjs).
- **The thread shows the change before you land it.** `task.diffSummary` and `task.diffFile`
  ([`src/daemon/taskdiff.ts`](src/daemon/taskdiff.ts)) read the *same* commits the grader reads —
  `resolveRange` picks them, and `collectDiff` was split into `numstatEntries`/`patchFor` so both
  callers see one file set. `thread/DiffPanel.tsx` draws it at the `awaiting_human` gate. ⛔ Two
  measured git facts are pinned in [`taskdiff.test.ts`](src/daemon/taskdiff.test.ts): `--numstat`
  without `-z` returns non-ASCII paths **C-quoted** (`"cafÃ©.txt"`), and a bare pathspec
  **over**-matches — `-- '*.tsx'` returned two files where `:(literal)*.tsx` returned none.
  ⚠️ The `rangeCache` stale-head trap reported during the debate **is not real**: rung 3 returns the
  branch answer without ever calling `rangeCache.set`, so a moving branch is re-resolved every time.
  The test pins that rather than the reasoning.
- **The security model is written down, and the permissive default is now a choice.**
  `permissionModeFor` ([`src/daemon/sessions.ts:720`](src/daemon/sessions.ts)) puts unattended work
  on `bypassPermissions` (claude-code) and `--dangerously-skip-permissions` (antigravity) — full OS
  user authority, no approvals raised. Adapters now declare `policy.headlessAuthority`, projects
  carry `permission.unattended`, and a `sandboxed-only` project **refuses** a bypassing candidate in
  `scoring.ts` rather than downgrading it into the t250 stall. README has a **Security model**
  section; the two lines that read as a security promise (*Isolated workspaces*, *Approvals, not
  interruptions*) now say what they actually mean.
- **OS notifications.** Three transitions only — `awaiting_human`, `completed`, `failed` — and only
  as a *change*, so attaching to a daemon that worked while the app was closed stays silent.
  `lib/notify.ts` holds the rule; main owns `Notification` and the window a click raises.
- **Debate seats see current code and stay in their role.** `report-only` work starts from the local
  landing target, and seat prompts treat the submitted text as a question. See
  [`transient_docs/debate_mode_2026-09-12.md`](transient_docs/debate_mode_2026-09-12.md) §12.
- **A squash-merged pull request no longer sits under Loose ends as "not landed".** ⭐ Measured on
  t389 (2026-09-12): the sweep had already recorded PR #139 `merged`, but the operator's trunk
  `C:\Dev\awardtracker` had the branch checked out, so retirement refused — silently, every five
  minutes — while the panel offered **Land it**. Now: a new `merged` loose-end kind with **Clean up**
  and a panel-wide **Check merged PRs**; an idle clean pool member is stepped off the branch, the
  operator's checkout never is; the reason is kept (`task_deliveries.retire_blocked`, migration 69)
  and said on the thread once. Same task: gh's "already exists" error quotes the command line, and
  the first-URL rule recorded `…/issues/133` as a delivery — `pullRequestUrlIn` takes only the last
  `/pull/<n>`, and migration 69 deletes such rows. ⚠️ The two panel buttons are covered by no UI test and
  have not been driven in the packaged app; the daemon side is tested against real git.
- **A report-only task (every debate seat) leaves nothing under Loose ends.** ⭐ Measured first:
  t393–t395 made **no** commits — each branch sat on local `main` at `4619e6f`, which was 15 ahead of
  `origin/main`, and the scan counted against the remote alone. Now `commitsOnlyOn`
  ([`worktrees.ts`](src/daemon/worktrees.ts)) counts what deleting a branch would lose; a report-only
  `done` requires a clean tree with no commit of its own and **retires the branch**; anything left is
  asked back once, then `await-human` (⚠️ which holds a debate round — deliberate, see
  [`docs/landing.md`](docs/landing.md)); and the closing prompt no longer tells such a task to commit,
  squash or rebase. ⚠️ The scheduler wiring (measure + retire in `landCompletion`) has no L2 test —
  no harness drives `completeTask` with a held git workspace; the decision and the measure are tested.
- **The reported Luna `task_complete` defect is closed.** Codex has no per-session MCP registration
  (`mcp: false`), so the old universal seat wording was wrong.
- **The t382 organizer capacity leak is closed.** A debate organizer winds down its run and session
  after sending round briefs or splitting work.

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
   update-available check that keeps `publish: null`; backup/export of the data directory (no such
   path exists today — task history, transcripts and cost evidence are one lost laptop from gone);
   and a clone-per-worker or container backend, which is the only thing that properly closes both
   the host-authority gap and the shared common-`.git` grant. ⚠️ Deliberately **not** on this list:
   GitHub/Linear/Slack intake, agent-to-agent messaging, kanban, voice, cross-machine sync.
9. **Give Antigravity a real per-worker isolation root.** It currently shares `~/.gemini`; changing
   `HOME` must first be proven not to disturb the OS-keyring credential. See [`docs/adapters.md`](docs/adapters.md).
10. **Finish the metering and calibration measurements.** Meter PTY-hosted Codex from rollout data;
   compare small and large quality-review models on the same five tasks; verify the Claude credits
   gauge against one real invoice; and decide whether preempted runs should contribute to estimates.
11. **Increase thread UI coverage where behaviour changes.** The add-project wizard, project settings,
   conversations, session TUI, routing pages and selected thread rows are exercised; most thread
   interactions remain hand-tested. Extract pure decisions into `src/renderer/src/lib/` first.
12. **Continue the scheduler split only when touching it.** `scheduler.ts` remains about 3,780 lines
   against a ~1,500 target. Existing seams import back from it, so no extracted module may read a
   scheduler binding at module evaluation time.

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
remove the corresponding row here. R5 is intentionally dropped: resume is measured and shipped
within one account; cross-account transplant needs a second subscription.

## Durable constraints

- A worker is an account; a session is a live process. Quota belongs to the worker, context to the
  session. [`docs/glossary.md`](docs/glossary.md) is authoritative.
- The scheduler spends zero tokens; model judgment is asynchronous and has a deterministic fallback.
- Agents use pooled worktrees, never the trunk — unless the task's workspace mode is `trunk`, which
  holds the single trunk lease. Nothing kills a process by image name or bare PID.
- The renderer treats agent output as untrusted text. No raw HTML.
- Do not trust an agent-session view of `%APPDATA%`: packaged hosts can redirect it. See
  [`docs/development.md`](docs/development.md) §4.
