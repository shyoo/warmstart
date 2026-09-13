# Warmstart — Session Handoff

## Current state — 2026-09-13

Warmstart M0–M6 is implemented. The current branch contains debate mode, quota-aware scheduling,
pooled worktrees, model-aware routing, quality review, remote access, packaging, the completed
Warmstart rename, and the three pre-public blockers a three-seat debate on t392 converged on:
**in-app diff review**, an **honest security model with a per-project containment setting**, and
**desktop notifications**. The maintained reference in [`docs/`](docs/README.md) is the authority on
each subsystem; dated design and incident history belongs in `transient_docs/`, not here.

Baseline (2026-09-13, Windows, measured **after** t423): typecheck, lint, build pass; L1
**3,409 passed, 2 skipped** (193 files); L2 **203 checks** (5 skipped); L3 **421 checks**; L4
`test:pack` **19 checks**, re-run after repackaging. ⚠️ L4 proves the *package*, not this change's
screens — see remaining work 14. ⚠️ The macOS arm64 baseline (L1 **3,367 passed, 12 skipped**; L2
**198**; L3 **419**; L4 **17**) was taken **before** t423 and has not been re-run on it.

## Closed in this cleanup

- **Claude Code narrates its work, and the Session TUI stopped pretending to be one (t423,
  2026-09-13).** ⛔ It was our decoder, not the CLI: `textBlocks` kept only `type: "text"` blocks, so
  a prose-less `assistant` record decoded to `other` and reached nobody — measured on a real
  1,679-record session, **1,310 (78%) carried no text block at all** (814 tool calls, 496 thinking).
  Tool calls are now a declared `StreamEvent.tool_use` on both adapters, in one vocabulary
  (`toolLine`) that `activity.proseOf` already filters. ⛔ The **thinking words do not exist**:
  `thinking: ""` in the stream, with `--include-partial-messages` and without, and 490 of 496 empty
  in the transcript — what is free is `system/thinking_tokens`, an estimate, with no flag. A fleet
  setting (`liveNarration`, default `summary`) turns on partial output where an adapter declares
  `streamsPartialOutput`; it buys word-by-word prose at ~10× the stream lines and nothing else.
  The Session TUI tab now draws `SessionStream` (decoded records, collapsible) for a piped session
  and the real xterm for a PTY one, with **Open a real terminal** (`session.attach`) beside it —
  always a **fork**, so the run carries on and the original stays resumable
  (`--resume <old> --fork-session --session-id <new>`, measured: minted id honoured, 31,372 tokens
  read from cache). ⛔ **Work stays on pipes**: `rate_limit_event` exists only in stream-json output
  and nowhere in the transcript, so a full-TUI work session would go quota-blind.
  ⭐ Two live bugs fell out of the same root cause — raw bytes written at a `stream-json` stdin, which
  corrupts the next message and **exits the CLI 1** (measured; the control run exited 0): *take the
  keyboard* on a dispatched task ended the run on the first character, and `askForWrapUp` wrote its
  prompt with a carriage return, so **every soft cancel of a dispatched task** timed out at 90s
  logging *did not wrap up in time* about a prompt the agent had never seen. ⭐ And a third finding
  wired in: `rate_limit_info.unifiedWindows` carries a live utilization per window on every turn
  (`QuotaSnapshot.source: 'stream'`), where the only other source is a cache measured 19 days stale.
  ⚠️ **L1 only — none of the UI has been driven in the packaged app**, and whether `unifiedWindows`
  names an Opus window is unverified (the publish guard makes being wrong cost nothing). Decisions:
  [`transient_docs/live_narration_2026-09-13.md`](transient_docs/live_narration_2026-09-13.md).
  ⚠️ It also carries **four L3 checks t422 left red**: splitting Global into tabs moved the tray
  switch, the fleet finish picker and the Projects table behind three different tabs, and
  `test/ui.test.mjs` still looked at whichever tab Global happened to remember. Each section names
  its tab now — the controls were never gone.
- **Remote listener auto-retries Tailscale every 60s (2026-09-13).** A reboot starts the app before
  the Tailscale service, so the one-shot probe saw none and the listener stayed down until somebody
  clicked *Re-check Tailscale*. A 60-second `setInterval` in `startRemoteServer`
  ([`src/daemon/remote/server.ts`](src/daemon/remote/server.ts)) re-probes while `remoteListening()`
  is true and `live` is null; it is a no-op once the listener is up and is cleared on `close()`.
- **macOS worktree symlinks, CLI PATH detection, and header metrics (2026-09-13).** Worktree `.git`
  pointers resolve with `fs.realpathSync`, or a temp dir crossing macOS's `/var` → `/private/var`
  symlink breaks relative traversal (`worktrees.ts`). A non-Windows GUI launch searches the standard
  user bin paths (`which.ts`), and task-table column widths gained 2–8px for macOS font metrics.
- **Global settings are now task-oriented tabs (t422, 2026-09-13).** Global opens on **Fleet settings**; Notice isolates doctor warnings, Status holds daemon/CLI/worker/cost-model facts and Projects, App behavior holds window preferences, and Remote connection orders Tailscale, project access, desktop and phone pairing. Adding a remote computer is modal. The phone QR encoder now restores QR's fixed dark module after format placement; it was previously overwritten for some masks and could not be read by a camera. ⚠️ Landed without `npm run test:ui`, which the tab split broke in four places; t423 repaired it.

- **Later pushes reconcile with an earlier local landing (t421, 2026-09-13).** A landing message
  remains an honest record of what its own strategy did. When `origin/<target>` later contains its
  commit, startup and a five-minute sweep fetch first and add a separate *Later observed* thread row;
  they never rewrite history or claim the tool made the operator's push.
- **One desktop drives another computer's fleet (t419, 2026-09-13).** A picker above Overview lists
  *This computer* and paired remotes; `Root` re-keys `App` on a switch. Main's `RemoteClient`
  reaches the remote's existing listener with a **desktop** credential: its own *Allow paired
  desktops* switch, TLS on the tailnet hostname only, sealed by `safeStorage` in `remotes.json`.
  RPC versions are a negotiated range capped at ±1 (`shared/rpcversion.ts`).
- **A nearby reset no longer preempts healthy work (t418, 2026-09-13).** Early wrap-up now needs its model pool at high-water (92% for five-hour windows), not just t416's `config cache` reset; refusal and the 95% active-overrun guard remain separate.
- **Pages and Routing Model tables stay centred (t417); the task table's narrow columns really drop
  (t415).** `.tbl--paper` is a fit-content block with `overflow-x: auto`; centring check measures
  client box. A dropped task column is `visibility: collapse; width: 0` so cells stay in DOM without gap.
- **Canonical versioning and verified release download (t416, 2026-09-13).** `version.json` names
  the release and repo; build rejects mismatches. Packaged app polls GitHub Releases, verifies
  `SHA256SUMS.txt`, and stages download in `<dataDir>/updates/`.
- **Show retained workspace locks in Flow (t413, 2026-09-13).** An `awaiting_human` ticket stays in
  Awaiting and names the workspace it still locks, rather than pinning under Running or hiding the lock.
- **Composer workspace pill first, purple pending-PR dot, split thread bubbles on a mid-flight reply
  (t414, 2026-09-13).** See `lib/threadbubble.ts` and `delivery.pending`.
- **Five UI reports off t410 (2026-09-13).** **Changes in this task** is drawn wherever the change
  resolves, not only at `awaiting_human`; each commit links its own `<sha>^!` diff behind the same
  double gate; side-by-side layout (`lib/sidebyside.ts`); bars under 3D marks (`lib/plot3d.ts`).
- **Credits off is four situations, and the row now says which one (t408, 2026-09-13).** Measured on
  Claude Code 2.1.270: `hasExtraUsageEnabled: true` with `spend_limit_reached: true` reports exact cause
  and refill date (`creditsMismatchKind`, `src/shared/credits.ts`). Spend meters keep non-zero counters;
  fleet card draws spent credit gauge. Detail in [`docs/adapters.md`](docs/adapters.md).
- **Two dispatch faults measured off t408 and t410 (2026-09-13).** ⭐ *A sandboxed Codex run cannot
  write a file a sandboxed run wrote* — a dead run's DACL the operator cannot rewrite; `sweepAcls`
  ([`acl.ts`](src/daemon/acl.ts)) replaces every path `icacls /reset` refuses (on **stderr**, which the
  old call discarded), 7.2 s for 19.7k files. ⭐ *A Muse run bridged through WSL rewrote ws3's `.git`
  pointer*; pool pointers are now **relative** and `ensureWorktreePointer` repairs before every park.
  ⚠️ Whether muse's `edit_file` accepts the relative pointer is inferred, not measured.
- **Loose ends offers Delete it** (`deleteUnlandedBranch`, on a confirmed click only); **the database
  backs itself up** (`backup.ts`, daily, 14-day prune).
- **Trunk mode: a task can work in the project checkout itself** (t401). `workspaceMode`
  (`worktree` | `trunk`, migration 70) resolves task → project → `worktree`. Five decisions pinned in
  [`trunkmode.test.ts`](src/daemon/trunkmode.test.ts): one trunk task at a time; a worktree landing
  into a busy or dirty trunk goes to **`landing_queued`**; a trunk task is dispatched onto whatever
  the checkout holds and told; `pull-request` is refused there; a resting trunk task keeps its lease.
  ⚠️ **Not driven in the packaged app** — [`docs/landing.md`](docs/landing.md#working-in-the-trunk).
- **Repeated compaction and quota tipping loops are prevented (t401, t404).** `decideRevive`
  ([`cacheclock.ts`](src/daemon/cacheclock.ts)) checks refusal and pool state before waking a closed
  conversation to compact; `reviveAndCompact` backs off across revives. Preemption wrap-up falls back
  to handoff where the vendor is refusing or the window is spent.
- **macOS build script parity.** [`scripts/build-mac.sh`](scripts/build-mac.sh) mirrors `build-win.ps1`.
- **The thread shows the change before you land it.** `task.diffSummary` / `task.diffFile`
  ([`taskdiff.ts`](src/daemon/taskdiff.ts)) read the *same* commits the grader reads. ⛔ Two measured
  git facts are pinned in [`taskdiff.test.ts`](src/daemon/taskdiff.test.ts): `--numstat` without `-z`
  returns non-ASCII paths **C-quoted**, and a bare pathspec **over**-matches.
- **The security model is written down, and the permissive default is a choice.** `permissionModeFor`
  ([`sessions.ts`](src/daemon/sessions.ts)) puts unattended work on `bypassPermissions` — full OS user
  authority. Adapters declare `policy.headlessAuthority`, projects carry `permission.unattended`, and
  a `sandboxed-only` project **refuses** a bypassing candidate rather than downgrading it into t250's
  stall. README's **Security model** says what it means.
- **Debate seats see current code and stay in their role**; **squash-merged PRs and report-only tasks
  retire under Loose ends** without leaving false unlanded ends (`task_deliveries.retire_blocked`).

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
5. **Run on macOS with a real CLI; this is the launch gate.** Local build, packaged execution and
   L1–L4 pass on macOS arm64; driving real agent tasks in flight does not. Still to verify: detached
   daemon startup without system Node under hardened runtime, Application Support isolation,
   Antigravity's Keychain interaction, and Gatekeeper. The signed arm64 release waits on it.
6. **Execute the signing/release pipeline.** macOS signing and notarisation are decided; required
   secrets are not configured and `.github/workflows/release.yml` has never run. Windows is
   intentionally unsigned initially. Release notes must tell upgraders to uninstall the old app,
   because the `appId` changed.
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
- The renderer treats agent output as untrusted text. No raw HTML.
- Do not trust an agent-session view of `%APPDATA%`: packaged hosts can redirect it. See
  [`docs/development.md`](docs/development.md) §4.
