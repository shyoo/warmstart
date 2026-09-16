# Warmstart — Session Handoff

## Current state — 2026-09-16

Warmstart M0–M6 is implemented, including debate mode, quota-aware scheduling, pooled worktrees,
model-aware routing, quality review, remote access, packaging, and atomic worker/model reassignment.
The maintained reference in [`docs/`](docs/README.md) is the
authority on each subsystem; dated design and incident history belongs in `transient_docs/`, not here.

Baseline (2026-09-16, **Windows 11**, measured on t485's tip, `0.1.0+7.gcced61f`): typecheck, lint
and build pass; L1 **3,618 passed, 5 skipped** (212 files); L2 **203 checks** (5 skipped); L3
**474 passed, 4 skipped** at the pinned 1024×720 window; L4 **19 checks** against
`release/win-unpacked`. macOS 13 arm64, 2026-09-14: L3 434 (6 skipped), L4 17 on a
signed, hardened-runtime bundle. Last CI green on all seven jobs: `593e5c6`, run 35058132724 — the
merge commit itself. CI is **enabled**, and so is the **Release** workflow, now proven end to end.

**`v0.1.0` is released and `latest`** (tag build 35066743396, 2026-09-16, attested — the first
tag build on the public repository). **The version is now the tag** (t485, below): nothing in the
tree carries one, so there is no "prepared, untagged" state any more. ⏭ The next release is one
turn: `/release rc` on a green `origin/main`, install and verify it, `/release promote`. ⚠️ The
first cut through the new flow is the test of `release.yml`'s new verify step; it fails before
`npm ci` if it fails. Then Phase 3/4 (write-up, demo GIF, landing page, channels), all off-repo.

## Closed in this cleanup

- **A release is one turn, and the tag is the version (t485, 2026-09-16).** `v0.1.0` cost four
  turns, two "Prepare vX" commits and two CI runs whose only input was a version string (measured:
  runs 35062655991 → 35066743396). The version was a source fact, so every rc and every promotion
  had to go through the pipeline before a tag could point at it. Now `scripts/version.mjs` derives
  it from git (`WARMSTART_VERSION` on a release build, `git describe` otherwise → `0.1.0+7.gcced61f`),
  every bundle reads `__APP_VERSION__`, and `electron-builder.js` stamps `extraMetadata.version`
  (the yml is `electron-builder.base.yml` because electron-builder finds `.yml` before `.js`).
  `package.json` keeps `0.0.0`; `check-version.mjs` refuses a build if a version is written back.
  `/release rc` → `scripts/release-tag.mjs plan` (next version from the tags that exist) → notes →
  `cut`: one annotated tag on `origin/main`'s tip, pushed after the base gate, the on-main check,
  and a CI-green lookup. `/release promote` tags the rc's *commit* with the bare version and the
  workflow rebuilds — chosen over flipping the pre-release flag, which would ship `-rc.N` as the
  version forever. Notes are the tag body; `releases/` takes no new files. ⭐ `npm run pack` on this
  branch stamped `0.1.0+7.gcced61f.dirty` into the asar and the packaged daemon answered with it.
  ⚠️ Unmeasured: the first tag through `release.yml`'s new verify step. Design:
  [`transient_docs/release_flow_2026-09-16.md`](transient_docs/release_flow_2026-09-16.md).

- **A codex conversation keeps its tree between turns, Land finds the branch wherever it is, and the
  session line names the model it asked for (t483, 2026-09-16).** t481 (CodexFirst, `gpt-5.6-sol`):
  Land answered *"not holding a workspace"* 31s after the turn ended, about a branch with one clean
  verified commit. ⭐ Measured on the daemon log and ws1's reflog: codex exits once per turn, *after*
  `endConversationTurn` closed the run, so `onSessionExit` found no open run, read the task as nobody's
  and parked ws1 onto `origin/main`. It now asks `taskOfSession`, so an `awaiting_human` conversation
  keeps the claim (`idleturn.test.ts`, red without the fix); and `landConversationWork` borrows a pool
  member when no tree has the branch (`conversationland.test.ts`). ⚠️ The Commit instruction telling
  codex *not* to merge was correct — an MCP-less adapter has no `land_work`, so the person presses Land.
  ⭐ *"— model unknown · mode unknown"* was display only: codex's rollout recorded `gpt-5.6-sol` at
  `medium` on all three turns, but `thread.started` carries neither. `initLine` (`stream.ts`) now fills
  from the spawn request, marked *(as requested)*, and `stripFrames` keeps the daemon's dim lines out
  of an MCP-less reply read back from the pane (which also quoted that header as the answer's first line).

- **A tree a waiting ticket still owns reads `locked` on both sides of the board, and "at capacity"
  now says what to do about it (t480, 2026-09-16).** Flow's awaiting lane marked the ticket `locks
  ws2` while ws2's own row read **free** — one fact, two answers, and the wrong one on the column an
  operator reads to find a tree that can take work. Not cosmetic: a free row is one
  `computeWorkspaceRows` pairs an inbound dispatch with. `isLockedWorkspace`
  (`Flow.tsx`) draws the pool member held by an `awaiting_human`/`paused_user` ticket as `locked`
  — ticket, tree and account, in the human tone — and withholds it from inbound pairing; the lane
  count is unchanged, because it counts *active* tasks. ⭐ The capacity refusal is one shared string
  (`shared/capacity.ts`), read by the scheduler's hold reason and `spawnSession`'s throw alike:
  `<label> at capacity` (the prefix the suites match), then what is full, that **Max parallel
  instances** is the setting and raising it dispatches on the next tick, and the cost — quota drains
  faster, the reading is less reliable, warm sessions are reused less. `MAX_HELP` beside the control
  carries the long form, pinned by an L3 check. `docs/routing.md` §2.2, `docs/ui.md` §3,
  `docs/glossary.md`. ⚠️ The locked *row* is L1-only: `ui.test.mjs` never opens the Flow board and
  a claim cannot be staged over RPC. Baseline on this tip, Windows 11: typecheck, lint, build pass;
  L1 **3,601 passed, 5 skipped** (211 files); L2 **203**; L3 **474 passed, 4 skipped**.

- **Open conversations sit under their project in the sidebar, and a task can be renamed (t479,
  2026-09-16).** Switching between two conversations meant Tasks board → row → open, every time. A
  project row now lists every *unfinished* conversation under it (💬, newest first; one press opens
  the thread) with a ▾/▸ fold remembered per project — ⛔ unfinished, not running: a conversation
  rests at `awaiting_human` between turns, so only finished/cancelled/draft/deleted leaves the list
  (operator's decision, with the fold and no cap). The thread heading is now the rename control
  (`thread/TitleEditor`) over the existing `task.update { title }`, which clears the controller's
  summary and leaves held statuses alone — pinned at L1 in `titlesummary.test.ts`, and by 11 L3
  checks that file a conversation, open it from the sidebar, rename it and watch it leave on Finish.
  ⭐ Driven visibly at 1440×900 on the showcase fleet. `docs/ui.md` §3. Baseline on this tip,
  Windows 11: L1 **3,592 passed, 5 skipped** (212 files); L3 **473 passed, 4 skipped**; typecheck, lint, build pass. L2/L4 not
  re-run — no daemon or packaging change.

- **The window now says why orchestratord died, within a second (t474.2, 2026-09-15).** `rc.1`
  installed beside the trunk-built app found a v73 database it understood as v71, logged one line and
  exited five times while the window said *Starting orchestratord…*. `ensure()` now listens for the
  child's `exit`, and `main/daemonexit.ts` reads the `failed to start` line into the status message
  (⭐ +508ms against a `user_version = 999` database). `docs/architecture.md` § startup. ⛔ The
  release-side gate, `check-release-base.mjs`, refuses a trunk ahead of `origin/main`, a branch
  behind it, or a dirty trunk (`releasebase.test.ts`); `release-tag.mjs cut` runs it first.
- **`warmstart-site` polish (t468/t469/t471).** ⚠️ Committed there, **not pushed** — a push deploys.
- **An rc cannot become `latest` (t474, 2026-09-15).** `release.yml` derives `--prerelease` from a
  `-` in the version — ⛔ which matters because `src/main/updates.ts` polls `/releases/latest`, an
  endpoint GitHub never answers with a pre-release or draft, so every release the workflow had
  published before was invisible to installed apps. `isNewerVersion` lets an installed rc see its
  bare final. O9 closed by wording: signing is a comment on the first PR, not a promised bot (t481,
  2026-09-16); `.github/pull_request_template.md`, `CLA-SIGNERS.md` and the maintainer checklist
  make the first external signature reproducible rather than a memory-only process.

- **A granted directory can now be committed in, and an agent can ask for one that works (t470,
  2026-09-15).** Codex's elevated Windows sandbox writes a **deny** ACE on each `--add-dir` root's
  `.git`, so edits landed and `git commit` died at `.git/index.lock`. ⭐ Probed on codex-cli 0.151.0:
  passing `<dir>/.git` as its own root draws no deny; `gitMetadataRoots` returns it for the workspace
  and every grant (it had hit plain-clone `trunk` workspaces too). ⭐ New MCP tool
  **`request_directory`** (`daemon/dirgrants.ts`): **Grant** attaches the folder, ends the run and
  requeues it for a warm resume with the agent's `state` as handoff. ⚠️ `claude-code` only; the rest
  name the path after `NEEDS DECISION:`. See `docs/mcp.md`, `adapters.md`.

- **Quota-preemption hand-off with a destination, and Plan & Execute (t456/t458, 2026-09-15).** A
  preemption warning's chosen hand-off now names where the work goes
  (`quotaPreemptWarning.reassignWorkerId`, read by `preempt()` at expiry); Plan & Execute is the same
  `plan` kind with fan-out capped at one, derived rather than stored (`planModeOf`,
  `shared/tasks.ts`), whose executor lands onto the project's target. Design:
  [`transient_docs/plan_and_execute_2026-09-15.md`](transient_docs/plan_and_execute_2026-09-15.md).
  ⚠️ **Neither run against a real preemption or agent**; the cost claim is unmeasured.

## Remaining work — ordered by payoff

Each needs a real signed-in account, a macOS machine, release credentials, or a human product
judgement. Do not replace the missing evidence with a unit test.

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
5. ✅ **Closed 2026-09-15** — the signed, notarised `rc.2` bundle opened a PTY and drove a real
   agent on the owner's Mac. Still unmeasured individually: Application Support isolation and
   Antigravity's Keychain under the hardened runtime; both were exercised only as part of that run.
6. **Cut the first release through the tag-is-the-version flow** (`/release rc`, then `promote`)
   and watch `release.yml`'s verify step — the one part of t485 no local check can reach.
7. **Pair two real machines over Tailscale (t419).** Generate a desktop code on one, pair from the
   other, then drive a terminal, add a worker and file a task remotely. Confirm notifications from
   both computers, a revoke on the host cutting the client off, and the ±1 version warning.
8. ✅ **Closed 2026-09-15** — `rc.2` installed and verified working on Windows and macOS. ⚠️ Not yet
   written down as a narrative; the demo GIF (Phase 3) is the place that record will live.
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
