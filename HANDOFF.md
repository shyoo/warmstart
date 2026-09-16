# Warmstart — Session Handoff

## Current state — 2026-09-15

Warmstart M0–M6 is implemented, including debate mode, quota-aware scheduling, pooled worktrees,
model-aware routing, quality review, remote access, packaging, and atomic worker/model reassignment.
The maintained reference in [`docs/`](docs/README.md) is the
authority on each subsystem; dated design and incident history belongs in `transient_docs/`, not here.

Baseline (2026-09-15, **Windows 11**, measured on t474.2's tip over the merge of t446–t473, at
`0.1.0-rc.1`): typecheck, lint and build pass; L1 **3,570 passed, 5 skipped** (210 files); L2
**203 checks** (5 skipped); L3 **452 passed, 4 skipped** at the pinned 1024×720 window; L4 **19
checks** against `release/win-unpacked`. macOS 13 arm64, 2026-09-14: L3 434 (6 skipped), L4 17 on a
signed, hardened-runtime bundle. Last CI green on all seven jobs: `593e5c6`, run 35058132724 — the
merge commit itself. CI is **enabled**, and so is the **Release** workflow, now proven end to end.

⛔ **`v0.1.0-rc.1` is tagged at `eefbbbd`, one commit *before* that merge, so the six published
artifacts contain none of t446–t473** — not the `.git` directory grant, not Plan & Execute, not the
trunk `GIT_DIR` repair. Release run 35055712204 succeeded and the pre-release is public with both
`.dmg`s, both `.exe`s and `SHA256SUMS.txt`, which closes item 6; what it does *not* do is ship this
tree. ⏭ **Cut `rc.2` from the merge before installing anything on a second machine**, or items 5
and 8 get demonstrated against a build 25 commits behind the repository. The rest of the
go-public order stands: install *that* artifact → items 5 and 8 → delete draft
`untagged-34911447448` → flip the repository public → `/release patch` for the bare `0.1.0`, the
first release an installed app can see.

## Closed in this cleanup

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
  `release.yml` reads that file as the first part of the release body, rejects a tag without one
  before `npm ci`, and derives `--prerelease` from a `-` in the version — ⛔ which matters because
  `src/main/updates.ts` polls `/releases/latest`, an endpoint GitHub never answers with a pre-release
  or draft, so every release this workflow had ever published (always `--prerelease`) was invisible
  to installed apps. `isNewerVersion` now lets an installed rc see its bare final. O9 closed by
  wording: `CONTRIBUTING.md`/`CLA.md` promised a CLA bot that does not exist; signing is now a
  comment on the first PR. ✅ The tag build has since run and published (item 6).

- **Codex's reasoning effort is now selectable, matching Claude and Muse (t473, 2026-09-15).**
  `selectableEffort` had been `false` since 2026-08-27 pending a real run — AGENTS.md forbids
  promoting a documented-but-unmeasured flag, and `codex exec --help` lists no `--reasoning-effort`
  flag at all; `-c model_reasoning_effort=<level>` is the actual route in. Measured live against a
  signed-in ChatGPT account (codex-cli 0.151.0): a fresh `exec` and an `exec resume` both echoed the
  level back in the rollout's `turn_context` (`"effort":"high"`/`"medium"`), and an invalid level
  failed the turn with the API's own enum error rather than being silently dropped. `plan()` in
  `openai-compatible.ts` now sends the flag beside `--model`; `constraints.test.ts` and
  `docs/adapters.md` updated to match. ⛔ Past Codex runs' `effort` stays `null`, not backfilled:
  `null` already reads as "CLI default" everywhere, and `statistics.ts` already excludes a
  null-effort session from the per-effort breakdown rather than bucketing it as unknown.

- **User-facing copy rewritten in direct developer style (t464, 2026-09-15).** Sentences, tooltips,
  placeholders and section intros across 21 components in `src/renderer/src/components`; 112 lines
  shorter, with test-invariant assertions and RPC contracts untouched.

- **Finishing a conversation no longer races Retire it (t467, 2026-09-15).** Read-only evidence from
  the live database showed t466 `completed` with its run closed while session `753261d2` remained
  `live` and still claimed its workspace, so Loose ends offered an empty branch and retirement then
  refused the checkout. `resolveTask` now waits (bounded, 15s) for the session process to exit and
  parks/releases its workspace before the Finish RPC returns; a process that misses the wait keeps
  its claim and is never reused. Refusals say **Could not retire/delete/clean up** and what to do.
  Pinned by `runfailure.test.ts` and real-git `landingcorners.test.ts`.

- **A granted directory can now be committed in, and an agent can ask for one that works (t470,
  2026-09-15).** ⛔ The t469 grant was *not* dropped: `--add-dir C:\Dev\warmstart-site` was on the
  argv of both runs (daemon log, 02:14:44 and 02:23:16). Codex's elevated Windows sandbox grants each
  `--add-dir` root a write ACE and then writes an explicit **deny** ACE on that root's `.git` — its
  own audit log, `granting write ACE to …warmstart-site` then `applied deny ACE to protect
  …warmstart-site\.git` — so every edit landed and `git commit` died at `.git/index.lock: Permission
  denied`. ⭐ Probed against codex-cli 0.151.0: passing `<dir>/.git` as a root of its own draws a
  grant and **no** deny, and the commit succeeds. `gitMetadataRoots` (was `gitWritableRoots`) returns
  it now, for the workspace and every granted folder; `externalGitRoots` keeps the `icacls` reset to
  worktrees this fleet made. ⚠️ It silently hit any plain-clone workspace too — a `trunk`-mode task
  could not commit at all. ⭐ New MCP tool **`request_directory`**
  (`daemon/dirgrants.ts`): the operator's **Grant** attaches the folder to the task, ends the run and
  requeues it, so the grant arrives on a warm resume — the card says the restart costs tokens, and
  the agent's `state` becomes the handoff. Refusals never end a turn. ⚠️ `claude-code` only (the one
  adapter with MCP); the rest name the path after `NEEDS DECISION:`. See `docs/mcp.md`, `adapters.md`.

- **The quota-preemption card's wrap-up buttons, and hand-off with a destination (t458,
  2026-09-15).** Multi-button options wrap in `.decide-buttons`, one grid item, so a second button
  stops auto-placing into the description's column. ⭐ A hand-off chosen during the warning can name
  where the work goes: `quotaPreemptWarning.reassignWorkerId`, set by `task.overrideQuota` (refused
  beside `preemptionAction: 'compact'`) and read by `preempt()` at expiry, which reassigns, clears
  `not_before`, and falls back to pausing if the chosen worker is gone. Pinned in
  `quotaoverride.test.ts`, `preemption.test.ts`, `test/ui.test.mjs`. ⚠️ **Not run against a real
  preemption**; seeded through the store like the suite's other quota states.

- **Plan & Execute, and the composer pill's teaching order (t456 / t458, 2026-09-15).** Plan & Execute
  is the same `plan` kind with the fan-out capped at one and no integration turn; the shape is
  *derived*, never stored — `planModeOf` (`shared/tasks.ts`) reads
  `min(mandate.maxChildren, childDefaults.maxChildren) <= 1` and everything follows, including the
  executor landing onto the **project's** target rather than the planner's branch. The pill now reads
  Single Task, Conversation, Plan & Execute, Plan & Split, Debate, from the single `KIND_OPTIONS`
  order. Design, measurements and the two operator decisions:
  [`transient_docs/plan_and_execute_2026-09-15.md`](transient_docs/plan_and_execute_2026-09-15.md).
  ⚠️ **Not run against a real agent**, and the cost claim is unmeasured on this fleet (item 2).

- **t408–t455, landed and documented in docs/ (2026-09-13–15).** Earlier cleanup items now fully
  covered by the docs/ pages they owed; see git history for t408–t449 (probe PTY answers, live quota
  probe, remote settings, Statistics axes, landing messages, welcome tour) and t451–t455 (gate panel,
  idle-turn deferral, Quality Review's N+1 fetch, phone `ask_human` decision card, tour navigation).

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
5. **Run the *signed* app on macOS with a real CLI; this is the launch gate.** The owner confirmed
   an unsigned build compiles, runs and pairs in remote mode, and `./scripts/build-mac.sh` now
   reports a build signed with the hardened runtime, and `npm run test:pack` passes on the Mac (all
   2026-09-14). Remaining: launch *that* bundle, open a PTY, and drive one real task. Still unverified either way: detached daemon startup without system Node
   under the hardened runtime, Application Support isolation, Antigravity's Keychain, Gatekeeper.
6. **Cut `rc.2` from this tree** (`/release rc` → `/push` → tag). `rc.1`'s tag build (35055712204)
   proved the pipeline end to end, but was tagged at `eefbbbd`, before the merge — see the top.
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
