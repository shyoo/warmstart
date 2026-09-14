# Warmstart — Session Handoff

## Current state — 2026-09-14

Warmstart M0–M6 is implemented, including debate mode, quota-aware scheduling, pooled worktrees,
model-aware routing, quality review, remote access, packaging, and atomic worker/model reassignment.
The maintained reference in [`docs/`](docs/README.md) is the
authority on each subsystem; dated design and incident history belongs in `transient_docs/`, not here.

Baseline (2026-09-14, **Windows 11 x64**, measured on this branch's tip): typecheck, lint, build
pass; L1 **3,454 passed, 4 skipped** (197 files); L2 **203 checks** (5 skipped); L3 **440 checks**;
L4 **19 checks** against `release/win-unpacked`. Last CI seen (HEAD `d27a282`, run 34798079433,
green on all seven jobs): L2 198 on both runners; L3 **425** on Windows (4 skipped) and **424** on
Linux (5 skipped) — the skips name the screen; L4 19 on Windows, 17 on Linux. ⚠️ CI was disabled by
the owner around 2026-09-13; the commits after `d27a282` have no runner counts.

## Closed in this cleanup

- **Retire it / Delete it no longer refuse a branch sitting in an idle pool member (t444, 2026-09-14).**
  `retireStrandedBranch` and `deleteUnlandedBranch` refused any branch a worktree held, full stop —
  even a finished task's own unclaimed, clean pool-member slot, which is exactly what `parkWorkspace`
  would detach anyway. The merged-PR sweep (`deliveries.ts`) already had this exception; the new
  `idlePoolHolder` in [`worktrees.ts`](src/daemon/worktrees.ts) is the shared question both now ask —
  still refusing the operator's own trunk, a claimed slot, or a dirty one, stepping off (`git switch
  --detach`) only what a park would.
- **The controller's label consult stopped dropping itself as "overtaken" (t440, 2026-09-14).**
  `questionStillStands` had no branch for the `title` kind and fell through to `triage`'s gate —
  `awaiting_human` or `failed` only — so a label asked about a task doing its ordinary work (`ready`,
  `assigned`, `running`) was dropped before the controller was ever asked, reading as nearly every
  label consult failing. It now stands until `completed`, `cancelled` or `failed`, matching
  `askForTitle`. ⚠️ The Enter-key report in the same task was not a code bug: `isSubmitKey` is
  correct and identically wired in every composer; the Ctrl+Enter preference had reset because
  `ui-settings.json` only survives an `agentyard` → `Warmstart` productName change if the old
  install's data directory is still on disk when the new build first runs — item 6's known cost.
- **The Attention bar no longer offers answer buttons for a question it cannot show (t441, 2026-09-14).**
  `answerableHere` checked only option count/length, so a long question with short options rendered
  inline while `.approvals-what` truncated the text — answerable blind. It now also requires the
  full question fit in 100 characters, else falls back to **Answer…**.
- **The live thread tail named landing correctly (t438, 2026-09-14).** A task with `task.landing`
  true still counted as `live` output because `showsLiveOutput` only looks at `status`, so the empty
  tail read *"waiting for the agent's first words…"* while the agent had already finished and the
  branch was rebasing, verifying or merging. `Thread` now takes a `landing` prop and swaps the
  placeholder to *"landing — rebasing, verifying and merging…"* when it is set.
- **Thread controls (t437, 2026-09-14).** Stop is a compact red `.task-stop` beside the status;
  `.dep-remove` lost its oversized minimums; the Statistics toggle is a `SettingSwitch`.
- **Muse could not grade anything, and the app would not say why (t436, 2026-09-14).** Muse Code
  1.1.1 reads `<workspace>/.codex/skills` at startup and exits 1 in ~4.5s against a non-directory
  (`runtime host failed to start: … Not a directory (os error 20)`, stderr, stdout empty). This
  repo's `.codex` symlink, added 2026-09-13, is a seven-byte **file** on a `core.symlinks=false`
  checkout — so every Muse review in the 06:19 batch failed. ⭐ Measured three ways against the live
  CLI: absent starts, directory starts, file dies. `.codex` is now local-only
  (`scripts/link-agent-skills.mjs`, gitignored, junction on Windows). ⛔ The second half is the one
  that generalises: a `stream` session's non-protocol stderr was dropped by `StreamParser`, so both
  the reviewer and `onSessionExit` reported an unexplained death. `sessionDiagnostics` keeps a
  bounded tail and both now quote it. ⚠️ The retention *plumbing* has no L1 test — no declarative
  adapter decodes a stream — so it is proven only by the pure functions either side of it.
- **The README is a user guide with real screenshots (t439, 2026-09-14).** t435 had replaced it with
  nine hand-drawn SVG mock-ups and a capture script that never produced an image (it died on the
  adapter id `codex`, and ran headless, where `Page.captureScreenshot` never returns). The README now
  walks a first run — account, project, task, thread, landing, debate — around twelve PNGs that
  `scripts/generate-readme-assets.mjs` captures from the built renderer against a fictional fleet
  ([`docs/development.md`](docs/development.md) §2). ⭐ Two things the script had to learn: the
  daemon memoises run prices and nothing outside can invalidate them, so history is seeded before
  the capturing daemon starts and live state after; and `Browser.close` leaves orchestratord
  running — six orphans were found on this machine — so every launch now ends with `daemon.shutdown`
  and a wait on the lock file's pid.
- **The status bar spans the full window as `.shell`'s own grid row (t434, 2026-09-14)** — it used to sit inside `.main`'s flex column, so its border stopped at the resizable sidebar's edge. **Global › Status no longer repeats Notice's warnings (t433):** only Notice lists them.
- **Muse reasoning-effort choices are available end to end (2026-09-14).** The catalogue offers `none`, `minimal`, `low`, `medium`, `high`, `xhigh` and `ultra`; controls pass them to Muse. ⚠️ The regression test rejects retired `max`.
- **Three settings faults the operator hit driving a remote machine (t431, 2026-09-14).** The workers
  table's reorder arrows are `position: relative; z-index: 1` so hover no longer paints over them
  ([`docs/testing.md`](docs/testing.md) §3); `SignInLocationWarning` names the machine for an RDP/VNC
  sign-in; `preventSleep` (`UiSettings`, default on) holds a `powerSaveBlocker` per-install. ⚠️ None
  of the three driven in the packaged app.
- **The thread ledger reads as one list (2026-09-13).** Operational facts lead, run prompt and
  activity references open compact dialogs, and the model row separates the latest run from
  next-run choices.
- **Quality Review's copy and tile labels read as one page (t430, 2026-09-13).** `.prose-note` holds
  every paragraph on the page to the same 62ch, and the four count tiles are named for eligibility —
  *Gradable tasks with 0 reviews / only 1 review / 2+ reviews* and *Non-gradable tasks*.
- **The three-axis plot trusts its own data and remembers its filter (t429, 2026-09-13).**
  `measuredModelPoints` drops any model whose weakest axis is under `MIN_TRUSTED_SAMPLES` (5); the
  "Exclude API rate & mixed" checkbox persists via `lib/prefs.ts`; and each axis's low-end label moved
  off the shared origin point, which had drawn three strings stacked into garbled text.
- **CI on `main` is green again (2026-09-13).** Six task-table checks failed on both runners after
  the ~30-commit merge `3ff9ffd`; three measured causes, all written up in
  [`docs/testing.md`](docs/testing.md) §3. Dep and Took now collapse together at a 660px panel.
- **Cross-platform adapter tests no longer create `C:` in POSIX checkouts (2026-09-13).** The
  cross-adapter API-key test passed `C:/tmp/root` to every adapter; Muse planning creates its prompt
  and XDG roots, and Node treats that spelling as relative on macOS/Linux. The writable fixture now
  lives under the suite's temporary directory and a regression asserts the checkout stays clean.
- **A probe PTY answers the TUI's cursor-position query (t3, 2026-09-13).** Muse Code 1.2.1 writes
  `ESC[6n` at startup and exits 0 at +6.4s unanswered, before `readyMs`, so every `/usage` probe read
  *"the probe session did not start"* on a signed-in worker. `termquery.ts` answers it on `probe`
  PTYs only, proven through the real `spawnSession` in
  [`probepty.test.ts`](src/daemon/probepty.test.ts). ⚠️ Not yet driven in the packaged app: rebuild,
  press **Refresh** on Muse, and expect *Currently unavailable* until the account completes one turn.
- **Antigravity CLI commissioning and live quota probe on macOS (2026-09-13).**
  `readAntigravityIdentity`/`probeIdentity` read the OAuth token and auth email instead of a false
  `loggedIn: false` that locked the worker into `Antigravity: unknown`; the live packaged probe reads
  all 4 quota windows in 6s.
- **The diff moved out of the thread into a Diff pane (t425, 2026-09-13).** `DiffPane` is a column of
  the shell right of the work; the inline **Changes in this task** keeps its file list and draws no patch.
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
- **Security model and loose ends cleanup.** Unattended permission mode documented (`docs/security.md`); squash-merged PRs and report-only tasks cleanly retire under Loose ends.

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
