# Warmstart — Session Handoff

## Current state — 2026-09-14

Warmstart M0–M6 is implemented. The current branch contains debate mode, quota-aware scheduling,
pooled worktrees, model-aware routing, quality review, remote access, packaging, the completed
Warmstart rename, the three pre-public blockers a three-seat debate on t392 converged on, and atomic
worker/model reassignment: the scheduler cannot resume an explicit Opus choice on an account's Haiku
default between separate UI writes. The maintained reference in [`docs/`](docs/README.md) is the
authority on each subsystem; dated design and incident history belongs in `transient_docs/`, not here.

Baseline (2026-09-14, **Windows 11 x64**, measured on this branch's tip): typecheck, lint, build
pass; L1 **3,439 passed, 4 skipped** (197 files); L2 **203 checks** (5 skipped); L3 **439 checks**.
⚠️ L4 `test:pack` was **not run here** — the previous macOS reading (17 checks against
`release/mac-arm64`, 2026-09-13 on `ac37ec7`) is the last one. ⚠️ One L3 flake seen and not reproduced: a stale
`.git/worktrees/convo-ws1/index.lock` left by an interrupted run failed *the landing this section
needs actually landed*; a clean re-run was green. Last CI seen (HEAD `d27a282`, run 34798079433, green on all seven jobs): L2 198
on both runners; L3 **425** on Windows (4 skipped) and **424** on Linux (5 skipped) — the skips name
the screen; L4 19 on Windows, 17 on Linux. ⚠️ CI was disabled by the owner around 2026-09-13; the
two commits after `d27a282` have no runner counts.

## Closed in this cleanup

- **Global › Status no longer repeats Notice's warnings (t433, 2026-09-14);** only Notice lists them.
- **Muse reasoning-effort choices are available end to end (2026-09-14).** The catalogue offers
  `none`, `minimal`, `low`, `medium`, `high`, `xhigh` and `ultra`; controls pass them to Muse. ⚠️ The regression test rejects retired `max`.
- **Three settings faults the operator hit driving a remote machine (t431, 2026-09-14).**
  ⭐ *The reorder arrows could not be clicked, and vanished on hover.* The workers table re-lays its
  rows out as cards where the order cell and the worker cell are given the **same grid area**; overlaps
  paint in tree order, so the worker cell was on top for hit-testing, and `.tbl tr:hover td` gave it a
  background that painted over the arrows too. The cell is now `position: relative; z-index: 1`.
  ⛔ Every DOM-level check was green through all of it, including one that clicks the arrow and watches
  the daemon reorder the fleet: a scripted `.click()` bypasses hit-testing. The new check asks
  `elementFromPoint` and printed `worker-cell` before the fix ([`docs/testing.md`](docs/testing.md) §3).
  ⭐ *A sign-in runs beside the credential, not beside the operator.* Commissioning while driving
  another computer opened the vendor's OAuth browser on **that** computer's screen while the Sign in
  terminal here waited. `SignInLocationWarning` (above *Create and sign in*, and again in the Sign in
  panel) names the machine when one is selected, and otherwise states the rule for an RDP/VNC operator
  to apply — the app cannot detect that case. [`docs/remote.md`](docs/remote.md).
  ⭐ *A host left running to take work slept mid-run.* `preventSleep` (`UiSettings`, **default on**,
  the only App-behavior switch that is) holds a `powerSaveBlocker('prevent-app-suspension')`, applied
  at launch as well as on change. ⚠️ Idle sleep only — not a closed lid, and the copy says so.
  ⛔ Per-install, so the setting deciding whether a run survives the night is the **host's**. ⚠️ None of the three driven in the packaged app.
- **The thread ledger reads as one list (2026-09-13).** Operational facts lead;
  created/directory/landing take clearer labels; the stopped-task control matches the small setting
  controls; run prompt and activity references open compact dialogs rather than boxed disclosures; and
  the model row separates the latest run from next-run choices, cache-risk copy behind its info control.
- **Quality Review's copy and tile labels read as one page (t430, 2026-09-13).** The paragraphs under
  *Commission a batch* had no width limit while the panel subtitle was capped at 62ch, so one page read
  two widths of prose; a new `.prose-note` holds both to 62ch. The four count tiles were named by
  review-count bucket, but the operator-relevant question is eligibility — they now read *Gradable
  tasks with 0 reviews / only 1 review / 2+ reviews* and *Non-gradable tasks*.
- **The three-axis plot trusts its own data and remembers its filter (t429, 2026-09-13).**
  `measuredModelPoints` drops any model whose weakest axis is under `MIN_TRUSTED_SAMPLES` (5); the
  "Exclude API rate & mixed" checkbox persists via `lib/prefs.ts`; and each axis's low-end label moved
  off the shared origin point, which had drawn three strings stacked into garbled text.
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
- **Antigravity CLI commissioning and live quota probe on macOS (2026-09-13).** Standalone OAuth
  credentials live in `~/.gemini/jetski-standalone-oauth-token` and auth emails in
  `antigravity-cli/cli.log`; `readAntigravityIdentity` read neither, returned a false
  `loggedIn: false`, and so blocked `mayRefreshUsage` — locking the worker into
  `Antigravity: unknown`. It and `probeIdentity` now read both, and the live packaged probe read all
  4 quota windows in 6s.
- **The diff moved out of the thread into a Diff pane (t425, 2026-09-13).** `DiffPane` is a column of
  the shell right of the work — its own drag handle, full height, one scroll, sticky file headers.
  The inline **Changes in this task** keeps its file list and draws no patch.
- **Claude Code narrates its work, and the Session TUI stopped pretending to be one (t423, 2026-09-13).**
  Tool calls emit declared `StreamEvent.tool_use`; `liveNarration` (default `summary`) buys word-by-word
  prose; the Session TUI draws `SessionStream` for a piped session and xterm for a PTY one.
- **t410–t422, all landed and all documented in [`docs/`](docs/README.md) (2026-09-13).** macOS
  worktree symlink resolution and GUI-launch PATH search; Global settings split into task-oriented
  tabs; *Later observed* reconciliation when a push lands after a local landing; one desktop driving
  another computer's fleet (picker above Overview, TLS over the Tailnet hostname, RPC range ±1); the
  92% high-water preemption guard, canonical `version.json`, retained locks in Flow's Awaiting, the
  composer workspace pill, credit gauges and `sweepAcls`.
- **Two dispatch faults measured off t408 and t410 (2026-09-13).** ⭐ *A sandboxed Codex run cannot
  write a file a sandboxed run wrote* — a dead run's DACL; `sweepAcls` ([`acl.ts`](src/daemon/acl.ts))
  replaces every path `icacls /reset` refuses (on **stderr**, which the old call discarded), 7.2 s for
  19.7k files. ⭐ *A Muse run bridged through WSL rewrote ws3's `.git` pointer*; pool pointers are now
  **relative**. ⚠️ Whether muse's `edit_file` accepts that is inferred, not measured.
- **Loose ends offers Delete it** (`deleteUnlandedBranch`, on a confirmed click only); **the database
  backs itself up** (`backup.ts`, daily, 14-day prune).
- **Trunk mode: a task can work in the project checkout itself** (t401). `workspaceMode`
  (`worktree` | `trunk`, migration 70); five decisions pinned in
  [`trunkmode.test.ts`](src/daemon/trunkmode.test.ts).
  ⚠️ **Not driven in the packaged app** — [`docs/landing.md`](docs/landing.md#working-in-the-trunk).
- **Repeated compaction and quota tipping loops are prevented (t401, t404).** `decideRevive`
  ([`cacheclock.ts`](src/daemon/cacheclock.ts)) checks refusal and pool state before reviving to
  compact; preemption wrap-up falls back to handoff where the window is spent.
- **The thread shows the change before you land it.** `task.diffSummary` / `task.diffFile`
  ([`taskdiff.ts`](src/daemon/taskdiff.ts)) read the *same* commits the grader reads; two measured git
  facts are pinned in [`taskdiff.test.ts`](src/daemon/taskdiff.test.ts).
- **The security model is written down, and the permissive default is a choice.** `permissionModeFor`
  ([`sessions.ts`](src/daemon/sessions.ts)) puts unattended work on `bypassPermissions` — full OS user
  authority — and a `sandboxed-only` project **refuses** a bypassing candidate rather than downgrading
  it into t250's stall. README's **Security model** says what it means.
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
