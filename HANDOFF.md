# Warmstart — Session Handoff

## Current state — 2026-09-16

Warmstart M0–M6 is implemented, including debate mode, quota-aware scheduling, pooled worktrees,
model-aware routing, quality review, remote access, packaging, and atomic worker/model reassignment.
The maintained reference in [`docs/`](docs/README.md) is the authority on each subsystem; dated
design and incident history belongs in `transient_docs/`, not here.

Baseline (2026-09-17, **Windows 11**, measured over `0.1.1+12.g6b1bda6.dirty`): typecheck, lint and
build pass; L1 **3,685 passed, 5 skipped** (220 files). L2 **203 checks** (5 skipped) and L4 **19 checks**
against `release/win-unpacked` were at `0.1.1+1.g1fff656`. L3 not re-run on this
tip (a renderer change, but `test/ui.test.mjs` never opens a project tab — see t500 below); it was
**474 passed, 4 skipped** at `0.1.0+8.gb642d0e`. macOS 13 arm64,
2026-09-14: L3 434 (6 skipped), L4 17 on a signed, hardened-runtime bundle. CI is **enabled**, and so
is the **Release** workflow.

**`v0.1.1` is released and `latest`** (tag build 35165991396, 2026-09-17, attested; five installers
+ `SHA256SUMS.txt`). It was verified as `v0.1.1-rc.1` (tag build 35161851026) and promoted onto that
rc's own commit `1d2c714`, so `v0.1.1` and `v0.1.1-rc.1` name the same bytes. ⭐ **The whole
tag-is-the-version flow has now carried a release end to end** — `/release rc`, verify, `/release
promote`, `release.yml`'s verify step included — in two turns and no "Prepare vX" commit.
⚠️ `main` is *ahead* of the released tag: the two fixes below landed after the rc was cut, so the
0.1.1 installers do not contain them. ⏭ Next is Phase 3/4 (write-up, demo GIF, landing page,
channels), all off-repo.

## Closed in this cleanup

- **A codex run can reach the network; it still cannot push (t494 ← t493, 2026-09-16).** t493 saw every
  `gh` call, `git fetch origin main` and `git push` die at the socket and asked how a branch could be
  pushed. ⭐ Not `gh`: codex's `workspace-write` ships with `network_access: false` and `exec` has no
  prompt to ask — so the *fetch first* clause every worktree agent gets had failed on every codex run.
  `plan()` passes `-c sandbox_workspace_write.network_access=true`; `envFor` appends
  `http.sslBackend=openssl` on Windows (schannel cannot open the cert store under the restricted token).
  Measured with `codex sandbox` (zero tokens) and three ~35k-input `exec` turns. ⛔ **No credential
  reaches the sandbox** — GCM and `gh`'s keyring both fail there, so `gh` is anonymous and a push cannot
  succeed; landing pushes, outside, as the instruction already says. ⚠️ Deliberately not done: handing in
  the operator's token (`gh auth token` → `GH_TOKEN`) lets a *sandboxed* agent write to every repository it reaches; if authenticated `gh` inside codex is wanted, that is the decision. `docs/adapters.md`, `docs/security.md`. ⚠️ The first landing hit two 15s
  timeouts: `%TEMP%` holds **28,760** leftover fixtures and an adapters test walked it as `cwd` (1.6s idle; now an empty mkdtemp, 1ms); git-heavy `conversationland` timed out on load alone. Clear the litter.

- **A run that commits in another repository is held, not finished (t492, 2026-09-16).** t491 committed in
  `warmstart-site` while filed on `sunghwanyoo-site`; the trunk finish saw nothing and completed it unpushed.
  `strayCommits` checks repositories the run's tool lines name against their reflog. `docs/landing.md`.

- **The trade-off scatters name their marks (t490, 2026-09-16).** `placeScatterLabels`, `compactModelLabel` in `Statistics.tsx`; axes say *right/top is better*. Demo video: `scripts/record-demo.mjs` → `out/demo/`, staged on the invented fleet (`docs/development.md`).

- **`scripts/version.mjs` printed nothing when *run* on Linux or macOS, and that decided a
  release's visibility (2026-09-16).** It tested direct invocation by comparing `import.meta.url`
  against a hand-built `file:///${process.argv[1]}` — right on Windows, never true on POSIX. ⭐ So
  `release.yml`'s `version=$(node scripts/version.mjs)` was empty, and **`v0.1.1-rc.1` published as a
  full release and became `/releases/latest`** — corrected on GitHub with `gh release edit
  v0.1.1-rc.1 --prerelease` before promotion. `pathToFileURL` now; `release-tag.mjs` and
  `check-release-base.mjs` carried the same line and are fixed too; the workflow refuses a version
  that is not version-shaped. `version.test.ts` runs the script as a program and `scripts.test.ts`
  fails on the *shape* in any `scripts/*.mjs`. ⚠️ `scripts/build-mac.sh` reads the same command into
  `.build-cache/version.txt`; unmeasured on macOS, worth a look on the next Mac.

- **electron-builder is invoked from one script, and never from a config file that computes
  anything (2026-09-16).** t485's `electron-builder.js` — an ESM config that `extends:` the settings yml to stamp the version — worked on Linux, macOS and this Windows machine, and on **Windows CI** made `electron-builder --dir` exit **0** having printed nothing and written no `release/`, so `test:pack` found no package (⭐ measured: run 35158401830, twice, same runner image, Node 22.23.2 and electron-builder 26.16.1 that built `v0.1.0` green; not reproducible through `npx electron-builder`, `npm run pack`, or `CI=true npm run pack`). ⛔ **The root cause is still unknown**; removing the JS config restores the green build. The settings are back in `electron-builder.yml`, the only config, as for every release up to `v0.1.0`; `scripts/pack.mjs` passes `-c.extraMetadata.version`, which ⭐ reaches the packaged `package.json` and leaves the project's own alone (probed with `9.9.9-probe`, read back out of `app.asar`), and spawns `node <cli.js>` from electron-builder's `bin` rather than the `node_modules/.bin` batch shim. `src/daemon/packaging.test.ts` pins the shape: one config, no version in it, every `pack`/`dist:*` script through the wrapper. ⚠️ A packaging step that reports success without packaging is the worst shape a failure can take, and **L4 was the only tier that could see it** — nothing below L4 builds a package.

- **A local worker's model is what its server serves, named `local-llm:<served id>` (t486,
  2026-09-16).** `costmodels/local.llm` listed one id, `qwen3-coder-30b-a3b`; every model write is
  validated against the cost model, so it was the only default a person could set and the one
  migrations 44/61 wrote — while llama.cpp ignores `model` on a single-model server, so the
  Qwen3.8-27B endpoint answered and every run and grade said the 30B coder had. The file now
  declares `dynamic_models` (a template under `id_prefix`); `probeIdentity` reads `/v1/models` and
  llama.cpp's `/props` into `identity.servedModels` / `contextWindow`; `knownModelIds` feeds
  `model.options` (an entry per local worker), fitness and triage; the bridge asks `/v1/models`
  when no model is set and names it on `init`. Migration 74 clears the pinned literal to null.
  `docs/cost-model.md` §8a. ⚠️ **Not yet driven against a real server** — start one, press Probe on
  the local worker, confirm the picker lists the gguf and a run's session names it. Design:
  [`transient_docs/local_model_identity_2026-09-16.md`](transient_docs/local_model_identity_2026-09-16.md).

- **A release is one turn, and the tag is the version (t485, 2026-09-16).** `v0.1.0` cost four
  turns, two "Prepare vX" commits and two CI runs whose only input was a version string (measured:
  runs 35062655991 → 35066743396). The version was a source fact, so every rc and every promotion
  had to go through the pipeline before a tag could point at it. Now `scripts/version.mjs` derives
  it from git (`WARMSTART_VERSION` on a release build, `git describe` otherwise → `0.1.0+7.gcced61f`),
  every bundle reads `__APP_VERSION__`, and `scripts/pack.mjs` passes `extraMetadata.version`
  (⛔ it was an `electron-builder.js` for a day; see the entry above for why it is not).
  `package.json` keeps `0.0.0`; `check-version.mjs` refuses a build if a version is written back.
  `/release rc` → `scripts/release-tag.mjs plan` (next version from the tags that exist) → notes →
  `cut`: one annotated tag on `origin/main`'s tip, pushed after the base gate, the on-main check,
  and a CI-green lookup. `/release promote` tags the rc's *commit* with the bare version and the
  workflow rebuilds — chosen over flipping the pre-release flag, which would ship `-rc.N` as the
  version forever. Notes are the tag body; `releases/` takes no new files.
  ⭐ `v0.1.1-rc.1` is the first tag through it and the verify step passed. Design:
  [`transient_docs/release_flow_2026-09-16.md`](transient_docs/release_flow_2026-09-16.md).

- **A codex conversation keeps its tree between turns, Land finds the branch wherever it is, and the
  session line names the model it asked for (t483, 2026-09-16).** Codex exits once per turn, after
  `endConversationTurn` closes the run, so `onSessionExit` used to find no open run and park the
  workspace onto `origin/main` mid-conversation; it now asks `taskOfSession`, so an `awaiting_human`
  task keeps its claim, and `landConversationWork` borrows a pool member when no tree has the branch.
  *"— model unknown · mode unknown"* was display only: `initLine` now fills from the spawn request.

- **A held conversation's worker slot never came back (t498 ← t497, 2026-09-17).** ClaudeThird held a
  conversation resting at `awaiting_human`; a second task pinned to it queued at capacity, exactly as
  designed — but closing the conversation never freed the worker. `resolveTask` (Finish) and
  `cancelTask`'s `windDown` (Stop) both found "the session to close" through `sessionOf`, which answers
  "is a run open right now" — `endConversationTurn` finishes that run the instant the turn ends and
  keeps the session live for the reply, so neither ever found it. `restingSessionOf` (scheduler.ts)
  finds the most recent run's session whether or not it is open; both call sites use it now. ⛔ Fixing
  this exposed a second bug in the same function: `decideSessionFate` read a stale pre-write
  `task.cancel?.restingState`, so an ordinary human Stop always closed a warm session instead of
  deciding whether to keep it — now passed in explicitly. `conversationcapacity.test.ts`.

- **Routing prefers subscription quota that would otherwise be forfeit at reset (t499, 2026-09-17).**
  `quotaRisk` used to *penalise* an account resetting soon with money already spent on it (90% of a
  7d window, 10h to reset, scored `−0.491`). New signed term `prepaid` (`scoring.ts`, routing model
  **v1.1**): `+0.25 + 0.75×forfeitValue` for a forfeiting subscription window (`forfeitShare`'s pace
  projection), `0` for local/free/unknown billing, `−1` for money spent now (credits past a blocking
  window, or a priced API rate with no subscription window). Always on, not behind
  `modelRoutingActive()`. `windowRisk` lost its reset-horizon factor (it could exceed 1.0); `quotaRisk`
  now skips a billing window `prepaid` finds forfeiting, including a fresh non-session
  `allowed_warning` on it. `docs/routing.md` §3.3, §3.3a.

- **Three thread-page UI fixes (t500, 2026-09-17).** The thread no longer needs a manual scroll to
  follow a running agent: a reader already at the bottom is kept pinned there as messages and the
  live activity tail grow, the same pinned-tail pattern `SessionStream` already used for its own pane
  (`isNearThreadBottom`, `lib/threadscroll.ts`). `.detail-head` — the back button and the `t<seq> ·
  title` heading — is now `position: sticky` at the top of `.content`, so a long thread no longer
  scrolls the way out off the page; the title truncates to one line rather than wrapping the pinned
  header taller. The composer's ordinary pill row (`.composer-bar`) no longer wraps to a second line
  at an unpredictable point — it scrolls horizontally instead, the same answer already used for the
  Plan & Split and Debate tables; `.composer-send` buttons no longer wrap their own label either.
  `docs/ui.md`.

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
5. **Verify `v0.1.1` as installed from the Releases page**, on Windows and on a Mac — the promoted build is a rebuild of the rc, not the same artefacts.
6. **Pair two real machines over Tailscale (t419).** Generate a desktop code on one, pair from the
   other, then drive a terminal, add a worker and file a task remotely. Confirm notifications from
   both computers, a revoke on the host cutting the client off, and the ±1 version warning.
7. **Post-launch, in the order the t392 debate ranked them:** a first-class OpenCode adapter (the
   generic declarative adapter cannot meter, gets no MCP tools and cannot reap orphans); CI watch
   after `gh pr create` ([`src/daemon/landing.ts`](src/daemon/landing.ts) ~l.1391); an
   update-available check that keeps `publish: null`; a full data-directory export (isolation roots,
   attachments); and a clone-per-worker or container backend, the only thing that closes both the
   host-authority gap and the shared common-`.git` grant. ⚠️ Deliberately **not** on this list:
   GitHub/Linear/Slack intake, agent-to-agent messaging, kanban, voice, cross-machine sync.
8. **Give Antigravity a real per-worker isolation root.** It shares `~/.gemini` today; changing `HOME`
   must first be proven not to disturb the OS-keyring credential. See [`docs/adapters.md`](docs/adapters.md).
9. **Finish the metering and calibration measurements.** Meter PTY-hosted Codex from rollout data;
   compare small and large quality-review models on the same five tasks; verify the Claude credits
   gauge against one real invoice; and decide whether preempted runs should contribute to estimates.
10. **Increase thread UI coverage where behaviour changes.** Most thread interactions remain
   hand-tested. Extract pure decisions into `src/renderer/src/lib/` first.
11. **Continue the scheduler split only when touching it.** `scheduler.ts` remains about 3,780 lines
   against a ~1,500 target; no extracted module may read a scheduler binding at module evaluation time.
12. **Drive t423's live views in the packaged app, with a real run behind them.** Watch a dispatched
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

Record results, CLI versions and dates in [`docs/cost-model.md`](docs/cost-model.md), then remove the row.

## Durable constraints

- A worker is an account; a session is a live process. Quota belongs to the worker, context to the
  session. [`docs/glossary.md`](docs/glossary.md) is authoritative.
- The scheduler spends zero tokens; model judgment is asynchronous and has a deterministic fallback.
- Agents use pooled worktrees, never the trunk — unless the task's workspace mode is `trunk`, which
  holds the single trunk lease. Nothing kills a process by image name or bare PID.
- The renderer treats agent output as untrusted text; no raw HTML. Do not trust an agent-session view of `%APPDATA%`: packaged hosts can redirect it. See [`docs/development.md`](docs/development.md) §4.
