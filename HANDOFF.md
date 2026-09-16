# Warmstart — Session Handoff

## Current state — 2026-09-16

Warmstart M0–M6 is implemented, including debate mode, quota-aware scheduling, pooled worktrees,
model-aware routing, quality review, remote access, packaging, and atomic worker/model reassignment.
The maintained reference in [`docs/`](docs/README.md) is the
authority on each subsystem; dated design and incident history belongs in `transient_docs/`, not here.

Baseline (2026-09-16, **Windows 11**, measured on the packaging fix over `0.1.0+9.gd5e8f3f`):
typecheck, lint and build pass; L1 **3,635 passed, 5 skipped** (214 files); L2 **203 checks**
(5 skipped); L4 **19 checks** against `release/win-unpacked`, the packaged daemon answering
`v0.1.0+9.gd5e8f3f.dirty`. L3 not re-run on this tip (no renderer change); it was **474 passed, 4
skipped** at `0.1.0+8.gb642d0e`. macOS 13 arm64, 2026-09-14: L3 434 (6 skipped), L4 17 on a
signed, hardened-runtime bundle. CI is **enabled**, and so is the **Release** workflow.

**`v0.1.0` is released and `latest`** (tag build 35066743396, 2026-09-16, attested — the first
tag build on the public repository). **The version is now the tag** (t485, below): nothing in the
tree carries one, so there is no "prepared, untagged" state any more, and a release is one turn:
`/release rc` on a green `origin/main`, install and verify it, `/release promote`. ⭐ That flow has now
carried a real cut, `release.yml`'s verify step included. Then Phase 3/4 (write-up, demo GIF, landing
page, channels), all off-repo.

**`v0.1.1-rc.1` is tagged, built and published** (tag build 35161851026, 2026-09-16; five installers
+ `SHA256SUMS.txt`, attested). ⚠️ It published as a **full release** and became `/releases/latest`
for ~8 minutes before being corrected with `gh release edit --prerelease` — see the version.mjs entry
below. ⏭ Next: install it, verify it, then `/release promote`.

## Closed in this cleanup

- **`scripts/version.mjs` printed nothing when *run* on Linux or macOS, and that decided a
  release's visibility (2026-09-16).** It tested whether it had been invoked directly by comparing
  `import.meta.url` against a hand-built `file:///${process.argv[1]}` — right on Windows (`C:\a` →
  `file:///C:/a`), never true on POSIX (`/a` → `file:////a`). ⭐ So `release.yml`'s
  `version=$(node scripts/version.mjs)` was the empty string, its `case "$version" in *-*)` found no
  `-`, and **`v0.1.1-rc.1` published as a full release and became `/releases/latest`** — the one thing
  t474 says an rc must never be, because installed apps poll that endpoint. Corrected on GitHub with
  `gh release edit v0.1.1-rc.1 --prerelease`; `/releases/latest` reads `v0.1.0` again. `pathToFileURL`
  now, and the workflow **refuses** a version that is not version-shaped rather than defaulting.
  ⚠️ Every consumer that *imports* `resolveVersion()` was unaffected, which is why no build looked
  wrong and every existing test stayed green; `src/shared/version.test.ts` now runs the script as a
  program, and ⛔ that check is green on Windows either way — it only goes red where the bug bit.
  ⚠️ `scripts/build-mac.sh` reads the same command into `.build-cache/version.txt`, so its step
  fingerprints were built on an empty version on macOS; unmeasured, and worth a look on the next Mac.

- **electron-builder is invoked from one script, and never from a config file that computes
  anything (2026-09-16).** t485's `electron-builder.js` — an ESM config that `extends:` the settings
  yml to stamp the version — worked on Linux, on macOS and on this Windows machine, and on **Windows
  CI** made `electron-builder --dir` exit **0** having printed nothing at all and written no
  `release/`, so `test:pack` found no package (⭐ measured: run 35158401830, twice, on the same runner
  image, Node 22.23.2 and electron-builder 26.16.1 that built `v0.1.0` green; not reproducible here
  through `npx electron-builder`, `npm run pack`, or `CI=true npm run pack`). ⛔ **The root cause is
  still unknown**; what is measured is that removing the JS config restores the green build. The
  settings are back in `electron-builder.yml`, the only config, discovered as it was for every release
  up to `v0.1.0`; `scripts/pack.mjs` passes `-c.extraMetadata.version`, which ⭐ reaches the packaged
  `package.json` and leaves the project's own alone (probed with `9.9.9-probe`, read back out of
  `app.asar`), and spawns `node <cli.js>` from electron-builder's `bin` rather than the
  `node_modules/.bin` batch shim. `src/daemon/packaging.test.ts` pins the shape: one config, no
  version in it, every `pack`/`dist:*` script through the wrapper. ⚠️ A packaging step that reports
  success without packaging is the worst shape a failure can take, and **L4 was the only tier that
  could see it** — nothing below L4 builds a package.

- **A local worker's model is what its server serves, named `local-llm:<served id>` (t486,
  2026-09-16).** `costmodels/local.llm` listed one id, `qwen3-coder-30b-a3b`; every model write is
  validated against the cost model, so it was the only default a person could set and the one
  migrations 44/61 wrote — while llama.cpp ignores `model` on a single-model server, so the
  Qwen3.8-27B endpoint answered and every run and grade said the 30B coder had. The file now
  declares `dynamic_models` (a template under `id_prefix`); `probeIdentity` reads `/v1/models` and
  llama.cpp's `/props` into `identity.servedModels` / `contextWindow`; `knownModelIds` feeds
  `model.options` (an entry per local worker), fitness and triage; the bridge asks `/v1/models`
  when no model is set and names it on `init`, which `noteModelChosen` records on the session and
  `noteReviewerModel` on the grade. Migration 74 clears the pinned literal to null. Benchmark
  priors match the family on the file name; labels are the file name without `.gguf`.
  `docs/cost-model.md` §8a. ⚠️ **Not yet driven against a real server** — both llama.cpp scripts
  were started for this task and neither ever answered on 8080/8090 during the run (no `llama`
  process, nothing listening; measured three times over ~40 min). Next: start one, press Probe on
  the local worker, confirm the picker lists the gguf and a run's session names it.
  Design: [`transient_docs/local_model_identity_2026-09-16.md`](transient_docs/local_model_identity_2026-09-16.md).

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

- **`warmstart-site` polish (t468/t469/t471).** ⚠️ Committed there, **not pushed** — a push deploys.
- **A granted directory can now be committed in, and an agent can ask for one that works (t470,
  2026-09-15).** Codex's elevated Windows sandbox writes a **deny** ACE on each `--add-dir` root's
  `.git`, so edits landed and `git commit` died at `.git/index.lock`. ⭐ Probed on codex-cli 0.151.0:
  passing `<dir>/.git` as its own root draws no deny; `gitMetadataRoots` returns it for the workspace
  and every grant (it had hit plain-clone `trunk` workspaces too). ⭐ New MCP tool
  **`request_directory`** (`daemon/dirgrants.ts`): **Grant** attaches the folder, ends the run and
  requeues it for a warm resume with the agent's `state` as handoff. ⚠️ `claude-code` only; the rest
  name the path after `NEEDS DECISION:`. See `docs/mcp.md`, `adapters.md`.

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
5. ✅ **Closed 2026-09-15** — the signed, notarised `rc.2` bundle drove a real agent on the owner's
   Mac. Unmeasured alone: Application Support isolation, and Antigravity's Keychain under hardening.
6. **Install `v0.1.1-rc.1` on Windows and macOS, verify it, then `/release promote`** so a final 0.1.1 becomes `latest`.
7. **Pair two real machines over Tailscale (t419).** Generate a desktop code on one, pair from the
   other, then drive a terminal, add a worker and file a task remotely. Confirm notifications from
   both computers, a revoke on the host cutting the client off, and the ±1 version warning.
8. ✅ **Closed 2026-09-15** — `rc.2` installed and verified on Windows and macOS.
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
