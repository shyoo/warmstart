---
name: push
description: Ship this session's work all the way to origin — refresh HANDOFF.md (under 200 lines) and any docs/ page the change made wrong, run the suites, build and drive the packaged app, commit, push, and watch CI. Use when the user runs "/push" or asks to "commit and push", "ship this", "get this on main", or "wrap up and push". For a local commit with no push, use /commit instead.
---

# /push — docs, suites, package, commit, **push**

Six steps, in order. **Only run this when asked** — `AGENTS.md` § Git: commit on `main` directly,
and only on request.

⛔ **This skill reaches origin, and `/commit` does not.** They are the same pipeline; `/commit` stops
after step 5 with the work committed locally and nothing published. If the user asked for a *local*
commit — "commit this", "save a checkpoint", "don't push yet" — you are in the wrong skill. Nothing
is lost by running `/commit` first and pushing afterwards: steps 1-5 are identical.

⏱ Budget ~15 minutes end to end. Step 3 is ~3 min, step 4 is ~10. Say so up front if the user is
waiting.

## 0. Where are you standing?

```bash
git rev-parse --git-dir --git-common-dir --abbrev-ref HEAD
```

Two different paths means you are in a **worktree**; the same path twice means the **trunk**
(`C:\Dev\warmstart`, branch `main`). Establish this first — it changes steps 2, 5 and 6.
Say which one you are in.

| | **Trunk** | **Worktree** (`warmstart/t<n>-<topic>`) |
|---|---|---|
| `HANDOFF.md` | edit at step 2 | ⚠️ edit at step 5, **after** the rebase |
| Commit | on `main` | on the task branch |
| Push | `git push` | `git push origin HEAD:main` — the trunk holds `main` checked out, so you cannot check it out here |
| After | — | tell the user the trunk is now behind and needs `git pull` |

⛔ **The branch is named after the task, never after the worktree slot** (`AGENTS.md`). If you are on
a branch named after a directory, fix the name before pushing.

## 0.5. Catch up with origin before you write anything

⛔ **A commit on a base that moved is the thing this step exists to prevent.** Not pushing does not
mean not knowing: fetching is a read, it costs seconds, and it is the difference between a merge you
do now with the change fresh in mind and one somebody does later with none of the context.

```bash
git fetch origin
git rev-list --left-right --count origin/main...HEAD
```

That prints `<behind> <ahead>`. **If the first number is 0 you are current — say so and go to step
1.** Otherwise integrate, and which way depends on whether the working tree is dirty:

**Working tree clean** — integrate first, then do the work of the session's commit on top:

```bash
git status --short          # must be empty
git pull --rebase origin main
```

**Working tree dirty** — ⛔ **do not stash.** `git stash` on the trunk sweeps up whatever any other
tool or agent left in the working tree, and a stash is a *repository* ref that travels with nothing;
this project has already lost an afternoon's work that way. Instead commit first and rebase after:

1. Finish steps 1-5 and make the commit.
2. Then `git fetch origin && git rebase origin/main`.
3. ⚠️ **Re-run step 3 after the rebase.** This is what catches a semantic conflict git merged
   cleanly: your change and theirs each pass alone and fail together.
4. Report that the commit was rebased onto `origin/main`, and onto which SHA.

⚠️ Either way you end **ahead of `origin/main` and merged with it.** A rebase moves local commits
only; the push in step 6 is still the first thing that writes to origin.

⚠️ Doing this now rather than discovering it at step 6 is the point: a push rejected after ten
minutes of packaging costs you step 3 and step 4 all over again.

⛔ If the rebase conflicts, **stop and show the conflict.** Do not resolve somebody else's change on
their behalf and do not `--skip` a hunk to make it apply — `git rebase --abort` leaves the session's
work exactly as it was, which is the recoverable state.

## 1. Survey what changed

```bash
git status --short
git log --oneline origin/main..HEAD
git --no-pager diff --stat origin/main...HEAD
```

Read enough of the diff to write accurate docs and an accurate message. Earlier unpushed commits stay
as they are — **do not rewrite pushed history, and do not squash without asking.** This repo's log is
a sequence of readable stories; collapsing two of them loses one.

Then measure how stale the durable docs are, because that decides how much of step 2 you owe:

```bash
git log -1 --format='HANDOFF last touched: %h %ad %s' --date=short -- HANDOFF.md
wc -l HANDOFF.md
```

## 2. Update the docs — every edit net-neutral or net-shorter

⚠️ **If you are about to append, ask what you can remove in the same edit** (`AGENTS.md` § Doc
hygiene). Nothing here gets a dated `## Latest` section; that pattern grew a 1,400-line handoff in
the sibling repo and no next agent could read it.

- **`HANDOFF.md`** — current state + next steps ONLY. **Target under 200 lines**; it was 356 on
  2026-08-26, so it is already over and trimming is part of this step, not a favour to a future
  session.
  - **Refresh the `Baseline` line with counts you actually ran in step 3** — not the counts already
    written there. ⭐ *Measure, don't assert* (`AGENTS.md`): a baseline copied forward is a claim
    nobody checked. Include the date.
  - Delete every next-step this session finished. A measurement run (R1–R12) that landed moves its
    result into `docs/cost-model.md` **with the date and the CLI version**, and its row is deleted
    here.
  - No session narrative. Reasoning worth keeping goes to `transient_docs/changes_history.md`;
    routine work needs no entry at all, because `git log` already has it.
  - Re-read the file top to bottom before finishing and cut what became history.
  - ⚠️ **From a worktree, do this at step 5 instead.** Your base is stale right now, and two sessions
    rewriting one hand-curated file from different bases conflict in the one place a conflict costs
    somebody their next-steps.
- **`docs/`** — permanent and maintained. **Kept current, not appended to.** ⛔ Go through this
  table and update the page your change made wrong. `docs/development.md` §7 is the same table with
  the reasoning; [`docs/README.md`](../../../docs/README.md) is the index.
  - `docs/architecture.md` — a process, a loop or its cadence, an RPC method, the data directory,
    an environment variable, or an **invariant**. ⛔ A new invariant goes here in full and is
    *pointed at* from `AGENTS.md`, never written out twice.
  - `docs/data-model.md` — a migration, a column, or a change to a load-bearing union. ⛔ A new
    migration also bumps the `MIGRATION_COUNT` figure in §2 of that page.
  - `docs/cost-model.md` — any measured number, cache or compaction behaviour, quota rung, or a
    measurement run that landed. ⛔ Every number carries where it came from and when.
  - `docs/routing.md` — an eligibility gate, a weight, a tie-break, or the controller consult.
  - `docs/adapters.md` — anything learned about what a CLI can actually do. ⛔ Never promote a
    capability to `measured` without having watched it be true.
  - `docs/sessions.md` — continuation, resume, or cross-task sharing. `docs/landing.md` — finish
    policies, the landing bar, rescue commits, loose ends.
  - `docs/mcp.md` — a tool added, removed or moved between tiers. `docs/ui.md` — a route, a
    component, or a renderer convention.
  - `docs/testing.md` — a new tier, or **a new way a suite here can lie**. ⭐ A suite that reported
    a confident false pass earns an entry even after it is fixed.
  - `docs/development.md` — a script, a build flag, a packaging rule, or a platform failure.
  - `docs/glossary.md` — only if a domain word changed meaning or a new load-bearing one appeared.
  - If a page is still correct, say so and skip it. Do not touch a file to prove you read it.
- **`AGENTS.md`** — the map: durable rules, layout, and one-line pointers into `docs/`. Edit only if
  a durable fact changed. ⛔ **Under 200 lines, and the detail belongs on the page, not here** — it
  loads into every session's context. **Also delete any pitfall this session made impossible** — the
  code path is gone, or a guard now catches it. The rule stays; the story of the bug goes to
  `changes_history.md`.
- ⭐ **`npm test` (step 3) carries the guard**, `src/daemon/docs.test.ts`: it fails on a page missing
  from the index, a relative link resolving to nothing, a `src/…` path a doc cites that has moved,
  and `AGENTS.md` / `HANDOFF.md` past 200 lines. ⚠️ It checks the mechanical half only — it cannot
  tell whether a sentence is still *true*, which is what this step is for.
- **`README.md`** — only if user-facing setup, commands, or install/build instructions changed.
- **`transient_docs/changes_history.md`** — the archive, and the only place a narrative belongs.
  A decision and its reasoning, a rejected alternative, a subtle bug and its fix. ⚠️ It runs
  **oldest first, by milestone** (M1 → M6), so a new section is appended at the end, not inserted at
  the top. ⛔ Never read this file for status.
- ⛔ **`internal_docs/` is the owner's private notes.** Gitignored. Do not commit it, do not cite it,
  do not edit it.

## 3. Run the suites — do not push broken code

```bash
node scripts/ensure-electron.mjs
```

That first line is not optional: Electron 44 ships no postinstall, so `node_modules/electron/dist`
can be empty and every suite below needs it. The failure looks like a broken build, not a missing
download.

```bash
npm run typecheck && npm run lint && npm test
npm run test:daemon
npm run test:ui
```

- **Run all of them, not only the ones you think you touched.** `test:daemon` and `test:ui` drive the
  real app over a real daemon and catch what typechecks perfectly.
- ⛔ **Never run `npm run test:e2e`.** It is the only suite that spends tokens, it is gated behind
  `WARMSTART_E2E=1`, and CI deliberately never invokes it. If the change genuinely needs
  it, **ask first** and say what it will cost.
- ⚠️ **Report the numbers, not "tests pass".** They become the `Baseline` line in step 2.
- A failure is a stop condition. Fix it, or say plainly what is broken and stop.

## 4. Build the release artifact

```bash
npm run pack        # electron-builder --dir → release/win-unpacked
npm run test:pack   # the only suite that runs against a real package
```

⛔ **`test:pack` is not optional and nothing above covers it.** It is the only thing that catches a
native module left inside the asar, an app that cannot start its own daemon, or a PTY that will not
open — every one of which passes `test:ui` and fails on a user's machine.

⛔ **It rewrites `release/win-unpacked/`, so nothing may be running out of it.** ⚠️ There was a
second copy under `release/suite/` for exactly one day (2026-08-27) so that packaging could not
collide with an app run from the repo; it is gone, because the app to *use* is the one the
installer installs. If `pack` fails with `EPERM`/`EBUSY`, something is executing out of
`release/` — **find out whose it is before reaching for a kill**, and expect it to be the
operator's own app rather than a stranded test. Their answer decides; do not assume.

⚠️ orchestratord is detached by design and outlives its window, so closing the app is not always
enough — but with the tray switched off, quitting now asks the daemon to stop itself.

⚠️ **Every suite below L1 drives a build product and none of them builds one.** `test:daemon` and
`test:ui` start the app out of `out/`; `test:pack` drives the package. Each now refuses when the
artefact predates `src/` — but the order above is still the order: build, then drive.

Then the installer, when the user wants an artifact rather than a check:

```bash
npm run dist:win    # → release/warmstart-<version>-win-{x64,arm64}.exe
```

- `release/` is **gitignored**. The artifact is a build product; it is never committed and step 6
  does not carry it. Report its **path, size and mtime** as evidence it was built, and say which
  version string it carries (`version.json` → `version`, mirrored in `package.json`).
- ⛔ **Bumping the version is the owner's call, not yours.** That is `/release`, on request; never
  edit `version` to make a filename look right.
- ⚠️ Unsigned by design — SmartScreen warns on the installer, and macOS is un-notarised. That is the
  honest state of a pre-alpha, not a build failure and not something to work around.
- On a docs-only change, `pack` + `test:pack` is enough. Say you skipped `dist:win` and why.

## 5. Commit

```bash
git add -A && git status --short
```

Then **read that output**.

- ⛔ Confirm nothing staged defeats `.gitignore`'s intent: no `internal_docs/`, `out/`, `release/`,
  `node_modules/`, no `*.db` / `*.db-wal` a dev run dropped, no `*.tsbuildinfo`.
- ⛔ **Never commit a credential or anything out of a worker's isolation root.** Those live in the OS
  app-data directory; nothing in this repo should ever contain one.
- **Worktree only** — rebase first, then write `HANDOFF.md` (step 2), then commit:
  ```bash
  git fetch origin && git rebase origin/main
  ```
  ⚠️ **Re-run step 3 after the rebase.** This is what catches a semantic conflict git merged cleanly:
  your change and theirs each pass alone and fail together.
- ⚠️ If step 0.5 found you behind with a dirty tree, the rebase happens **now**, after this commit —
  then step 3 again. Same rule in the trunk as in a worktree.
- Message: a **title that says what happened**, then the reasoning. The log here reads as sentences —
  *"A lint script that had never once run, and the four bugs it found"*, *"Linux does not call the
  executable what productName says"* — not as `fix(ui): …`. Match it. Body: what changed, and what
  was wrong before. End with:
  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  ```
  ⭐ Sign off as **the model actually doing the work**. If that line names an older model than you
  are, you are the newer fact: use your own name and update this file.
  (`git log -3 --format=%B | grep -i co-authored` shows what the repo has been using.)
- Never `--no-verify` or skip hooks unless the user explicitly asks.

## 6. Push, then watch CI

```bash
git push                    # trunk
git push origin HEAD:main   # worktree
```

- If the push is rejected, somebody pushed in the gap: `git fetch && git rebase origin/main`, re-run
  step 3, push again. ⛔ **Never force-push without asking.**
- Confirm it landed and report the range:
  ```bash
  git status -sb && git log --oneline origin/main -1
  ```
- **CI runs on every push to `main`** — seven jobs across Windows and Linux, ~2-3 minutes:
  `typecheck · lint · build · unit`, then `daemon`, `ui` and `packaged app` on each of
  `windows-latest` and `ubuntu-latest`. ⚠️ There is **no macOS runner** (counted 2026-09-01, run
  33578997956) — a macOS-only regression is not something a green tick here rules out.
  ```bash
  gh run list --limit 3
  ```
  Report the run number and offer to watch it. ⛔ Do not call a push green before the run finishes:
  the local suites do not cover Linux, and the `packaged app` jobs run only on push, never on a
  pull request.
- **From a worktree:** say that the trunk is now behind `origin/main` and needs a `git pull`.

## Guardrails

- ⛔ **No step here may spend a token** except `test:e2e`, which this skill never runs.
- ⛔ **Never kill a process by image name, and never kill a bare pid.** If a suite leaves something
  running, read its command line and confirm it is yours first. `taskkill /IM` has taken out the
  user's own Claude Code window.
- ⛔ **Do not sweep somebody else's work into your commit.** In the trunk, `git add -A` stages
  whatever any other tool left in the working tree. Read `git status` and confirm the files are
  yours.
- **The two names.** Anything a user or an agent reads says **Warmstart** — commit
  messages, docs, README, UI copy. `agentyard` stays internal: source comments, `window.agentyard`,
  test fixtures, `LEGACY_APP_DIR`.
- If something in this file turns out to be wrong — a script renamed, a suite retired, a count that
  no longer matches — **fix it in the same session**. A stale skill gets followed anyway.
