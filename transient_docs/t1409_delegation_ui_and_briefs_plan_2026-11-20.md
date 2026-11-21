# t1409 — Delegation UX, Composer Cleanup, Model Sorting, Plan & Execute Removal, and Subtask Brief Alarms

**Date:** 2026-11-20  
**Branch:** `warmstart/t1409-given-that-we-have-delegation-mode-plan`  
**Strategy:** Two-wave delegation to `[tier:low]` workers (`gemini-4-hydrogen · high`), respecting `ROOT_MANDATE.maxChildren = 5` and keeping Wave 1 file ownership strictly disjoint.

---

## 1. Requirements Summary

| # | Request | Piece | Wave |
|---|---|---|---|
| (1) + (2a) | Select Delegate ON/OFF + allowed delegation tiers/models in the **New Task** menu, using a consistent split-pill toggle UI (`[ON/OFF \| Delegate ▼]`) in both New Task and Thread composers. | **P4** | Wave 1 |
| (2b) | In the **thread composer box**, show the current model and effort — not a separate tier pill (e.g. `High`) beside them. Clicking the Model pill lets the user choose Auto tiers, tags, or models. | **P3** | Wave 1 |
| (3) | Remove **Plan & Execute** mode (code, composer, prompts, tests, `README.md`, `docs/*.md`). Website (`warmstart.dev`) lives off-repo per `HANDOFF.md` and will be flagged for the operator. | **P5** | Wave 2 |
| (4) | Sort Antigravity Gemini models cleanly so Gemini 4 models (listed + discovered) are grouped together rather than scattered across the list. | **P1** | Wave 1 |
| (5) | Collapse detailed per-turn timeline history (`timeline · runs, compactions & reviews`) under a closed-by-default `▶` disclosure in the right status sidebar. | **P2** | Wave 1 |
| (6) | Add **subtask brief** and **alarmed brief** support via MCP + `warmstart-agent` CLI: on-demand concise progress summary of all subtasks, periodic alarm (30m default), and early brief when a subtask completes while others are still running so orchestrator conversations can launch waves early. | **P6** | Wave 1 |

---

## 2. Detailed Piece Specifications

### Wave 1 (5 parallel `[tier:low]` pieces — zero logic collisions)

#### P1 — Adapter-Neutral Model Sorting (Item 4)
- **Root cause (measured):** `costmodels/google.antigravity.2026-08.json` interleaves `gemini-4-*`, `claude-*-5-5`, `gemini-3.8-flash`, and `gpt-oss-120b`, and `CostModel.offeredModelIds()` (`src/daemon/costmodel.ts:461`) appends `discovered()` (`gemini-4-neon`, `gemini-4-carbon`, `gemini-pro-orchestrator`) at the end.
- **Design:**
  - Add `src/shared/modelsort.ts` (`sortModelIds(ids, preferredFamilyOrder?)`) + `src/shared/modelsort.test.ts`:
    - Groups models by family prefix (`gemini`, `claude`, `gpt`, `muse`, etc.), preserving the order in which families first appear in the input/cost-model list.
    - Within a family, parses semantic/numeric version (`gemini-4-*` → `4.0`, `gemini-3.8-*` → `3.8`, `claude-opus-5-5` → `5.5`, `gpt-6.1-sol` → `6.1`) and sorts **versioned models before versionless** (`gemini-pro-orchestrator`), **version descending** (`4` before `3.8`), and within the same `(family, major, minor)` sorts deterministically by variant name (`argon`, `carbon`, `hydrogen`, `neon` for Gemini 4; preserving `opus` > `sonnet` > `haiku` or natural name order for Claude).
  - Apply `sortModelIds` in `CostModel.offeredModelIds()` (`src/daemon/costmodel.ts`) and `knownModelIds()` (`src/daemon/workers.ts`).
  - Reorder `models` in `costmodels/google.antigravity.2026-08.json` cleanly (Gemini 4 group → Gemini 3.8 → Claude 5.5 → GPT-OSS).
  - Add regression assertions in `src/daemon/modeldiscovery.test.ts` verifying listed + discovered `gemini-4-*` models are grouped contiguously ahead of `gemini-3.8-flash` and `claude-*`.
  - Update `docs/adapters.md` briefly if needed.

#### P2 — Collapsible Right-Sidebar Timeline Disclosure (Item 5)
- **Design:**
  - Extract `src/renderer/src/components/thread/SideTimeline.tsx` wrapping the timeline list in a closed-by-default `<details className="detail-side-box side-timeline-disclosure">`.
  - `<summary className="side-label side-timeline-summary">` renders a `▶` caret (rotates to `▼` when `[open]`) followed by `timeline · runs, compactions & reviews` and the item count (`({count})`).
  - Wire `<SideTimeline>` into `src/renderer/src/components/TaskThread.tsx` (lines ~1380–1456). When `LedgerPeek`'s `onJumpToRun` is clicked, set `timelineDetailsRef.open = true` before scrolling so jumping to runs still reveals them.
  - Add `.side-timeline-disclosure` / `.side-timeline-summary` CSS right after `.detail-side-box` in `src/renderer/src/styles/app.css`.
  - Add unit tests in `src/renderer/src/components/thread/SideTimeline.test.tsx` proving closed-by-default rendering and expand-on-click behavior.

#### P3 — Thread Composer Model/Effort Display & Integrated Tier Selection (Item 2b)
- **Root cause (measured):** In `src/renderer/src/components/thread/Reassign.tsx` (`AssignPills`), when a task uses Auto Model with a tier tag (e.g. `High`), `AssignPills` renders `[Worker] [Gemini 4 Neon] [High] [High]` — a separate `TagsPill` showing the tier `High` right beside the current model and `High` effort — and disables the Model pill whenever `workerId` is Auto.
- **Design:**
  - Remove the separate `TagsPill` from `AssignPills` (`src/renderer/src/components/thread/Reassign.tsx`).
  - Replace the Model `<PillSelect>` in `AssignPills` with a `<Pill>` dropdown (always enabled unless `disabled` is true — NOT locked when `workerId` is empty/Auto) containing:
    1. **Auto Model** section: `Auto Model (Any)` plus one selectable item per available capability tier (`Auto Model · High`, `Auto Model · Med`, `Auto Model · Low`, plus any custom tiers), and compact checkboxes for any non-tier feature tags (e.g. `ZDR`) if present on the fleet/account.
    2. **Account default** option (when a worker is pinned).
    3. **Models** section: concrete models for the pinned worker, or (when Worker is Auto) concrete models across enabled workers labeled with their worker so clicking one selects that worker + model atomically.
  - Closed pills under the composer show `[Worker] [Current Model] [Current Effort]` when untouched after a run (never a bare `High` tier pill). Before a run or after changing to Auto Model, the Model pill itself reads `Auto Model` or `Auto Model · High` (clearly prefixed).
  - Add scoped CSS right after `.compose-assign` in `src/renderer/src/styles/app.css`.
  - Update and expand `src/renderer/src/components/thread/Reassign.test.tsx` to cover: no standalone tier pill, current model/effort display, selecting a tier via the Model menu (both pinned and Auto worker), and selecting a concrete model from Auto worker.

#### P4 — Split-Pill Delegation Toggle UI & New Task Delegation Controls (Items 1 & 2a)
- **Design:**
  - Create a reusable split-pill component `DelegateSplitPill` in `src/renderer/src/components/thread/DelegatePill.tsx`:
    ```
    +---------+------------+
    | ON/OFF  | Delegate ▼ |
    +---------+------------+
    ```
    - Visually one unified split pill (`.split-pill`): left segment is the `<button aria-pressed={on} aria-label="Toggle delegation">` reading `ON` or `OFF` (accented when ON, muted when OFF); right segment is a `<Pill>` reading `Delegate ▼` (or concise filter summary like `Delegate (Low) ▼` / `Delegate (2 models) ▼` when restricted) opening the portalled popover with **Allowed tiers** and **Allowed models** checkboxes (showing configured tier badges beside each model).
  - Update `DelegatePill` (used in `TaskThread.tsx`, keeping its existing props unchanged!) to render `DelegateSplitPill`.
  - Add delegation policy support to `task.create`:
    - `TaskCreateParams` (`src/shared/protocol.ts`), `CreateTaskInput` (`src/daemon/tasks.ts`), and `'task.create'` (`src/daemon/api/tasks.ts`): accept optional `delegationPolicy?: { on?: boolean; allowedTiers?: string[]; allowedModels?: Array<{ model: string; effort?: string | null }> }`.
    - When `delegationPolicy` is supplied: if `on === false`, strip `'spawn_tasks'` from `mandate.allowed`; if `on !== false`, keep `'spawn_tasks'`, normalize `allowedTiers` (`cleanTags(allowedTiers.map(asTierTag))`) and `allowedModels`, and mint `delegationToken` when restrictions or explicit `on: true` are set.
  - Wire `DelegateSplitPill` into `src/renderer/src/components/NewTask.tsx` for `Single Task` and `Conversation` kinds (not `Plan&Split` or `Debate`), persisted in `ComposerPrefs` (`src/renderer/src/lib/composerprefs.ts`: `delegation?: { on: boolean; allowedTiers: string[]; allowedModels: string[] }`, defaulting to `on: true` to preserve existing `ROOT_MANDATE` default while allowing toggling off or restricting models/tiers before filing). Pass `delegationPolicy` on `task.create` when filing.
  - Add `.split-pill` CSS around `.delegation-picker` (~line 10047) in `src/renderer/src/styles/app.css`.
  - Add unit tests in `src/renderer/src/components/thread/DelegatePill.test.tsx` and daemon tests in `src/daemon/delegation.test.ts` (for `task.create` with `delegationPolicy`).

#### P6 — Subtask Progress Brief & Alarmed Briefs (Item 6)
- **Invariants enforced (`AGENTS.md`):**
  - Zero-token scheduler loop: periodic alarm checks run inside `tick()` with zero LLM calls unless an alarm actually fires for a task with open subtasks.
  - Compare-and-set before wake: update `last_brief_at`, `next_brief_at`, and `reported_settled_json` atomically before posting/waking so simultaneous ticks or settling children never double-wake.
  - Never wake a `paused_user` or terminal parent task; auto-disable alarms once all subtasks have settled; avoid duplicate wakes when the last piece settles (`reportDelegationIfSettled` already posts `delegation.settled`).
- **Schema (`src/daemon/db.ts`, Migration 97):**
  - New table `delegation_brief_alarms (task_id primary key, enabled, interval_minutes, early_on_settle, last_brief_at, next_brief_at, reported_settled_json, created_at, updated_at)`.
- **Daemon module (`src/daemon/subtaskbrief.ts` + `src/daemon/subtaskbrief.test.ts`):**
  - `buildSubtaskBrief(parentTaskId, opts?)`: formats a concise one-line-per-subtask summary of all non-deleted child tasks (`parent_task_id = parentTaskId`, ordered by `seq`) showing `t<seq>`, status (`completed`, `running · Nm`, `ready / waiting`, `blocked on t...`, `awaiting_human`, `paused_quota`, `failed`, `cancelled`), worker/model when running, branch + completion summary when completed, hold reason when held/failed, plus current alarm status.
  - `setSubtaskBriefAlarm(parentTaskId, opts)`: enables/updates/disables the alarm (`enabled`, `intervalMinutes` default `30`, clamped `5..1440`, `earlyOnSettle` default `true`). Seeds `reported_settled_json` with already-settled child IDs on arming so old completions don't trigger spurious wakes.
  - `onSubtaskSettledForBrief(childId, wake)`: called from `onTaskSettled` (`src/daemon/scheduler.ts`). If the child's parent has an active alarm with `early_on_settle = 1`:
    - If NO open subtasks remain on the parent: disable the alarm (`enabled = 0`); if the child belongs to a `delegation` row, let `reportDelegationIfSettled` deliver the final `delegation.settled` wake (no duplicate wake); otherwise post one final brief and wake.
    - If ≥1 open subtask still remains and `childId` is not yet in `reported_settled_json`: atomically record settled IDs + bump `last_brief_at` / `next_brief_at`, add system message (`event: 'delegation.brief'`), and wake via `wake.deliver` / `wake.requeue`.
  - `checkSubtaskBriefAlarms(wake)`: called from `tick()` (`src/daemon/scheduler.ts`). Atomically claims due alarms (`enabled = 1 and next_brief_at <= now`), auto-disables if parent is terminal or has zero open subtasks, skips waking while `paused_user` (advancing `next_brief_at`), otherwise posts `delegation.brief` and wakes.
- **RPC, MCP & `warmstart-agent` CLI:**
  - `MessageEvent` (`src/shared/tasks.ts`): add `'delegation.brief'`.
  - `src/daemon/prompt.ts`: include `'delegation.brief'` in `DELEGATION_EVENTS` and render its headline + detail in `messageText`.
  - `src/daemon/delegation.ts`: mention `subtask_brief` and `subtask_brief_alarm` in `delegationClause` for conversations (using MCP vs `warmstart-agent` syntax via `agentCli`).
  - `src/shared/protocol.ts`: add `'agent.subtaskBrief'` and `'agent.subtaskBriefAlarm'`.
  - `src/daemon/api/agent.ts`: implement both handlers.
  - `src/daemon/agentcli.ts`: add both to `AGENT_METHODS`.
  - `src/daemon/remote/policy.ts`: add both as `'deny'`.
  - `src/mcp/workertools.ts`: register `subtask_brief` and `subtask_brief_alarm` (automatically exposed to BOTH MCP and `warmstart-agent` CLI!).
  - Update `src/agentcli/args.test.ts`, `docs/mcp.md`, and `docs/data-model.md`.

---

### Wave 2 (filed after Wave 1 merges — touches shared files cleanly)

#### P5 — Remove Plan & Execute Mode & Update Markdown Docs (Item 3)
- Remove `'execute'` from `ComposerKind` (`src/renderer/src/lib/composerprefs.ts`, falling back legacy saved `'execute'` to `'task'`), remove `PLAN_EXECUTE_PIECES`, remove `Plan&Execute` from `NewTask.tsx` (`KIND_OPTIONS`, `KIND_SHORT`, `WorkflowShape`, `isExecute`, submit branches), remove `src/renderer/src/lib/executornotice.ts` + `executornotice.test.ts`.
- Remove `PLAN_EXECUTE_CHILDREN`, `planModeOf`, `isPlanExecute`, and `'plan-execute'` from `src/shared/tasks.ts`, `src/daemon/split.ts`, `src/daemon/prompt.ts` (`handoffInstruction`), `src/daemon/tasks.ts`, `src/daemon/api/agent.ts`, `src/mcp/workertools.ts`, `src/renderer/src/components/TaskTypeIcon.tsx`, `src/renderer/src/components/Questions.tsx`, `src/renderer/src/lib/taskview.tsx`. Enforce `maxChildren >= 2` on `task.plan` while existing historical `kind = 'plan'` DB rows continue to load safely as `Plan & Split`.
- Update affected tests (`src/shared/tasks.test.ts`, `src/daemon/split.test.ts`, `src/renderer/src/lib/composerprefs.test.ts`, `src/renderer/src/lib/taskview.test.ts`, `src/renderer/src/components/TaskTypeIcon.test.tsx`, `test/ui.test.mjs`).
- Update `README.md` ("Four ways to file a task") and all `docs/*.md` pages (`getting-started.md`, `data-model.md`, `landing.md`, `mcp.md`, `routing.md`, `ui.md`, `architecture.md`, `glossary.md`) so `src/daemon/docs.test.ts` passes cleanly.
- **Website (`warmstart.dev`):** Lives off-repo (`HANDOFF.md`), not present in this workspace; note clearly for the operator so they can attach its directory if they want us to edit it too.
