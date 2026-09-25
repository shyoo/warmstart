# t693 — Show the Plan & Execute instruction in full before it runs

**2026-09-25 · t693 · implementation plan, not status.** Status lives in `HANDOFF.md`.
Design of record for the shape itself: `plan_and_execute_2026-09-15.md`.

## 1. The defect, measured

In t690 the operator approved a Plan & Execute handoff having seen only a one-line
summary, not the instruction the executor would actually receive. The reduction happens in
exactly one place — [`src/daemon/api/agent.ts`](../src/daemon/api/agent.ts) (`agent.split`,
lines 218–226):

```ts
const label = piece.summary?.trim() || piece.title.trim().split(/\r?\n/)[0] || `piece ${i + 1}`
```

`piece.title` **is** the executor's prompt ([`src/daemon/split.ts`](../src/daemon/split.ts):52:
"⛔ This is the child's **prompt**, not a label — `promptFor` sends it verbatim"), and the
approval question keeps only its first line (or the planner's optional one-line `summary`).
The question text then tells the operator "this is your look at the instruction"
(`agent.ts:240–245`) — but the look is one line. Nothing downstream truncates: the
`questions.question` column is unbounded `text`
([`src/daemon/db.ts`](../src/daemon/db.ts):825), `askQuestion` stores it verbatim
([`src/daemon/questions.ts`](../src/daemon/questions.ts):170), and `QuestionCard` renders
the whole string ([`src/renderer/src/components/Questions.tsx`](../src/renderer/src/components/Questions.tsx):160)
— as a plain `<p>`, no markdown. After approval the full instruction survives only as the
filed child's task title, readable in the child thread once it is too late to refuse.

So the approval gate the design promises ("the operator approves the instruction before it
is filed") currently approves a label. Any fix must put the full bytes in front of the
operator *at approval time*, on every surface that answers a question (desktop, remote
desktop, phone — all read the same `questions` row over RPC).

## 2. Options

### A. Full instruction in the approval question (user's option 2)

Daemon: in `agent.split`, when `handoff` is true, append the piece's full `title` to the
question text (below the existing prose, so the framing still reads first). No schema
change — the column already holds `text`. Phone/remote get it for free over the existing
RPC.

Renderer: `question-text` is a plain `<p>`. A multi-KB brief renders as a wall, so the card
needs either (A1) a collapsed "View full instruction" expander showing the raw text, or
(A2) the same treatment rendering markdown through the thread's existing markdown renderer
(agent output is already text-never-markup per `docs/ui.md`, so this reuses a trusted
renderer rather than adding one).

- Effort: S. Daemon ~10 lines + L1; renderer one component change + L1/L3.
- Risk: very long briefs bloat the card and the thread history. Mitigated by collapsed by
  default (one click to review, which is the point — approval must be a deliberate look).
- Limits: the text lives only in the question row; after answering, review means opening
  the child task. Nothing new to clean up — answered rows already age out the way they do
  today.

### B. Instruction as a file + markdown view pane (user's option 1)

Daemon writes the piece's `title` to a scratch file at approval time; the approval question
links it; a new pane (modelled on
[`src/renderer/src/components/DiffPane.tsx`](../src/renderer/src/components/DiffPane.tsx):
same RPCs-the-views-read pattern, open-budget, resizer) renders it as markdown.

- New surface area: a scratch location (data dir vs task workspace — data dir keeps it out
  of the repo the executor works in, but needs a writer + a read RPC since the renderer
  never touches disk), a read RPC, a pane component, and a lifecycle (delete on
  answer/refusal/expiry/orphan-sweep — an approval file that outlives its question is
  litter with the operator's data in it).
- Effort: M. Daemon writer + RPC + lifecycle with L1; pane with L1/L3; `docs/ui.md` edit.
- Security: render through the existing markdown-as-text path only; the file must never be
  executed, imported, or attached into a prompt — the "code is never loaded from the data
  directory" invariant applies to anything the daemon writes there.
- Benefit over A: nicer reading for very long briefs; the file persists beside the task
  for post-hoc review.

### Recommended sequence

A first in all cases: the approval card must carry the full bytes regardless, otherwise B's
pane is a second click the operator can skip — which reproduces today's defect with one
more step. B follows only if briefs routinely exceed a comfortable card (see D5).

## 3. Test plan (either option)

- L1 (`split`/agent-approval tests): execute-mode approval question contains the full
  piece title verbatim, not just the first line; split-mode cards unchanged unless D2 says
  otherwise; refusal still returns the operator note verbatim.
- L1/L3 renderer: expander (A) or pane (B) opens, renders the bytes, and does not fire for
  other question origins.
- `docs.test.ts` gate: any `docs/` edit indexed and linked; `HANDOFF.md` stays ≤ 200 lines.
- Manual: file a Plan & Execute task, confirm the approval card shows the whole brief on
  desktop; answer from phone once if B (bytes must travel, not paths).

## 4. Decisions needed before implementation (see NEEDS DECISION in the task thread)

**Chosen 2026-09-25:** D1 = A (full text in the card, collapsible). D2 = execute handoffs
only, split cards unchanged. D3 = thread markdown subset. D5 = head of 8 framing lines,
collapse past 12. Implemented as `splitApprovalFor` + `ApprovalBody`; D4 (scratch file)
not needed.

- **D1.** A (text in card), B (file + pane), or A-now-B-later?
- **D2.** Scope: Plan & Execute handoffs only, or every `task_split` approval (split pieces
  are also full prompts, same blind-approval shape)?
- **D3.** Rendering: collapsed plain-text expander (A1) or markdown-rendered (A2)?
- **D4 (if B).** Scratch location: data directory (needs new RPC + lifecycle) or task
  workspace (visible to the executor — probably wrong, but stated so it is chosen against)?
- **D5.** Size guard: collapse by default at any length, or inline short briefs (e.g. ≤ 20
  lines) and collapse beyond?
