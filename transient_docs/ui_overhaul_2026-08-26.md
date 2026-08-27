# UI overhaul — project-centric navigation (2026-08-26)

A plan, not a record. Status lives in `HANDOFF.md`; when a phase lands, delete its section here and
move anything worth keeping to `changes_history.md`.

## The problem

Work is currently split across **Tasks / Projects / Controller**, and a project is one list view
among seven rather than the axis everything hangs off. The sidebar has three groups (Fleet, Work,
Settings) whose top group duplicates the fleet strip that is already on every screen.

The owner's read, 2026-08-26: *a project is the unit of work, the way it is in Claude Code.* Fleet is
a settings concern. Cost is something you want per project and in total.

Target sidebar:

```
Overview          cost + attention + fleet health, across everything
Projects
  multi_agent_controller
  magic_writer
  award_tracker
Settings
  Workers
  Doctor
```

## Decisions taken (owner, 2026-08-26)

| # | Decision |
|---|---|
| D-U1 | A project page is **tabbed**: Tasks · Sessions · Cost · Settings |
| D-U2 | **Every task must have a project.** The blank option in the creation form goes away |
| D-U3 | The **Controller lives in Overview** — it is fleet-wide judgment, like cost |
| D-U4 | Overview shows **cost (fleet + per project)**, **things needing attention**, and **fleet/quota health**. ⛔ Not a live-session list |

⚠️ D-U2 is a data-model decision and the only one that is awkward to reverse. See the constraint
below before implementing it.

## What the code already gives us, and what it does not

Measured 2026-08-26 against `main` at `82177c4`:

- ⭐ **`task.list` already filters by project** (`tasks.ts:111`). Grouping tasks per project is a UI
  change with no daemon work behind it.
- ⭐ **`runs.project_id` is populated**, so per-project cost is an aggregation over data that already
  exists — but `cost.report` has **no project dimension at all**. New endpoint, not a regroup.
- ⛔ **`sessions.project_id` is read and never written.** `spawnSession` takes no project and no
  insert sets it, so **every session row in a real database has `project_id: null`**. The Sessions
  tab in D-U1 is empty until this is fixed. Phase 4.
- ⚠️ **`tasks.project_id` is `references projects(id) on delete set null`.** A `not null` column and
  that clause cannot both hold: deleting a project would fail instead of orphaning its tasks. So
  D-U2 is enforced **in the API and the UI, not by the schema** — see Phase 2.

## Phases

Each phase leaves the app working. Nothing here is a big-bang rewrite of `App.tsx`.

### Phase 0 — the menu removal is deliberately NOT landed

⛔ **Do not commit this one.** Owner's call, 2026-08-26: removing the Electron File/Edit/View/Window
bar is small, self-contained and verifiable, which makes it the right first task to **dispatch
through Multi Agent Controller itself** — the point is to exercise the tool end to end and polish the
approach, and a fix landed by hand teaches nothing about either.

The first attempt is kept for comparison, not for merging:

- `archive/t1-first-attempt` (`5683e84`) — what the agent produced on 2026-08-26, plus the commit
  that rescued it after auto-landing refused.
- `multi-agent-controller/t1-…` was **reset to base** and the pooled workspaces parked detached, so a
  re-dispatch starts from a clean tree. ⚠️ Without that reset the agent would `git switch` onto a
  branch already containing the finished work, and the run would prove nothing.

What to watch on the re-run, because each of these was wrong the first time: whether the agent
**commits** its work (it did not, which is why landing refused), what the landing message says about
where the work is, whether the session pane shows prose rather than `stream-json`, and whether the
run's token totals match the transcript.

### Phase 1 — the shell

Replace the flat `View` union in `App.tsx` with a route object:

```ts
type Route =
  | { kind: 'overview' }
  | { kind: 'project'; id: string; tab: 'tasks' | 'sessions' | 'cost' | 'settings' }
  | { kind: 'settings'; page: 'workers' | 'doctor' }
```

The sidebar renders Overview, the live project list, and Settings. **Every existing view moves behind
the new routing unchanged** — Tasks, Cost, Controller and the rest keep working while the structure
around them changes. Nothing is rewritten in this phase.

- Files: `App.tsx`, `styles/app.css`.
- ⚠️ The UI suite reads `.nav-item` text to check every section is reachable. It will need updating
  in the same commit, not afterwards.
- Empty state: with no projects, the Projects group shows an inline "Add a project" rather than a
  bare heading. A stranger's first launch has no projects and must not hit a dead end.

### Phase 2 — the project page, and D-U2

A `Project` container owning the tab bar, with each tab a scoped version of what exists:

- **Tasks** — `Tasks.tsx` filtered to `projectId`. ⛔ Its project picker disappears here; the project
  *is* the context, and a picker that can contradict the page you are on is a bug waiting to happen.
- **Sessions** — the existing session list filtered by project. Empty until Phase 4; say so in the
  empty state rather than rendering a blank table that looks broken.
- **Cost** — this project's slice of Phase 3's aggregation.
- **Settings** — what `Projects.tsx` holds today for one project: root, vcs, landing strategy,
  policy, resources.

D-U2 lands here, in three parts:

1. `task.create` and `task.plan` **reject a null `projectId`** with a reason, rather than silently
   accepting one.
2. The creation form drops its blank option and defaults to the project you are standing in.
3. A migration assigns existing project-less tasks. ⚠️ **Assign, do not delete.** If exactly one
   project exists, use it; otherwise leave them null and let Overview list them as needing a home —
   a migration that guesses an owner for somebody's work is worse than one that asks.

⛔ The column stays nullable (see the constraint above). `on delete set null` means a deleted project
still nulls its tasks, so the UI must survive a null `projectId` even after D-U2. **Prefer archiving
a project to deleting one** — `projects.archived_at` already exists.

### Phase 3 — Overview

The only phase with substantial daemon work.

- New `cost.byProject`: aggregate `runs` by `project_id` — tokens by class, run count, outcome mix.
  ⚠️ Cache reads are cumulative re-reads, not context; the display leads with **spend** and **current
  context**, never a cumulative counter dressed as a size (see `docs/cost-model.md` §5 and
  `renderForHuman` in `stream.ts`).
- **Attention**: tasks in `awaiting_human`, failed runs, blocked work, across all projects, each
  linking into its project. ⭐ This is the section that would have surfaced the 2026-08-26 task that
  finished, failed to land, and sat with its work uncommitted in a pooled worktree.
- **Fleet and quota health**: worker quota with its age, reserve verdicts, doctor warnings.
- **Controller** (D-U3): the consult ledger and the hourly cap, as a section here.

⚠️ Consults are **not project-scoped** in the daemon. Overview is the honest home for them precisely
because there is nothing to scope them by; do not invent a project column for them to make the UI
tidier.

### Phase 4 — stamp sessions with their project

`spawnSession` takes a `projectId` and records it; the scheduler passes the task's project when it
dispatches. Fixes the empty Sessions tab, and makes per-project *live* cost possible.

Worth doing regardless of the UI: a session that cannot say what project it belongs to is a gap in
the model, not just in the display.

## Risks

- **`App.tsx` is the only file every view goes through.** Phase 1 touches it once, deliberately, and
  everything else is additive.
- **The UI suite asserts on nav text and layout.** Update it with each phase; a suite that is red for
  three phases teaches everyone to ignore it.
- ⛔ **Do not let the overhaul quietly change what a number means.** The quota cell, the context
  figure and the spend figure each earned their current wording by being wrong once.

## Not in scope

- Whether the fleet strip stays on every screen. The owner deferred this explicitly on 2026-08-26.
- A live-session list in Overview (excluded in D-U4).
- Any change to what the scheduler does. This is a navigation and presentation overhaul.
