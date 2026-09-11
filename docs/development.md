# Development

Setup, the build pipeline, packaging, the platform failures that look like something else, and the
commit workflow.

> **Audience:** anyone building, packaging, or debugging a build that fails for a reason that is not
> in the code.
> **Authority for:** the scripts, the platform pitfalls, and what a commit owes the docs.
> Suites are in [`testing.md`](testing.md).

---

## 1. Setup

```bash
npm install
node scripts/ensure-electron.mjs   # not optional — see below
npm run dev
```

⛔ **Electron does not download itself.** Electron 44 ships **no postinstall** — it exposes
`install-electron` as a bin and leaves the ~110MB download to you — so `npm install` finishes with
`node_modules/electron/dist` empty and every suite here needs that dist. `scripts/ensure-electron.mjs`
retries and reports whether the release host is reachable. **The failure looks like a broken build,
not a missing download.** ⚠️ This is not npm blocking a script; there is no script to block, so there
is no npm setting that fixes it. It is idempotent — safe to run when you are unsure.

Requirements: Node 22+ (to build; the app runs on the Node inside Electron), Git 2.40+, and at least
one agent CLI on `PATH` for anything beyond L1.

**Pulling source does not refresh dependencies.** When `package.json` or `package-lock.json` changes,
run `npm ci` before building (or `npm install` only when deliberately changing the resolved dependencies),
then run `node scripts/ensure-electron.mjs`. An existing `node_modules` otherwise lacks newly locked
packages and TypeScript reports the misleading-looking `Cannot find module` error.

## 2. The scripts

```bash
npm run dev          # electron-vite dev
npm run typecheck    # tsc --noEmit over tsconfig.node.json and tsconfig.web.json
npm run lint         # eslint, type-aware rules on
npm run build        # typecheck + production bundle into out/
npm start            # preview a production build

npm test             # L1
npm run test:daemon  # L2   ⚠️ needs out/ built
npm run test:ui      # L3   ⚠️ needs out/ built
npm run test:all     # L1 + L2 + L3 — the pre-commit set
npm run test:pack    # the packaged app  ⚠️ needs release/ packed
npm run test:e2e     # ⛔ spends real tokens; WARMSTART_E2E=1 required

npm run pack         # electron-builder --dir → release/win-unpacked
npm run dist         # installers for the current platform (dist:win / dist:mac / dist:linux)
```

⚠️ **Type-aware lint rules are on.** They cost a TypeScript program per run and are the only rules
that can see the mistakes this codebase actually makes — a floating promise in a process-spawning
daemon, a `String(x)` on a value a vendor may send as an object, an `any` out of `JSON.parse`. ⛔ A
rule is disabled only with the reason written down; *"it fired a lot"* is not a reason.

### `scripts/build-win.ps1` — the whole pipeline, cached

⭐ Runs checks → bundle → packaged app → drive it. **~92s cold, seconds warm.** Steps are
content-addressed: each fingerprints the files it reads (SHA-256 over **content**, never mtimes) and
is skipped only when the fingerprint is unchanged *and* its outputs are still on disk. A stamp is
written only after the step exits 0, every stamp carries the script's own hash, and a skip prints the
date the step last really ran.

| Flag | Does |
|---|---|
| `-Help` (`-h`, `-?`) | the options, grouped by the question being asked |
| `-Restart` | ⭐ the inner loop: stop what this repo has running, build, start the result |
| `-Quick` | typecheck, lint, unit, bundle. No packaging |
| `-Installer` | also the NSIS installer (x64 + arm64) |
| `-SkipTests` | bundle and package with no suites. ⚠️ `test:pack` is the only asar check |
| `-Fresh` (`-NoCache`, `-Rebuild`) | ignore every cached step |
| `-StopDaemon` | stop this repo's app and daemon first. ⛔ Refuses while agent processes are under it |
| `-StopAgents` | implies `-StopDaemon` and stops the agents too. ⚠️ Ends real work on a real account |

⛔ **Never by image name, at either level.** A process is stopped only if it executes from a path this
repo owns or is a verified descendant of one that does, and its `(pid, creation time)` pair is re-read
at the moment of the kill. ⚠️ Windows has no SIGTERM: `Stop-Process` is `TerminateProcess`, so the
daemon's own shutdown — which closes sessions and releases claims — does not run, and any agent CLI it
spawned is left orphaned, signed in, and able to keep spending. That is why the refusal is the
default.

## 3. Packaging

⛔ **There is exactly one packaged app in the tree, `release/win-unpacked/`, and it is the build's.**
A second copy under `release/suite/` existed for one day (2026-08-27) so packaging could not collide
with an app run from the repo. It was removed the same day, because **the app to use is the one the
installer installs**, and two identical executables with only one ever new cost more than they saved —
98 minutes debugging a change that had in fact taken effect, then an `EPERM` that stopped a commit.
So packaging *does* collide with the repo's own copy now, and that is correct rather than a bug.

⛔ When it collides, **find out whose the process is before reaching for a kill.** A command line
matching the packaged binary matches the operator's own app just as well as a test's. ⚠️ And
orchestratord is **detached by design**, so it holds the binary after its window closes — the topology
working, not a leak. Guard the directory actually being rewritten, nothing wider.

⚠️ Builds are **unsigned**. Windows SmartScreen warns; macOS Gatekeeper refuses until cleared by hand.
That is the honest state of a pre-alpha; signing is a certificate and a release process, not a config
line. ⛔ Bumping `package.json` `version` is the owner's call.

`release/` is gitignored. An artifact is a build product and is never committed.

## 4. Platform failures that look like something else

### Paths

⛔ **Never compare two paths with `===`.** Windows filesystems are case-insensitive and Windows
*paths* are not, so `c:\Dev\x` and `C:\Dev\x` are one directory and two strings. This install held one
pooled worktree under both spellings in `sessions.cwd`; the source was `policyFor`, which derives an
unconfigured workspace root by concatenating onto `project.root` while a configured one comes back
from `resolve` in the config's own case.

Use `samePath` from `fspath.ts`. It folds case on win32 only, because `/Dev` and `/dev` are genuinely
two directories everywhere else. ⚠️ **Both failures are silent**: a missed match costs a cold start,
and in the workspace pool it hands the task a **different worktree** than the one its conversation
describes.

⛔ **An agent's `%APPDATA%` may not be the user's.** A tool running inside a packaged host — the Claude
desktop app is an MSIX package — has `AppData\Roaming` redirected to that package's
`%LOCALAPPDATA%\Packages\<id>\LocalCache\Roaming\`: reads fall through to the real folder until the
package holds its own copy, writes always land in the copy, and every process the tool spawns inherits
the redirect. Measured 2026-09-10: the same `warmstart.db` path was 425 KB from the user's shortcut
and 37 MB from the agent's shell, and `fsutil file queryfileid` run from inside reported the two as
one file. Every launch by the agent showed the fleet; every launch by the user was empty; the user's
"the file is not there" was correct all day. To see what the user sees, spawn outside the package
(`Invoke-CimMethod -ClassName Win32_Process -MethodName Create`, output to `C:\Users\Public\`) or ask
the user to run the command. `C:\Dev` and `C:\Users\Public` are not redirected.

### Spawning

- **node-pty does not search PATH.** On Windows it goes straight to `CreateProcess` and fails with a
  bare *File not found* for a command that runs fine in a shell. Everything spawnable goes through
  `daemon/which.ts`, which also routes `.cmd`/`.bat` shims through the command processor.
- ⛔ **`cmd /d /s /c <shim>` splits any path containing a space.** `/s` makes cmd strip the outer
  quotes and take the rest literally, and the Windows default home has a space in it. Use `/d /c` and
  let Node quote the argument; do **not** add quotes yourself. Latent since M1 and invisible until a
  CLI installed as a `.cmd` rather than a `.exe`. Everything that starts a CLI goes through
  `launchable()` / `launchArgs()`, **including detection** — `execFile` on a `.cmd` without a shell
  fails with a bare `spawn EINVAL`, and detection that fails for an installed CLI reports it missing.
- ⛔ **`node --experimental-strip-types` resolves no path aliases, and the failure is silent.**
  `local-llm.test.ts` spawns `adapters/local-llm-bridge.ts` as *source* that way rather than building
  it. Type stripping is not compilation: it knows nothing of `@shared`, so an import through the alias
  kills the child before its first record and every check in that suite waits out its 15s timeout and
  reports as **slow rather than broken** — 105 seconds of red with no error message anywhere in it
  (2026-09-07, an `errorMessage` sweep that touched 91 files and could not touch that one). The bridge
  therefore copies in anything it would otherwise share, and the suite asserts that it did.
- **`--print` will not start under a PTY.** It exits immediately with *"Input must be provided either
  through stdin or as a prompt argument"*, because a pseudo-terminal is not piped stdin. The `stream`
  transport uses real pipes; only `pty` uses node-pty.

### Electron

- **A sandboxed preload must be CommonJS.** `package.json` sets `"type": "module"`, so the preload is
  built to `index.cjs` via an explicit rollup output override in `electron.vite.config.ts`. If you see
  *"Cannot use import statement outside a module"* from the preload, that override was lost. ⛔ Do not
  "fix" it by dropping `sandbox: true`.
- **A native module cannot be loaded from inside an asar.** `dlopen` needs a real path and the archive
  is virtual, so `.node` files are unpacked beside it. ⚠️ The `.node` files are **not** in
  `@lydell/node-pty` — they are in per-platform siblings like `node-pty-win32-x64`, so a glob naming
  the parent matches nothing. `npm run test:pack` is the only suite that catches this.
- ⛔ **`ready-to-show` is not a guarantee.** See [`testing.md`](testing.md) § *A window the operator
  did not ask for* for the measurement and what `showwindow.ts` does about it.
- **A Windows tray icon is a runtime resource.** The `.ico` embedded in the executable is not what
  `new Tray()` reads; `resources/icon.ico` is copied through `extraResources` and loaded by
  `trayIconPath()`. `test:pack` checks both the embedded app icon and the runtime tray file.

### Git and worktrees

⛔ **A sandboxed worker in a `git worktree` cannot commit unless the trunk's `.git` is writable.**
`<worktree>/.git` is a file, not a directory: the index lives in `<trunk>/.git/worktrees/<slot>` and
the objects and branch ref in the common `<trunk>/.git`, so a sandbox scoped to the workspace forbids
all three. codex is granted them with `--add-dir` (`gitWritableRoots` in
`adapters/openai-compatible.ts`).

⚠️ Widening a worker's writable set is not free — the common `.git` carries every other task's refs —
so it is granted from the measured requirement and never by reflex, and `--sandbox` itself is never
relaxed to buy the same thing.

⚠️ **The ACL reset on prepare (`cleanWorkspaceAcls`) is partial, twice over, and now says so.**
Measured in `ws1`, 2026-09-11: a sandboxed Codex run rewrites files as `CodexSandboxOffline`, and the
daemon — the operator's own token, unelevated — holds Modify on those but not WRITE_DAC, so
`icacls /reset /t /c` answers *Access is denied* on each (171 of 19,321) and carries on; they keep
the DACL the sandbox last gave them, an old capability SID included. And the full pass takes
**7.2 s** against the 5 s `execFileSync` cap, so it is killed on every prepare and whatever sorts
after the cut-off is never touched. Both were silent behind `stdio: 'ignore'`; both are `warn` lines
now. Raising the cap costs every dispatch that much and is a separate decision; delete-and-checkout
of the sandbox-owned files (Modify includes DELETE) is the untried fix.

⛔ **A worktree is where an agent *starts*, not a boundary it is held inside.** For `antigravity-cli`
the workspace must be named with `--add-dir <cwd>` on **every** spawn, resume included — cwd alone let
a task edit and commit in the trunk on 2026-08-28. ⚠️ Ask any new adapter the same question before
trusting it with `--dangerously-skip-permissions`: *what, other than the cwd, tells this CLI where it
may work?* If the answer is nothing, the flag is bounded by nothing.

⚠️ **Kept because the failure is silent:** a task that commits straight onto `main` never moves its
branch, so the finish logs `nothing-to-land` and every gate that runs *before a branch merges* is
skipped. Nothing detects this. If a task finishes `nothing-to-land` and the work plainly happened,
read `git reflog` in the trunk before believing the agent did nothing.

## 5. Working in a worktree

Agent sessions on this repository run in a pooled git worktree, not the trunk.

- The branch is named after the **task** (`warmstart/t123-…`), never after the slot.
- ⛔ **The git stash stack is shared with the trunk and every other worktree.** Never use bare
  `git stash` / `git stash pop`. Prefer a temporary WIP commit; if you must stash, use
  `git stash push -u -m "<unique-tag>"`, capture the SHA from `git stash list --format='%H %gs'`, and
  restore with `git stash apply <sha>`.
- Run every command from the worktree. Do not `cd` to the trunk.

## 6. CI

`.github/workflows/ci.yml`, on push to `main`, on pull requests, and on demand.

- `check` (ubuntu): typecheck · lint · build · unit. Runs first, and populates the Electron cache the
  matrix jobs restore.
- `daemon`, `ui`, `pack`: Linux + Windows on push and PR.
- ⛔ **macOS runs on demand or on a tag only.** GitHub bills macOS at 10× and Windows at 2×; measured
  2026-08-26 → 2026-08-30, **103 runs in five days** exhausted the account's allowance. Coverage is
  not dropped, it is made deliberate — `workflow_dispatch` and any tag run the full three-platform
  matrix.
- ⛔ **No job may spend a token.** Runners have no agent CLI and nobody signed in; that is the state
  the suites were taught to handle.

⚠️ A green tick does not rule out a macOS-only regression on an ordinary push, and the `pack` jobs run
on push, never on a pull request.

## 7. Committing, and what a commit owes the docs

Private repo, single developer, no PR review. Commit on `main` directly, and **only when asked**.

**`/commit` commits locally; `/push` publishes.** Same pipeline: catch up with `origin/main` → survey
the diff → **update the docs** → run the suites → build and drive the packaged app → commit. `/commit`
stops there; `/push` pushes and watches CI.

⛔ **Both fetch and integrate `origin/main` first.** A commit on a base that moved is a conflict
deferred, not avoided. ⚠️ On a dirty tree they commit and *then* rebase, because `git stash` on the
trunk sweeps up whatever another agent left there.

⛔ **Both are Claude Code slash commands, not a general instruction.** A non-Claude worker dispatched
onto a task in this project (codex, agy) has no way to invoke either and must not reproduce their
steps from memory — follow the finishing instruction the task actually gives you. Measured 2026-09-01:
a codex worker read `AGENTS.md`, narrated *"I'm using the project's /commit workflow,"* and improvised
its own version, including editing unrelated lint failures to make a "required" check suite pass.

### The doc step, in full

Every commit that changes behaviour owes an edit to whichever of these it made wrong:

| Change | Owes |
|---|---|
| a measured number, cache/compaction behaviour, a quota rung, a landed measurement run | [`cost-model.md`](cost-model.md) — ⛔ with its source and date |
| what a CLI can actually do | [`adapters.md`](adapters.md) — ⛔ never promote to `measured` without watching it be true |
| routing, scoring, gates, the consult | [`routing.md`](routing.md) |
| a migration, a column, a status or a union | [`data-model.md`](data-model.md) |
| an MCP tool or tier | [`mcp.md`](mcp.md) |
| a process, a loop, an invariant, an env var | [`architecture.md`](architecture.md) |
| a suite, a harness helper, a new class of false pass | [`testing.md`](testing.md) |
| a script, a flag, a platform failure | this page |
| a route, a component, a token | [`ui.md`](ui.md) |
| a domain word's meaning, or a new load-bearing one | [`glossary.md`](glossary.md) |
| finishing, landing, rescue, loose ends | [`landing.md`](landing.md) |
| conversation reuse, resume, sharing | [`sessions.md`](sessions.md) |
| user-facing setup, commands, install | `README.md` |
| ⛔ **always** | `HANDOFF.md` — baseline counts you actually ran, and delete every next-step this session finished |

⚠️ **If a page is still correct, say so and skip it.** Do not touch a file to prove you read it.
⚠️ **If you are about to append, ask what you can remove in the same edit.**

Narrative belongs in `transient_docs/changes_history.md` — oldest first, appended at the end — and
nowhere else. ⛔ Never read that file for status.

### The guard

`src/daemon/docs.test.ts` runs in `npm test` and CI. It fails on a page missing from
[`docs/README.md`](README.md), a broken relative link in any tracked markdown, a `src/…` path cited by
a doc that no longer exists, and `AGENTS.md` or `HANDOFF.md` over their line budgets. It catches the
mechanical half of staleness only — a sentence that is simply untrue still needs a reader.
