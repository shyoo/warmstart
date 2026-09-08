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
| `Flow` | project lifecycle map: 6-column kanban flow with ticket ↔ workspace ↔ worker bindings and read-only grading runs |
| `FleetStrip` `Workers` `FleetSettings` | the fleet: per-account quota with its **age**, reset countdowns, live sessions; one two-column settings card per worker |
| `Tasks` `TaskThread` `Dependencies` | the board, one task's thread, and prerequisite edges |
| `NewTask` `Pill` | the composer: the prompt first, its settings as a row of **pills** under it |
| `Attention` `Questions` | the approvals/questions/quota-gate bar — one keystroke above the operator's work |
| `Overview` `Controller` `Conversations` | dashboard, the controller chat, and conversation history |
| `Project` `ProjectSettings` `Projects` | the project routes and the policy tier |
| `NewProject` | the add-project wizard: three steps, one modal, `lib/newproject.ts` holds its rules |
| `Cost` | what the scheduler chose and why |
| `Statistics` | what finished tasks actually cost, took and scored — three tabs, one RPC |
| `LooseEnds` | work that exists and is going nowhere → [`landing.md`](landing.md) |
| `Doctor` | which CLIs were found, who is signed in, how old each reading is, what is unverifiable |
| `Logs` | the daemon's log, live and filterable, ring-buffered so a late window sees the past |
| `Terminal` | the real agent TUI over xterm.js, not a reconstruction |
| `AppSettings` `SettingRow` `SettingButtonSelect` `SidebarResizer` | chrome |

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

⛔ **A thread message renders inline code spans, and nothing else of markdown.** Every message this
codebase writes names refs, branches, shas and files in backticks — *"Landed as `98f200ab` onto
`main`"* — and `{m.text}` printed the backticks, which is the worst of both readings: punctuation to
ignore, and no distinction between `main` the branch and main the adjective. `lib/codespans.ts`
splits the text and `.msg-code` sets the fenced runs in the mono face. ⚠️ Headings, links and
emphasis are deliberately **not** rendered: those are a different feature with a different risk — an
agent's own prose reaching this path — and nothing here needs them. A span never crosses a newline,
so the worst an unmatched backtick can do is print itself.

⛔ **The thread's timeline is ordered on when each entry *finished*, not when it started**
(`byEndThenStart` in `lib/taskview.tsx`). Runs, compactions and reviews nest rather than queue — a
compaction happens *inside* the run that asked for it — so the two always share a start and never
share an end. Measured on t231, 2026-09-05: run 2 ran 16:44:24–16:55:19 and its compaction ran
16:44:26–16:47:06, so start-time order printed a compaction that had visibly finished at 16:47
*below* a run still going at 16:55. ⚠️ An entry that has not finished sorts last, which is not a
fallback but the answer — it has not ended, so it ends after everything that has. The start time
breaks ties, so two open entries still have a stable order.

⛔ **Analytics holds three pages, and they answer different questions.** *Routing Model* explains a
choice: every number on it is shrunk toward a prior, blended or clamped, because it is about to be
acted on. *Statistics* (`components/Statistics.tsx`, one `statistics.report` call for all three tabs)
describes what happened: nothing on it is smoothed. Price, Velocity and Quality each fold the last
200 finished tasks into an agent → model → effort tree, **re-folding the raw samples at every rung**
rather than averaging the rung below, and every table prints `n` beside its percentiles. The two
pages will disagree — a shrunk pace factor is not a measured p50 — and the page says so rather than
reconciling them quietly. Price additionally names its basis per row: `subs`, `API rate` or `mixed`,
since averaging an amortised share of a flat fee together with money billed on top means nothing.
⚠️ An `unknown` renders `n/a`, never `$0.00`, and the benchmark prior and fitness columns are drawn
on **model** rows only — a prior is published per model, so there is no prior for `high` alone.

⛔ **The chart names the harness as well as the model, and the table does not have to.** Its bars are
model rows, which in a table are indented under the agent row that owns them; a chart has no such
parent, and `claude-sonnet-4-6` is served both by Claude Code and by Antigravity out of different
subscriptions at different prices. So `graphLabel` prints *Antigravity · Sonnet 4.6*, read off the
agent rows in the same report rather than off the adapter registry — the chart names only what the
table beneath it is folding.

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
and whether both an exact diff and a peer remain so it can still be graded. A "Filter out cannot be graded" toggle
persists in operator preferences, and permanent refusals are printed beside **no**, not deferred until a batch skips it.
The two link to each other in both
directions rather than repeating each other. ⛔ **It is also the only place a review is commissioned in bulk** —
the *Grade up to five* button that used to sit on Routing Model › Quality is gone and links here,
because two buttons spending turns on the same accounts under different caps is a way to empty a
quota window by pressing the wrong one.

⚠️ **One steady progress mark, beside Refresh, and it tracks the grading rather than the fetch.**
While a batch runs the page polls every three seconds; a spinner bound to the fetch therefore blinked
on and off across both the Refresh button and the "Filter out cannot be graded" label, at a cadence
that described the poll and nothing an operator cares about. The mark is drawn for as long as
`batch.state === 'running'` and the button keeps its label and stays clickable throughout.

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
openai-compatible* names neither. So *Work by*, *Graded by*, the batch's *Reviewer* column and the
*Model / agent* and *Graded on* tables on Routing Model › Quality all lead with the model and put the
adapter's own label beside it — *GPT 5.6 Terra · Codex CLI*. ⚠️ The labels come from the adapters
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

⛔ **In Plan & Split the composer draws two labelled rows of pills, and this is decision D5.** The
first is **Planner** — worker, model, effort, reuse, finish, priority, dependencies, attachments — which
is what the *planning turn* runs as. The second is **Each piece**, plus a fan-out pill, which is what
every subtask it files inherits. "Plan with one model, build with another" is the case Plan & Split
exists for, and one row would have forced them to be the same.

⚠️ Until t182 **every one of those controls was hidden** whenever the kind pill said Plan. That was
honest while a plan task was never dispatched — nothing would have read them — and wrong the moment one
is. Only the Draft button and the schedule clock stay task-only: a scheduled plan and a draft plan are
both coherent, and neither has been asked for.

⚠️ The captions are not decoration. Two identical rows of pills with nothing to tell them apart is the
failure they buy, and it is worse than one row. The fan-out pill's number is written into the task's
**mandate**, so the number shown is the number enforced — never a second, invisible cap.

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

⛔ **A conversation's thread offers Finish · Stop · Commit · Land, and which of the last two is drawn
is decided by git rather than by the task.** `task.pendingWork` reads the workspace at the moment the
card renders; `hasDiff` counts **uncommitted** files only, because an unlanded commit is already safe
on the branch and warning about it would cry wolf on every conversation that did commit. Finish
releases the workspace, so over a dirty tree it arms once and says what it would lose before it will
do it.

- **Commit ▼** — uncommitted files. The ▼ offers the finish ladder minus `await-human` (which is
  what the conversation is already doing) and `custom` (an instruction about the project's own finish,
  not about this commit); the rung writes itself to the task and the agent is asked — in the same
  session, so it still has the context — to commit and report complete, after which the ordinary
  landing path runs that rung. ⚠️ It asks rather than commits because the daemon never authors a
  commit; see [`landing.md`](landing.md).
- **Land ▼** — a clean tree with commits the landing target does not have. ⛔ **Two controls, not one
  that changes meaning:** committing costs a turn and landing does not, so `task.landConversation`
  writes the rung and lands the branch itself — rebase, the project's checks, merge — through the same
  `decideFinish` bar a first completion meets. Its ▼ offers only the rungs the tool acts on
  (`policyLands`: merge, push, pull request), because landing under `commit-only` would be a button
  that does nothing. This state used to have no button at all: Commit had nothing to ask for and
  *Retry landing* is drawn only after a landing has already failed.
- ⭐ **Both are buttons with a second answer behind a ▼ — `SplitButton`, not a picker** (t283).
  They shipped as `SettingButtonSelect`s: the dark rounded control with a ✍ on it that every
  *setting* in this app wears, in a column beside a green Finish and a red Stop. The one row on the
  card that spends a turn was the one that did not read as pressable, and a picker has no default
  action — pressing it could only open a list. Now the main half acts and the ▼ chooses, Commit in
  `--warn` and Land in `--primary` (never `ok` or `danger`: those two are spoken for on this card).
  The ▼ half is a `Pill` wearing the button's colour, so the portal, the flip and the arrow keys are
  the same code every other menu uses.
- ⭐ **The rung it starts on is the task's, else the project's, else the fleet's** — `defaultRung`
  in `lib/finishrung.ts`, and the card prints where the answer came from. ⛔ Deliberately **not**
  `resolveFinishPolicy`, which answers `await-human` for a conversation above every other tier: that
  is right for what happens when a task finishes on its own and useless for the button whose purpose
  is to overrule it. Before this the controls had no value at all, so their menus opened on the first
  rung of the ladder — `commit-only` — and a project configured for commit·verify·merge was offered
  the one rung that leaves the work on the branch. ⚠️ Where the tier below asks for something the
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
way, so neither the `depends on` nor the `blocks` list can ever name it; `pieces`, with how each one
turned out, failures included; and `each piece`, which reads back the accounts and models the Pieces row
set, resolved exactly as `applySplit` resolves them.

⛔ **The title column takes the slack when the window is stretched.** An automatic table layout
hands out spare width in proportion to what each column *asked* for, and a column asks for as much as
its widest content wants — capped by `max-width`. At 48ch the title stopped asking, so a wider window
was shared evenly between the one column that is text and the eleven that are numbers, dates and
chips. `.tbl--tasks` raises the cap to `min(120ch, 46vw)`: still definite, because that is what
`text-overflow: ellipsis` needs to draw at the column edge, and still bounded at both ends.
⚠️ **And two truncations were fighting.** `taskLabelShort` cut the string at 70 characters *before*
the cell ever measured anything, so a wide window drew an `…` with empty space after it — a
truncation mark that was not telling the truth. The table now passes `TITLE_CHARS`, a bound on the
payload (a title *is* the prompt, and can be paragraphs) set well past the widest the column can be,
which leaves CSS to decide where the line ends.

⛔ **Every column of the task table sorts, and two kinds of column sort in two different places.**
`seq`, `title`, `status`, `quality`, `created` and `updated` are real columns: SQLite orders them and
the pager slices the result. `from`, `worker`, `dep`, `took` and `price` are **derived on read** —
active time is folded from a task's runs minus every stretch spent waiting on a person, a price is
this task's share of an account's billing window — so no `order by` can name them, and `pageTasks`
loads the whole filtered set, orders it and slices afterwards (`DERIVED_TASK_SORTS`). ⚠️ Ordering a
page by a number the database could not see would drop and repeat rows between pages, which looks
exactly like data loss. A name column opens A→Z and a measurement opens biggest-first; `null` sorts
last in **both** directions, because unpriced is not free and ungraded is not zero.

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
| `taskview.tsx` `fleetcard.ts` `fleetcounts.ts` | derived view state |
| `format.ts` `modelname.ts` `agenticon.ts` | display formatting |
| `live.ts` | `showsLiveOutput(status)` — which statuses get a peephole |
| `menuposition.ts` | where a pill's portalled menu goes: flip above, clamp to the window, never clip |
| `newproject.ts` | the add-project wizard's step blockers, its creation plan, and the template signature |
| `prefs.ts` | saved views, fleet collapse and density, page size (localStorage) |
| `uisettings.ts` `zoom.ts` | tray/Enter behaviour and zoom, mirrored from main's `ui-settings.json` |
| `pasteimages.tsx` | paste-to-attach; downscales to 1568px and uploads one image per call |
| `composerprefs.ts` | what the composer was last set to — ⛔ **last-selected beats inherited**, and model/effort are keyed **per account** |

⚠️ `UiSettings` is **separate from fleet `Settings`** on purpose. Those live in the daemon's database
and change what the *scheduler* does; these are read by the main process and change what the *window*
does — including whether closing it leaves the daemon running, which main must decide when the daemon
is not answering.

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

⚠️ Reuse an existing class before adding one. The check-command textarea once borrowed `.ask-input`,
whose entire design is to be invisible.

## 6. Conventions

- ⛔ **A quota reading is never shown without its age**, and a stale one is never shown as a current
  number. ⚠️ "Unknown" is not the whole answer either — never probed, no usage cache yet, stale, a
  failed probe, and `quotaProbe: 'none'` are **five** states with five different things to do about
  them. Collapsing them is what made a working Probe button look broken. See `quotaGap()`.
- ⛔ **A window label names the window, not the card it is on.** Adapters name a quota window by its
  pool *and* its length — `Muse 5h` — because a reading has to be legible wherever it is quoted. On a
  worker card the pool half is the card's own title repeated down the rows, paid for out of the
  column the bars need, so `shortWindowLabels` (`src/renderer/src/lib/fleetcard.ts`) drops it and
  `.wcard-windows--terse` narrows the label column to match. ⛔ Dropped only when what is left still
  tells the rows apart: Antigravity meters two pools on one account, and `Claude/GPT 5h` beside
  `Gemini 5h` shortened would draw two bars claiming to be the same window. The full label is on
  every row's tooltip in both cases.
- ⛔ **Money accrues in dollars, under the windows it is no longer bounded by.** A quota gauge is a
  share of a fee already paid; a usage-credit meter is a bill being run up now, so the fleet card
  draws it as its own row below the gauges rather than as a fourth gauge among them. ⚠️ Drawn only
  where the vendor reports credits *enabled* on that account: with them off the vendor publishes no
  balance at all, and `money()` would print `$0.00` for a purse that has merely not been shown.
- ⛔ **A checkbox that records an intention says so.** Settings › Workers › *Credits* does not turn
  usage credits on — the vendor reports `can_toggle: false` and `/usage-credits` opens a login chooser
  — so it is labelled with what the vendor currently says (`(on)` / `(vendor: off)`) and its tooltip
  names where the real switch lives. Presenting it as the switch would be the one lie the fleet strip
  exists to prevent: a control that appears to be on and does nothing.
- ⛔ **A held task says *why*, and says *when* where the refusal has an end.** `ready` on its own is
  unreadable: it is the scheduler's word for *eligible*, and a person who just filed a task reads it
  as *waiting for me*.
- ⛔ **A completed task is not still waiting on its last hold.** `holdReason` is durable history and
  may survive a landing failure that was resolved separately; task rows and the detail facts suppress
  it after completion. Failed and cancelled tasks retain their reason because it can explain the end.
- ⛔ **An avoidable quota preemption warns before it acts, and quota holds surface at the prompt.** The running task's quota-gate fact and thread prompt area show the persisted countdown, its reason, and **Override preemption**; clicking it keeps the same session running until the measured window reset. Furthermore, any task paused or held on quota renders a `.decide--quota` card directly above the composer (`QuotaDecide`) matching the action-card shape of `Decide`, and active holds appear in the top `Attention` bar with direct override actions so they are immediately visible rather than buried in the side pane alone. A vendor refusal is not offered as a choice because the turn has already failed.
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
- ⛔ **A Flow ticket appears in one lifecycle lane only.** A workspace claim enriches Running only
  while its task is `running` or `cancelling`; a release still unwinding must not pin a completed or
  awaiting ticket under Running as a second copy.
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
