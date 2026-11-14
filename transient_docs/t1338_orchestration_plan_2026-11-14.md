# `t1338` Orchestration Investigation & Implementation Plan (2026-11-14)

## 1. Executive Summary

Task **`t1338`** (*"What is the next step?"*, project `taxreturn4all`, `kind: 'conversation'`, id `0e8bd42e-4f19-4c76-8573-0e06a29d792c`) ran across **16 runs** between `2026-11-11 21:06` and `2026-11-14 08:54` on worker `AgyFirst` (`agy` adapter, Antigravity conversation `ba43a97f-a030-4fde-9c4a-ba53c177f1d5`, 718 trajectory steps), orchestrating Phase 4 (New York TY2025 pilot) across 4 delegated waves (`t1340`–`t1343`, `t1345`, `t1347`, `t1348`).

Instead of a smooth multi-wave orchestration flow, the operator experienced:
1. **Six unexplained `paused_quota` interruptions after clean turns** (Runs #6, #8, #9, #12, #13, #14).
2. **Missing wave summaries and closing explanations** whenever a turn ended via `warmstart-agent ask_human`, `warmstart-agent task_split`, or a post-turn `paused_quota` preemption — even though the agent actually wrote detailed 20–35 line review and merge summaries in the underlying Antigravity trajectory (`ba43a97f.db` steps 246, 314, 391, 507, 577, 637).
3. **A stalled post-Wave-4 resume** (Runs #14 and #15), where after `t1348` settled and was merged in Run #13, the resumed conversation emitted only `"No subagents or background tasks were running at the time of the restart. Branch warmstart/t1338-what-is-the-next-step (304c9ecc1) remains clean, verified, and ready to land."` with no Wave 4 summary or next-step prompt.
4. **Two landing failures (`git rebase main` self-conflicts + `delegationLandingBlocker` refusal after squash)** followed by a contradictory final state at `08:54:29 AM` (`M#48` wall of repeated text + `M#49` *"Finished, not landed: the agent made no commits, so there is nothing to land"*) 24 seconds after `M#46` had already landed `22457b6e` onto `main`.
5. **`When done` shutdown blocked by `awaiting_human`** (fixed in this commit in [`src/main/poweraction.ts`](../src/main/poweraction.ts)).

---

## 2. Measured Timeline of `t1338`

| Run # | Run ID | Model | Time (local) | Outcome | Trajectory Steps | What happened in `ba43a97f.db` vs. what appeared in `task_messages` |
|---:|---|---|---|---|---|---|
| 1 | `d0795ef6` | `claude-opus-5-5` | 11/11 21:06–21:08 | `completed` | 0–19 | Inspected repo, called `warmstart-agent ask_human` with 3 options (`Q#1`). `onStreamResult` returned early at `helperEndedLastRun`, so no assistant summary message was posted before `Q#1`. |
| 2 | `8cb969fc` | `claude-opus-5-5` | 11/11 21:27–21:33 | `completed` | 20–78 | Designed NY TY2025 pilot plan, called `warmstart-agent task_split` (`t1340`–`t1343`, Wave 1). Waiting on delegation approval (`A#1`). |
| 3 | `85ed6fc1` | `claude-opus-5-5` | 11/12 06:16–06:21 | `failed` | 79–111 | Wave 1 settled. Agent began merging `t1340`–`t1343`, hit `HTTP 400 Invalid request: maximum iterations exceeded` (step 111), parked at `paused_user` (`M#9`). |
| 4 | `e4055aa5` | `claude-opus-5-5` | 11/12 07:10–07:22 | `completed` | 112–212 | Resolved `HANDOFF.md` conflicts across `t1340`–`t1343`, ran pytest (704 passed), posted full Wave 1 summary (`M#11`). |
| 5 | `460d50c6` | `claude-opus-5-5` | 11/12 10:47 | `preempted` | 213–215 | Hit genuine Claude/GPT 7d pool exhaustion at step 215 (`Individual quota reached... Resets in 8h56m7s`). Parked at `paused_quota` (`M#13`). |
| 6 | `db4922b3` | `gemini-4-argon` | 11/12 19:21–19:26 | `completed` → `paused_quota` | 216–246 | Operator switched task to `gemini-4-argon`. Agent committed Wave 2 scaffolding (`d64cb45`) and ran `warmstart-agent task_split` (`t1345`, auto-approved via token). **Step 246 summary was dropped** (`helperEndedLastRun`), and `agy 1.5.7` echoed step 215's stale error on exit, triggering a false `paused_quota` (`M#16`). |
| 7 | `6a30d25f` | `gemini-4-argon` | 11/12 19:41–19:47 | `completed` | 247–314 | Wave 2 (`t1345`) settled. Agent fast-forward merged `t1345`, ran checks, called `warmstart-agent ask_human` (`Q#2`), and **wrote a 20-line Wave 2 Review & Merge Summary in step 314 — which was silently dropped** because `deferQuestion` had already ended the run. |
| 8 | `278a2273` | `gemini-4-argon` | 11/12 20:06–20:07 | `preempted` | 315–324 | Operator chose *"Land Wave 1 + Wave 2 onto main first"*. Agent ran `warmstart-agent land_work` (step 322), which failed on `git rebase main` (`HANDOFF.md` conflict). Turn ended with step 215's stale error → false `paused_quota` (`M#20`). |
| 9 | `b97010df` | `gemini-4-argon` | 11/12 20:51–21:08 | `completed` → `paused_quota` | 325–391 | Operator clicked **Resolve & retry** (`M#21`). Agent rebased and squashed (`40777eb8e`) as instructed by `resolveConflictOnTask`, then ran `land_work` (step 340) which **failed `delegationLandingBlocker`** (`the work of t1340, t1342, t1343, t1345 is not in this branch` because squashing replaced their commit SHAs!). Agent restored unsquashed `1115d39`, delegated Wave 3 (`t1347`), and wrote a detailed explanation in step 391 — **dropped** (`helperEndedLastRun`) + false `paused_quota` (`M#24`). |
| 10 | `02dbce1d` | `gemini-4-argon` | 11/13 21:09–21:18 | `completed` | 392–507 | Wave 3 (`t1347`) settled. Agent merged `t1347` (`38dc0ef2b`), verified 96/96 tests, called `warmstart-agent ask_human` (`Q#3`), and **wrote a 25-line Wave 3 Review & Merge Summary in step 507 — silently dropped** (`helperEndedLastRun`). |
| 11 | `b00a988b` | `gemini-4-argon` | 11/13 21:33–21:34 | `failed` | 508–519 | Operator answered `Q#3` (*"Proceed to Wave 4"*). Antigravity aborted step 519 (`Error: User aborted request.`). Parked at `paused_user` (`M#31`). |
| 12 | `07bccd5e` | `gemini-4-argon` | 11/13 21:44–21:54 | `completed` → `paused_quota` | 520–577 | Resumed, delegated Wave 4 (`t1348`, auto-approved). **Step 577 summary dropped** (`helperEndedLastRun`) + false `paused_quota` (`M#35`). |
| 13 | `26540985` | `gemini-4-argon` | 11/13 22:04–22:13 | `failed` → `paused_quota` | 578–637 | Wave 4 (`t1348`) settled (`M#36`, marked `delivered_at` when Run #13 started). Agent merged `t1348` (`304c9ecc1`), ran full suite (257 passed), and **wrote a 35-line Wave 4 Review & Merge Summary in step 637**. Because `orchestratord` had not yet been restarted after `t1349`, step 215's stale error triggered `restForQuota` (`M#37`), which **discarded step 637's entire Wave 4 summary**. |
| 14 | `155b89e6` | `gemini-4-argon` | 11/14 00:40–00:41 | `failed` → `paused_quota` | 638–642 | Resumed from `paused_quota`. Because `M#36` was already marked `delivered_at`, `promptFor` sent **only bare conversation boilerplate**; Antigravity injected `[Notice] All your subagents and background tasks have been stopped due to server restart...`. Agent replied to the restart notice (step 640), then hit stale error (`M#39`). |
| 15 | `a79c3abb` | `gemini-4-argon` | 11/14 01:09–01:10 | `completed` | 643–645 | Daemon restarted at `01:08` (`t1349` active). Resumed from `paused_quota` with the same empty `promptFor` preamble + Antigravity restart notice. Agent replied only: *"No subagents or background tasks were running at the time of the restart. Branch warmstart/t1338-what-is-the-next-step (304c9ecc1) remains clean, verified, and ready to land."* (`M#42`), leaving the task in `awaiting_human` with no Wave 4 summary or next step. |
| 16 | `00da1816` | `gemini-4-argon` | 11/14 08:27–08:54 | `completed` | 646–717 | Operator clicked **Land**, which failed on `git rebase main` (`M#44`), then clicked **Resolve & retry** (`M#45`). Agent rebased, squashed (`22457b6e9`), hit `delegationLandingBlocker` (step 697) and `--set-aside` CLI string-coercion bug (step 709), bypassed via Node HTTP `--set-aside` (step 711) which **landed `22457b6e` onto `main` at `08:54:04` (`M#46`)** and moved the conversation to `warmstart/t1338.2-what-is-the-next-step`. Obeying `M#45` (*"report the task complete again"*), the agent then output `TASK COMPLETE:` (step 717), which evaluated `decideFinish` on the new empty `.2` branch and parked at `awaiting_human` (`M#49`: *"the agent made no commits, so there is nothing to land"*). |

---

## 3. Root-Cause Analysis

### Root Cause 1: `awaiting_human` blocked `When done` shutdown (`src/main/poweraction.ts`)
- **Mechanism**: [`hasActiveWork`](../src/main/poweraction.ts#L17-L22) excluded `awaiting_human` from the active task status list, but checked:
  ```ts
  sessions.some((session) =>
    ['work', 'consult', 'review'].includes(session.purpose) && !sessionEnded(session.state))
  ```
- When a task enters `awaiting_human` (`endConversationTurn`, `completeTask`, `parkForHuman`), Warmstart intentionally keeps its `work` session open (`state: 'live'`, `purpose: 'work'`) so a human reply reuses the warm prefix (`0.1×` vs `2.0×`). [`toSession`](../src/daemon/sessions.ts#L443) marks that session `idle: !hasOpenRun(r.id)` (`true`), while `state` in SQLite remains `'live'`.
- Because `hasActiveWork` did not ignore warm idle `work` sessions (`session.purpose === 'work' && (session.state === 'idle' || Boolean(session.idle))`), session `6839ff69` kept `hasActiveWork` returning `true` indefinitely.
- **Status**: **Fixed in this commit** in [`src/main/poweraction.ts`](../src/main/poweraction.ts#L16-L28) and tested in [`src/main/poweraction.test.ts`](../src/main/poweraction.test.ts#L9-L24). Also accounts for `Boolean(task.landing)` so an active manual conversation landing (`task.landConversation`) is not interrupted by shutdown.

### Root Cause 2: Closing prose and wave summaries are dropped when `warmstart-agent` ends a run or when a completed turn hits `restForQuota`
- **Mechanism A (`warmstart-agent ask_human` / `await_human` / `task_split`)**:
  - In MCP-less stream adapters (`agy`), the agent invokes `warmstart-agent ask_human` or `warmstart-agent task_split` as a shell command during its turn, and then writes its human-facing summary in the final assistant message of that turn (`ba43a97f.db` steps 246, 314, 391, 507, 577).
  - Inside the CLI call, `deferQuestion` ([`src/daemon/scheduler.ts`](../src/daemon/scheduler.ts#L5047)) or `endPlannerForSplit` ([`src/daemon/scheduler.ts`](../src/daemon/scheduler.ts#L4978)) immediately closes the `runs` row (`endRun(..., 'completed')`).
  - When the CLI process subsequently emits its `result` record (`result.text` containing the agent's summary), [`onStreamResult`](../src/daemon/turnend.ts#L396) hits:
    ```ts
    if (mcpLess && helperEndedLastRun(session.id)) return
    ```
    and returns without ever recording `result.text` / `closingReply` into `task_messages`!
- **Mechanism B (`restForQuota` after assistant prose)**:
  - In Run #13 (`26540985`), the agent finished merging `t1348` and wrote the 35-line Wave 4 Review & Merge Summary (step 637), which streamed into `activity` (`kind: 'text'`).
  - When the turn ended with `result.isError: true`, [`onStreamResult`](../src/daemon/turnend.ts#L455-L459) called `endUnfinishedRun(..., 'failed')` → `restForQuota` ([`src/daemon/scheduler.ts`](../src/daemon/scheduler.ts#L4745-L4846)), which posted `M#37` (`Waiting for quota...`) without flushing the assistant's closing prose from the run into `task_messages`.

### Root Cause 3: Warm resume after `paused_quota` sends a bare preamble when prior messages were already marked `delivered_at`
- **Mechanism**:
  - In [`promptFor`](../src/daemon/prompt.ts#L980), `markMessagesDelivered(task.id, promptSentAt)` marks all undelivered `task_messages` (such as `M#36`, the `delegation.settled` notice for `t1348`) as delivered **at the moment Run #13's prompt is constructed**.
  - When Run #13 later ended in `paused_quota` without recording a completion or reply, `t1338` was re-dispatched in Run #14 (`155b89e6`) and Run #15 (`a79c3abb`) on the warm conversation (`resumed: true`, `compacted: false`).
  - In [`promptFor`](../src/daemon/prompt.ts#L800-L960):
    - `holdsPrompt` is `true` (`resumed && !compacted`)
    - `holdsContract` is `true`
    - `outstanding` (`undeliveredMessages(task.id)`) is `[]` (because `M#36` was already marked `delivered_at` in Run #13!)
    - `followUp` (`holdsContract && outstanding.length > 0`) is `false`
    - `recovering` (`!holdsPrompt && priorRuns.length > 0`) is `false`
  - As a result, `requestParts` is `[]` and `recoveryParts` is `[]`! `promptFor` sent **only the 2-paragraph conversation preamble** (`worktreeArrivalNotice` + `conversationInstruction` + `delegationClause`) with no task prompt, no message, and no recovery instruction.
  - Because `agy` also injected `[Notice] All your subagents and background tasks have been stopped due to server restart...` into the resumed process, the model saw its own step 637 Wave 4 summary already in the transcript followed only by the restart notice, and answered the restart notice instead of summarizing or advancing the task.

### Root Cause 4: `git rebase <base>` self-conflicts on merged delegated branches, `delegationLandingBlocker` rejects squashed branches, and `--set-aside` fails CLI number-array parsing
- **Mechanism A (`mergeLocal.land` in [`src/daemon/landing.ts`](../src/daemon/landing.ts#L893))**:
  - When a coordinator merges multiple parallel child branches (`t1340`–`t1343`) that touched the same file (`HANDOFF.md`) and resolves the conflicts in merge commits (`5a5187631`, `bfd33b4d8`, `b33733073`), the branch history has diamond merges.
  - Even when `main` (`ea5bc1a5e`) has **not moved** (`isAncestorOf(cwd, base, branch)` is `true`), `mergeLocal.land` unconditionally runs `git rebase main` without `--rebase-merges`.
  - Plain `git rebase` drops merge commits and replays each child's commit linearly onto the others without the merge commits' conflict resolutions, causing the branch to conflict with itself!
- **Mechanism B (`resolveConflictOnTask` vs. `delegationLandingBlocker`)**:
  - [`resolveConflictOnTask`](../src/daemon/resolutions.ts#L129-L130) instructs the agent: *"Once the rebase is clean, if two or more commits ahead of `main` all belong to this task, squash them into one coherent commit"*.
  - When the coordinator squashes, the original child commit SHAs (`t1340`, `t1342`, `t1343`, `t1345`, `t1347`, `t1348`) are no longer git ancestors (`isAncestorOf`) of `HEAD`.
  - [`delegationLandingBlocker`](../src/daemon/delegation.ts#L384-L429) checks only `isAncestorOf(cwd, childTip, parentHead)` (or `commitsOnlyOn(cwd, target, childBranch).length === 0`), so it falsely blocks landing with `Nothing was landed: the work of t1340, ... is not in this branch` even when every file change from those children is present in the squashed commit!
- **Mechanism C (`warmstart-agent land_work --set-aside <seq>` in [`src/agentcli/args.ts`](../src/agentcli/args.ts#L207-L209))**:
  - `land_work`'s schema declares `setAside: z.array(z.number().int().positive()).optional()`.
  - In [`parseFlagArgv`](../src/agentcli/args.ts#L207-L209), `f.kind === 'list'` pushes raw strings (`list.push(value)`) without coercing numeric elements when the Zod array item type is `number`, causing `warmstart-agent land_work --set-aside 1340` to fail schema validation (`expected number, received string`).

### Root Cause 5: `resolveConflictOnTask` sends work-task completion instructions to conversations, and `TASK COMPLETE:` after `land_work` triggers a false `"the agent made no commits"` hold with concatenated run prose
- **Mechanism**:
  - [`resolveConflictOnTask`](../src/daemon/resolutions.ts#L133) (and `resolveChecksOnTask`, `resolveCommitOnTask`, `resolveTrunkMovedOnTask`) always instructs the agent to *"report the task complete again"*, even when `isOpenConversation(task)` is `true` (where landing uses `warmstart-agent land_work` or the **Land** button, not `TASK COMPLETE:`).
  - In Run #16, the agent ran `warmstart-agent land_work` (step 711), which succeeded (`M#46`) and rotated the conversation onto a fresh empty branch `warmstart/t1338.2-what-is-the-next-step` ([`src/daemon/conversationland.ts`](../src/daemon/conversationland.ts#L293-L309)).
  - Then, following `M#45`'s instruction, the agent emitted `TASK COMPLETE:` at the end of the same turn (step 717).
  - [`onStreamResult`](../src/daemon/turnend.ts#L424) saw `TASK COMPLETE:` and called `completeTask` ([`src/daemon/scheduler.ts`](../src/daemon/scheduler.ts#L4139)), which ran `decideFinish` against `warmstart/t1338.2-what-is-the-next-step` (0 commits ahead of `main` because `land_work` had just landed the commits 24 seconds earlier!) and parked the task with `M#49`: *"Finished, not landed: the agent made no commits, so there is nothing to land"*.
  - Simultaneously, [`closingReply(run.id)`](../src/daemon/activity.ts#L186-L195) concatenated **every** assistant `text` line from the entire 27-minute run (`rows.join('\n\n')`), producing `M#48`'s 5-paragraph wall of interim tool-call narration.

---

## 4. Implementation Plan

### Phase 1: Preserve Assistant Summaries Across Helper-Ended and Preempted Turns
**Files**: [`src/daemon/turnend.ts`](../src/daemon/turnend.ts), [`src/daemon/scheduler.ts`](../src/daemon/scheduler.ts), [`src/daemon/activity.ts`](../src/daemon/activity.ts)

1. **Flush closing prose when `helperEndedLastRun(session.id)` is true in `onStreamResult` ([`src/daemon/turnend.ts`](../src/daemon/turnend.ts#L396))**:
   - Before returning at `if (mcpLess && helperEndedLastRun(session.id))`, extract the final assistant prose (`result.text?.trim() || lastRunClosingText(session.id)`), strip any trailing control lines, and if non-empty and not already recorded as an `'agent'` message on the task during that run, append it via `addTaskMessage(task.id, 'agent', text)` (ordered before or alongside the pending question/delegation card so the operator sees the wave review summary in the thread).
2. **Record partial/closing assistant prose when a turn is parked by `restForQuota` ([`src/daemon/scheduler.ts`](../src/daemon/scheduler.ts#L4745-L4846))**:
   - In `onStreamResult` / `restForQuota`, if the run produced substantive assistant prose (`result.text` or `closingReply(run.id)`) before the terminal quota error, record that assistant message in `task_messages` before posting the `Waiting for quota` system message.
3. **Scope `closingReply(runId)` ([`src/daemon/activity.ts`](../src/daemon/activity.ts#L186-L195)) to the final assistant turn segment**:
   - Instead of joining every `kind = 'text'` row across the entire run (which concatenates interim narration before tool calls across 20+ minutes), select the `text` blocks emitted **after the last `tool` / `thinking` event** in that run (falling back to the last non-empty `text` row if none).

### Phase 2: Never Send an Empty Warm-Resume Prompt After an Interrupted Run
**Files**: [`src/daemon/prompt.ts`](../src/daemon/prompt.ts), [`src/daemon/scheduler.ts`](../src/daemon/scheduler.ts)

1. **Detect interrupted prior runs on warm resume in [`promptFor`](../src/daemon/prompt.ts#L859-L960)**:
   - Track whether the most recent prior run on the task ended without completing its turn (`lastRun.outcome === 'failed' || lastRun.outcome === 'preempted'`, or ended in `paused_quota` / `paused_user` after consuming messages).
   - If `holdsPrompt` is `true` and `outstanding.length === 0` (because messages were marked `delivered_at` at the start of the interrupted run), include an explicit **interrupted-turn continuation block** in `recoveryParts`:
     - Re-include the messages that were first delivered in that interrupted run (or state what the interrupted run was doing), and
     - Explicitly instruct the agent: *"Your previous run was interrupted before its closing reply was recorded in the task thread. Check the current git state, post your summary of what was completed, and either continue or hand back to the person."*
2. **Test in `src/daemon/prompt.test.ts`**:
   - Verify that when a conversation or work task has `delegation.settled` delivered in Run $N$, and Run $N$ ends with `preempted` / `failed`, Run $N+1$ on the same warm session (`resumed: true`) receives a non-empty continuation prompt referencing the settled delegation and asking for the summary.

### Phase 3: Fix Delegated-Branch Rebase Self-Conflicts, Post-Squash `delegationLandingBlocker`, and `--set-aside` CLI Coercion
**Files**: [`src/daemon/landing.ts`](../src/daemon/landing.ts), [`src/daemon/delegation.ts`](../src/daemon/delegation.ts), [`src/agentcli/args.ts`](../src/agentcli/args.ts)

1. **Skip redundant `git rebase <base>` when `<base>` is already an ancestor of `<branch>`, and preserve merges with `--rebase-merges` ([`src/daemon/landing.ts`](../src/daemon/landing.ts#L890-L915))**:
   - In `mergeLocal.land`:
     - Check `await isAncestorOf(cwd, base, branch)`. If `base` is already an ancestor of `branch` (i.e. `main` has not moved since the branch or its latest merge was cut), **do not run `git rebase <base>`** — `git merge --ff-only <branch>` into `<base>` will fast-forward cleanly without re-serializing diamond merge commits!
     - When `base` *has* moved (`!isAncestorOf(cwd, base, branch)`), run `git rebase --rebase-merges <base>` so resolved merge commits from parallel delegated pieces (`t1340`–`t1343`) are preserved rather than flattened into self-conflicts.
2. **Teach `delegationLandingBlocker` to recognize squashed/rebased child work ([`src/daemon/delegation.ts`](../src/daemon/delegation.ts#L384-L429))**:
   - When `isAncestorOf(cwd, childBranch, parentHead)` is `false` (for example after the coordinator squashed or rebased the parent branch):
     - Check `git cherry <parentHead> <childBranch>` (patch-id equivalence) or check whether the tree diff of `childBranch` relative to its cut base (`child.gitBaseCommit`) is already satisfied in `parentHead`.
     - Additionally, when the coordinator explicitly merges or squashes on the parent branch after all delegated pieces settle, allow `delegationLandingBlocker` to pass if every file modified by `childBranch` (`git diff --name-only <cutBase>..<childBranch>`) has no remaining unapplied hunks against `parentHead` or if the coordinator recorded a squash/rebase covering those commits.
3. **Coerce numeric array items in `parseFlagArgv` ([`src/agentcli/args.ts`](../src/agentcli/args.ts#L195-L215))**:
   - Inspect the element type of `ZodArray` in `unwrapField` (`elementScalar`: `'number' | 'boolean' | 'string'`).
   - When `f.kind === 'list'` and `f.elementScalar === 'number'`, coerce each flag value with `Number(value)` (matching `f.kind === 'number'`) so `warmstart-agent land_work --set-aside 1340` passes `z.array(z.number().int().positive())`.
   - Add a unit test in `src/agentcli/args.test.ts` covering `land_work --summary "..." --set-aside 1340 --set-aside 1342`.

### Phase 4: Make Conflict/Check Resolvers Conversation-Aware and Guard `completeTask` After `land_work`
**Files**: [`src/daemon/resolutions.ts`](../src/daemon/resolutions.ts), [`src/daemon/scheduler.ts`](../src/daemon/scheduler.ts), [`src/daemon/turnend.ts`](../src/daemon/turnend.ts)

1. **Make `resolveConflictOnTask`, `resolveChecksOnTask`, `resolveCommitOnTask`, and `resolveTrunkMovedOnTask` conversation-aware ([`src/daemon/resolutions.ts`](../src/daemon/resolutions.ts#L118-L215))**:
   - When `isOpenConversation(task)` is `true`:
     - Do **not** instruct the agent to squash delegated merge history or *"report the task complete again"* (which triggers `TASK COMPLETE:`).
     - Instead instruct: *"Confirm there are no conflict markers and the tree is clean, commit or amend any fixes, then run `warmstart-agent land_work --summary \"<one-line summary>\"` (or reply to the person so they can press **Land**)."*
2. **Guard `onStreamResult` / `completeTask` when `land_work` already landed in the same run ([`src/daemon/turnend.ts`](../src/daemon/turnend.ts#L424), [`src/daemon/scheduler.ts`](../src/daemon/scheduler.ts#L4139))**:
   - If `isOpenConversation(task)` is `true` and the conversation already landed a slice during the current run (`task_messages` has a `'landed'` message with `createdAt >= run.startedAt`), treat a trailing `TASK COMPLETE:` line at the end of that same turn as the turn's closing reply (`endConversationTurn`) rather than starting a second `completeTask` → `decideFinish` cycle on the freshly rotated `.N` branch!

---

## 5. Verification Matrix

| Area | Test File | What to Verify |
|---|---|---|
| Power action (`When done`) | [`src/main/poweraction.test.ts`](../src/main/poweraction.test.ts) | `awaiting_human` task + warm idle `work` session (`idle: true` or `state: 'idle'`) returns `hasActiveWork === false`; active `work` session (`idle: false`), `consult`/`review` session, or `landing: true` returns `hasActiveWork === true`. (**Implemented & passing**) |
| Helper-ended & preempted turn summaries | `src/daemon/turnend.test.ts` | When an MCP-less run ends via `ask_human` or `task_split`, or is parked via `restForQuota`, `result.text` / final assistant prose is recorded in `task_messages`. |
| Warm resume after `paused_quota` | `src/daemon/prompt.test.ts` | Resuming a warm session after a `preempted` / `failed` run whose messages were already marked `delivered_at` emits an explicit continuation prompt rather than bare boilerplate. |
| Delegated branch landing & `--set-aside` | `src/daemon/landing.test.ts`, `src/agentcli/args.test.ts` | `mergeLocal.land` fast-forwards without self-conflicting when `base` is already an ancestor of a branch with diamond merges; `parseFlagArgv` coerces `--set-aside 1340` to `[1340]`. |
| Conversation conflict resolution & post-`land_work` turn end | `src/daemon/resolutions.test.ts`, `src/daemon/turnend.test.ts` | `resolveConflictOnTask` on an open conversation instructs `land_work` instead of `TASK COMPLETE:`; a trailing `TASK COMPLETE:` in the same run as a completed `land_work` ends the conversation turn cleanly without posting *"the agent made no commits"*. |
