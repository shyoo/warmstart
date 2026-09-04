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
| `Attention` `Questions` | the approvals/questions bar — one keystroke above the operator's work |
| `Overview` `Controller` `Conversations` | dashboard, the controller chat, and conversation history |
| `Project` `ProjectSettings` `Projects` | the project routes and the policy tier |
| `Cost` | what the scheduler chose and why |
| `LooseEnds` | work that exists and is going nowhere → [`landing.md`](landing.md) |
| `Doctor` | which CLIs were found, who is signed in, how old each reading is, what is unverifiable |
| `Logs` | the daemon's log, live and filterable, ring-buffered so a late window sees the past |
| `Terminal` | the real agent TUI over xterm.js, not a reconstruction |
| `AppSettings` `SettingRow` `SettingButtonSelect` `SidebarResizer` | chrome |

⛔ **Quality review has no view of its own**, and that is a decision rather than an omission. It is a
field on a task, not a place to go: a dedicated "Quality" page would be a second board to keep in
step with the first, and the cross-agent comparison the feature exists to enable is a *query* over
stored rows — a thing to run when there is something to compare, not a screen to build before there
is. It appears in three places only: a `Quality` column in `Tasks`, a `#N Quality Review` row in
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

⛔ **The Conversation kind hides two pills, and hiding them is what it means.** A conversation is
`Reuse` + `await human`, and both come from the kind rather than from the row: `resolveFinishPolicy`
and `resolveSessionSharing` answer `await-human` and `on` off a conversation task **above the project
and the fleet**, so a project set to `commit-and-merge` cannot land a chat. The composer therefore
draws neither pill — a control offering a choice that is not on the table is worse than a missing one
— and files the task with both fields on `inherit`, which is the value that keeps the kind answering.
The thread shows the same two as read-only facts.

⛔ **A conversation's thread offers Finish · Stop · Commit, and Commit is drawn only when git says
there is something to commit.** `task.pendingWork` reads the workspace at the moment the card renders;
`hasDiff` counts **uncommitted** files only, because an unlanded commit is already safe on the branch
and warning about it would cry wolf on every conversation that did commit. Finish releases the
workspace, so over a dirty tree it arms once and says what it would lose before it will do it. The
Commit menu offers the finish ladder minus `await-human` (which is what the conversation is already
doing) and `custom` (an instruction about the project's own finish, not about this commit); picking a
rung writes it to the task and asks the agent — in the same session, so it still has the context — to
commit and report complete, after which the ordinary landing path runs that rung. ⚠️ It asks rather
than commits because the daemon never authors a commit; see [`landing.md`](landing.md).

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
- ⛔ **A held task says *why*, and says *when* where the refusal has an end.** `ready` on its own is
  unreadable: it is the scheduler's word for *eligible*, and a person who just filed a task reads it
  as *waiting for me*.
- ⛔ **A completed task is not still waiting on its last hold.** `holdReason` is durable history and
  may survive a landing failure that was resolved separately; task rows and the detail facts suppress
  it after completion. Failed and cancelled tasks retain their reason because it can explain the end.
- ⛔ **An avoidable quota preemption warns before it acts.** The running task's quota-gate fact shows
  the persisted one-minute countdown, its reason, and **Override preemption**; clicking it keeps the
  same session running until the measured window reset. A vendor refusal is not offered as a choice
  because the turn has already failed.
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
- ⛔ **Deleting a task requires an explicit Yes or No confirmation.** No is focused first and Escape
  declines; the task list must never turn the destructive row-menu click directly into an RPC.
- ⛔ **A control that cannot be used is still a control.** Where `selectableEffort` is false the New
  Task form renders **no** effort control rather than a disabled one, which would sit there implying a
  choice was being made.
- `rules-of-hooks` and `exhaustive-deps` are on and earn their place: the fleet strip and the terminal
  both subscribe to daemon events, and a missing dependency renders a stale worker list.
