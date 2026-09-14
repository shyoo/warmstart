# Warmstart — Session Handoff

## Current state — 2026-09-13

Warmstart M0–M6 is implemented. The current branch contains debate mode, quota-aware scheduling,
pooled worktrees, model-aware routing, quality review, remote access, packaging, the completed
Warmstart rename, the three pre-public blockers a three-seat debate on t392 converged on, and atomic
worker/model reassignment: the scheduler cannot resume an explicit Opus choice on an account's Haiku
default between separate UI writes. The maintained reference in [`docs/`](docs/README.md) is the
authority on each subsystem; dated design and incident history belongs in `transient_docs/`, not here.

Baseline (2026-09-13, macOS arm64, measured on `ac37ec7` plus the adapters-guard precondition
committed with it): typecheck, lint, build pass; L1 **3,434 passed, 5 skipped** (197 files); L2
**203 checks** (5 skipped); L3 **427 checks** (2 skipped); L4 `test:pack` **17 checks** against
`release/mac-arm64`. Last CI seen (HEAD `d27a282`, run 34798079433, green on all seven jobs): L2 198
on both runners; L3 **425** on Windows (4 skipped) and **424** on Linux (5 skipped) — the skips name
the screen; L4 19 on Windows, 17 on Linux. ⚠️ CI was disabled by the owner around 2026-09-13; the
two commits after `d27a282` have no runner counts. L4 proves the *package*, not this change's
screens — see remaining work 14.

## Closed in this cleanup

- **CI on `main` is green again (2026-09-13).** The ~30-commit merge `3ff9ffd` never got a run, and
  the first push after it (run 34795442043) failed six task-table checks on both runners. Three
  causes, each measured: a *collapsed* column keeps its geometry and read as an overflow it never
  paints ([`docs/testing.md`](docs/testing.md) §3); three columns sized on macOS were 1–2px under
  their Linux headings, so every width is now the Linux need plus margin and no rung squeezes a
  column; and a 1024px screen cannot stage the container-versus-viewport half of the narrow check,
  which skips there by name. Dep and Took now collapse together at a 660px panel.
- **Cross-platform adapter tests no longer create `C:` in POSIX checkouts (2026-09-13).** The
  cross-adapter API-key test passed `C:/tmp/root` to every adapter; Muse planning creates its prompt
  and XDG roots, and Node treats that spelling as relative on macOS/Linux. The writable fixture now
  lives under the suite's temporary directory and a regression asserts the checkout stays clean.
- **A probe PTY answers the TUI's cursor-position query (t3, 2026-09-13).** Muse Code 1.2.1 writes
  `ESC[6n` at startup and exits 0 at +6.4s unanswered — before `readyMs` — so every `/usage` probe
  read *"the probe session did not start"* on a signed-in, trusted worker (t1's trust fix was in the
  packaged app and was not the cause). `termquery.ts` answers that one request on `probe` PTYs only;
  xterm.js answers it for a watched session. Proven through the real `spawnSession` in
  [`probepty.test.ts`](src/daemon/probepty.test.ts) (red without the wiring). ⚠️ Not yet driven in
  the packaged app: the running daemon hosts this task, so it could not be restarted from here —
  rebuild, press **Refresh** on Muse, and expect *Currently unavailable* until the account completes
  one turn (adapters.md, fault 3).
- **Antigravity CLI commissioning and live quota probe on macOS (2026-09-13).** Standalone OAuth credentials
  live in `~/.gemini/jetski-standalone-oauth-token` and auth user emails in `antigravity-cli/cli.log`.
  `readAntigravityIdentity` previously checked only `google_accounts.json` and `oauth_creds.json`, falsely
  returning `loggedIn: false` when `settings.json` was present. This blocked `mayRefreshUsage`, locking
  the worker into `Antigravity: unknown`. Fixed `readAntigravityIdentity` and `probeIdentity` to inspect
  the token file and log, added a screen-parsed identity sync hook, and verified the live probe in the
  packaged app reads all 4 quota windows (Gemini 5h/7d, Claude/GPT 5h/7d) in 6s.
- **The diff moved out of the thread into a Diff pane (t425, 2026-09-13).** A patch drawn inline got
  the thread column at best and the 300px ledger at worst, which was the report. `DiffPane` is now a
  column of the shell right of the work — its own drag handle (`PaneResizer`), full height, one scroll,
  sticky file headers, every file stacked. The inline **Changes in this task** keeps its file list and
  draws no patch; a file row or *Open in Diff pane* opens the pane there.
- **Claude Code narrates its work, and the Session TUI stopped pretending to be one (t423, 2026-09-13).**
  Tool calls emit declared `StreamEvent.tool_use` (`toolLine`). A fleet setting (`liveNarration`, default
  `summary`) buys word-by-word prose. The Session TUI draws `SessionStream` for a piped session and xterm
  for a PTY one, with **Open a real terminal** (`session.attach`).
- **macOS worktree symlinks, CLI PATH detection, and header metrics (2026-09-13).** Worktree `.git` pointers
  resolve with `fs.realpathSync`, non-Windows GUI launch searches standard user bin paths (`which.ts`),
  and task-table column widths gained 2–8px for macOS font metrics.
- **Global settings are now task-oriented tabs (t422, 2026-09-13).** Tabs: Fleet settings, Notice, Status,
  App behavior, and Remote connection. Phone QR encoder restores fixed dark module.
- **Later pushes reconcile with an earlier local landing (t421, 2026-09-13).** Startup and a five-minute
  sweep fetch first and add a separate *Later observed* thread row when `origin/<target>` contains the commit.
- **One desktop drives another computer's fleet (t419, 2026-09-13).** Desktop picker above Overview,
  `RemoteClient` TLS over Tailnet hostname sealed in `remotes.json`, negotiated RPC version range (±1).
- **Nearby reset preemption guard, versioning, retained locks, composer pill, UI fixes (t410-t418).**
  High-water threshold (92%) for 5h window resets; canonical `version.json`; Flow shows locks in Awaiting;
  composer workspace pill first; credit gauges and DACL `sweepAcls` repair on Windows.
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
