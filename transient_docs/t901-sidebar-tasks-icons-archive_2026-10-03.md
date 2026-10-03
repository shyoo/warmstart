# t901 — Sidebar task list, task-type icons, project archive (plan, 2026-10-03)

A dated plan, stale by design. Status lives in `HANDOFF.md`.

## Operator decisions (t901, 2026-10-03)

| # | Question | Decision |
|---|---|---|
| 1 | Which tasks are listed under a project in the sidebar | **Every unfinished task, any type, capped**: newest activity first, at most 8 rows, then a "N more…" row that opens the project's Tasks board |
| 2 | Task-type icons | **Monochrome pictograms, theme-aware**: inline SVG in `currentColor`, one component, dark and light both come from tokens |
| 3a | Archiving a project that has unfinished tasks | **Refused** until every task is completed, cancelled or a draft |
| 3b | Where Archive / Unarchive lives | **Both** the project's Settings page and a right-click menu on the sidebar row |

## What exists today (read 2026-10-03, `d86b0cd6`)

- `openConversations()` (`src/renderer/src/lib/sidebarconversations.ts`) picks the sidebar rows:
  `kind === 'conversation'`, not deleted, status not in `{completed, cancelled, draft}`, newest
  `updatedAt` first. `App.tsx` draws them under the project row, behind a ▾/▸ fold that is stored
  per project in localStorage.
- Five task types, all named by `taskTypeLabel()` (`src/shared/tasks.ts`): Single Task (`work`),
  Plan & Split / Plan & Execute (`plan`, split by `isPlanExecute`), Conversation, Debate.
- The daemon already has `project.archive`
  (`src/daemon/api/projects.ts`). It prunes the project's managed pool worktrees (a worktree with work
  in it is kept), sets `archived_at`, and emits `project.changed`. `project.list` leaves archived rows
  out. **Nothing in the renderer calls it.** There is no unarchive. `addProject()` on an archived root
  reloads it but leaves it archived, so re-adding a folder cannot bring it back. Remote policy
  sets `project.archive` to `deny`.

## 1. Every unfinished task under its project

- `sidebarconversations.ts` → rename the rule to `openTasks()`. It keeps the `FINISHED` set and drops
  the `kind === 'conversation'` filter. It returns `{ shown, hidden }` with `SIDEBAR_TASK_CAP = 8`.
  The "unfinished, not running" comment still holds and is widened to cover every kind. A paused,
  queued, blocked or held task is still work the person is in the middle of.
- `projectSidebarActive()` takes the listed rows, so a listed task's open thread owns the selection.
  An overflowed task's thread gives the selection back to the project row.
- `App.tsx`: each row is `<TaskTypeIcon task/> title [Working]`. The overflow row reads
  `N more…` and routes to `{ kind: 'project', id, tab: 'tasks' }`. Fold labels and aria change from
  "conversation(s)" to "task(s)". The localStorage key stays `sidebarConversationsCollapsed`, because
  renaming it would unfold every project a person had folded.
- Plan pieces are listed flat, like every other task (decision 1 above).
- Tests: extend `sidebarconversations.test.ts` (kinds, cap, order, finished/draft/deleted
  excluded, active selection with an overflowed task). L3 `test/ui.test.mjs` has no credentials, so
  an assertion that would pass against an empty list is only half a check. Mutate the code and
  watch the test go red first.

## 2. `TaskTypeIcon`

- New `src/renderer/src/components/TaskTypeIcon.tsx`: 16×16 viewBox, `stroke="currentColor"`,
  `fill="none"`, 1.5 stroke, `aria-hidden` plus a `<title>` set to `taskTypeLabel(task)`. Shapes:
  - Single Task: rounded square with a check mark
  - Plan & Split: one stem forking into two arrows
  - Plan & Execute: three list lines with a play arrow
  - Conversation: a speech bubble
  - Debate: two overlapping speech bubbles facing each other
- Which icon is drawn comes from a pure `taskTypeKey(task)` beside `taskTypeLabel` in
  `src/shared/tasks.ts`, so the label and the icon cannot disagree about a plan's shape. It is a
  closed union, and the component has one exhaustive switch.
- Colour: `.task-type-icon { color: var(--color-text-dim) }`; an active row inherits its own colour.
  Dark, light and system themes, including a live switch, come from `tokens.css` with no second
  asset set. No emoji.
- Used in the sidebar first. The Tasks board and thread header can take it later; that is out of
  scope here.
- Tests: `taskTypeKey` covers all five; a render test checks that each key yields an `<svg>` with no
  hard-coded fill or stroke colour.

## 3. Archive

### Daemon
- `project.unarchive { id } → Project`: clears `archived_at` and emits `project.changed`.
- `project.archive` refuses while the project has an undeleted task that can still dispatch, run
  or land (`holdsProjectOpen`: not terminal, not draft). This differs from the sidebar rule, which
  still lists a `failed` task, because nothing moves a failed task without a person. The error
  names the count. The check is in the daemon, before the prune, so neither entry point can skip it.
- `addProject()` on an archived root unarchives it. Re-adding is the obvious way back.
- *As built:* a separate `project.listArchived` rather than a param on `project.list`, so the
  remote surface stays active-only by construction. Remote policy: both new methods are `deny`,
  matching archive.
- `reorderProjects` already ignores archived rows. Leave it as is.
- Tests: refuse with unfinished tasks, archive when only finished tasks remain, unarchive, re-add
  unarchives, and `project.listArchived` lists archived projects.

### Renderer
- `App.tsx` keeps the active `projects` list for every other consumer (NewTask, Tasks, Overview…).
  The sidebar also fetches `archivedProjects` when the filter is not Active, and refreshes it on
  `project.changed`.
- Header: `PROJECTS [funnel] [+]`. The funnel opens a small menu, placed with
  `menuPosition()`, with radio items Active / Archived / All. The funnel is accented when the filter
  is not Active. The filter is stored in localStorage (`appKey('sidebarProjectFilter')`) and
  defaults to Active. An empty Archived view reads "No archived projects".
- An archived row is dimmed and not draggable, and it lists no tasks (it has none unfinished). Clicking
  it opens the project. `ProjectRoute` resolves it from the archived list and shows an "Archived"
  banner with Unarchive.
- A right-click on a project row opens a context menu (a new pattern, kept small and reusing the
  same menu component) with Archive… or Unarchive. Archive is disabled, with its reason, while tasks
  are unfinished.
- Project Settings has an "Archive project" row with a confirm step. It names the worktree pruning,
  and it becomes Unarchive when the project is archived. Both entry points call the same handler.
- Tests: L1 for the filter rule and persistence; L3 asserts the funnel menu, archive refused with a
  live task, and the round trip through the Archived filter.

### Docs owed (docs/development.md §7)
`docs/ui.md` (sidebar task list, icons, filter, context menu), `docs/data-model.md` or
`docs/architecture.md` wherever project lifecycle is described (archive guard, unarchive, re-add),
`docs/mcp.md`/remote policy note if it lists methods, and `HANDOFF.md`.

## Order of work
1 → 2 (the icons land in the rows step 1 creates) → 3 daemon → 3 renderer → docs → checks.
