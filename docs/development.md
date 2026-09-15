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
node scripts/ensure-electron.mjs     # not optional — see below
node scripts/link-agent-skills.mjs   # .codex → .claude, per checkout — see below
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

### The `.codex` link

`.codex` points at `.claude` so codex finds the same project skills, and it is **made locally and
never committed**. ⛔ git with `core.symlinks=false` — the default wherever the user cannot create
links, which is most Windows checkouts — writes a committed symlink out as a *regular file
containing its target*. That bought codex nothing and cost this fleet every Muse run: Muse Code
opens `<workspace>/.codex/skills` at startup and exits 1 in ~4.5s against a non-directory, which
took out a whole quality-review batch on 2026-09-14 (t436; measured in
[`adapters.md`](adapters.md#muse-reads-workspacecodexskills-before-it-starts-and-dies-on-a-non-directory-t436-2026-09-14)).

`scripts/link-agent-skills.mjs` makes a junction on Windows and a symlink elsewhere, removes the
placeholder file if one is there, and leaves a real `.codex` directory alone. It is idempotent, it
takes an optional directory argument, and `src/daemon/skilllink.test.ts` fails if a placeholder file
ever reappears in this checkout. ⚠️ A pooled worktree gets no `.codex` at all, which is a codex
without the shared skills and a muse that starts — run the script in a slot if you need the skills
there.

## 2. The scripts

```bash
npm run dev          # electron-vite dev
npm run version:check # version.json agrees with package and lock metadata
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

### `scripts/generate-readme-assets.mjs` — the README screenshots

`node scripts/generate-readme-assets.mjs [scene …]` after `npm run build` writes `docs/images/*.png`
from the real renderer, driving a fictional fleet: three invented accounts, a throwaway git project
under `out/showcase/`, and tasks, runs and quota readings written straight into a scratch database.
No real account, project or CLI is touched and no task is ever `ready`, so nothing dispatches.

⛔ **A window appears for about a minute, and that is the mechanism.** Under `WARMSTART_HEADLESS=1`
the window is never shown, Chromium paints nothing, and `Page.captureScreenshot` waits for ever —
measured 2026-09-11 and again on 2026-09-14, when the first version of this script was found never
to have produced an image. ⚠️ **Two launches.** Run prices are memoised in the daemon and nothing an
outside process can call invalidates them, so finished history is seeded *before* the daemon that
serves the screenshots starts; running tasks are seeded *after* it, because `reconcileTasks` at
startup reaps every `running` task whose daemon died. ⛔ Each launch ends with `daemon.shutdown` and
a wait on the lock file's pid: `Browser.close` alone leaves orchestratord running, and six of them
were found holding six scratch databases before that was understood.

⚠️ **Type-aware lint rules are on.** They cost a TypeScript program per run and are the only rules
that can see the mistakes this codebase actually makes — a floating promise in a process-spawning
daemon, a `String(x)` on a value a vendor may send as an object, an `any` out of `JSON.parse`. ⛔ A
rule is disabled only with the reason written down; *"it fired a lot"* is not a reason.

### `scripts/build-mac.sh` and `scripts/build-win.ps1` — the whole pipeline, cached

⭐ Runs checks → bundle → packaged app → drive it. **~92s cold, seconds warm.** Steps are
content-addressed: each fingerprints the files it reads (SHA-256 over **content**, never mtimes) and
is skipped only when the fingerprint is unchanged *and* its outputs are still on disk. A stamp is
written only after the step exits 0, every stamp carries the script's own hash, and a skip prints the
date the step last really ran. On macOS use `scripts/build-mac.sh`, on Windows use `scripts/build-win.ps1`.

| Flag (macOS / Windows) | Does |
|---|---|
| `--help` (`-h`) / `-Help` (`-?`) | the options, grouped by the question being asked |
| `--restart` / `-Restart` | ⭐ the inner loop: stop what this repo has running, build, start the result |
| `--quick` / `-Quick` | typecheck, lint, unit, bundle. No packaging |
| `--installer` / `-Installer` | also the installer (macOS DMG or Windows NSIS) |
| `--skip-tests` / `-SkipTests` | bundle and package with no suites. ⚠️ `test:pack` is the only asar check |
| `--fresh` / `-Fresh` (`-NoCache`) | ignore every cached step |
| `--stop-daemon` / `-StopDaemon` | stop this repo's app and daemon first. ⛔ Refuses while agent processes are under it |
| `--stop-agents` / `-StopAgents` | implies `--stop-daemon` and stops the agents too. ⚠️ Ends real work on a real account |

⛔ **Never by image name, at either level.** A process is stopped only if it executes from a path this
repo owns or is a verified descendant of one that does, and its `(pid, creation time)` pair is re-read
at the moment of the kill. ⚠️ Windows has no SIGTERM: `Stop-Process` is `TerminateProcess`, so the
daemon's own shutdown — which closes sessions and releases claims — does not run, and any agent CLI it
spawned is left orphaned, signed in, and able to keep spending. That is why the refusal is the
default. On macOS/Unix, `scripts/build-mac.sh` sends `SIGTERM` first and waits for graceful exit.

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

⚠️ **Windows builds are unsigned** and SmartScreen warns. That is a deliberate decision, not an
oversight: signing Windows is a certificate and a purchase, not a config line. **macOS is the other
way round now** — see below. **`version.json` is the version source.** Its value is compiled into the window, daemon and MCP
server; `package.json` and `package-lock.json` carry the same value because Electron Builder requires
package metadata, and `npm run version:check` refuses a mismatch. Change all three deliberately before
tagging `v<version>`; the release workflow rejects a tag that does not name `version.json`.

### macOS signing and the hardened runtime

Every claim in the table below was read out of `app-builder-lib` 26.15.3's own source and re-checked
against 26.16.1, not out of a build log; the owner's Mac has since built a bundle that `codesign`
reports as signed with the hardened runtime (2026-09-14). Pinned by
[`src/daemon/macsigning.test.ts`](../src/daemon/macsigning.test.ts), which runs everywhere and proves
only what the configuration *asks for*.

| Setting | Value | Why |
|---|---|---|
| `mac.identity` | **absent** | `identity: null` takes `handleNullIdentity()` in `macPackager.js` and returns before anything else. ⛔ Notarisation is called from *inside* `sign()`, so a null identity silently disabled both. Absent means auto-discovery of a *Developer ID Application* certificate. |
| `mac.hardenedRuntime` | `true` | Notarisation requires it. ⚠️ Also app-builder-lib's own default for a non-MAS build; stated because it is a decision. |
| `mac.notarize` | `false` | Unset, app-builder-lib notarises whenever signing succeeded *and* the Apple variables happen to be in the environment, so a local build's duration would depend on the operator's shell. `npm run dist:mac:release` overrides it to `true`, and the release workflow is the only caller. |
| `resources/entitlements.mac.plist` + `.inherit.plist` | 3 keys | Found by name in `buildResources`, so no path in any config can be wrong. ⛔ They **replace** electron-builder's built-in template rather than extend it. |

⭐ **The trap to hold in your head: an unsigned build proves nothing about any of this.** The
hardened runtime is a *signing* flag. On a machine with no certificate electron-builder logs a
warning, builds happily, and produces a bundle the flag was never applied to — identical in name,
size and behaviour to one that passed. `scripts/build-mac.sh` therefore ends by reading the bundle
back with `codesign` and printing which of the three outcomes actually happened (unsigned / signed
without the runtime / signed with it). ⛔ Believe that line, not this table.

**The first Mac session, in order.** Each step is worth doing before the next because each one can
fail on its own.

1. **Certificate first.** Install the *Developer ID Application* certificate into the login keychain
   and confirm `security find-identity -v -p codesigning` lists it. Without this, steps 2–4 are
   measuring an unsigned bundle and will all appear to pass.
2. **`./scripts/build-mac.sh`** — no installer, no notarisation, ~90s. Read the signing line it
   prints. ⭐ If it does not say *hardened runtime ON*, stop and fix that; nothing after this means
   anything until it does.
3. **Open a PTY in the signed app.** This is the actual risk: library validation applies to every
   `.node` the app loads, and `@lydell/node-pty` loads out of `app.asar.unpacked` and spawns a helper
   binary of its own. Open a terminal in the app and start a session. ⚠️ If the app opens but the
   *daemon* never comes up, the first thing to try is
   `com.apple.security.cs.allow-dyld-environment-variables` — the plists say why it is deliberately
   absent.
4. **`npm run test:pack`** against the signed bundle, then drive a real task end to end.
5. **Only then** dispatch the release workflow with `platforms=macos`. The five repository secrets
   it reads (`MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
   `APPLE_TEAM_ID`) are set (2026-09-14): `MAC_CSC_LINK` is the bare base64 of the exported `.p12`
   (`base64 -i cert.p12 | gh secret set MAC_CSC_LINK`; `decodeCscLinkBase64` accepts anything over
   2,048 chars), and the three `APPLE_*` values are all-or-nothing in `getNotarizeOptions`. ⚠️ macOS
   runners bill at roughly ten times the Linux rate, so it is worth having the answer before spending
   one.

⛔ **electron-builder must be ≥ 26.16.1 for `CSC_LINK` to work at all.** Measured on runs
34909163579 and 34910069869 (2026-09-14): 26.15.3–26.16.0 create the temporary keychain with a
random password, then run `security set-key-partition-list -k <p12 password>` — the certificate's
password where the *keychain's* is required — so every CI signing attempt died on `SecKeychainUnlock:
The user name or passphrase you entered is not correct`, with the argument masked as `***` because it
equalled the secret. The local build never sees this: it signs from the login keychain and skips
`createKeychain`. npm's `latest` tag still pointed at 26.15.3 when this was found; the fix is in the
`v26` tag. A password error on the `security import -P` line before it *is* a wrong
`MAC_CSC_KEY_PASSWORD` — the first run was that.

⭐ **If the hardened runtime does break node-pty, that is a finding, not a defeat** — write down
which binary failed validation and how, because it decides whether the fix is an entitlement, a
signing-order change, or `asarUnpack`.

### Release downloads

On a packaged build, Warmstart polls the latest stable GitHub Release for the repository recorded in
`version.json`. A newer release is downloaded only when it contains the exact builder filename for
this OS and architecture (`warmstart-<version>-<os>-<arch>.<ext>`) and `SHA256SUMS.txt` names a
matching SHA-256. The file lands in `<dataDir>/updates/`; the footer exposes it once verified.
⛔ Warmstart never executes or installs the download. Opening its folder is the operator's action,
because an app that manages credentials and starts agents must not replace itself unattended.

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

⛔ **macOS `/var` is a symlink to `/private/var`.** Computing relative paths with `path.relative` breaks
if one path traversed the symlink and the other was canonicalized. Always canonicalize with
`realpathSync` before writing relative worktree `.git` pointers (`worktrees.ts`).

### Spawning

- **node-pty does not search PATH.** On Windows it goes straight to `CreateProcess` and fails with a
  bare *File not found* for a command that runs fine in a shell. Everything spawnable goes through
  `daemon/which.ts`, which also routes `.cmd`/`.bat` shims through the command processor.
- **GUI apps on macOS/Linux do not inherit shell profile PATH.** App bundles launched via desktop shells
  inherit a minimal system PATH missing `~/.local/bin`, `/opt/homebrew/bin`, and `/usr/local/bin`.
  `which.ts` and `spawnEnv()` prepend standard user bin directories on non-Windows platforms, and
  `which()` verifies macOS `/usr/bin` candidates to skip broken Apple xcrun shims.
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

On macOS, keep the native `appMenu` and `editMenu` roles in the application menu. Chromium routes
the standard `⌘C`, `⌘V` and `⌘X` editing commands through those roles; setting the application menu
to `null` leaves fields typable but disables copy, paste and cut. Windows and Linux may keep the
application menu disabled because their editing shortcuts are handled by the window directly.

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

⛔ **A file a sandboxed Codex run cannot write is one a sandboxed run wrote.** Measured on t408
and reproduced by hand in `ws1`, 2026-09-13 (`src/daemon/acl.ts` carries the numbers). Codex puts
an inheritable per-run grant on the workspace root and takes it back when the run ends; inheritance
is *propagated* by the operator's unelevated token, and propagation needs WRITE_DAC on each
descendant. A file the sandbox created or rewrote is owned by `CodexSandboxOffline`, on which the
operator holds Modify and nothing more — so the grant silently skips it (`icacls` reports *Failed
processing 0 files*), it keeps the DACL an earlier run left, and the next run answers *Failed to
write file* on exactly that file. 124 files in `ws1`, 18,780 in `ws2` (a sandboxed `npm ci`), one
branch ref in the trunk's `.git`. **The fix is replacement, not permission:** Modify includes DELETE,
so `sweepAcls` copies each refused path beside itself and renames the copy over it — a new file the
operator owns, with clean inherited permissions, every byte kept. Proven by a real sandboxed
`codex exec` patching `Workers.tsx`, the file t408 was refused on. The sweep runs on prepare over
the workspace, its `.git/worktrees/<slot>` and the common `.git`'s `refs`, `logs` and top-level
files; never the object store. ⚠️ It is asynchronous now (the old call froze the daemon for 5 s
and was killed before it finished): a full pass of a 19.7k-file workspace takes **7.2 s** of the
dispatch, and nothing else waits. ⚠️ `icacls` prints its refusals on **stderr**; the old
`stdio: 'ignore'` dropped them. What it cannot name — a handful of empty directories with
unspellable names that a sandbox leaves at the workspace root — is not re-owned and does not matter.

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
