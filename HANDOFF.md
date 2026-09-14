# Warmstart — Session Handoff

## Current state — 2026-09-14

Warmstart M0–M6 is implemented, including debate mode, quota-aware scheduling, pooled worktrees,
model-aware routing, quality review, remote access, packaging, and atomic worker/model reassignment.
The maintained reference in [`docs/`](docs/README.md) is the
authority on each subsystem; dated design and incident history belongs in `transient_docs/`, not here.

Baseline (2026-09-14, **Windows 11 x64**, measured on this branch's tip): typecheck, lint, build
pass; L1 **3,450 passed, 4 skipped** (197 files); L2 **203 checks** (5 skipped); L3 **440 checks**.
⚠️ L4 `test:pack` was **not run here** — the previous macOS reading (17 checks against
`release/mac-arm64`, 2026-09-13 on `ac37ec7`) is the last one. ⚠️ One L3 flake seen and not reproduced: a stale
`.git/worktrees/convo-ws1/index.lock` left by an interrupted run failed *the landing this section
needs actually landed*; a clean re-run was green. Last CI seen (HEAD `d27a282`, run 34798079433, green on all seven jobs): L2 198
on both runners; L3 **425** on Windows (4 skipped) and **424** on Linux (5 skipped) — the skips name
the screen; L4 19 on Windows, 17 on Linux. ⚠️ CI was disabled by the owner around 2026-09-13; the
two commits after `d27a282` have no runner counts.

## Closed in this cleanup

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
- **The status bar spans the full window as `.shell`'s own grid row (t434, 2026-09-14)** — it used
  to sit inside `.main`'s flex column, so its border stopped at the resizable sidebar's edge.
  **Global › Status no longer repeats Notice's warnings (t433):** only Notice lists them.
- **Muse reasoning-effort choices are available end to end (2026-09-14).** The catalogue offers
  `none`, `minimal`, `low`, `medium`, `high`, `xhigh` and `ultra`; controls pass them to Muse. ⚠️ The regression test rejects retired `max`.
- **Three settings faults the operator hit driving a remote machine (t431, 2026-09-14).**
  ⭐ *The reorder arrows could not be clicked, and vanished on hover.* The workers table re-lays its
  rows out as cards where the order cell and the worker cell are given the **same grid area**; overlaps
  paint in tree order, so the worker cell was on top for hit-testing, and `.tbl tr:hover td` gave it a
  background that painted over the arrows too. The cell is now `position: relative; z-index: 1`.
  ⛔ Every DOM-level check was green through all of it: a scripted `.click()` bypasses hit-testing, so
  the new check asks `elementFromPoint` ([`docs/testing.md`](docs/testing.md) §3).
  ⭐ *A sign-in runs beside the credential, not beside the operator.* Commissioning while driving
  another computer opened the vendor's OAuth browser on **that** computer's screen while the Sign in
  terminal here waited. `SignInLocationWarning` (above *Create and sign in*, and again in the Sign in
  panel) names the machine when one is selected, and otherwise states the rule for an RDP/VNC operator
  to apply — the app cannot detect that case. [`docs/remote.md`](docs/remote.md).
  ⭐ *A host left running to take work slept mid-run.* `preventSleep` (`UiSettings`, **default on**,
  the only App-behavior switch that is) holds a `powerSaveBlocker('prevent-app-suspension')`, applied
  at launch as well as on change. ⚠️ Idle sleep only — not a closed lid, and the copy says so.
  ⛔ Per-install, so the setting deciding whether a run survives the night is the **host's**. ⚠️ None of the three driven in the packaged app.
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
- **Antigravity CLI commissioning and live quota probe on macOS (2026-09-13).** `readAntigravityIdentity`
  and `probeIdentity` now read the OAuth token and auth email the CLI writes instead of returning a
  false `loggedIn: false` that locked the worker into `Antigravity: unknown`; the live packaged probe
  reads all 4 quota windows in 6s.
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
