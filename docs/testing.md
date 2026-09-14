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
| **L1** | `npm test` | `vitest`, `src/**/*.test.ts{,x}`, pure logic against the source | nothing |
| **L2** | `npm run test:daemon` | a live orchestratord over its own HTTP/WS RPC | nothing |
| **L3** | `npm run test:ui` | the built app, driven over the DevTools protocol | nothing |
| **L4** | `npm run test:e2e` | an agent in the loop | ⛔ **real tokens** |
| — | `npm run test:pack` | the **packaged** app in `release/win-unpacked` | nothing |
| — | `npm run coverage` | L1 again, instrumented — see §4 | nothing |

`npm run test:all` is L1 + L2 + L3. That is the pre-commit set.

⛔ **Never run `test:e2e` unasked.** It is the only suite that spends, it is gated behind
`WARMSTART_E2E=1`, and CI deliberately never invokes it.

### What each tier can prove

- **L1** proves arithmetic. Scoring, the cache-clock decision function, the reserve, `activetime`,
  formatting, `conversation.ts`. If a behaviour can be a pure function, it belongs here — that is why
  `lib/conversation.ts` exists at all.
- **L2** proves the daemon: scheduling, the task DAG, cancellation, approvals, the controller, cost
  arithmetic, spawn/stream/teardown, and **remote access over its own listener**. It spawns one
  session on a worker with **no credentials**, which is what makes process handling testable for
  free. ⚠️ The remote section binds a *random* high port and turns the listener off again — the
  8787 default is a hard-coded port and two copies of this suite must be able to run at once. It
  exists because every bug that feature shipped with was in the seam between its allowlist and its
  callers, and every one of them passed the unit tests.
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

### A textarea has no text, so reading it as text passes against a blank

⛔ **`element.innerText` never includes a textarea's value.** The add-project wizard's L3 section
asserted that the check-command box opened on the proposals read off the project's manifest, by
matching against the step's `innerText` — which would have passed identically had the box been empty,
because the value was never in the string either way. Caught 2026-09-06 only because the proposal
happened to be missing from that reading while being demonstrably present in the file the wizard
wrote. ⚠️ Read a form control's **`.value`**; `innerText` answers a question about a *rendering* and a
control's content is not rendered into its own subtree.

### A wrapping box reports its own width, so asking whether the text fits reads the column back

⛔ **`element.scrollWidth` is the content's width only while the content cannot wrap.** Asked of a box
whose text *has* wrapped, it is the box: `scrollWidth <= clientWidth` is then true by construction, so
a check written as *does this label fit its column* answers **yes** for the one heading that did not
(2026-09-13, the task table's `ACTION`). The same reading also called a one-line heading two lines,
because an element's height includes the cell's padding and a lone line-height does not.

⚠️ Measure the **text**, not the element that holds it: a `Range` over the node's contents gives the
text's own box whatever markup wraps it, and the number of distinct `top` values among
`range.getClientRects()` is the number of lines it occupies — one rect per run, so a heading with a
sort arrow beside it is still one line. And take one line's height from a probe inserted in that very
element, because `getComputedStyle(el).lineHeight` is the string `normal` in most of this app and
`parseFloat` of it is `NaN`, which every comparison reads as *fits*.

### A collapsed column keeps its geometry, so it reads as a collision it never paints

⛔ **A `<col>` at `visibility: collapse; width: 0` leaves its cells in layout with their content
laid out past them.** Measured 2026-09-13 in Electron 44: the cell reads `clientWidth 0` and
`scrollWidth 75`, its computed `visibility` is still `visible`, and a nowrap span inside it ends 75px
into the neighbour — every number a *does this overflow* check looks for — while a screenshot of the
same table shows none of it. Two task-table checks written at a 1440px window, where every column is
drawn, read that shape as six faults on the CI runners (run 34795442043): Windows clamps the window
to a 1024px screen and Xvfb leaves the panel under 1050px beside the default sidebar, so Created and
Updated were collapsed by the very container query the next section proves.

⚠️ Measure what is painted: take the widest layout the screen allows first (the sidebar at its own
minimum, read off the separator's `aria-valuemin`), then measure only cells with `clientWidth > 0`,
and where none is drawn `skip` with the window and panel width as the reason — a screen is a
capability of the machine. ⛔ Not a check over the collapsed cells, which fails a layout nobody sees,
and not one over an empty list, which passes while proving nothing.

### An `overflow: hidden` box still scrolls, so scrolling it proves nothing

⛔ **`scrollHeight > clientHeight` and an assignment to `scrollTop` are both true of a box the
operator cannot scroll at all.** `overflow-y: hidden` still establishes a scroll container: the
content overflows and *programmatic* scrolling moves it, so the sidebar check written from those two
alone passed with the sidebar's `overflow-y` mutated to `hidden` (t338, 2026-09-09) — a green run over
navigation that had gone off the bottom of the window for good.

⚠️ Scrollability is one of the few things there is no behavioural signal for, so read the computed
`overflow-y` and require `auto` or `scroll` **beside** the geometry. That is the exception to
preferring behaviour over implementation, not a licence to assert CSS generally: the property is the
only thing separating *the content is down there* from *the operator can get to it*.

⭐ The same check earns its keep on the layout it is really about. Anchoring a group to the foot of a
sidebar with `justify-content: flex-end` looks identical to `margin-top: auto` whenever there is spare
room, and differs only once the sidebar is full — which is the case a fixture that opens no projects
never reaches on its own. Inject the height rather than trusting the empty state, and ⛔ make the
injected child `flex-shrink: 0`: an empty flex item shrinks back to nothing and measures a container
that never overflowed.

### A suite that never reaches your change

⛔ **`test/ui.test.mjs` never opens a project.** Every task it files has `projectId: null`, so it
drives the **Unassigned** route and nothing under `components/Project.tsx`. A mutation to a project
route ran green there on 2026-08-28 — three checks passing with row-click navigation deliberately
broken.

When you change anything on a project tab, **mutate the code and watch the suite go red first.** If it
stays green, the suite is not reaching your change.

⚠️ **And a section that reads whatever pane is still on screen is not reaching your change either.**
The thread-ledger checks asserted against a task nobody had opened — the section before them left a
different thread up, and the model row they were reading belonged to that one's run. They passed for
as long as the timing held, and flipped the day a section four seconds earlier was added
(2026-09-08). A section that depends on a particular screen now navigates to it and waits for the
value it is about, rather than for a fixed number of milliseconds.

⛔ **A `?.click()` that matched nothing dismisses nothing, and says nothing either.** The composer
section closed itself by finding a `.panel-head` button whose text was `Cancel`; that button stopped
existing the day the composer became a modal, so the optional chain resolved to `undefined` and every
check for the rest of the run read a window with a dialog over it (t354 → t356, 2026-09-11). A driver
step whose whole job is to change the screen is worth asserting on: this one now checks the dialog is
gone, which is one line and the only thing that would have caught it.

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

⛔ **Then the probe itself lied, which is the part worth remembering** (2026-09-09). The helper ran
`Get-CimInstance … .Count` on Windows and `ps -eo pid=` elsewhere, and parsed **both** with
`Number(stdout) > 0`. That is right for a printed count and wrong for a list: `Number()` of
multi-line output is `NaN`, `NaN > 0` is `false`, so off Windows the probe reported **every** host as
denied — including hosts where enumeration plainly worked — and the suite then demanded
`sampleProcessTree` answer `null` while it correctly answered a real sample. ⚠️ A two-platform probe
needs the *shape* of each platform's output checked separately; sharing the parser silently makes one
branch a constant.

⭐ The general form: **a capability probe is code too, and a probe that always answers the same thing
is worse than no probe** — it turns one assertion into the wrong assertion rather than into none, and
the failure then points at the code under test instead of at the fixture.

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

### A suite that fails because of what previous suites left in `%TEMP%`

⛔ **These suites leak their scratch directories, and the leak eventually fails the suite.** Every
tier below L1 makes its sandbox with `mkdtempSync`, and on Windows a held handle routinely defeats the
`afterAll` that would remove it — several `afterAll`s say so in as many words. The debris is harmless
until it is not: on 2026-09-09 `%TEMP%` held **26,234 entries, 17,247 of them `agentyard-*`**, going
back a fortnight.

⭐ At that size a `git` invocation whose `cwd` is `%TEMP%` costs **1,247ms instead of 143ms**, so
`claude-code`'s `plan()` — which asks `workspaceGrants(cwd)`, which shells out to git — took 1,342ms
per call. Alone that is merely slow; across 156 files in parallel it put a **synchronous** test over
the 15s timeout, and `adapters.test.ts > claude-code is told to call exactly that tool` failed four
runs in a row while passing in 1.3s on its own. Deleting the stale directories, and nothing else,
returned the suite to 156/156 and the whole run from 52s to 35s.

⚠️ **A synchronous test that times out is never about its own code**, and a test that passes alone and
fails in the suite is reporting on the machine. Before changing anything, count what is in `%TEMP%`.
Clearing it is safe for entries older than the current run — but ⛔ match on the suites' own prefixes
and an age, never the whole directory, because a *live* run's sandbox is in there too.

### A test that needs a CLI on PATH, on a machine that has none

⛔ **Any test that calls `plan()` needs the CLI on PATH, and CI has none installed.** `plan()` resolves
the command before it builds an argv, so an argv assertion passes on a developer machine and throws
`'claude' is not on PATH` in CI. Stub the names onto PATH the way `adapters.test.ts` and
`resume.test.ts` do — empty files, both with and without `.exe`.

⛔ **`plan()` is not the only gate, and the second one is quieter** (2026-09-09). `eligibility.ts`
rejects a worker whose adapter is not installed with a *standing* reason **before** any other gate, so
a suite about routing gets an empty candidate list and an assertion failure that names the host:
`expected 'Claude Code is not installed' to match /CodexOne at capacity/`. Four suites — `reviewer`
(7 cases), `scheduling` (2), `reviewqueue` (1), `headlesspermission` (1) — were green on the author's
Windows box and red on every CI runner for this reason. ⚠️ Use `forceInstalled(...ids)` from
`testkit.ts`, and **undo it in `afterAll`**: adapter objects are module singletons, so a suite that
leaks the stub makes every later suite in the same worker believe the CLI is present.

⛔ **Stub, do not skip.** `describe.runIf` satisfies the "skipped visibly" rule and loses the point:
these suites test selection logic, which has nothing to do with a CLI and should run everywhere.
Skipping leaves the router covered only on machines that happen to have the vendors installed.

⚠️ This has now been found **four times**, the second in a brand-new file written by somebody who had
read the first one's explanation. Check a new suite against a stripped PATH before pushing:

```bash
env -u LOCALAPPDATA PATH=/c/Windows/System32:/c/Apps/nodejs:/usr/bin \
  node node_modules/vitest/vitest.mjs run <file>
```

### A fixture with nothing to vary tests nothing, and still looks like a test

⛔ `expect(withinPath(root.toLowerCase(), at('ws1'))).toBe(win)` reads as a platform-split
assertion about case folding. On Windows `root` was `C:\Dev\x` and lowercasing changed it, so
the assertion meant something. On POSIX `root` was `/dev/x` — **already lowercase** — so
`.toLowerCase()` returned the same string, the call asked whether a directory contains its own
child, and the honest answer `true` failed against an expected `false` (2026-09-09).

⚠️ The failure presented as a platform bug in `fspath.ts` on Linux and macOS. It was a fixture
with no case to fold. The sibling `samePath` tests a few lines above had always used `/Dev/x`
against `/dev/x` and were correct throughout.

⭐ **The check that catches this class: for every transform a test applies, confirm the fixture is
actually changed by it.** If `f(x)` and `x` are equal for the chosen fixture, the assertion is
about something else — and it will pass or fail for reasons unrelated to what its name claims.

### A Windows path through a shell heredoc loses a backslash

⛔ `'C:\\ws1'` written through a shell arrives as `'C:\ws1'`, which TypeScript reads as `C:ws1` — a
path that matches nothing. ⚠️ The damage is not a crash: a gate keyed on that path returns "no match"
for the *wrong reason*, so a test asserting `toBeNull()` passes while proving nothing. Four did, in
`resume.test.ts`, on 2026-08-28.

Write such literals with the **Edit tool**, which does not go through a shell, and put the path in a
named constant so there is one occurrence to get right rather than nine.

### A Windows-shaped fixture path is relative off Windows

⛔ On POSIX, Node treats `C:/tmp/root` as a relative path, not a drive-rooted one. A test that hands
that spelling to code which creates directories therefore writes a literal `C:` directory beneath
the test process's working directory. This happened in `adapters.test.ts`: Muse planning correctly
creates its prompt and XDG roots, and the cross-adapter fixture leaked them into the checkout on
macOS (measured 2026-09-13).

Use a directory created beneath `tmpdir()` for any fixture a subject may write, and remove it in the
suite teardown. Reserve Windows-shaped strings for pure path-shape assertions whose subjects perform
no filesystem I/O.

### A window the operator did not ask for

⛔ **A suite may drive a window; it may not put one on the operator's screen.** `test:ui` and
`test:pack` set `WARMSTART_HEADLESS=1`, and `createWindow` honours it by skipping both of
its `show()` paths. The window is created, the renderer loads, React runs, Blink lays out, and every
`innerText` and `getBoundingClientRect` answers exactly as it does on screen. What stops is a
1440×900 window taking focus off whatever the operator was typing, several times a run.

⚠️ **Do not assert this with `document.visibilityState`**: a window created `show: false` and never
shown reports `visible` to its own renderer, because nothing ever hid it (measured 2026-09-01). Only
the window manager can answer, which is why the check asks the OS for `MainWindowHandle` and skips
where there is no equivalent one-liner.

⚠️ The flag is set by the suites, never derived from `app.isPackaged` or `NODE_ENV` — `npm run dev`,
`scripts/build-mac.sh --restart` and `scripts/build-win.ps1 -Restart` must still open a window.

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

## 4. Coverage, and what the number is for

`npm run coverage` is `npm test` with v8 instrumentation. **Baseline 2026-09-07: 50.27% statements**
(19,919/39,618), 81.16% branches, 77.31% functions, over 134 files and 2,768 checks.

⛔ **It measures L1 and nothing else, and a number read without that sentence is misleading.** The
daemon's HTTP surface is proven at L2 and the renderer at L3, and neither is instrumented. A file at
0% here is *not covered by pure-logic checks* — it is not necessarily untested.

| Area | Statements | What it means |
|---|---|---|
| `src/shared` | 94.36% | what good looks like here |
| `src/daemon` | 76.40% | solid; `gradebatch.ts` 6.7% and `chat.ts` 11.1% are the low ones |
| `src/renderer/src/lib` | 75.76% | the extract-a-pure-function-and-check-it pattern, working |
| `src/daemon/adapters` | 65.27% | stream decoding covered, spawning not |
| `src/renderer/src` components | **0.00%** | ~15k statements; one number is most of the gap |

⛔ **There is no threshold, on purpose.** A coverage gate makes the cheapest route to a green build
*writing a check that executes a line and asserts nothing about it* — and §3 above is a list of the
times a suite here already reported a confident false pass without any help. The number says where to
look next; whether a thing is worth covering stays a judgement.

⚠️ **The renderer's 0% is not an argument for a DOM tier.** Components are proven at L3 against a real
daemon, and a jsdom tier would be a fourth way to test the same thing. The way that number moves is
the way `lib/` got to 75%: when a component's decisions — which control to draw, what a row says, when
something is disabled — become pure functions, they get checked here. See
`transient_docs/maintainability_plan_2026-09-07.md`.

⚠️ Entry points are excluded (`daemon/index.ts`, `mcp/index.ts`, `src/main`, `src/preload`). Their
whole behaviour is starting something; counting them buries the files where the number means anything.

## 5. Writing a new check

- Seed rows through [`src/daemon/testkit.ts`](../src/daemon/testkit.ts), not raw SQL. A column rename is currently a 41-file edit because 41 suites write their own inserts; the kit's builders take the union of the options the copies took, so extend the kit rather than forking a local copy. Suites migrate to it opportunistically, when already being edited.
- Use the harness (`test/lib/harness.mjs`): `check`, `skip` with a reason, `section`, `summary`,
  `wait`, `startDeadline`, `freePort`, `makeProject`/`destroyProject`, `writeProbeAdapter`.
- ⛔ **Skip visibly, with the reason.** A silently absent check is indistinguishable from a passing
  one, and CI depends on the distinction.
- Report **numbers**, not "tests pass". They become the `Baseline` line in `HANDOFF.md`.
- A new guard is not trusted until you have watched it go **red**.
- A watchdog grace period needs three assertions: the first tick warns without acting, a tick before
  the durable deadline still waits, and a tick at/after it acts only if the trigger remains true.
- Two POSIX-only checks are skipped on Windows; that is expected, not a failure.
