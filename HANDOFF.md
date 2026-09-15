# Warmstart — Session Handoff

## Current state — 2026-09-14

Warmstart M0–M6 is implemented, including debate mode, quota-aware scheduling, pooled worktrees,
model-aware routing, quality review, remote access, packaging, and atomic worker/model reassignment.
The maintained reference in [`docs/`](docs/README.md) is the
authority on each subsystem; dated design and incident history belongs in `transient_docs/`, not here.

Baseline (2026-09-14, **macOS 13 arm64**, measured on this branch's tip with electron-builder
26.16.1): typecheck, lint pass; L1 **3,468 passed, 5 skipped** (200 files); L2 **203 checks** (5
skipped); L3 **434 passed, 6 skipped** at the pinned 1024×720 window; L4 **17 checks** against a
signed, hardened-runtime bundle. Last CI green on all seven jobs: `c909c4c`, run 34883661692, with t445.2's fix for
`3489bc0`'s red `ui · windows-latest` (run 34872370257). CI is **enabled**, and so is the
**Release** workflow: it has been dispatched twice with `platforms=macos` (item 6 below), so a `v*`
tag now builds both platforms.

## Closed in this cleanup

- **macOS GUI launch missing Homebrew PATH in landing verification checks (t14, 2026-09-14).**
  Minimal GUI launch PATH (`/usr/bin:...`) on macOS lacks `/opt/homebrew/bin`, failing project checks (`npm run typecheck`) during landing with `/bin/sh: npm: command not found`. `which.ts` exports `augmentPath()`, `orchestratord` augments `process.env.PATH` at startup, and `landing.ts`, `worktrees.ts`, and `deliveries.ts` use `spawnEnv()` so checks and tools resolve cleanly.
- **macOS `xcrun` git resolution failure and trunk lock phantom blocking (t12/t13, 2026-09-14).**
  Minimal GUI launch PATH on macOS hit `/usr/bin/git`, an Apple `xcrun` shim failing when Command Line Tools are misconfigured. `which.ts` and `spawnEnv()` prepend extraDirs and `which()` skips broken xcrun shims. `git.ts` routes through `which('git')` and `spawnEnv()`. `trunkOccupiedBy` resolves session holders via `taskOfSession`, avoids self-blocking, and sweeps stale claims.
- **macOS text editing shortcuts work again (t446, 2026-09-14).** The native `appMenu`/`editMenu` roles restore Chromium's `⌘C`/`⌘V`/`⌘X` routing; Windows/Linux keep the menu disabled. Pinned by [`src/main/applicationmenu.test.ts`](src/main/applicationmenu.test.ts).
- **Retire it / Delete it no longer refuse a branch sitting in an idle pool member (t444, 2026-09-14).**
  `retireStrandedBranch` and `deleteUnlandedBranch` refused any branch a worktree held, even an idle pool member. The new `idlePoolHolder` in [`worktrees.ts`](src/daemon/worktrees.ts) steps off (`git switch --detach`) clean idle pool members.
- **`ui · windows-latest` went red on two checks the local suite could not see (t445.2, 2026-09-14).**
  ⭐ `test:ui` now pins its window to CI's 1024×720 via `ui/window-state.json`, and reproduced the
  reorder-arrow failure locally on the first run. The arrows were fine: at that height the row sat
  below `.content`'s fold and `elementFromPoint` hit-tested an off-screen point, so the check scrolls
  first; mutating the cell's `z-index` away still turns it red. ⛔ The second was a product bug:
  `task.message` on a `ready` task emitted nothing, so no other view saw the note. Locally the task
  was `running` (a CLI on `PATH`) and run events hid it. Now emits `task.changed`, pinned by
  `taskmessage.test.ts`. [`docs/testing.md`](docs/testing.md) §3 and the headless section.
- **macOS signing is configured, and the config now says which of three things a build did (t445,
  2026-09-14).** `hardenedRuntime: true`, `identity` *absent* rather than `null`, `notarize: false`,
  and explicit entitlements in `resources/entitlements.mac.*.plist`. ⛔ The measurement that changed
  the shape of the fix, read out of `app-builder-lib` 26.15.3 rather than a vendor doc: notarisation
  is called from **inside** `sign()`, so `identity: null` silently disabled signing, notarisation and
  the hardened runtime in one line — and `hardenedRuntime` already *defaults to true* for a non-MAS
  build, so `false` had been an explicit opt-out. ⭐ The half that generalises: **an unsigned build
  proves nothing about the hardened runtime**, because the runtime is a signing flag — a machine
  with no certificate produces a bundle the flag was never applied to, identical in name and size to
  one that passed. `scripts/build-mac.sh` and the release workflow now read the bundle back with
  `codesign` and print which happened. ✅ The owner's Mac built it **signed with the hardened
  runtime** (2026-09-14, also on electron-builder 26.16.1); not notarised, and nothing has yet been
  run under it. [`docs/development.md`](docs/development.md) §3 has the first-session checklist.
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
- **Three settings faults the operator hit driving a remote machine (t431, 2026-09-14).**
  ⭐ The workers table's reorder arrows could not be clicked and vanished on hover — the order cell and
  worker cell shared one grid area, so hover painted over the arrows; the order cell is now
  `position: relative; z-index: 1`, caught only by `elementFromPoint`, since a scripted `.click()`
  bypasses hit-testing ([`docs/testing.md`](docs/testing.md) §3).
  ⭐ A sign-in run while driving another computer opened the vendor's OAuth browser on *that* screen;
  `SignInLocationWarning` names the machine or states the rule for an RDP/VNC operator to apply.
  ⭐ A host left running to take work could sleep mid-run; `preventSleep` (`UiSettings`, default on)
  holds a `powerSaveBlocker`, per-install since the setting deciding whether a run survives the night
  is the host's. ⚠️ None of the three driven in the packaged app.
- **CI on `main` is green again (2026-09-13).** Six task-table checks failed on both runners after
  the ~30-commit merge `3ff9ffd`; three measured causes, all written up in
  [`docs/testing.md`](docs/testing.md) §3. Dep and Took now collapse together at a 660px panel.
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
- **t408–t425, all landed and all documented in [`docs/`](docs/README.md) (2026-09-13).** The Diff
  pane; Claude Code's `StreamEvent.tool_use` narration and the split Session TUI; macOS worktree
  symlink resolution and GUI-launch PATH search; task-oriented Global settings; *Later observed*
  reconciliation; one desktop driving another's fleet; the 92% preemption guard; `sweepAcls` for a
  dead run's DACL; **relative** pool `.git` pointers; unattended permission mode in `docs/security.md`.

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
