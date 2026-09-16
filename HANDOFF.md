# Warmstart — Session Handoff

## Current state — 2026-09-16

Warmstart M0–M6 is implemented, including debate mode, quota-aware scheduling, pooled worktrees,
model-aware routing, quality review, remote access, packaging, and atomic worker/model reassignment.
The maintained reference in [`docs/`](docs/README.md) is the
authority on each subsystem; dated design and incident history belongs in `transient_docs/`, not here.

Baseline (2026-09-16, **Windows 11**, measured on t478's tip over `0.1.0`): typecheck, lint and
build pass; L1 **3,575 passed, 5 skipped** (210 files); L2 **203 checks** (5 skipped); L3 **456
passed, 4 skipped** at the pinned 1024×720 window; L4 **19 checks** against
`release/win-unpacked`, 2026-09-15. macOS 13 arm64, 2026-09-14: L3 434 (6 skipped), L4 17 on a
signed, hardened-runtime bundle. Last CI green on all seven jobs: `593e5c6`, run 35058132724 — the
merge commit itself. CI is **enabled**, and so is the **Release** workflow, now proven end to end.

**Version is `0.1.0`, prepared by `/release patch` (t474.6, 2026-09-15): committed, untagged. The
repository is public** (flipped 2026-09-15 after `rc.2` was installed and verified on both machines
— the launch gate, items 5 and 8, is closed). ⏭ Land → CI green → `git tag v0.1.0 && git push
origin v0.1.0`. It publishes as a full release, so `/releases/latest` serves it and every `rc.2`
install is offered it; and it is the first tag build on a public repository, so the attestation
step runs for the first time — watch it. Then Phase 3/4 (write-up, demo GIF, landing page,
channels), all off-repo.

## Closed in this cleanup

- **A run's prompt chip now hangs under the request, and every benchmark prior cites its leaderboard
  (t478, 2026-09-16).** The `📋 49` chip sat under the run's *last agent answer*, which read as
  though the agent had been handed its own reply — a person who typed `/push` found their prompt two
  bubbles below. `promptAnchors` (`lib/threadbubble.ts`) replaces `promptMessageId`: a run claims the
  last unclaimed request before `startedAt` (a human message, or the opening message of a task an
  agent filed) and falls back to its own last answer when a retry followed no new note. ⭐ Routing
  Model › Models grew a **Prior source** column and Table 13 — the leaderboards, their files and
  retrieval dates, carried on the report from `benchmarkTable()` because only the daemon can read
  `benchmarks/*.json`; a family-prefix prior reads *inferred, family match* rather than borrowing the
  neighbour's citation. ⭐ Both read back off the built app: `test/ui.test.mjs` seeds a run carrying a
  prompt through the store and asserts which bubble the chip lands under — reverting the anchor turns
  those two checks red, which is how they were confirmed to test anything.

- **A long thread no longer hides the task's status (t477, 2026-09-16).** Once the status box has
  scrolled off the top, `thread/LedgerPeek` pins a small box at the top of the ledger column with
  the task, its status and hold line, and — once the timeline has gone too — the latest run (`#N`,
  account / model, fresh, status, usage), read from the same rows; pressing it scrolls the row back.
  `lib/scrolledpast.ts` measures geometry on scroll and after every render — ⛔ an
  `IntersectionObserver` missed a box jumped past in one frame, and the hidden L3 window gets no
  scroll events at all (measured: a hand-dispatched `scroll` drew what the real `scrollTo` had not).
  ⭐ Driven visibly at 1440×900 on the showcase fleet and pinned by six L3 checks. `docs/ui.md` §3.
  Baseline on this tip over `01b3cf4`, Windows 11: L1 **3,581 passed, 5 skipped** (211 files); L3
  **462 passed, 4 skipped**; typecheck, lint, build pass. L2/L4 not re-run — no daemon/packaging change.

- **README.md rephrased in direct developer tone, with warmstart.dev's pitch phrases (t476,
  2026-09-16)** — e.g. "Right agent and the right model, without thinking twice" for "Smart routing".
  Verified facts, security boundaries and documentation links kept as they were.

- **The window now says why orchestratord died, within a second (t474.2, 2026-09-15).** The
  operator installed `rc.1` beside the trunk-built app they run daily; the trunk had migrated the
  live database to v73 and the release understood v71, so the daemon logged one actionable line and
  exited five times over two minutes while the window said *Starting orchestratord…* throughout.
  `ensure()` now listens for the child's `exit` and stops polling at once, and `main/daemonexit.ts`
  reads the `failed to start` line back from the day's log into the status message. ⭐ Driven from
  `out/` against a `user_version = 999` database: the panel read the full refusal **+508ms** after
  the page was reachable. `docs/architecture.md` § startup. ⛔ The release-side lesson is now a
  gate: `npm run release:check` (`scripts/check-release-base.mjs`, step 0 of `/release`) refuses
  a trunk ahead of `origin/main`, a branch behind it, or a dirty trunk; real-git
  `releasebase.test.ts` reproduces the 25-commit trap. ⛔ Found on the way: unanchored `release/`
  in `.gitignore` had swallowed `.claude/skills/release/`, so the skill was never in `57e6747`.
- **`warmstart-site` polish (t468/t469/t471).** ⚠️ Committed there, **not pushed** — a push deploys.
- **A release now carries notes written at bump time, and an rc cannot become `latest` (t474,
  2026-09-15).** `/release` (`.claude/skills/release/`) bumps the three version files, writes
  `releases/v<version>.md` and commits; it never tags, because the tag is the publish trigger.
  `release.yml` reads that file as the release body, rejects a tag without one before `npm ci`, and
  derives `--prerelease` from a `-` in the version — ⛔ which matters because `src/main/updates.ts`
  polls `/releases/latest`, an endpoint GitHub never answers with a pre-release or draft, so every
  release this workflow had published was invisible to installed apps. `isNewerVersion` now lets an
  installed rc see its bare final. O9 closed by wording: `CONTRIBUTING.md`/`CLA.md` promised a CLA
  bot that does not exist; signing is now a comment on the first PR. ✅ The tag build has published.

- **Codex's reasoning effort is now selectable, matching Claude and Muse (t473, 2026-09-15).**
  `codex exec --help` lists no `--reasoning-effort` flag; `-c model_reasoning_effort=<level>` is the
  route in. Measured live (codex-cli 0.151.0): a fresh `exec` and an `exec resume` both echoed the
  level back in the rollout's `turn_context`, and an invalid level failed the turn with the API's
  own enum error rather than being silently dropped. `plan()` in `openai-compatible.ts` sends it
  beside `--model`. ⛔ Past Codex runs' `effort` stays `null`, which already reads as "CLI default"
  everywhere and is excluded from the per-effort breakdown rather than bucketed as unknown.

- **User-facing copy rewritten in direct developer style (t464, 2026-09-15).** Sentences, tooltips,
  placeholders and section intros across 21 components in `src/renderer/src/components`; 112 lines shorter.
- **Finishing a conversation no longer races Retire it (t467, 2026-09-15).** `resolveTask` now waits
  (bounded, 15s) for the session process to exit and parks/releases its workspace before the Finish RPC
  returns, preventing race conditions with empty branch retirement. Pinned by `runfailure.test.ts` and
  `landingcorners.test.ts`.

- **A granted directory can now be committed in, and an agent can ask for one that works (t470,
  2026-09-15).** ⛔ The t469 grant was *not* dropped. Codex's elevated Windows sandbox grants each
  `--add-dir` root a write ACE and then writes an explicit **deny** ACE on that root's `.git` (its
  own audit log says so), so every edit landed and `git commit` died at `.git/index.lock: Permission
  denied`. ⭐ Probed against codex-cli 0.151.0: passing `<dir>/.git` as a root of its own draws a
  grant and **no** deny, and the commit succeeds. `gitMetadataRoots` (was `gitWritableRoots`) returns
  it now, for the workspace and every granted folder (⚠️ it had hit any plain-clone workspace too — a
  `trunk`-mode task could not commit at all). ⭐ New MCP tool **`request_directory`**
  (`daemon/dirgrants.ts`): the operator's **Grant** attaches the folder to the task, ends the run and
  requeues it, so the grant arrives on a warm resume with the agent's `state` as the handoff. ⚠️
  `claude-code` only; the rest name the path after `NEEDS DECISION:`. See `docs/mcp.md`, `adapters.md`.

- **Quota-preemption hand-off with a destination (t458, 2026-09-15).** A hand-off chosen during
  the warning names where the work goes (`quotaPreemptWarning.reassignWorkerId`, written by
  `task.overrideQuota`, read by `preempt()` at expiry). ⚠️ **Not run against a real preemption**.

- **Plan & Execute, and the composer pill's teaching order (t456 / t458, 2026-09-15).** Plan & Execute
  is the same `plan` kind with the fan-out capped at one and no integration turn; the shape is
  *derived*, never stored — `planModeOf` (`shared/tasks.ts`) reads
  `min(mandate.maxChildren, childDefaults.maxChildren) <= 1` and everything follows, including the
  executor landing onto the **project's** target rather than the planner's branch. The pill reads
  from the single `KIND_OPTIONS` order. Design and the two operator decisions:
  [`transient_docs/plan_and_execute_2026-09-15.md`](transient_docs/plan_and_execute_2026-09-15.md).
  ⚠️ **Not run against a real agent**, and the cost claim is unmeasured on this fleet (item 2).

- **t408–t455, landed and documented in docs/ (2026-09-13–15).** Covered by the docs/ pages they
  owed; see git history (probe PTY answers, live quota probe, remote settings, Statistics axes,
  landing messages, welcome tour, gate panel, idle-turn deferral, phone `ask_human` card).

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
6. **Tag `v0.1.0`** once this commit is on `main` with CI green — see the top. Attestation is the
   one pipeline step never yet exercised.
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
