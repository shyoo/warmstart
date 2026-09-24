# The renderer

React 19 under `src/renderer`. What it may and may not do, how it is routed, and where its
conventions live.

> **Audience:** anyone changing a screen.
> **Authority for:** routes, the component map, styling tokens and renderer-side state.
> ⚠️ Read [`testing.md`](testing.md) § *A suite that never reaches your change* before trusting a
> green `test:ui` on anything under a project tab.

---

## 1. What the renderer is allowed to be

⛔ **It holds no daemon token and no port.** Every call goes `window.agentyard.rpc(method, params)` →
`ipcRenderer.invoke('daemon:rpc')` → main → orchestratord. The renderer is the surface that displays
**untrusted agent output**; it does not get a credential to a service that can spawn processes.

⛔ **Agent output is rendered as text, never as markup.** `task.activity` — the live peephole — is a
bounded in-memory tail, not persisted, and gone when the daemon restarts. That is the correct lifetime
for *what is happening right now*; the thread is what a person reads afterwards.

⚠️ **One tail row is one row on screen, and how the daemon cuts those rows is the adapter's call** —
`AdapterCapabilities.outputFraming`, because the bytes do not say. On a `message` adapter (claude-code,
openai-compatible) one event is a whole assistant message: it settles on arrival and its own linebreaks
become rows. On a `delta` adapter (muse-code, antigravity-cli, local-llm) one event is a handful of
tokens: a fragment without a trailing newline extends the open row instead of pushing a new one, so
streamed prose reassembles rather than reading one word per line, and `append` on the event carries the
whole line so watchers replace their last row rather than extending it. Getting this backwards has cost
both directions once each — one word per line on muse (t272), and Claude's messages concatenated with
their linebreaks gone (t284).

⛔ **No native modules here.** They live in the daemon so an Electron upgrade cannot break a running
fleet.

Events arrive as `DaemonEvent` over `daemon:event-push` (`shared/protocol.ts`). `session.data` is raw
terminal bytes and goes to xterm.js and nowhere else.

## 2. Routes

`App.tsx` holds a `Route` union — there is no router library.

```
{ kind: 'overview',   page: 'dashboard' | 'controller' }
{ kind: 'project',    id, tab: ProjectTab, taskId? }
{ kind: 'unassigned', … }   ⚠️ temporary; it removes itself once tasks.project_id is never null
```

`ProjectTab` (`components/Project.tsx`): `flow · tasks · thread · conversations · sessionTui ·
settings`.

⚠️ **`taskId` rides on the route**, not on the Tasks list: the Thread tab is a destination, so Back
has to return to a *task* and not merely to a tab. The open task survives a tab change.

⛔ **Thread, not Conversation.** A *conversation* is the agent session you resume with `--resume` or
`--conversation`; it has an id and outlives the task that opened it. A task's messages are a different
thing entirely. See [`glossary.md`](glossary.md).

## 3. The component map

| Component | Screen |
|---|---|
| `Flow` | project lifecycle map: 6-column kanban flow with ticket ↔ workspace ↔ worker bindings and read-only grading runs. ⭐ The **trunk** is the first binding row of every git project, labelled with its landing target (`main`); a trunk held by a resting task is drawn *held* and a pool member held by a ticket waiting on a person is drawn *locked*, never *free*, and an inbound ticket is only ever drawn heading for the kind of tree it will get (`computeWorkspaceRows`) |
| `FleetStrip` `Workers` `ModelTable` `FleetSettings` | the fleet: per-account quota with its **age**, reset countdowns, live sessions; one two-column settings card per worker with an inline model-routing/purpose table (`ModelTable`). Default is a radio choice and the one row that cannot be removed. Removing another purpose row clears that purpose too. Summary is one model/effort pair, never every effort row of one model. Selectable legacy efforts normalize to `medium`; `n/a` is reserved for a model with no effort levels. Labels are user-defined refinements for Auto Model. Model edits apply the returned worker row immediately; `worker.changed` updates other windows. Eligibility, capacity, and order changes re-read `fleet.list`. |
| `Tasks` `TaskThread` `thread/*` `Dependencies` | the board, one task's thread, and prerequisite edges. Before `task.page` first answers, Tasks shows a spinning mark and *Loading tasks…* — never the actionable **No tasks yet** result, which is true only after an empty answer. ⛔ **Only the first ever answer, not every one.** `refresh` also re-runs on `task.changed`/`run.changed`, which the scheduler tick broadcasts every 10-20s; a `loadedOnce` ref keeps a later refresh from tearing the rendered table back down to the spinner, which used to blip a fully drawn board blank on a timer (t624, 2026-09-22). A project with open PRs renders a dedicated pending pull request banner (`.tasks-pr-banner`) above the filters with task links, PR URLs and an instant **Check merged PRs** action, and tasks with open deliveries carry a purple `PR #N` pill beside their title. Opening a task lands at the **bottom** of its thread, where the recent conversation sits above the reply box — once per navigation, never per render, so a thread growing under a running agent does not yank back a reader who scrolled up (`lib/threadscroll.ts`). ⭐ **And stays there only when the whole page is at its bottom.** A scroll listener on `.content` tracks `isNearPageBottom`, and a dependency-free `useLayoutEffect` follows `.content`'s actual bottom after every render. It never follows the shorter thread anchor: the adjacent right pane can continue below the composer and must remain reachable. Scroll away to read and the page stops chasing you; scroll back to the bottom and it resumes. ⛔ A jump the page makes *for* you — pressing the ledger peek — releases the pin itself, not through the `scroll` event it causes: that event arrives a frame later, and a render inside that frame (or a hidden window, which is not reliably handed scroll events) re-pinned the reader to the bottom they had just left (Windows CI, 2026-09-18). |
| `thread/DiffPanel` | **Changes in this task**: a file list with counts, drawn wherever the change resolves. ⚠️ Collapsed by default everywhere, including at the `awaiting_human` gate (2026-09-14) — it used to spring open on its own there, which read as a surprise rather than a nudge; the person presses it themselves. ⭐ Since t425 it draws **no patch**: a file row, or *Open in Diff pane*, opens the pane at that file. The two patch renderers (`PatchBody`, `SplitBody`) live in this file because its rule governs them: ⛔ every line is a **text node** — in `<pre>` for the single column, in a `<td>` for the split (`lib/sidebyside.ts`) — and the only thing derived from its content is a CSS class from the first character (`lib/diffline.ts`): no markdown, no highlighter, no linkified paths |
| `DiffPane` | the **Diff pane**: one task's change, every file stacked in one scroll under a sticky path header, in a shell column right of the work (t425). A branch reads `task.diffSummary` + `task.diffFile`; one recorded commit — pressed from the ledger's sha — reads `task.commitDiff` + `task.commitFile`, `<sha>^!`. ⛔ Owned by `App.tsx` as one `DiffPaneRequest` behind `DiffPaneContext` (`lib/diffpane.ts`) and it **follows the route**: it closes the moment the route stops naming its task, survives that task's tabs, and is never a history entry. ⚠️ `initialExpansion` opens files from the top until 12 files or 1,500 counted lines, one `git` call each; the rest open on a press. Between hunks a `⋯ N unmodified lines` row is arithmetic on the `@@` headers (`lib/hunks.ts`), never a read of the file. Decisions: `transient_docs/diff_pane_2026-09-13.md` |
| `thread/LedgerPeek` | the **ledger peek** (t477): once the thread has pushed the status box off the top of the page, a small box pinned at the top of the ledger column repeats the task, its status and its hold line — and, once the timeline box has gone too, the latest run (`#N Run`, account / model, fresh, status, usage). ⛔ A stand-in, never a second source: every value is read from the same `task` and `run` the rows use, and `latestRunEntry` names the *timeline's* last run with the timeline's own `#N`, not `runs[0]`. Pressing a half scrolls the box it stands in for back into view. ⚠️ Drawn only for a box that went out *upwards* (`lib/scrolledpast.ts`): geometry measured on the `.content` scroll event and re-checked after every render, ⛔ not an `IntersectionObserver` — a box jumped past in one frame (End, `scrollTo`) crosses no threshold and was never reported, and a hidden window is not reliably handed its scroll events at all (L3, 2026-09-16). The mount is a zero-height `position: sticky` child right after the ledger box, which is why `.detail-side` is `align-self: stretch`. |
| sidebar projects and conversations (`App.tsx`, `lib/projectorder.ts`, `lib/sidebarconversations.ts`, `lib/taskview.tsx`) | project rows are drag-and-drop reorderable; the complete order is persisted by the daemon, so every window and restart sees the same order. Status colour answers *who is this waiting on* (`STATUS_ATTENTION` in `lib/taskview.tsx`, t668): **blue** = agent working (running, dispatching, queued, grading, landing, cancelling); **yellow** = human action needed (`awaiting_human` only); **grey** = parked, needs nobody, a trigger moves it later (`paused_user`, `paused_quota`, blocked, scheduled, draft, queued to land); green completed; red failed. Every task status pill carries a hover saying which. Project status dots use the same buckets with strict precedence: agent (pulsing blue) > human (solid yellow) > `pending_pr` (purple) > parked (solid grey) > idle (grey ring). When unfinished tasks exist, the project row draws right-aligned `running/awaiting/parked` counts (e.g. `1/0/2`), each number in its bucket's colour when non-zero. Every **unfinished conversation** a project is in the middle of is listed under the project row, indented past the project name with no glyph (t671; a 💬 competed with the status dot), newest activity first; one press opens its thread (`tab: 'thread', taskId`) and the conversation — not its parent project — reads active while it is the route (t479). Other project tabs and threads retain the project selection. ⛔ *Unfinished*, not running: a conversation rests at `awaiting_human` between every turn, so it stays listed through waiting, paused, queued and quota-held — only `completed`, `cancelled`, `draft` or deleted takes it off (operator's decision). The project row grows a ▾/▸ fold, drawn only where there is something to fold; the folded set is a `localStorage` preference per project, default open. Data is the `task.list` App already holds for the project dots. |
| `thread/TitleEditor` | the task page's heading, and the one place a task is **renamed** (t479): press the title or its pencil, type, Enter; Esc cancels, blur saves. Goes through `task.update { title }`, which trims, keeps the old title on an empty string and clears the controller's `titleSummary` so the typed name is what every list shows; `admit()` at its end leaves held and terminal statuses alone, so renaming a waiting conversation cannot re-dispatch it (`titlesummary.test.ts`). ⚠️ Not drawn on a draft, whose title box lives in `DraftControls` beside its prompt. ⭐ **`.detail-head` — the back button and this heading — is `position: sticky` at the top of `.content`.** Unlike `LedgerPeek`, nothing here is a stand-in: the real back button and the real rename control keep working stuck as they do unstuck, so a long thread pushing the header off the top still leaves the way out, and the task's `t<seq> · title`, in reach without scrolling up. ⛔ Its `top` is `calc(-1 * var(--sp-5))`, not `0` — plain `0` sticks flush with `.content`'s *padding* edge, leaving that padding permanently visible above the header as an unfilled strip once stuck (t561, 2026-09-19); the negative offset lets it keep sticking past the padding so its own background reaches the fleet strip. The title truncates to one line with an ellipsis (`.title-editable-text`) rather than wrapping, so a long one cannot grow the pinned header taller — the full text is still the `title` attribute's tooltip, and unabridged as the thread's own first message. |
| `TaskSettingPicker` | ⛔ **one component, seven uses** — the thread's finish, conversation, completion, compaction, objective, worker and priority settings |
| `NewTask` `NewTaskModal` `Pill` | one shell-owned composer modal: the project and the prompt first, the rest as a row of **pills** under it — except the workspace, which is a joined `SegmentedControl` group (`Project · …` | `Worktree` | `Trunk`) with the answer pressed, because a two-way choice hiding one half in a menu is how a trunk job gets filed unseen; a project in view is selected but can always be changed |
| `Attention` `Questions` | the approvals/questions/quota-gate bar — one keystroke above the operator's work. A question card answers with options, prose, **and attachments**: the same [+] file/folder menu the composer has, because an agent's NEEDS DECISION lands here and "attach that folder" needs somewhere to happen (t521). A folder answered with is granted to the task exactly as a composed one; a folder alone, with no option or prose, counts as an answer |
| `Overview` `Controller` `Conversations` | dashboard, including a host-tool setup card when Git, GitHub CLI or Tailscale is absent; the controller chat; and conversation history |
| `Project` `ProjectSettings` `Projects` | the project routes and the policy tier. ⭐ `Project.rootExists` is read fresh on every `project.list` (t514): a directory moved or renamed outside Warmstart (`c:\Dev\magic_writer` → `c:\Dev\inkland`) shows a banner on the project header naming the missing path and lets the operator point the same project id at its new location (`project.relocate`), keeping its tasks and history rather than losing them to a re-add. The path field is `NewProject`'s shared `PathField` (t517): an OS folder picker beside the text input, typing still works, and the button hides on a remote target the same way it does in the add-project wizard |
| `NewProject` | the add-project wizard: three steps, one modal, `lib/newproject.ts` holds its rules |
| `RoutingModel` `RoutingOverview` `QualityModel` `CostModel` `VelocityModel` `ModelsModel` `Math` | the routing model, written up as a paper: abstract, contents, five numbered sections, KaTeX for the arithmetic |
| `Statistics` | what finished tasks actually cost, took and scored — three tabs, one RPC, a window control. ⭐ `TradeoffPlots` draws the three-way trade-off as three flat scatters — quality vs cost, quality vs active time, cost vs active time (quality always *y*, active time always *x*, 2026-09-23) — replacing an earlier rotatable 3D plot reported confusing to read and hard to interact with (2026-09-14) |
| `LooseEnds` | work that exists and is going nowhere → [`landing.md`](landing.md) |
| `Doctor` | which required/conditional host tools and agent CLIs were found, who is signed in, how old each reading is, what is unverifiable, and which projects' directories are missing |
| `WelcomeTour` | a per-display, first-launch three-step guide with real screenshots (`src/renderer/src/assets/welcome/*.png`, captured over a fictional fleet by `scripts/generate-tour-assets.mjs`; regenerate when the wizard, Workers card or composer changes) and prev/next onboarding navigation to introduce adding a project, adding a worker, and filing a task; completing or skipping it records `warmstart.welcomeComplete` in guarded `localStorage` |
| `Logs` | the daemon's log, live and filterable, ring-buffered so a late window sees the past |
| `Terminal` | the real agent TUI over xterm.js, not a reconstruction. ⚠️ Only a `pty` session has one — see below |
| `SessionStream` | the *decoded* stream of a dispatched agent: one row per tool call, thinking phase, rate-limit caution and message. ⛔ Openly a reconstruction, because there is no screen to mirror |
| `AppSettings` `SettingRow` `SettingButtonSelect` `PaneResizer` | chrome. `PaneResizer` is the one drag handle, specified per pane: `SidebarResizer` writes `--sidebar-w` from the left edge, `DiffPaneResizer` writes `--diffpane-w` from the right, both remembered per display in `localStorage` |
| `GlobalSettings` | the five in-page Global tabs: Notice (doctor warnings), Status (daemon, CLIs, workers, cost models and projects), Fleet settings (the default), App behavior and Remote connection. The settings panels keep a 920px measure, so a maximised window cannot strand a hand's width of dead space between a label and its control. |
| `RemoteAccess` | the shown computer's listener: Tailscale state, project enablement, phone and desktop switches, pairing material and host-paired devices. It renders in Global → Remote connection, with the per-project half in `ProjectSettings`. See [`remote.md`](remote.md) |
| `Root` `MachinePicker` `RemoteMachines` | which computer the window shows. `Root` keys `App` by the selected computer so a switch re-mounts everything, and owns notifications so they survive the switch; `MachinePicker` sits above Overview; `RemoteMachines` lists remotes and opens a modal to add one from Global → Remote connection. `lib/target.ts` holds the id every `rpc()` names. See [`remote.md`](remote.md#remote-desktops) |
| `src/mobile` | fixed-tab phone PWA: project-scoped Overview (Attention + 200-entry timeline), quota gauges, paginated task cards with a `+` composer, and read-only Settings. See [`remote.md`](remote.md) |

⛔ **A thread setting is one component, and the menu behind it is a pure function.**
(`components/TaskSettingPicker.tsx` over `lib/threadview.ts`.) Finish, conversation, completion,
compaction, objective, worker and priority were seven copies of the same `useAction` + button + note;
what differs between them is a menu and an RPC, and both are now passed in. ⚠️ **`inherit` is
answered twice, differently, and that is the feature**: the menu entry reads `inherit (await human)`
so choosing it is informed, while the button reads `await human` alone — what is in effect, which is
what somebody scanning the pane is asking. ⛔ The write stays a typed `rpc()` call at the call site
rather than a method name assembled from a string, so a renamed RPC still fails the build.

⛔ **Adding a project is a wizard, and it is chrome rather than a route.** (`components/NewProject.tsx`;
its rules are pure functions in `lib/newproject.ts`.) The sidebar's Projects group carries a `+`, and
both it and the Projects panel's button open the same modal — the state lives in `App.tsx` so it
cannot be opened twice. Three steps: the **directory** and what `project.inspect` found in it, then the
**workspace directory, the five policy tiers and the check list**, then the **starter files and a plain
list of every write**. ⛔ **Nothing touches a disk until Create**: `project.inspect` and
`project.docTemplates` are read-only, and `project.create` performs the whole sequence in the daemon,
so *registered but unconfigured* is not a state the renderer can produce. ⚠️ Every refusal is the
daemon's — already a project, a workspace directory another project owns, one inside the repository —
because deciding them needs a filesystem and the list of every other project's pool; `stepBlockers`
repeats the sentence rather than re-deriving it, and prints it in the footer beside the button it
disables. ⛔ The directory fields use `window.agentyard.pickFolders()`, the same bridge the composer's
*Add folder* uses, and typing a path still works.

⚠️ **A starter template is regenerated when what it quotes changes, and never over text somebody
typed.** The three docs name the project, the landing target and the check list, so going Back and
changing any of them has to leave them agreeing with it — but `DocDraftState.edited` freezes a doc the
operator has opened and written in, because rewriting it would discard their work with no undo.

⛔ **The window's title bar is this app's, and there is only one of it.** `captionOptions` in
[`../src/main/titlebar.ts`](../src/main/titlebar.ts) hides the native caption on Windows and macOS and
leaves the platform's own window buttons overlaid at one end of it; `.titlebar` in `App.tsx` draws the
rest — panel toggle, back, forward, refresh, the two zooms with their reset badge, the app name, and
the global **New task**. ⚠️ Two halves make it work and either alone is a bug that looks like the
other's. (1) The strip's inset comes from `env(titlebar-area-x/width/height)`, never a constant: the
buttons are at the right on Windows and the left on macOS, and their width follows the display scale —
145px on the machine this was measured on (2026-09-11, t356). (2) `-webkit-app-region: drag` on the
strip with `no-drag` on every control in it; with only the first, its buttons move the window instead
of doing anything. ⚠️ **Linux keeps its own frame** — `titleBarOverlay` is Windows and macOS only, so
hiding the caption there would leave a window with no close button — and the strip simply reserves no
caption width, which is what the absent environment variables already say. t354 shipped this row
*under* the native caption and the window carried two title bars; `test/ui.test.mjs` now measures that
the row starts at y=0 with the sidebar and the work below it.

⚠️ **Overview and Projects grow from the top of the sidebar; Analytics, History and Settings are
anchored to its bottom** (`.sidebar-bottom`). When projects use all available height the whole sidebar
scrolls, preserving that order rather than hiding utility destinations.

⛔ **`margin-top: auto` on the anchored block, never `justify-content` on the sidebar.** The two are
indistinguishable while there is spare room and part company exactly when there is not: an auto margin
resolves to zero once the content no longer fits, so the groups fall back into normal scroll order,
where anchoring the *container* keeps pushing and puts them past the end of the scroll range. Both
halves are pinned in `test/ui.test.mjs`, the second by injecting the height, since that fixture opens
no projects and never fills the sidebar on its own ([`testing.md`](testing.md) §3).

⚠️ **A project's Settings tab has a Cold start panel, and it only knows what is on disk**
(`ProjectSettings.tsx`). *Orientation docs* is a two-value `SettingButtonSelect` — `auto` names the
docs the project actually keeps, `off` says nothing about them — and under it the panel prints which
of `AGENTS.md`, `HANDOFF.md` and `README.md` `project.inspect` found there, so the choice is not made
blind: on a project with none of them, `auto` and `off` do the same thing and the panel says so.
Below it a multi-line *Seeding prompt* box goes verbatim into the same cold prompt, after the doc
line. ⛔ Neither reaches a warm session — see [`sessions.md`](sessions.md) — and the panel says that
too, because a setting whose effect is *sometimes* is one an operator will otherwise test by watching
a follow-up and conclude is broken.

⛔ **A thread message renders as a chat bubble, and who wrote it decides how its text is read.** Human bubbles sit right; agent, controller and darker system bubbles sit left, with no role column (`lib/threadbubble.ts`). Under each bubble — outside it, on the bubble's own side (`.msg-body` stacks the two; t374 took the clock out of the bubble, t378 put it back beneath) — a meta line carries the time, a `📋 1,475` `PromptChip` on the **request that caused the run** — the human message that asked, or the opening message of a task an agent filed (`promptAnchors`), falling back to the run's own last answer when a retry followed no new note, and to the live bubble when the run has claimed nothing — which opens the prompt in a dialog, and ⓘ for a system line's `detail`. Intermediate activity is a `⚙ n steps` chip. ⛔ No full-width *"Prompt sent for run …"* rows, anywhere in the thread. Every message this
codebase writes names refs, branches, shas and files in backticks — *"Landed as `98f200ab` onto
`main`"* — and `{m.text}` printed the backticks, which is the worst of both readings: punctuation to
ignore, and no distinction between `main` the branch and main the adjective. `lib/codespans.ts`
splits the text and `.msg-code` sets the fenced runs in the mono face. A span never crosses a
newline, so the worst an unmatched backtick can do is print itself.

⭐ **And an agent's, a controller's and this codebase's own lines are read as markdown, while a
person's are not** (t369, 2026-09-11). The risk that kept markdown out — *an agent's own prose
reaching this path* — arrived anyway when conversations did: an agent's reply is written by a CLI
whose house style is markdown, and the thread printed `**So the order is:**` and `## Yes — macOS`
as literal asterisks and hashes down the page. `lib/markdown.ts` parses a **closed** subset —
headings, fenced code, lists, quotes, rules, and inline code/strong/em/strike/link — and
`thread/Markdown.tsx` draws it with elements written in that file. ⛔ No raw HTML, no
`dangerouslySetInnerHTML`, and the only attribute a message can reach is a link's `href`, which is
whitelisted to `http`/`https`/`mailto` **at the parse** so an unsafe scheme is never a link at all.
Links carry `target="_blank"` and are caught by `setWindowOpenHandler`, which denies the navigation
and hands the URL to the real browser. ⭐ A **bare** `http(s)` URL is a link too (t401): the PR a
`pull-request` landing opened was printed as text nobody could click. Trailing sentence punctuation
and an unmatched closing bracket are trimmed off it. ⚠️ A construct the parser does not know renders as the
characters the agent wrote. ⚠️ A **person's** message keeps the inline-code-only reading: they typed
those characters into a box and reinterpreting a `*` they meant literally changes their own words.

⛔ **The thread's timeline is ordered on when each entry *finished*, not when it started**
(`byEndThenStart` in `lib/taskview.tsx`). Runs, compactions and reviews nest rather than queue — a
compaction happens *inside* the run that asked for it — so the two always share a start and never
share an end. Measured on t231, 2026-09-05: run 2 ran 16:44:24–16:55:19 and its compaction ran
16:44:26–16:47:06, so start-time order printed a compaction that had visibly finished at 16:47
*below* a run still going at 16:55. ⚠️ An entry that has not finished sorts last, which is not a
fallback but the answer — it has not ended, so it ends after everything that has. The start time
breaks ties, so two open entries still have a stable order. A dead ask a newer landed sibling on
the same session supersedes reads *superseded* rather than *failed* (`lib/compactionstatus.ts`) —
t446's preemption ask died unhonoured at 17:14 while the clock's 17:18 retry landed at 17:21, and
"failed" alone read as though the session had never been compacted.

⛔ **Analytics holds three pages, and they answer different questions.** *Routing Model* explains a
choice: every number on it is shrunk toward a prior, blended or clamped, because it is about to be
acted on. *Statistics* (`components/Statistics.tsx`, one `statistics.report` call for all three tabs)
describes what happened: nothing on it is smoothed. Price, Velocity and Quality each fold finished
tasks into an agent → model → effort tree, **re-folding the raw samples at every level** rather than
averaging the level below, and every table prints `n` beside its percentiles. ⭐ **How far back it
reads is the reader's choice** (t361): the *Window* control in the head reads the last 200 finished
tasks (the same ceiling `paceFactors` uses, so the two surfaces agree about which tasks exist) or
*all* of them, remembered per display in `localStorage` (`readStatisticsWindow`, `prefs.ts`) and
sent as `{ window }`; the report echoes `window` and a `sampleLimit` of `null` for the unbounded
read, and the daemon reads the default for anything but the literal `all`. The two pages will
disagree — a shrunk pace factor is not a measured p50 — and the page says so rather than reconciling
them quietly. Price additionally names its basis per row: `subs`, `API rate` or `mixed`, since
averaging an amortised share of a flat fee together with money billed on top means nothing — and the
model level (with the effort levels under it) is split one row per basis, so a model billed both ways
gets a row per basis while the agent row above still folds everything.
⚠️ An `unknown` renders `n/a`, never `$0.00`, and the benchmark prior and fitness columns are drawn
on **model** rows only — a prior is published per model, so there is no prior for `high` alone.
⭐ Quality draws the same chart as the other two tabs, over each row's `distribution` of **clean**
composites (`QualityStatRow.distribution`, whose `average` *is* `cleanComposite`); a row nothing
clean has graded has an empty distribution and no bar — an ungraded model has no distribution, not
a short one.

⭐ **Statistics also has a trade-off section, `TradeoffPlots`** (`Statistics.tsx`), above its three
tabs: three flat scatters — quality against cost, quality against active time, and cost against
active time, with quality always the vertical axis and active time always the horizontal one
(2026-09-23) — each plotting only an adapter/model pair with measured price, active time and clean
quality evidence, so a missing value is never drawn as a deliberate coordinate. ⭐ This replaces an
earlier single rotatable 3D scatter (retired 2026-09-14, reported confusing to read and hard to
interact with); a flat scatter has a position a reader can recover without dragging anything. This is
a comparison aid, not routing input, and the tabular distributions remain the authoritative evidence
behind every point. Model rows group the stable display identity, so dated Claude ids such as
`claude-haiku-4-5-20251001` fold into the same *Haiku 4.5* row; missing model ids remain in the agent
total but have no phantom child. Each mark draws the agent's own `AgentIcon` rather than a plain dot,
so the Claude, Antigravity and Codex marks are told apart at a glance without reading the tooltip. An
**Exclude API rate & mixed** checkbox in the head (`measuredModelPoints(report, excludeApiMixed)`)
drops price rows billed outside the flat subscription fee from the cost axis only — the same
two-kinds-of-dollar distinction the price tab already makes — and a model left with no
subscription-only price simply drops out of every scatter rather than being priced from the wrong
dollars; the section itself keeps showing (with the checkbox still reachable) as long as *something*
measured has ever qualified unfiltered. ⭐ The checkbox is a per-display preference
(`readStatisticsExcludeApiMixed`/`writeStatisticsExcludeApiMixed` in `lib/prefs.ts`), so it survives a
page change or an app restart rather than resetting to off. ⛔ A model whose weakest axis rests on
fewer than `MIN_TRUSTED_SAMPLES` (5, the same floor the price table dims its `n` column at) is dropped
from all three scatters entirely — a mark has no column to dim a thin count in, so it is excluded
rather than drawn as a confident point over a guess. ⭐ **Every axis is better away from the origin (2026-09-14)**, and its
title says so by position — *right is better*, *top is better* — since "higher" read as a claim about
the number on an inverted axis. Cost and active time are measured such that a *smaller* number is the better outcome,
so `axisPosition` plots them on an inverted position (`max - value`) while the tick labels and tooltip
still show the real dollar/duration — a mark further from the origin is always the better outcome, on
every axis, without needing to reverse quality too. ⭐ **The hover legend is a reserved-height strip
below each chart, not a line in the head.** The head used to grow the tooltip inline and push the
chart down on hover; `.scatter-plot-legend` always renders (a non-breaking space when nothing is
hovered) so its height never changes and the chart above it never moves.

⛔ **The chart names the harness as well as the model, and the table does not have to.** Its bars are
model rows, which in a table are indented under the agent row that owns them; a chart has no such
parent, and `claude-sonnet-4-6` is served both by Claude Code and by Antigravity out of different
subscriptions at different prices. So `graphLabel` prints *Antigravity · Sonnet 4.6*, read off the
agent rows in the same report rather than off the adapter registry — the chart names only what the
table beneath it is folding. The subscription rows and the API/mixed rows are drawn in separate
charts with separate axes: an overage must not flatten the subscription distributions it is meant to
be compared against. ⛔ A bar carries its basis in parentheses (*Opus 4.6 (mixed)*) **only in a chart
that holds more than one basis** — under a title that already reads *Subscription*, *(subs)* said the
same thing twice and took the width the model name needed (t361). The label column is sized to the
longest label by `labelColumn` — the type steps down from 12 to 11 to 10 before anything is cut —
because a chart whose labels cannot be read is not a comparison, whatever its bars say.

⭐ **Routing Model is a paper, and is set as one** (t361; `components/RoutingModel.tsx`, `.paper` in
`app.css`). It is the page where an operator decides whether to trust the scheduler, and a scoreboard
invites a glance where a paper invites checking: a title (*Routing Model v{ROUTING_MODEL_VERSION}*, the constant in
`@shared/routing.ts`), a summary, a contents strip, and five numbered sections — §1 the
introduction, motivation and the model itself, §2–§4 one per axis, §5 models — in a single measured
serif column with captioned, booktabs-ruled tables and the arithmetic typeset by **KaTeX**
(`components/Math.tsx`: `<M>` inline, `<Eq>` display with a caller-set number). ⭐ **The setting
(t378):** the face is `--font-serif` in `tokens.css` — Sitka Text on Windows, Iowan Old Style on
macOS, system fonts only, ordered by width because a wide serif reads better on a screen than a book
face (Georgia is kept out of the front of the stack for its old-style figures); the ink is
`--color-paper-ink`, one step below `--color-text` on the dark theme, so a column of serif does not
glare; the measure is 80ch (764px on Windows, up from 570px). ⭐ Every section heading — the summary's
own `h4` and each `.doc-section h3` — is set in `--color-accent` rather than the paper ink, so a page
of otherwise all-prose column reads its own structure at a glance instead of as one undifferentiated
block of text. Tables are content-width and centred
in the column, every column but the first centred (the Statistics convention) and a prose column
(`.tbl-wide`) left; and each section ends in a **Previous / Next** pager (`.paper-pager`) that
turns to the neighbouring section from its top. ⛔ **Only program
constants reach KaTeX** — TeX literals in components, or `WEIGHT_FORMULAS` run through `lib/tex.ts` —
never agent output or operator text; `trust` is off. ⛔ **Table 1 is not typed twice.** The weight
formulas, their signs and the balanced column come from `WEIGHT_FORMULAS`, `WEIGHT_SIGNS` and
`evaluateWeightFormula` in `@shared/routing.ts` — the strings the scheduler stamps on every stored
decision, checked against `weights()` by `cost.test.ts` — and `tex.test.ts` typesets every one of them
with errors *on*. ⚠️ The section tabs keep their one-word labels (the UI suite clicks them by text);
the `§n` is a CSS counter, which `innerText` does not include. ⚠️ Every measured figure the prose
quotes names its page and date, because a motivating example that invents its numbers teaches the
reader to distrust the real ones underneath. ⚠️ A shell heredoc on this platform drops one backslash
from every `\` — `tex.ts` was written that way once and `\mathrm{cost}` typeset as six italic letters
without complaint; `tex.test.ts` now pins the backslash, and TeX-bearing files are written with the
Edit tool.

⛔ **The scored table on Routing Model › Quality is grouped by agent, not ordered by score.**
(`groupKeys`, `QualityModel.test.tsx`.) One head row per agent — *Claude Code · 2 models · 7
reviews* — with its models beneath it, agents by label and models by label within each, so a row
does not move when a grade lands; the number to compare on is in the row and the order is for finding
the row. The flat list ordered by composite put *Opus 5 · Claude Code* three rows from *Sonnet 5 ·
Claude Code* and left the reader to regroup it by eye (t361).

⚠️ **A task can be taken out of all of it, from its own thread.** The `statistics` row in the thread's
right pane toggles `Task.excludedFromStats`, and an excluded task leaves Statistics, the pace factor
the router reads, and every quality aggregate at once. ⛔ It is for a *measurement* that is wrong, not
a result somebody dislikes, and the estimator deliberately still reads its tokens: a task excluded
for an impossible duration spent exactly what it spent.

⛔ **Quality Review is the coverage page, and it is not a second scoreboard.**
(`components/QualityReview.tsx`.) *Statistics › Quality per Task* holds the distribution — how each
agent and model scores — and duplicating it here would leave two tables of the same numbers folded
two ways and no way to tell which was authoritative. This page answers what that one cannot: which
finished work carries **no** grade, exactly one, two or more, or **cannot be graded**; who has already graded each task;
and whether both an exact diff and a peer remain so it can still be graded. The 0/1/2+ tiles and tab
badges count only gradable work; **Non-gradable tasks** is disjoint, so a permanent refusal is never
claimed in both totals. A "Filter out cannot be graded" toggle
persists in operator preferences, and permanent refusals are printed beside **no**, not deferred until a batch skips it.
The two link to each other in both
directions rather than repeating each other. ⛔ **It is also the only place a review is commissioned in bulk** —
the *Grade up to five* button that used to sit on Routing Model › Quality is gone and links here,
because two buttons spending turns on the same accounts under different caps is a way to empty a
quota window by pressing the wrong one.

⚠️ **The visible page arrives before the fleet-wide coverage totals.** The table validates only the
page a person can see; the 0/1/2+ tiles and tab badges fill after `quality.coverage` has checked the
entire finished history. That keeps an old backlog from delaying the first 25 rows, while the totals
remain exact rather than guessed. **One steady progress mark, beside Refresh, tracks grading rather
than the fetch.**
While a batch runs the page polls every three seconds; a spinner bound to the fetch therefore blinked
on and off across both the Refresh button and the "Filter out cannot be graded" label, at a cadence
that described the poll and nothing an operator cares about. The mark is drawn for as long as
`batch.state === 'running'` and the button keeps its label and stays clickable throughout. The same
mark rides the sidebar's own **Analytics → Quality Review** link (`useQualityBatchRunning` in
`lib/daemon.ts`, its own 3s poll of `quality.batch`), so a batch grading in the background is visible
without opening the page.

⛔ **A poll may not stack on itself, and this page is where that rule was learned.** The in-flight
flag here was once argued away — *"the fetch is over in well under the three seconds between
polls"* — and measured false on 2026-09-09: `quality.queue` took **2.4s** against 322 finished tasks
with the daemon idle, and this page fires it from the 3s interval *and* again on every
`task.changed` / `run.changed`, which during a batch is most seconds. Because `orchestratord` is
single-threaded the calls do not overlap, they queue: 40 deep, `/health` took 78s and the UI's own
connection was reset out from under it — the *"TypeError: fetch failed"* badge. ⚠️ A ticking poll
that finds one in flight is **dropped, not queued**: the next is 3s away and asks for current state
anyway, so a refresh that waited its turn could only paint something staler. The daemon owes the
other half — see [`architecture.md`](architecture.md) §1.

⛔ **Batching is a queue, not a call.** `quality.batch.start` returns as soon as the queue exists and
the reviews run in the background (`daemon/gradebatch.ts`), because ALL over a backlog is hours of
grading and an RPC held open for it would be lost by the first window reload. Progress is read back
from `quality.batch`, and the reviews themselves are ordinary runs on ordinary tasks — the Tasks
table and the task threads are where they are watched. ⚠️ **Concurrency is not a number written
anywhere**: `requestReview` synchronously claims an account before its first await, the driver starts
everything that can start, and `reviewCandidates` refuses an account
that is already reviewing, so a two-account fleet grades two tasks at once and a one-account fleet
grades one. ⛔ **The count is what is *attempted*, not what is graded** — a task that is skipped stays
visible as a skip with its own reason rather than being silently replaced by the next one, because
*no peer left* and *the branch is gone so there is nothing to diff* are the fleet facts the page was
opened to find. A split child's recorded range remains valid after its planner branch is retired by
proving the commits reached the project's trunk. Stopping a batch stops the queue and never a review already in flight; that one is
stopped by name on its own task.

⛔ **No agent grades the same task twice.** Once an adapter has produced a *scored* grade for a task
it stops being a candidate for it, everywhere — the batch, the per-task Review button and the
reviewer picker alike (`gradedAdaptersOf`, `reviewCandidates`). ⚠️ By adapter, like authorship: two
Claude accounts are one judge. ⚠️ Only a grade that produced a number burns an adapter — a review
that timed out, refused, or answered with no JSON never answered, so its adapter is asked again, and
that is the same rule `tasks.quality_review_count` counts by. A task with nobody left reads *no
eligible review agent* with every candidate and its reason on hover, and a batch skips it.

⛔ **Every agent on the quality pages is named by its *model*, never by its adapter id alone.**
(`lib/agentname.ts`, `components/AgentLabel.tsx`.) `openai-compatible` is a transport, not a judge:
it is Codex CLI on one account and whatever a local endpoint is serving on another, and *graded by
openai-compatible* names neither. So *Work by*, *Graded by*, the batch's paired *Work by* and
*Grader* columns, and the *Graded on* table on Routing Model › Quality all lead with the model and
put the adapter's own label
beside it — *GPT 5.6 Terra · Codex CLI* — and the scored table there groups models under the agent's
label for the same reason. ⚠️ The labels come from the adapters
themselves (`ReviewQueuePage.adapterLabels`), not from a vendor table in the renderer that would go
stale the day one shipped, and the exact `adapter/model` slugs are in every `title`, because the
operator who needs the id is the one debugging a routing mistake. ⛔ A review that never recorded its
model reads *not recorded* rather than borrowing whatever Settings would pick today — the default now
is not evidence about a run that is over. ⚠️ *Graded by* names both halves while eligibility is still
burned by **adapter**: seeing that two different models graded does not mean a third behind the same
adapter may.

Quality review is otherwise a field on a task rather than a place to go. It appears in three further
places: a `Quality` column in `Tasks`, a `#N Quality Review` row in
`TaskThread`'s timeline (⚠️ the underlying run is filtered out so it draws once, not twice), and the
request box in that thread's facts column, whose every disabled state names its reason. The request
box offers **Auto**, which randomly chooses an available account and uses that adapter's small review
model selected on that worker, plus each routable peer by name. Transient account state (login,
health, quota, or another review in flight) does not make a configured peer vanish from the picker;
the daemon revalidates availability immediately before starting it. New built-in workers start with
the adapter's smallest configured model; the Workers card can change it or opt the account out of
grading. A pending review overlays **grading** in Tasks, TaskThread and Flow without changing the
task's stored lifecycle status or claiming a worktree. Accounts on any adapter that authored the work are absent;
the daemon revalidates a named choice when the button is pressed rather than trusting the menu.
The same thread ledger also offers **Your review** after completed or cancelled agent work: an operator
selects an integer 0–10 and must add a brief explanation. ⛔ **One rating per task, and it stays
editable**: once saved the box shows it with **Edit** (the same select and textarea, pre-filled,
saving through `review.manual.update`) and **Delete**, and a second save is refused by the daemon
rather than averaged in — one person twice is not two opinions. The rating counts in the task's
headline quality — the Tasks **Quality** column and the thread's *quality review* score line, whose
tooltip and denominator say when it is included (*Your rating*, or *N grades (… and your rating)*) —
and in the Analytics aggregate alongside peer grades, but never masquerades as the seven rubric
dimensions or as an agent reviewer; a mixed-authorship rating is kept but excluded from clean model
comparison.

⛔ **The project is the composer's first control, in its head row, not one of the pills.** It is the
only setting with no usable default — it decides the workspace, the branch and the policy every other
control inherits, and Send stays disabled until it is answered — so it sits beside the dialog's title
with the close button at the other end of the same row. On the pill row it read as one more remembered
preference at the far end of a line the eye has already left. ⚠️ **A pill's menu is portalled to
`<body>`, which makes it a sibling of a dialog's shade rather than a descendant**, so `.pill-menu`
sits above the shade's z-index and not merely above the page: underneath it, every dropdown in this
modal opened behind the dialog that owns it and read as clipped away (t354 → t356).

⭐ **Neither the pill row nor its buttons wrap to a second line — both scroll or overflow instead**
(2026-09-17). `.composer-bar`, the ordinary row of pills under the prompt, was `flex-wrap: wrap`: a
window narrower than that render's pill total, or a longer worker or project name shifting where the
row happened to break, folded it onto a second or third line at an unpredictable point — visually the
same "buttons are wrapping" complaint the Plan & Split and Debate rows had already been fixed for by
scrolling their table instead (`.composer-bar--plan`, `.composer-bar--debate`, above). The ordinary row
now takes the same answer: `flex-wrap: nowrap` and `overflow-x: auto`, so it is always exactly one line
tall regardless of window width or any single pill's label — `.pill` already caps a label at 22ch with
an ellipsis, so no pinned account or project name can grow the row on its own; a fleet with more pills
than fit on one line scrolls it, the gesture already asked of the two table variants beside it. `.btn`
carried no `white-space`, so a *button's own label* ("Save as Draft") could separately wrap onto two
lines inside itself when `.composer-send`'s row ran short of room; `.composer-send button` is now
`white-space: nowrap` and the row itself `flex-wrap: nowrap`, so a button holds its label on one line
and the row overflows rather than folding one in half. The modal is also modestly wider, 860px against
760px, which lowers how often either scroll is needed without pretending a fixed width removes the
need — a long enough label always can.

⛔ **The attachment picker lives inside the prompt it enriches, beside Save as Draft, Send and the
schedule clock.** Those actions apply to all five kinds, in the order the kind pill offers them:
Single Task, Conversation, Plan & Execute, Plan & Split and Debate. The same `[+]` attachment menu
(file, image, folder) is also offered by the thread composer at the bottom of the task view, so notes
into a live or resting task can attach files and grant folders directly (t527). ⚠️ That row
(`.compose-row`) is the one composer that *does* wrap, deliberately: the thread pane keeps it near
400px, its controls are fixed widths that reach ~240px with Linux fonts, and the box has a 150px flex
basis — when the two no longer fit side by side, Send drops under the box rather than the box shrinking
beneath the button (Linux CI, 2026-09-18: 133px box beside a 152px Send). At Windows widths nothing
wraps; the UI suite reads both states, since a horizontal overlap check alone would call a stacked
Send an overlap.
In Plan & Split the composer draws two labelled rows of pills, and this is decision D5. The first is
**Planner** — priority, dependencies, reuse, finish, worker, model and effort — which is what the
*planning turn* runs as. The second is **Executor**, plus a fan-out pill, which is what every subtask
it files inherits. "Plan with one model, build with another" is the case Plan & Split exists for, and
one row would have forced them to be the same. The kind pill starts the Planner row; the table scrolls
rather than truncating the executor's `Commit·Verify·Merge Branch` landing policy.

⚠️ Until t182 **every one of those controls was hidden** whenever the kind pill said Plan. That was
honest while a plan task was never dispatched — nothing would have read them — and wrong the moment one
is. A plan is a task like the other kinds at filing time, so it can now be saved as a draft or scheduled
before it reaches the planner.

⚠️ The captions are not decoration. Two identical rows of pills with nothing to tell them apart is the
failure they buy, and it is worse than one row. The fan-out pill's number is written into the task's
**mandate**, so the number shown is the number enforced — never a second, invisible cap.

⭐ **Plan & Execute draws the same two rows with three things removed and two added.** It is the same
kind (`plan`) and the same `task.plan` call; what makes it the other shape is that the fan-out is
filed as **1**, on the mandate and on `childDefaults` alike, which `planModeOf` reads back. So the
fan-out pill is **absent** rather than reading `<=1` — a control with one option is not a choice, and
changing it is changing the kind — and the Planner row's finish pill is absent too, because a planner
that writes no code and abandons its branch at the handoff can only be `report-only`. Added: a small
inline **diagram** of the dispatch (`WorkflowShape`, one of five schematic topologies keyed on the
kind pill — Plan & Split's three-turn fan-out-and-back, Plan & Execute's two-turn hand-off, Single
Task's one-turn run, Conversation's open-ended back-and-forth with no automatic landing, and Debate's
independent seats converging on the organizer — comparable at a glance and deliberately not a mockup
of any screen), and a **notice** pair from `executornotice.ts`. ⛔ The notice is the whole guardrail on executor choice —
decision D2 was *inherit as today, plus a notice that states the trade* — so it says when nobody named
an executor (the scheduler may hand the work back to the account that just planned, and then the only
saving is the review turn), and quotes the published trade with the fact that it was **not** measured
on this fleet. ⛔ It never ranks two models: this module can see two ids and nothing else.

⛔ **The accounts named on the Each piece row are a gate, and they reach the pieces.** The Workers
control there is a multi-select with a model and effort per account, and what it sets is `workerIds` on
every piece — read by `chooseTarget` as a *hard gate*, so a candidate not on the list is discarded rather
than scored lower. Measured on t197: the row was sent, stored and validated, and `applySplit` read only
the singular `workerId` beside it — so every piece was filed with no constraint at all, went through the
ordinary dispatcher, and was handed the largest model in the fleet for work whose whole point was that it
was small. A setting that is displayed and then not read is worse than one never offered.

⛔ **The Model pill offers two answers that are not models, and it is never disabled.** *Auto Model*
hands the choice to the router, which scores every model on the chosen account's `routableModels`
allowlist as its own candidate; *Inherit — <model>* files `constraints.modelPolicy: 'inherit'`, and
the scheduler then takes that account's own default and scores nothing. Both used to be the same
empty string, so an operator who pinned CodexFirst, read *Inherit — GPT 5.6 Sol* and pressed Send got
whatever the router scored best — GPT 5.6 Terra, measured — with no screen anywhere having said so.
The two are answerable with no account pinned (each account then uses *its* default), which is why
the pill stays live on **Auto Worker** where it used to be locked; only the list of models by name
needs a CLI, and that appears once one is pinned.

⚠️ **An effort is not drawn beside a model that has no levels.** `resolveModelChoice` inherits the
account's default effort independently of the model — right, and on `claude-haiku-4-5`, whose cost
model declares `effort_levels: []`, it rendered *Haiku 4.5 Med* for a flag the CLI takes and that
model ignores. The thread, the Tasks column and the dispatch itself all drop it now, and all three
drop it only where the cost model actually describes the model: an unpriced id says nothing about its
levels.

⛔ **Nor is one drawn while Auto Model has not named a model yet.** The New Task composer's Effort
pill used to resolve against the pinned worker's plain default model even while the Model pill read
*Auto Model* (or one of its class-scoped variants) — a level chosen there applied to one arbitrary
fallback, not to whichever model the router actually landed on. `showsEffortPicker`
(`lib/composerprefs.ts`) hides the pill unless a model is actually pinned or the policy is `inherit`,
both of which name one real model before dispatch. ⚠️ This is deliberately the opposite answer from
`effortLookupModel` (`lib/taskview.tsx`), which resolves a *reassign* row's effort against the
inherited model even under Auto Model: there the model that would run *right now* is already
knowable, so showing it is the honest thing to do; here, before any worker or model is chosen, it is
not.

⛔ **A model the router has not chosen yet is not named anywhere.** The Tasks list's Worker column
stacks the model under the account, and for a task that has not run it shows what the next dispatch
would ask for — but on an account with a `routableModels` allowlist there is no such answer:
`chooseTarget` scores each allowed model as its own candidate and settles it on the tick that
dispatches. The column drew the account default through the whole of `dispatching` — the seconds
spent claiming a worktree and running `prepare` — so a row read *GPT 5.6 Sol* and then *GPT 5.6
Terra* the instant its first run was recorded, which reads as the model being switched underneath the
operator (t336). It now says **router picks**, with the count of routable models in the tooltip, and
`ranModel` still wins the moment a run has one. ⚠️ The thread's model row had this right first
(*chosen at dispatch from N routable models*); the fix was to make the list ask the *same* predicate
— `routerPicksModel` in `taskview.tsx` — rather than to write the test out a second time, because a
row and the page it opens naming different models is its own bug.

⭐ **The ledger says what a task is on now and what it will be on next as two rows each, not one row
with a caption (t564).** `cur worker` (the live session's account, else `ranOn`) sits over
`next worker` (the pin picker), and `cur model` (`ModelFact`, the transcript's answer with its
effort) over `next model` (the model and effort pickers, with the cache-cost `(i)` in their row). A
task that has never run has no *cur* and reads plain `worker` / `model`, where the model row's
headline still says what the next dispatch would ask for. The old shape — a picker with *last run on
X* under it, a headline with *(Current)* and a `next` pill after it — read as one control, and the
UI suite reads both shapes back: `cur worker` appears once a run is seeded, and never before.

⛔ **A draft's thread can delete it.** The banner's *Delete draft* asks with the same confirmation the
Tasks row action uses and then leaves for the list, because a deleted task's thread can re-fetch
itself into nothing but *that task is no longer here*. Filing was previously the only way out of a
draft from the one screen somebody reading it was on.

⛔ **The Conversation kind hides two pills, and hiding them is what it means.** A conversation is
`Reuse` + `await human`, and both come from the kind rather than from the row: `resolveFinishPolicy`
and `resolveSessionSharing` answer `await-human` and `on` off a conversation task **above the project
and the fleet**, so a project set to `commit-and-merge` cannot land a chat. The composer therefore
draws neither pill — a control offering a choice that is not on the table is worse than a missing one
— and files the task with both fields on `inherit`, which is the value that keeps the kind answering.
The thread shows the same two as read-only facts.

⛔ **No *your call* card (t669).** A conversation rests at `awaiting_human` after every reply, and
the card that used to sit above the composer on each of those turns — Finish, Stop, Reassign, three
selectors and a message box — made a chat read as a form. Its controls moved to where the reply is
typed:

- **Stop beside Send** at `awaiting_human` as well as mid-run (`STOPPABLE`). Stop parks the task as
  `paused_user`; nothing is destroyed.
- **Complete beside Send** once the task is `paused_user` (Stop first, then Complete). It is
  `task.resolve`, which releases dependents where Stop does not; the tooltip (`completeTitle`) says
  so. Over uncommitted files it arms once (*Complete anyway*) before it will release the workspace.
  With nothing typed, the primary button on a stopped task reads **Resume** (`task.resume`); the
  *Paused by operator* banner that held Resume and Mark done is gone.
- **Worker · model · effort pills under the box** (`thread/Reassign.tsx`, `useReassignChoice`). A
  pick that differs from the task's pin draws the row in the accent, shows *undo*, and turns Send into
  **Reassign**: one `task.setWorker` write, then `task.message` with what was typed, or `Continue.`
  when nothing was — `task.message` is the only RPC that continues a resting task and it takes a text.
  The pills are read-only while a run is live, because the pin decides the next dispatch. They start
  where the box does (`.compose-assign`, `padding-left: --compose-attach-w + --sp-2`, t673), not
  right-aligned under Send.
- **The send-outcome hint clears itself once it stops being true** (`outcomeHintStale`,
  `lib/composeoutcome.ts`, t673). *Queued — same thread, same session where it can.* and *Delivered
  into the running turn.* used to sit under the composer forever: the requeue they describe resolves
  on a scheduler tick the composer does not watch, so nothing ever cleared a hint the task's own
  status had already moved past. `Compose` now records the task's status at the moment it sets
  `outcome` and drops the hint the first time `task.status` differs from that recording.

⛔ **What is left above the composer is the settle strip, drawn only when it has something to say**
(`Decide`, `.decide--strip`, no frame, no head; indented by the composer's square `[+]`,
`--compose-attach-w`, so it starts where the message box does, with buttons a step smaller than Send — t672):
**Commit ▼** and **Land ▼**, decided by git rather
than by the task — `task.pendingWork` reads the workspace; `hasDiff` counts **uncommitted** files only,
because an unlanded commit is already safe on the branch. The two are **independent**, and both can be
drawn at once — see `settleControls`. Then *Resolve & retry* and *Retry landing* after a failed landing
(Resolve & retry hands the repair to the worker the pills name), and one short `.decide-note` each for
what protects work: the uncommitted-file count Complete would release (*⚠️ 3 uncommitted files — press
Complete again to complete anyway* once armed), a workspace that could not be read, a refused commit or
landing, and how many tasks wait on this one. Each button's full explanation is its `title`. ⛔ **The
▼ level menus answer to where the task's work sits**: on the trunk the merge level and the
pull-request level are not offered, and the Land fallback is push rather than the merging fleet
default (t583).

`QuotaDecide` is unchanged by t669: preemption and quota holds are still a framed card above the
composer, with the older button-beside-paragraph rows and its own *Reassign* option and `ReassignNote`
box. With a note, `task.message` is the resume (it requeues a `paused_quota` task itself, and rides
along undelivered into the next run of a task still `ready` behind the gate); without one,
`task.resume`. During a quota preemption warning it itemizes each wrap-up choice distinctly
(`Compact & pause`, `Hand off & pause`, `Hand off & reassign`), attaching a labeled destination
dropdown to `Hand off & reassign` that excludes the preempted worker and defaults to Auto.
If the vendor refuses the turn on quota during the warning or wrap-up, the reassignment applies
immediately rather than stranding the task on the exhausted account.

⛔ **Neither Commit nor Land ends the conversation, and neither writes a level.** Both used to write
the chosen level onto the task, which took it out of `isOpenConversation` for ever — so pressing either
one, once, turned a chat into an ordinary work task that the next `task_complete` would complete. Only
**Complete** and **Stop** end a conversation. Press Land as often as there is something to land; each
press leaves the thread open on the next numbered branch ([`landing.md`](landing.md)).

- **Commit ▼** — uncommitted files. The ▼ offers the finish ladder minus `await-human` (which is
  what the conversation is already doing) and `custom` (an instruction about the project's own finish,
  not about this commit). The agent is asked — in the same session, so it still has the context — to
  commit and then land on the level picked, by calling `land_work`; on an adapter with no MCP it is
  asked to say the commit is ready and stop, and ⭐ **the tool lands it itself when the turn ends**
  (t581, `tasks.land_after_turn` → `landAfterCommitTurn`). `commit-only` asks for the commit and
  no landing. ⚠️ It asks rather than commits because the daemon never authors a commit; see
  [`landing.md`](landing.md). ⛔ **And a press that would re-ask for a commit already made is
  refused**, naming **Land** instead: t578's second press spent a whole turn asking its agent to
  commit work it had committed twelve seconds earlier.
- **Land ▼** — commits the landing target does not have. ⛔ **Two controls, not one
  that changes meaning:** committing costs a turn and landing does not, so `task.landConversation`
  lands the branch itself — rebase, the project's checks, merge — through the same `decideFinish` bar
  a first completion meets, and the thread comes back open on the branch it names. Its ▼ offers only
  the levels the tool acts on (`policyLands`: merge, push, pull request), because landing under
  `commit-only` would be a button that does nothing. ⚠️ It refuses while a turn is running — the
  agent is editing that tree — where `land_work` does not, because there the agent is blocked on the
  tool's own reply. This state used to have no button at all: Commit had nothing to ask for and
  *Retry landing* is drawn only after a landing has already failed. ⭐ **It no longer waits for a
  pristine tree** (t581, 2026-09-20). The condition was `!hasDiff && unlandedCommits > 0`, as though
  *something to commit* and *something to land* were alternatives; t578's operator had asked its agent
  to keep backups of the renders it was replacing, the agent rightly left those two untracked
  directories out of its commit, and from then on Land was never drawn over the squashed commit on the
  branch — leaving Commit as the card's only control, re-sending its instruction on every press. Both
  are drawn now, because both are true, and `settleControls` in `lib/finishlevel.ts` is where that
  decision lives so a test can reach it. ⛔ **No tree on the branch is not
  nothing to land** (t481, 2026-09-16): where no pool member has the branch checked out,
  `landConversationWork` borrows a free one (holder `land:<task>`), checks the branch out, lands and
  cuts the next branch there, then parks and releases it — the way *Retry landing* always has.
- ⭐ **Both are buttons with a second answer behind a ▼ — `SplitButton`, not a picker** (t283).
  They shipped as `SettingButtonSelect`s: the dark rounded control with a ✍ on it that every
  *setting* in this app wears, in a column beside a green Finish and a red Stop. The one row on the
  card that spends a turn was the one that did not read as pressable, and a picker has no default
  action — pressing it could only open a list. Now the main half acts and the ▼ chooses, Commit in
  `--warn` and Land in `--primary` (never `ok` or `danger`: those two are spoken for on this card).
  The ▼ half is a `Pill` wearing the button's colour, so the portal, the flip and the arrow keys are
  the same code every other menu uses.
- ⭐ **The level it starts on is the task's, else the project's, else the fleet's** — `defaultLevel`
  in `lib/finishlevel.ts`, and the button's tooltip says where the answer came from. ⛔ Deliberately **not**
  `resolveFinishPolicy`, which answers `await-human` for a conversation above every other tier: that
  is right for what happens when a task finishes on its own and useless for the button whose purpose
  is to overrule it. Before this the controls had no value at all, so their menus opened on the first
  level of the ladder — `commit-only` — and a project configured for commit·verify·merge was offered
  the one level that leaves the work on the branch. ⚠️ Where the tier below asks for something the
  button cannot do (`await-human`, `custom`), Commit falls back to `commit-only` rather than to the
  fleet default, because merging a trunk on behalf of a project that asked for a person is the
  expensive direction to be wrong in; Land falls back to `commit-and-merge`, because a Land that does
  not land is nothing.
- ⛔ **"I could not look" is not "there is nothing there".** When the measurement fails the Commit
  control is still drawn, carrying the reason. `pendingWorkFor` looks in three places, and the third
  is why: a conversation's claim on its workspace is released when its session ends, while the
  worktree keeps the branch **and every uncommitted file on it** — so the pool member that still has
  the branch checked out is searched by name (`workspaceOnBranch`, `unclaimed: true` on the answer).
  Without it, t280 rested with eight uncommitted files in ws2 while its own hold reason said *"use
  Finish, Stop or Commit below"* and no Commit was below.

⛔ **A pill's menu is rendered into a portal at the document root, positioned by `lib/menuposition.ts`.**
It used to be an absolutely positioned child of the pill, which every scroll container between it and the
page could clip — and the Plan & Split row *is* one, because `overflow-x: auto` makes a box a scroll
container in both axes. Its menus were cut to a few pixels tall with their options unreachable. Out at
the root nothing can clip it; the placement flips **above** the pill when the window has no room below,
which is the ordinary case for a composer sitting near the bottom of the window.

⭐ **A task's thread says which kind of task it is, and a subtask says whose plan it belongs to.** The
facts column carries `type` (`Task`, `Plan & Split` or `Conversation`) first, because it changes what everything under it
means; `parent`, for a piece of a split — ⛔ **lineage is not a dependency**, the edge points the other
way, so neither the `depends on` nor the `blocks` list can ever name it; `children`, with how each one
turned out, failures included; and `executors`, which reads back the accounts and models the Executor row
set, resolved exactly as `applySplit` resolves them. A child also carries `planned` above its `worker`
picker: the worker and model its plan filed it with (`plannedAssignment`), kept apart because moving a
child rewrites the picker and would otherwise erase what the plan chose (t353).

⭐ **`landing` is a status word, not a status** (t353). While `landTask` is rebasing, verifying and
merging, the daemon sets `landing` on every task it sends (`landingstate.ts`, applied once in
`events.ts` `emit` and on `task.list`/`task.page`/`task.get`), and `statusLabel`/`statusToneFor` show
it in the table, the thread and the phone. ⛔ It is never written to the row: a landing belongs to one
process, and a stored `landing` would outlive a daemon that died mid-merge.

⛔ **The title column takes the slack at every width.** `.tbl--tasks` has a fixed column budget:
ID, worker, active time, price, status and actions keep compact widths, and title receives what
remains. At 1250px the history dates yield; at 1000px filer and quality yield; at 700px dependencies
yield. This is a deliberate change of viewpoint, not a change to the operator's Columns preference:
the facts needed to act stay visible before horizontal scrolling becomes necessary. A long model id
ellipsises inside Worker rather than widening the table. ⚠️ `taskLabelShort` bounds the payload (a
title is the prompt and can be paragraphs), while CSS decides where its visible ellipsis belongs.

⛔ **A fixed column budget means no cell may size itself to its own content, and a date is wider on
some machines than others.** `Created` and `Updated` were drawn over `Status` on a 12-hour locale
(t376): `Sep 11 11:45 PM` does not fit a width set against `Sep 11 23:45`, and under `table-layout:
fixed` the overflow paints on the neighbour instead of widening anything. The stamp is therefore
rendered as two nowrap spans — `whenParts` in `lib/format.ts`, `Stamp` in `Tasks.tsx` — inside a
wrapping cell, so a narrow column costs a second line and never a collision, and neither the date nor
`11:45 PM` is ever broken mid-value. Today's stamp has no date and stays one line. ⚠️ The L3 suite
measures both halves of this: that nothing overflows or reaches Status as rendered, and that the cell
still has room for the widest single line a 12-hour clock can draw, measured in the cell's own font
rather than assumed from the machine running the test.

⛔ **And the heading has to fit too, which is a separate measurement from the cell.** A column sized
for its values can still be too narrow for its own label: the headings are uppercase with 0.06em
tracking and the **sorted** one carries an arrow, so `TOOK ↓` needs 42px where *4m 12s* needs far less.
It was given exactly 42 — a zero-pixel fit, which folded into two lines on the operator's display and
not in the suite (reported 2026-09-13), and a folded heading makes the whole header row two lines deep.
⭐ Measuring every heading found three more already overflowing silently onto their neighbours, the
same fault as the dates above: `FROM ↑` needed 44px in 28, `DEP ↓` 32 in 26, `QUALITY ↓` 59 in 42.
Headings on this table therefore never wrap (`white-space: nowrap` on the cell, not only on the sort
button — `ACTION` has no button in it), the widths are the measured need plus padding plus a margin,
and the L3 suite clicks **every** heading and reports `[label, needs, room]` on a passing run so the
next rename can read its margin off the output.

⛔ **Every column of the task table sorts, and two kinds of column sort in two different places.**
`seq`, `title`, `status`, `quality`, `created` and `updated` are real columns: SQLite orders them and
the pager slices the result. `from`, `worker`, `dep`, `took` and `price` are **derived on read** —
active time is folded from a task's runs minus every stretch spent waiting on a person, a price is
this task's share of an account's billing window — so no `order by` can name them, and `pageTasks`
loads the whole filtered set, orders it and slices afterwards (`DERIVED_TASK_SORTS`). ⚠️ Ordering a
page by a number the database could not see would drop and repeat rows between pages, which looks
exactly like data loss. A name column opens A→Z and a measurement opens biggest-first; `null` sorts
last in **both** directions, because unpriced is not free and ungraded is not zero.

⭐ **The task table's ID is fixed; its other columns are an operator preference.** The **Columns**
menu keeps the choice in guarded `localStorage`, scoped to the display like the task filters and page
size. It starts with every optional column shown, and an absent, malformed or old value does the same
so a browser preference cannot silently hide information. The ID stays because it is the compact,
stable reference shared by the table, the thread and row actions.

⭐ **The list comes back to the page you left it on, and the composer comes back with what you
typed in it.** Both were lost for the same reason: opening a task replaces the table with the thread,
which unmounts everything under it, so `← Tasks` mounted a fresh list on page 1 and a fresh, empty
composer. Neither is route state — there is no URL here — so both are held in `localStorage`.
⛔ The page offset is stored against a **signature** of what is being listed (project, buckets, sort,
direction, page size, trimmed search) and is ignored the instant any of it differs: the table already
resets to the first page when a filter changes, because page 4 of a filter with one page draws an
empty table under a chip reading `Done 3`, and a remembered offset has to obey the same rule.
⛔ The composer's memory is a **scratch and never a draft** — a draft is a task row somebody filed,
and auto-filing half a sentence would put work in the fleet's table nobody asked to create. It holds
the prompt, the prerequisites, the schedule and the ids of attachments that were already uploaded;
it deliberately does **not** hold preview bytes, because one downscaled screenshot is over a megabyte
of base64 against a ~5 MB budget and evicting the prompt to keep a thumbnail gets the trade backwards
(a restored attachment shows its name instead). The Tasks page opens the composer already if a
scratch exists — a remembered prompt behind a collapsed button is the same as no memory at all — and
**Cancel** clears it, so what was typed is closable rather than immortal. The pill row is a different
memory: `composerprefs` is how this operator files *every* task, the scratch is the one they are in
the middle of.

⚠️ The first kind option is **Single Task**, not *Task*. Beside *Plan&Split*, which files several,
plain “Task” read as the category rather than as one of five shapes.

### The Debate row, and the three notices under it

⛔ **Two rows, like Plan & Split, and the split means the same thing.** The first is **Organizer** —
priority, dependencies, finish, worker, model, effort — which is what the *arbitrating* turn runs as,
because a debate task **is** its organizer. The second is **Seats**: a seat-count pill (2–5, which is
also the fan-out cap the task is filed with, so the number on the pill is the number that will be
allowed), a round-budget pill (1–5), an exchange pill (*Verbatim* or *Organizer's digest*, decision
D4) and the **roster**.

⛔ **The roster is not `WorkersPicker`**, and the difference is the whole feature. That control
answers *which accounts may run a piece* — a closed list the scheduler picks from — and reusing it
would let three seats land on one account and still be called a debate. The roster answers *who sits
in seat 2*: an ordered list, one row per seat, each naming exactly one account, model and effort. A
duplicate triple is allowed, because a homogeneous debate is a thing a one-account operator may want.
⚠️ **Send is disabled until every seat names an account this fleet has** — filing a half-roster would
leave an organizer blocked on seats that were never filed, which is a task nothing can ever release.
⭐ When the preview reports **one model family** in every seat (`adapterSpread === 1`), each seat
row gains a **Lens** field — an evidence base that seat examines first, never a position to hold —
because prompt-level diversity is the only diversity left to buy there. With two families in the
room the field is not shown and a lens typed earlier is not sent: the roster already bought its
diversity, and an assigned role would re-introduce the penalty published work measures for one.

⛔ **The organizer's account picker is sorted by the fitness this fleet has measured, and says so.**
Published work finds a judge is what makes a diverse roster pay off, and that judges favour their own
generations — so the hint names the adapter beside the score. ⚠️ Advisory, never a gate: a weak
organizer is not refused, and an account with nothing measured keeps the fleet's own order, because
`null` is unknown and not a zero.

⛔ **Three notices sit between the settings and Send, and every one of them carries its basis**
(`src/renderer/src/lib/debatenotice.ts`). *Heterogeneity* is counted on the **adapter**, so two Claude
models read as one family. *Cost* comes from `task.estimatePreview` as a multiple of the same question
asked once, with `n/a` — never `$0.00` — where nothing could be priced, plus a fourth notice when the
fleet cannot run every seat at the same time (said out loud, never silently corrected). *Diminishing
returns* names what the literature found past 3–4 seats and rounds, that **none of it was measured on
this fleet**, and ⭐ the honest caveat: several published results find debate does not beat one strong
agent at the same token budget. That sentence is on the screen where the money is committed, and it is
the reason this feature can be trusted.

### The debate board

On the organizer's thread, above the messages: one column per seat, one row per round, the
organizer's own words between rows, and the verdict in the header once one has been chosen. ⛔ Every
cell is agent output, so it is **text** parsed by [`lib/markdown.ts`](../src/renderer/src/lib/markdown.ts)'s
closed subset — no raw HTML, no `dangerouslySetInnerHTML`. A debate is the one screen in this app
where several untrusted agents' words sit beside each other, which makes that rule more load-bearing
here, not less. Each position begins with a compact metadata table containing the confidence the
seat stated in its prose, or **Not stated** — it remains text rather than being normalised into a
number the system cannot justify, and its accent colour distinguishes metadata rather than grading
the claim. ⚠️ **Unresolved citations only**, beside the seat's name: a list of every path that
did resolve is a wall of text saying nothing happened, which is how a report stops being read. It is
a report, never a penalty.

⚠️ The **verdict card** is an ordinary `choice` question (origin `debate`), so it appears on the
Attention bar and is answerable from the phone, because `Question` already is.

⚠️ A subtask is marked in the task table with **➥**, not a `└`. A box-drawing corner claims to join the
row above it, and this table is sorted by whatever column the operator picked — one click on Updated and
the corner points at an unrelated task. The marker says *this belongs to something else*, which is the
only thing the row actually knows.

⚠️ `Conversations` is **one table, two scopes** — the same component renders with and without a
project. There is deliberately no fleet-wide Resources table: it listed the pools a project's own
Settings tab already shows.

## 4. Renderer-side logic lives in `lib/`, and is unit-tested

⭐ **The reason this directory exists:** the UI suite's worker has no credentials, so nothing it files
ever runs — any check against a session id, a token count or a quota delta passes against an empty
list. Logic extracted into a pure function under `lib/` is provable at L1 instead.

| Module | Holds |
|---|---|
| `daemon.ts` | the RPC/event client |
| `conversation.ts` | conversation grouping and outcome, as a pure function |
| `taskview.tsx` `threadview.ts` `fleetcard.ts` `fleetcounts.ts` | derived view state |
| `format.ts` `modelname.ts` `agenticon.ts` | display formatting |
| `live.ts` | `showsLiveOutput(status)` — which statuses get a peephole |
| `streamview.ts` | `mergeStreamLines(rows, line)` — one `session.stream` event folded into a live view. ⛔ Keyed on `seq`, because the backfill and the live feed **always** overlap: a pane asks for `session.streamlog` and starts receiving events in the same breath, so every line published in between arrives twice |
| `diffline.ts` | `patchLineKind(line)` — how a patch line is classified for display, from its **first character and nothing else** |
| `sidebyside.ts` | `splitPatch(patch)` — a unified patch as two-column rows. ⚠️ The pairing is **positional**: a removed run and an added run are zipped top-to-top and the surplus stands alone, so a line that moved across a large edit can sit opposite an unrelated one — which is what the single-column view beside the toggle is for |
| `notify.ts` | `notifiableTransition(before, task)` — when a task's movement is worth an OS notification. ⛔ A *transition*, never a state: first sight is always silent |
| `menuposition.ts` | where a pill's portalled menu goes: flip above, clamp to the window, never clip |
| `newproject.ts` | the add-project wizard's step blockers, its creation plan, and the template signature |
| `prefs.ts` | saved views, fleet collapse and density, page size, **which page of the list you were reading**, and which diff layout you read patches in (localStorage) |
| `uisettings.ts` `zoom.ts` | tray/Enter behaviour, colour theme, **keep-awake** and zoom, mirrored from main's `ui-settings.json` |
| `pasteimages.tsx` | paste-to-attach; downscales to 1568px and uploads one image per call |
| `composerprefs.ts` | what the composer was last set to — ⛔ **last-selected beats inherited**, and model/effort are keyed **per account** |
| `composerscratch.ts` | what is still half-written in the composer — ⛔ a **scratch, not a draft**: no task row is filed |

**Notifications are a window preference too**, for the same reason: `notifications` lives in
`ui-settings.json`, the renderer decides *when* (it already holds the fleet state) and main decides
*whether it can* (`Notification.isSupported()`) and owns the window a click raises. ⛔ Only three
transitions fire one — `awaiting_human`, `completed`, `failed` — and only as a change, because
attaching to a daemon that has been working while the app was closed would otherwise fire one per
resting task.

⚠️ `UiSettings` is **separate from fleet `Settings`** on purpose. Those live in the daemon's database
and change what the *scheduler* does; these are read by the main process and change what the *window*
does — including whether closing it leaves the daemon running, which main must decide when the daemon
is not answering.

**Appearance is a window preference:** Global offers System (the default), Light and Dark. System follows live OS light/dark changes; Light and Dark set an explicit palette.

**Keep this computer awake** (`preventSleep`) is the one switch on App behavior that **defaults to
on**. Main holds a `powerSaveBlocker('prevent-app-suspension')` while it is set, started at launch as
well as on change — the machine it matters most on is a host left running to take work, which nobody
opens the settings panel on. ⚠️ It asks the OS not to *idle*-sleep; it does not force the display on
and cannot override a closed lid, a deliberate Sleep or a flat battery. ⛔ Per-install, like every
other `UiSettings` field: driving another computer's fleet, the setting that decides whether the run
survives the night is the one on **that** computer, read by switching to it in the picker.

### The Session TUI tab is two things, because a dispatched agent has no terminal

⛔ **There is no screen to mirror, and none can be made.** Work runs on the `stream` transport
because `--print` refuses to start under a pseudo-terminal (`docs/adapters.md`), so a dispatched
session's output is a machine protocol on a pipe. The tab therefore draws whichever of two things is
true of the session in front of it:

- **`pty` session** — `TerminalPane`, the real CLI screen over xterm.js, with *take the keyboard*.
- **`stream` session** — `SessionStream`, the decoded records as rows, and it says on screen that it
  is not a terminal. Beside it, **Open a real terminal** (`session.attach`) starts the CLI itself in
  the same workspace holding a **fork** of the conversation — always a fork, even when it is resting.
  ⛔ `spawnSession`'s resume path reuses the *same row*, so a resumed conversation would come back
  marked `pty` while still reading `purpose: 'work'`, and `warmSessionFor` would then offer the
  terminal a person is sitting at to the next dispatch. ⚠️ Two processes, one worktree: the pane says
  so rather than implying otherwise.

⛔ **The keyboard switch is not offered on a pipe session, and that is a bug fix.** Measured
2026-09-13 on claude 2.1.270, raw keystrokes into `--input-format stream-json` stdin corrupt the next
message and **exit the CLI 1** — so *take the keyboard* on a dispatched task ended the run on the
first character. `writeSession` refuses it in the daemon too, because the RPC is reachable from a
paired desktop. Talking to a running agent is the thread composer, which delivers into the live turn.

## 5. Styling

`styles/tokens.css` then `styles/app.css`. The brief was *sleek, not coarse*, and coarseness comes
from three avoidable things: inconsistent spacing, saturated colour used decoratively, and type that
is too large and too varied.

- **Five type sizes. Not six.** `--text-meta` 11 · `--text-dense` 12 · `--text-body` 13 ·
  `--text-section` 15 · and one larger.
- **One accent.** Colour is reserved for **state**.
- ⛔ `color-scheme: dark` is load-bearing, not a formality. Without it the browser paints every
  UA-drawn surface light — scrollbars first and most visibly, but also over-scroll, form-control
  internals and the caret. Styling `::-webkit-scrollbar` alone leaves all of that.
- Fonts are stacks with system fallbacks (Inter, JetBrains Mono; both OFL and vendorable later
  without changing a rule).

- **`.panel` caps at 1100px; `.panel--wide` does not.** The cap is a reading measure for prose and
  forms. A panel whose content is a *board* — Flow, the task table — opts out, because squeezing the
  columns a reader is comparing while half the window stays empty is worse, not calmer. ⛔ Flow, Tasks
  and the thread are three views of one project, looked at one after another: they are all wide.
- **The task table responds to its panel, not the window.** Its fixed operational columns yield via
  the named `task-table` container as the resizable sidebar reduces the space actually available;
  viewport breakpoints cannot know how wide that sidebar is. ⛔ A dropped column is `visibility:
  collapse; width: 0` on its `<col>`, never `display: none` (which left every cell drawn, and hiding
  the cells too laid the table out against stale slots on some runs). ⚠️ Not a `ResizeObserver`
  either: it never delivers in the suite's hidden window, so L3 could not see it (2026-09-13).
  ⛔ A narrow panel drops columns and never squeezes one: a column's width is its *sorted* heading's
  need on Linux, the widest of the three fonts, plus padding and margin (measured in CI, 2026-09-13),
  and a collapsed column still keeps its geometry — see [`testing.md`](testing.md) §3.
- **A paper table scrolls inside its own box.** `.tbl--paper` is a fit-content block with
  `overflow-x: auto`, because a table cannot shrink below its min-content and Table 12 ran past a
  narrowed column.
- **The status bar ends with the app version.** Its left fact is the live orchestratord process;
  worker/session counts, platform and the version are separate facts, so the daemon does not have to
  be restarted just to say which packaged app opened the window. A downloaded update is a link to its
  verified installer folder, never an install button.

⚠️ Reuse an existing class before adding one. The check-command textarea once borrowed `.ask-input`,
whose entire design is to be invisible.

## 6. Conventions

- ⛔ **A quota reading is never shown without its age**, and a stale one is never shown as a current
  number. ⚠️ "Unknown" is not the whole answer either — never probed, no usage cache yet, stale, a
  failed probe, and `quotaProbe: 'none'` are **five** states with five different things to do about
  them. Collapsing them is what made a working Probe button look broken. See `quotaGap()`.
- ⛔ **A control that spends the operator's money says so before it is pressed, and is drawn only
  where it can help** (t570). *Warm up* appears on a worker's note row when that worker's adapter
  declares `usageRefresh.warmup` **and** its reading is the `no usage data yet` gap — never beside an
  account that already has a number, where the turn would buy nothing. Its sentence is the adapter's
  own (the renderer does not price another vendor's turn), it is repeated at commissioning by
  `AdapterFacts`, and `quotaGap`'s hint switches from *start a session and probe again* to the button
  only when one is on offer. ⚠️ Where a warm-up ran and the provider still published nothing, the
  daemon's sentence says a turn was already spent and not to send another — the one state in which
  "try again" is the wrong advice.
- ⛔ **A window label names the window, not the card it is on.** Adapters name a quota window by its
  pool *and* its length — `Muse 5h` — because a reading has to be legible wherever it is quoted. On a
  worker card the pool half is the card's own title repeated down the rows, paid for out of the
  column the bars need, so `shortWindowLabels` (`src/renderer/src/lib/fleetcard.ts`) drops it and
  `.wcard-windows--terse` narrows the label column to match. ⛔ Dropped only when what is left still
  tells the rows apart: Antigravity meters two pools on one account, and `Claude/GPT 5h` beside
  `Gemini 5h` shortened would draw two bars claiming to be the same window. The full label is on
  every row's tooltip in both cases.
- ⛔ **The sessions divider counts slots, not sessions (t549, 2026-09-19; word fixed t560).**
  Every worker card draws `sessions ──── 1 / 2 in use` (narrow: `──── 1 / 2 ────`): slots in use against *Max parallel
  instances* — open `work` sessions, a warm idle one included, plus `reservedSlots` the daemon serves
  from `retainedReservations()` for tasks holding a slot with no live process. That is the same
  arithmetic as `slotsInUse`, so the card cannot read `0 / 1` beside a task held *at capacity*; it
  turns amber when full, and the tooltip splits working / idle / held (`instanceUse`, `fleetcard.ts`).
  Drawn on every card, sessions or none, so it never resizes the strip. Below it, the most recent
  three session gauges and nothing else — the `+N more` line this replaced counted every warm
  conversation the account had ever measured (`+59 more`) and said nothing an operator acts on.
- ⛔ **Money accrues in dollars, under the windows it is no longer bounded by.** A quota gauge is a
  share of a fee already paid; a usage-credit meter is a bill being run up now, so the fleet card
  draws it as its own row below the gauges rather than as a fourth gauge among them. ⚠️ Drawn where
  the vendor published an amount to draw — `creditGaugeVisible` in
  [`shared/credits.ts`](../src/shared/credits.ts): credits on, *or* credits the vendor cut off with
  real spend on the clock, where the label reads `spent` and the value dims. ⛔ Never on a
  credits-off account with no numbers: the vendor publishes no balance at all there, and `money()`
  would print `$0.00` for a purse that has merely not been shown. ⭐ The second case was measured
  2026-09-13 on `ClaudeFirst`, where testing `enabled === true` alone left the account with the
  largest bill in the fleet (`$20.57`) as the one card drawing no credit gauge — because the vendor
  had turned credits off *on account of* that spend.
- ⛔ **A checkbox that records an intention says so.** Settings › Workers › *Credits* does not turn
  usage credits on — the vendor reports `can_toggle: false` and `/usage-credits` opens a login chooser
  — so it is labelled with what the vendor currently says (`(on)` / `(vendor: off)`) and its tooltip
  names where the real switch lives. Presenting it as the switch would be the one lie the fleet strip
  exists to prevent: a control that appears to be on and does nothing.
- ⛔ **Credits off is four situations, and the row says which one.** `enabled: false` covers a spent
  monthly allowance, a switch somebody threw, an account never offered credits, and a vendor refusing
  without saying why — each with a different next move. `creditsMismatchNote`
  ([`shared/credits.ts`](../src/shared/credits.ts)) names the one that applies, with the numbers where
  the vendor published them, and the Doctor warning and the once-per-cause suppression in
  `CreditsIntent.reportedKind` read the same judgement so they cannot drift from the row.
  ⭐ Measured 2026-09-13 on `ClaudeFirst`: the operator had turned usage credits on at the vendor and
  the row still said *Vendor reports credits off.* — true, and useless, because the switch was on and
  the *allowance* was spent (`$20.57` of `$17.30`, refilling on the subscription anniversary). ⚠️ A
  spent purse is drawn in dim text rather than amber: it is a reading, not a fault, and amber sends
  somebody looking for a switch that is already thrown.
- ⛔ **A held task says *why*, and says *when* where the refusal has an end.** `ready` on its own is
  unreadable: it is the scheduler's word for *eligible*, and a person who just filed a task reads it
  as *waiting for me*.
- ⛔ **A completed task is not still waiting on its last hold.** `holdReason` is durable history and
  may survive a landing failure that was resolved separately; task rows and the detail facts suppress
  it after completion. Failed and cancelled tasks retain their reason because it can explain the end.
- ⛔ **An avoidable quota preemption warns before it acts, and quota holds surface at the prompt.** The running task's quota-gate fact and thread prompt area show the persisted countdown, its reason, and **Override preemption**; clicking it keeps the same session running until the measured window reset. The default action comes from the adapter: a compact-capable worker shows **Compact & pause** and **Hand off & pause**, with the active default highlighted, while a worker that cannot compact offers handoff only. Any task paused or held on quota renders the same `.decide--quota` card directly above the composer (`QuotaDecide`), and active holds appear in the top `Attention` bar so they are immediately visible rather than buried in the side pane alone. A vendor refusal records its own reason and reset time on the task; it offers a retry, never the percentage-gate override, because the turn has already failed. ⚠️ The `Attention` row also carries **Dismiss**, which is not an override: it silences that one alert and changes nothing about the task — still gated, still in the Tasks list, still released by the fleet when the window resets. It is held in `localStorage` (`lib/quotaalerts.ts`) rather than in component state because a park lasts hours and t288 reported the same banner, with the same clock on it, surviving a restart of the app. A dismissal is scoped to the gate state it was made about — status, `notBefore`, and the preemption deadline, deliberately *not* `holdReason`, which the quota poller rewrites with a fresh percentage every reading — so a new window, a new preemption warning or a move between gate kinds interrupts again, and an entry is dropped as soon as its task is no longer gated.
- ⛔ **`awaiting_human` must offer somewhere to answer.** It is the one status explicitly about the
  operator, and it was once the only resting state with nothing to press.
- ⛔ **A measurement outranks a prediction wherever both exist, and the label says which is which.**
  The thread's `model` row leads with what the transcript says answered each turn and demotes the
  resolution to *next run asks for …*. Leading with the resolution made the row disagree with the run
  list under it on any account with more than one model pool, where the dispatch resolves the pool
  against a live quota reading (`modelFacts`, `resolveModelChoice`).
- ⛔ **Price and tokens are two rows, never a number with a caption.** They measure the same work with
  two instruments that [`cost-model.md`](cost-model.md) §5 never reconciles, so stacking the token
  count under the price read as a gloss *on* the price. One labelled row each, unit in the label.
- ⛔ **A run's `completed` beside a task's `awaiting_human` is not a contradiction** — the UI has to
  say so, because that pair is what somebody reads as broken.
- ⛔ **A Flow ticket appears in one lifecycle lane only, and the pool row says what the tree is.**
  A workspace claim enriches Running only while its task is `running` or `cancelling`, where the
  binding says **locked**; an `awaiting_human` ticket stays in Awaiting and names the workspace it
  still locks. A release still unwinding must not pin a completed or awaiting ticket under Running as
  a second copy. ⭐ **But the *workspace row* for that retained tree is drawn `locked` too**
  (`isLockedWorkspace`, `Flow.tsx`): the ticket read `locks ws2` while ws2's own row read **free** —
  one fact with two answers, and the wrong one on the column an operator reads to find a tree that
  can take work. It is not cosmetic: a free row is a row `computeWorkspaceRows` pairs an inbound
  dispatch with, drawing a ticket heading into a tree it cannot have. The row shows the ticket, the
  tree and the account in the human tone, and the count under Running is unchanged — it counts
  *active* tasks, and this one is not one.
- ⛔ **Stop grading stops only grading.** A pending quality review has its own read-only session and
  metered run, so its Stop grading button records that review/run as `cancelled` and leaves the
  completed task, its workspace, and prior scores unchanged.
- ⛔ **Deleting a task requires an explicit Yes or No confirmation.** No is focused first and Escape
  declines; the task list must never turn the destructive row-menu click directly into an RPC.
- ⛔ **A control that cannot be used is still a control.** Where `selectableEffort` is false the New
  Task form renders **no** effort control rather than a disabled one, which would sit there implying a
  choice was being made.
- `rules-of-hooks` and `exhaustive-deps` are on and earn their place: the fleet strip and the terminal
  both subscribe to daemon events, and a missing dependency renders a stale worker list.
