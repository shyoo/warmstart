# Delegation from any task — design, 2026-09-25 (t704)

⚠️ Dated design, not status. `HANDOFF.md` carries status; `docs/mcp.md` stays the tool authority.

## 1. What exists today (read from the code, 2026-09-25)

- Every worker-tier MCP session is already *registered* for `task_create` (with `aggregate`),
  `task_split` and `task_depend` (`src/mcp/index.ts`). Registration is for everyone because a
  session's MCP config is frozen and per-kind configs would buy extra prompt-cache prefixes
  (`docs/mcp.md` §2).
- They are *named in the prompt* only for plan tasks (`handoffInstruction`, `planningInstruction`
  in `src/daemon/prompt.ts`) and debate organizers. A single task or a conversation is never told
  delegation exists; it can only discover it from tool descriptions.
- `task_split` refuses any parent that is not a Plan & Split / Debate (`validateSplit` →
  `isIntegrationParent`, `src/daemon/split.ts`). It is the one path with a **structural approval
  card** showing each piece's full instruction (t693).
- `task_create` works from any task, but a coding child trips `riskOf` → `controller` gate
  (`src/daemon/judgment.ts`) and sits as a draft until a controller consult or its fallback answers.
  No card for the operator, no per-piece model hint, and nothing wakes the parent when it settles.
- Authority already has a slot for this: `MandateOperation` includes `spawn_tasks`
  (`src/shared/tasks.ts`), checked in `createTask`.
- The thread composer sends `task.message { id, text, attachmentIds }` — plain text. There is no
  slash-command concept anywhere in the renderer. ⛔ `docs/ui.md`: a person's own typed message is
  never reinterpreted, so a command must be captured as structure **at compose time**, not parsed
  back out of stored text.

## 2. Proposal

### 2.1 One delegation tool path: generalise `task_split`

`task_split` becomes the delegation tool for **any** task whose mandate allows `spawn_tasks` and
whose *Delegation* setting is on — not only plans. It already has everything delegation needs:
self-contained instructions, dependency edges, atomic filing, one approval card, the operator's
refusal note returned verbatim. The plan-specific rules (Plan & Execute = exactly one piece,
Plan & Split ≥ 2) stay as they are for plan tasks; elsewhere the floor is **1** piece.

- Only the description changes (one-time prompt-cache prefix invalidation, same price `land_work`
  paid). No new tool, no new tier.
- `task_create` is left as-is for "file an unrelated follow-up".
- Per piece, optional `class: 'low' | 'med' | 'high'` — a capability-class *hint* the scheduler
  routes on (`modelclass.ts`), never a worker or account name (worker tier must not assign work to
  a worker, `docs/mcp.md` §3).

### 2.2 Where delegated pieces land, and who hears back

- Pieces are cut from the caller's branch and finish `commit-and-verify` on their own branch, in a
  worktree of their own. ⛔ The daemon does not merge them: `merge-branch` parks any pooled slot
  holding the target (`parkPooledHolders`), and a delegating conversation is live in that slot. The
  caller merges with `git` on its review turn (D3b).
- `land_work` and a person's Land refuse while a piece is unsettled (landing retires the branch it
  was cut from); the agent's `land_work` also refuses while a completed piece's branch is not in
  HEAD, unless named in `set_aside`.
- When all pieces of one delegation settle, the thread gets a `delegation.settled` report, and the
  caller is woken to review: a conversation by delivery/requeue, a work task by its `settled` edges.

### 2.3 The per-thread *Delegation* switch

- A pill beside worker · model · effort under the composer: **Delegate: on / off**.
- Stored as the task's `spawn_tasks` authority, so the daemon enforces it (`createTask`,
  `validateSplit`) — the prompt merely reflects it. Off never changes the MCP config, so toggling
  costs no cache prefix; a toggle mid-conversation is announced to the agent in one sentence on the
  next turn.
- Prompt: when on, one clause in the conversation / work contract naming `task_split` for
  delegation (MCP adapters). MCP-less adapters get no delegation clause (they cannot call the tool);
  a `/delegate` sent to one asks for the pieces' instructions in its reply instead. Decided on
  `capabilities.mcp`, never an adapter name.

### 2.4 `/delegate` in the composer

- Typing `/` at the start of an empty composer opens a small menu of commands (only `/delegate` in
  this change; a registry so `/plan`-like ones can follow). Choosing or typing `/delegate ` converts
  the text into a **[Delegate] chip** at the head of the box; Backspace at the start removes the chip
  and keeps the words.
- Sent as `task.message { …, command: 'delegate' }`. The message row stores it as its `event`
  (`command.delegate`); the bubble draws the chip from that field. Stored text is exactly what the person
  typed after the command.
- Daemon side, a `delegate` command wraps the turn's text with a fixed instruction: *the person
  asks you to delegate the following; prepare self-contained pieces and call `task_split`; do not
  do the work yourself*. If Delegation is off for that thread, sending `/delegate` switches it on —
  the same authority path as the pill.
- Available in any thread composer (conversation or reply to a work task); not in New Task, whose
  type selector already offers Plan & Split / Plan & Execute.

## 3. Decisions

Answered by the operator on 2026-09-25, through `ask_human` on t704:

| # | Question | Answer |
|---|---|---|
| D1 | Approval card before pieces are filed? | Card only for agent-initiated delegation; a person's `/delegate` files straight away |
| D2 | When all pieces settle? | Post the outcome and wake the caller to review |
| D3 | Where do pieces land? | Into the caller's branch; `land_work` waits while pieces are unsettled |
| D3b | How, given `merge-branch` would park a live conversation's slot? | The caller merges each piece's branch on its review turn; pieces are `commit-and-verify` |
| D4 | Who picks the worker/model? | The agent may hint a class (low/med/high); the scheduler routes |
| D5 | Delegate default | On for conversations and work tasks |
| D6 | Which slash commands? | `/delegate` only, behind a registry |

Implemented in t704 as described above. Not yet flown with a real agent; see `HANDOFF.md`.
