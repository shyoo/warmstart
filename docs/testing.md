# Testing

Four tiers, organised by what a failure would *cost* rather than by the usual pyramid — and the ways
a suite in this repository has reported a confident pass for code that was broken.

> **Audience:** anyone writing or changing a test, or wondering why a suite went green.
> **Authority for:** what each tier can and cannot prove, and the suite pitfalls.
> Build commands are in [`development.md`](development.md).

---

## 1. The tiers

| Tier | Command | What it drives | Spends |
|---|---|---|---|
| **L1** | `npm test` | `vitest`, `src/**/*.test.ts`, pure logic against the source | nothing |
| **L2** | `npm run test:daemon` | a live orchestratord over its own HTTP/WS RPC | nothing |
| **L3** | `npm run test:ui` | the built app, driven over the DevTools protocol | nothing |
| **L4** | `npm run test:e2e` | an agent in the loop | ⛔ **real tokens** |
| — | `npm run test:pack` | the **packaged** app in `release/win-unpacked` | nothing |

`npm run test:all` is L1 + L2 + L3. That is the pre-commit set.

⛔ **Never run `test:e2e` unasked.** It is the only suite that spends, it is gated behind
`MULTI_AGENT_CONTROLLER_E2E=1`, and CI deliberately never invokes it.

### What each tier can prove

- **L1** proves arithmetic. Scoring, the cache-clock decision function, the reserve, `activetime`,
  formatting, `conversation.ts`. If a behaviour can be a pure function, it belongs here — that is why
  `lib/conversation.ts` exists at all.
- **L2** proves the daemon: scheduling, the task DAG, cancellation, approvals, the controller, cost
  arithmetic, spawn/stream/teardown. It spawns one session on a worker with **no credentials**, which
  is what makes process handling testable for free.
- **L3** proves the renderer against a real daemon: routes, forms, the ledger, project settings,
  Conversations, the session TUI.
- **L4** proves the only thing the others cannot — that a real agent, on a real account, completes a
  real task.
- **`test:pack`** proves what only packaging can break: a native module left inside the asar, an app
  that cannot start its own daemon, a PTY that will not open. Every one of those passes L3 and fails
  on a user's machine.

⚠️ **CI runs with no agent CLI installed and nobody signed in.** CLI-dependent checks are *skipped
visibly* with a stated reason and counted separately, so a green run on a runner is not a green run on
a developer's machine. `npm run test:daemon` skips 5 checks in that state.

## 2. Before any suite below L1

```bash
node scripts/ensure-electron.mjs   # Electron 44 ships no postinstall; the dist can be empty
npm run build                      # test:daemon and test:ui drive out/; test:pack drives release/
```

⛔ **Every suite below L1 drives a build product and none of them builds one.** Running any without a
fresh build silently tests code that is no longer in the tree **and reports a confident pass for it**
— three times on 2026-08-27. `checkBuildIsCurrent()` and the pack suite's asar check now refuse
instead. ⚠️ When you add a guard like that, watch it go red before you trust it green.

## 3. The ways a suite here has lied

Each of these produced a green run over broken code. They are why the rules below exist.

### A suite that cannot run twice at once is a bug in the suite

⛔ Two agents run these suites concurrently on this machine. `test/ui.test.mjs` held a hard-coded
debugging port until 2026-08-29: four runs started inside three and a half minutes, and because the
suite asked *the port* for a page rather than asking its own app, the losers drove a stranger's
application and then blocked forever when it was killed.

Anything shared is asked for at run time — `freePort()`, `mkdtempSync()` — never written down as a
constant. ⚠️ Prove it the only way that counts: **run the suite twice at once and require both to
pass.** Reverting that one constant fails 8 of 125 in one run and 33 of 81 in the other.

### Bound the wait nearest the resource

⛔ In that same incident *every* wait above the blocking call had a budget — 45s for the app to
appear, 30s in `until` and `waitFor` — and the DevTools request underneath them had none, so no budget
above it could ever be reached. Each suite declares a ceiling with `startDeadline`, whose `onExpire`
must stop what the suite started, because `process.exit` does not run `finally`.

### A check against an empty collection passes

⛔ **The UI suite's worker has no credentials, so nothing it files ever runs.** There are no rows in
`runs` and no sessions during that suite. Any check written against `.side-run`, a session id, a token
count or a quota delta will report **PASS against an empty list**.

Assert the collection is non-empty as half the claim, or test the logic as a pure function instead.

### A suite that never reaches your change

⛔ **`test/ui.test.mjs` never opens a project.** Every task it files has `projectId: null`, so it
drives the **Unassigned** route and nothing under `components/Project.tsx`. A mutation to a project
route ran green there on 2026-08-28 — three checks passing with row-click navigation deliberately
broken.

When you change anything on a project tab, **mutate the code and watch the suite go red first.** If it
stays green, the suite is not reaching your change.

### A merge strategy that silently does nothing looks exactly like one that worked

⛔ **`merge-branch` moves a git ref with `update-ref`**, which will happily move a branch backwards,
sideways, or out from under a worktree that has it checked out. Those are the two ways this corrupts a
repository rather than failing a task, and neither raises an error at the time.

So `mergebranch.test.ts` uses **real git in a real repository** — a stub of `update-ref` would pass
against every broken version — and each guard was watched going **red** before it was trusted green:

| Guard | Watched red by |
|---|---|
| the target must be checked out nowhere | replacing `branchCheckedOutIn` with `null` — the refusal test fails |
| a sibling's landing is not an agent in the trunk | dropping the `unexplained` filter in `decideFinish` — `landingtarget.test.ts` fails |

⭐ The same practice found a real defect in `applySplit` before it shipped: inter-piece edges were
written with `addDependency`, which is the raw edge write and deliberately does **not** re-admit, so a
piece that should have waited sat at `ready` and would have been dispatched in parallel with the piece
it depended on. The ordering the planner asked for would have been discarded silently.

### A test may not assert a host capability

⛔ `expect(sampleProcessTree(pid)).not.toBeNull()` reads as a test of this code and is a test of
whether *this machine* permits process enumeration. A codex worker runs under
`--sandbox workspace-write`, which denies the WMI query behind it, so on 2026-08-30 the suite went red
inside the worker and green on the host — and the agent read the difference as a regression it had
caused.

⚠️ The fix is never a skip: probe the capability with the platform's own command — not through the
function under test — and assert the other contract, which in a denied environment is the load-bearing
one. ⭐ Running the checks is not the agent's job anyway: `runChecks` runs `check` in the daemon,
outside any sandbox.

### A suite that fails because of the *shape* of the workspace it is in

⛔ **Pool members are not interchangeable, and the difference is invisible.** On t171, 2026-09-03,
`npm test` in `ws2` died before a single test ran — `EPERM: operation not permitted, open
…\ws2\node_modules\.vite-temp\vitest.config.ts.timestamp-….mjs` — while the same task, branch and
commands passed 1,576 / 1,642 / 1,644 tests in `ws1` and `ws3`. `ws2/node_modules` is a directory
junction to the trunk's; a codex sandbox resolves the link before it checks it, and the target had
never been granted. `linkedWritableRoots` now grants it (`adapters.md`).

⚠️ The lesson that outlives the fix: **a suite that fails in one workspace and passes in another is
reporting on the workspace, not on the change.** An agent has no way to tell those apart from the
inside, and the honest move when a suite cannot start is to say which workspace it was and what the
error was — not to conclude the change is broken, and not to commit as though the suite had run.

### A test that needs a CLI on PATH, on a machine that has none

⛔ **Any test that calls `plan()` needs the CLI on PATH, and CI has none installed.** `plan()` resolves
the command before it builds an argv, so an argv assertion passes on a developer machine and throws
`'claude' is not on PATH` in CI. Stub the names onto PATH the way `adapters.test.ts` and
`resume.test.ts` do — empty files, both with and without `.exe`.

⚠️ This has been found **twice**, the second time in a brand-new test file written by somebody who had
read the first one's explanation. Check a new suite against a stripped PATH before pushing:

```bash
env -u LOCALAPPDATA PATH=/c/Windows/System32:/c/Apps/nodejs:/usr/bin \
  node node_modules/vitest/vitest.mjs run <file>
```

### A Windows path through a shell heredoc loses a backslash

⛔ `'C:\\ws1'` written through a shell arrives as `'C:\ws1'`, which TypeScript reads as `C:ws1` — a
path that matches nothing. ⚠️ The damage is not a crash: a gate keyed on that path returns "no match"
for the *wrong reason*, so a test asserting `toBeNull()` passes while proving nothing. Four did, in
`resume.test.ts`, on 2026-08-28.

Write such literals with the **Edit tool**, which does not go through a shell, and put the path in a
named constant so there is one occurrence to get right rather than nine.

### A window the operator did not ask for

⛔ **A suite may drive a window; it may not put one on the operator's screen.** `test:ui` and
`test:pack` set `MULTI_AGENT_CONTROLLER_HEADLESS=1`, and `createWindow` honours it by skipping both of
its `show()` paths. The window is created, the renderer loads, React runs, Blink lays out, and every
`innerText` and `getBoundingClientRect` answers exactly as it does on screen. What stops is a
1440×900 window taking focus off whatever the operator was typing, several times a run.

⚠️ **Do not assert this with `document.visibilityState`**: a window created `show: false` and never
shown reports `visible` to its own renderer, because nothing ever hid it (measured 2026-09-01). Only
the window manager can answer, which is why the check asks the OS for `MainWindowHandle` and skips
where there is no equivalent one-liner.

⚠️ The flag is set by the suites, never derived from `app.isPackaged` or `NODE_ENV` — `npm run dev`
and `build-win.ps1 -Restart` must still open a window.

⛔ **The consequence: no suite can catch a regression in window *showing*.** `ready-to-show` has been
measured never firing (Windows 11, Electron 44, packaged and dev alike; `did-finish-load` at 72ms,
`ready-to-show` never at 8s or 20s, and 66ms with `--disable-gpu`). `showwindow.ts` backstops it with
`did-finish-load`, a main-frame `did-fail-load` and a timer. That path is proven by hand only.

### Killing something that is not yours

⛔ **Never kill a process by image name, and never kill a bare pid** — in product code *or* a test.
`killTree(pid, expect)` in the harness reads the command line and confirms it before acting. If the
command line cannot be read, the answer is **no**: a leaked process costs a stale port, killing the
wrong one costs somebody their work.

⚠️ `npm run pack` rewrites `release/win-unpacked/`, and there is exactly **one** packaged app in the
tree. If it fails with `EPERM`/`EBUSY`, something is executing out of `release/` — expect it to be the
operator's own app, and ask before reaching for a kill.

## 4. Writing a new check

- Use the harness (`test/lib/harness.mjs`): `check`, `skip` with a reason, `section`, `summary`,
  `wait`, `startDeadline`, `freePort`, `makeProject`/`destroyProject`, `writeProbeAdapter`.
- ⛔ **Skip visibly, with the reason.** A silently absent check is indistinguishable from a passing
  one, and CI depends on the distinction.
- Report **numbers**, not "tests pass". They become the `Baseline` line in `HANDOFF.md`.
- A new guard is not trusted until you have watched it go **red**.
- A watchdog grace period needs three assertions: the first tick warns without acting, a tick before
  the durable deadline still waits, and a tick at/after it acts only if the trigger remains true.
- Two POSIX-only checks are skipped on Windows; that is expected, not a failure.
