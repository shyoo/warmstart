# Human-in-the-loop — questions, choices, and phased execution (2026-08-30)

A plan, not a record. Status lives in `HANDOFF.md`; when a phase lands, delete its section here and
move anything worth keeping to `changes_history.md`.

## The problem

The tool assumes a task is asynchronous and non-interactive from dispatch to completion. Two real
classes of work break that assumption:

1. **The agent needs a decision only a person can make** — "OAuth, session cookies, or magic link?".
   Claude Code has a native multiple-choice tool for exactly this; Antigravity has an equivalent.
2. **The agent breaks the work into phases and stops between them**, expecting a go-ahead.

Neither is a failure mode to design out. A complex design prompt *should* stop and ask, and the
answer is worth more than the tokens it saves.

## What is already there, and precisely how it falls short

| Piece | Where | State |
|---|---|---|
| `request_human` MCP tool | `src/mcp/index.ts` | Exists. **Cannot carry an answer** |
| Approvals bar | `src/renderer/src/components/Approvals.tsx` | Allow / Always / Deny. No input |
| `awaiting_human` + Resolve | `scheduler.ts` `resolveTask` | Works |
| Send / Send and continue | `TaskThread.tsx:1322` | Works — the manual multi-phase answer today |
| Completion instruction | `scheduler.ts:1830` | Always "run to the end". No other contract exists |

### ⛔ Finding 1 — `request_human` transmits the question and cannot return the answer

It routes through `approval.request`, whose answer set is closed at `allow | allow_always | deny`
(`ApprovalDecision`, `shared/tasks.ts:438`). The tool result is therefore literally
`The operator agreed.` or `The operator declined.` A three-option design question is unanswerable by
construction, and the operator is shown a yes/no bar with no place to type.

### ⛔ Finding 2 — escalation to `awaiting_human` is unreachable

`WAIT_TIMEOUT_MS` is 10 min (`approvals.ts:41`); `DEFAULT_ESCALATE_AFTER_MS` is 30 min
(`approvals.ts:38`), and no caller overrides it. The waiter fires first and calls `recordAnswer`,
which sets `answered_at` — and `escalateStale` scans `openApprovals()`, i.e. `answered_at is null`.
So the escalation path is dead code for every approval that actually waits. `escalateStale` has no
test.

### ⛔ Finding 3 — an unanswered question is recorded as a refusal

Timing out denies. That is right for "may I run `rm -rf`" and wrong for "which design do you want":
the agent is told the operator *declined*, and builds on that.

### ⚠️ Finding 4 — the path is Claude-only

`capabilities.mcp` is `false` on `openai-compatible` and `antigravity-cli`, so neither
`task_complete` nor any question tool is registered there (corrected 2026-08-29, see
`docs/adapters.md`).

## The shape of the fix — a Question is a third object

`AGENTS.md` already draws one line: a **Task** is schedulable, durable, open answer set, outlives its
session; an **Approval** is an interrupt on one live session, closed answer set, dies with the
session. A **Question** is the missing cell — an interrupt on a live session, like an approval, but
with an **author-supplied answer set**, whose answer is *content returned into the tool result*
rather than a verdict.

⛔ It gets its own table and RPCs rather than widening `Approval`. Everything that makes Approval good
— rules, `allow_always`, glob matching, deny-wins — is meaningless here: you cannot remember the
answer to "which auth approach" as a project rule, and a `deny` that wins by default is the exact
wrong instinct for a design decision.

## Decisions taken (owner, 2026-08-30)

| # | Decision |
|---|---|
| D1 | On timeout: hold until `deadlineAt` (the session's real cache expiry), then let the session die and rest the task at `awaiting_human` **with the question preserved and still answerable**. Answering it resumes the task. Never fabricate consent, never fabricate refusal |
| D2 | Answerable in **both** places: the attention bar carries the clock and one-click answers; the task thread renders the full card. The bar is where you notice it; the thread is where the context is |
| D3 | **Autonomous by default**, checkpointed opt-in per task (defaulting from the project). The async premise stays the default; interactivity is something you choose for design work |
| D4 | **Measure Claude Code's native `AskUserQuestion` before building** (R14, below). If it reaches our permission-prompt tool we render the agent's own question verbatim, with no prompt cooperation needed |
| D5 | Interception answers through `{behavior:'deny', message}` — measured to reach the model as the tool result (R14.b′). Same turn, no stdin write, answer bound to the question. The park (D1) returns the same way with 'no answer arrived' |
| D6 | ✅ **A blocked run is not a failed run.** `RunOutcome` gains `blocked`: the agent asked and stopped, which is work in progress, not a fault. It does not count towards triage, does not bench the worker, and is not medianed by the estimator — `blocked` is not `completed` either |

## R14 — measured 2026-08-30, claude-code 2.1.251, claude-sonnet-5

**Question:** does Claude Code's native `AskUserQuestion` reach `--permission-prompt-tool` in
headless mode, and can the hook answer it?

**Method:** a probe matching `claude-code.ts` `plan()` flag for flag — `--permission-mode auto`,
`--mcp-config`, `--permission-prompt-tool mcp__multi-agent-controller__approve`, `-p` with
stream-json on both halves, `CLAUDE_CONFIG_DIR` set to the ClaudeSecond isolation root, cwd
`<dataDir>/scratch`. The only substitution was the MCP server: a stub registering the same
`multi-agent-controller`/`approve` name, recording each call verbatim and returning `allow`. One
turn, `$0.1967`, 341 output tokens.

### R14.a — ⭐ Yes, with the whole question intact

`AskUserQuestion` is in the headless tool list (`system/init` → `tools`), and it routes to the
permission-prompt tool with its full structured payload:

```json
{"tool_name":"AskUserQuestion","tool_use_id":"toolu_01AJN1L1wSPCQZvYkmHnbU36",
 "input":{"questions":[{"question":"Which authentication approach do you want...",
   "header":"Auth approach","multiSelect":false,
   "options":[{"label":"OAuth (external provider)","description":"Delegate login to..."}, ...]}]}}
```

`questions[]`, each with `question`, `header`, `options[{label, description}]` and `multiSelect` —
everything needed to render the agent's own question verbatim, with no cooperation from the prompt.

⚠️ `describeTarget` finds none of those keys and renders an empty target, so today this arrives at
the operator as a bare `AskUserQuestion` with Allow / Always / Deny.

### R14.b — ⛔ The hook gates *asking*, not *answering*

Returning `{behavior:'allow', updatedInput}` produced the tool result:

> `The user did not answer the questions.`

So interception yields the question but **cannot carry the answer back through the same call**. The
answer has to arrive as the next user message on the already-open stdin — which the `conversation`
transport already supports, and which the agent itself expects: it replied *"I'll wait — let me know
which approach you'd like."*

That is one extra turn: a cache read against a live session, not a rebuild. Not free, not expensive.

### R14.b′ — ⭐ `deny`'s message *is* the answer channel (measured 2026-08-30, $0.0637)

Same probe, one variable changed: the hook returned
`{behavior:'deny', message:'The operator answered: server-side session cookies (option b). Proceed on
that basis.'}`. The model received it as the tool result and acted on it:

```
TOOL_RESULT is_error=true: "The operator answered: server-side session cookies (option b). …"
ASSISTANT:  "Got it — server-side session cookies it is."
```

⭐ So a question **can** be answered in place, inside the same turn, with no second prompt and no
stdin write. That is the cheaper and tighter path: the answer is bound to the question it answers,
rather than arriving later as a free-floating user message after the model has been told nobody
replied.

Two costs, both acceptable and both to be written down where they happen:

- ⚠️ `is_error: true` on the tool result. The model handled it correctly here, but the channel is
  semantically a refusal, so the message must read as an answer and never as an apology.
- ⚠️ The `result` record's `permission_denials` now carries the whole `AskUserQuestion` input — our
  answer is filed as a denial. Nothing in the daemon reads that field today (checked), but anything
  that starts to must not count these.

**Decision (D5):** interception answers via `deny` + message. On the D1 park, the same channel
returns *"no answer arrived; this is being handed to a person"*, which lets the agent wrap up cleanly
instead of holding a tool call against a session that is about to be killed.

### R14.c — ⭐ The vendor already emits a "blocked, needs a human" record

Unlooked for, and the most valuable thing in the run:

```json
{"type":"system","subtype":"post_turn_summary","status_category":"blocked",
 "status_detail":"let me know which approach you'd like...",
 "needs_action":"let me know which approach you'd like..."}
```

⛔ **The `result` record cannot distinguish this from success** — `stop_reason: "end_turn"`,
`terminal_reason: "completed"`, `is_error: false`, exactly like a finished task. `post_turn_summary`
is the only thing that says the agent stopped because it is waiting on a person, and `decodeStream`
currently drops it as `{kind:'other'}`.

This is the multi-phase detection, supplied by the vendor, with no prose parsing whatsoever.

### R14.d — usage is in the stream after all, on this version

The `result` record carried a full `usage` block including `iterations`. `docs/adapters.md`'s matrix
says *"usage — ⛔ not in the stream, from the transcript"* (measured 2026-08-25). One of the two is
out of date; the transcript stays authoritative either way, but the row needs re-measuring against
2.1.251 before it is trusted again.

⚠️ Also seen: `rate_limit_event` reported `seven_day` utilisation **0.75** on ClaudeSecond, resetting
2026-09-03T01:00Z.

## Implementation

### 1. ✅ `src/daemon/questions.ts` — the object

**Landed 2026-08-30.** Schema **v20**; `Question`/`QuestionAnswer`/`QuestionResolution` in
`shared/tasks.ts`; `question.list` / `.forTask` / `.answer` RPCs; `question.opened` / `.answered` /
`.parked` events. `renderAnswer` is the single place an answer becomes a sentence, so the two doors
it can arrive through word it identically. `onSessionExit` parks any question still open — and an
open question is by itself enough to make the run `blocked`, without needing the vendor's record.

What follows was the plan and is now the description.

Table `questions`: `id, session_id, run_id, task_id, project_id, kind, question, options_json,
asked_at, deadline_at, answered_at, answer_json, answered_by`. A `waiters` map, structurally a
sibling of `approvals.ts`. `deadline_at` is the blocked session's cache expiry, computed the same way
`requestApproval` computes it — waiting is priced here for the same reason.

`kind` is `text | choice | multi`. Events `question.opened` / `question.answered`.

⛔ Per D1, the wait resolves in exactly three ways: an answer, the session dying
(`voidQuestionsForSession`, mirroring `voidApprovalsForSession`), or `deadlineAt` passing — and the
third **parks the task rather than answering it**. The question row stays open across the park, which
is what makes it answerable an hour later.

### 2. ✅ `ask_human` replaces `request_human` (worker tier, `src/mcp/index.ts`)

**Landed 2026-08-30**, with a `question.ask` RPC and the prompt builder pointed at the new name.
The `kind` is derived from what was supplied rather than asked for separately — a caller that says
`choice` and sends no options has described a question nobody can answer. `test/daemon.test.mjs`
drives it over a real stdio MCP client: 132 checks, up from 125.

⚠️ **Unmeasured (R15):** `question.ask` can block for minutes, and whether every MCP client
tolerates a tool call that long is not known. If one gives up first the call fails, the question stays
open, and it parks on schedule — the turn is lost, nothing else is. Worth one probe before relying on
long holds.

```
ask_human({
  question: string,
  kind?: 'text' | 'choice' | 'multi',   // default 'text'
  options?: [{ id, label, detail? }],
  default?: string
}) -> the operator's actual answer
```

On park (D1) it returns a plain sentence saying no answer arrived and the task is being handed to a
person — the agent's remaining turn is then short and cheap, and the process exits without pretending
it was told anything.

### 3. Both question and answer are written to `task_messages`

⭐ This is the part that makes it worth building rather than just typing into the live session. A
decision made in a live session today exists only in that session's scrollback; a successor after a
preemption pays to rediscover it. Written to the thread, it is carried into the next run's prompt by
the machinery already in `buildPrompt`, and it is in the permanent record of why the work is the way
it is.

### 4. ✅ UI

**Landed 2026-08-30.** `Approvals.tsx` → `Attention.tsx`, carrying approvals and questions in one
strip ordered oldest-first across both — whoever has waited longest is closest to going cold.
A `choice` question with at most three short labels answers in one click there; anything larger says
what is being asked and opens the task, because a design decision with three paragraphs of rationale
is not a strip. `Questions.tsx` holds the card, which sits **between the thread and the composer**:
the agent's turn ended with a question and that is where the answer goes.

⛔ Every kind gets a text box, including `choice`. The useful answer is very often *an option plus a
caveat*, and an interface that made you pick one of three and say nothing else would throw away the
sentence that mattered. Nothing chosen and nothing typed is not a submission.

⛔ A question does not wear the warning colour. Amber says *something may be about to go wrong*; an
agent asking which of three designs you want is the system working, and colouring it as an alert
teaches the operator to dread the bar. It uses `--state-human`, the same colour as `awaiting_human`.

⚠️ **Coverage gap.** `test/ui.test.mjs` drives the bar end to end — both kinds queued together, the
question taking the strip, its own three labels as the buttons, one click emptying it. The **thread
card is not covered by any rendering test**: a question with a `taskId` needs a live run to exist, and
the UI suite has no way to seed one. Typecheck and lint only.

### 5. `checkpoint` and the completion mode (D3)

`checkpoint({ phase, done, next })` is a Question whose answer set is
`{ continue · redirect + text · stop }`. Once Questions exist this is a thin wrapper.

A per-task `completion_mode` (`autonomous` | `checkpointed`), defaulting from the project, selects one
of two lines in the prompt builder beside the existing `task_complete` instruction:

- `autonomous` — "Work to the end. Stop only for a decision that changes what you build, and use
  `ask_human` for it."
- `checkpointed` — "Call `checkpoint` at each phase boundary and wait for the answer before starting
  the next."

⛔ Answering a checkpoint fast is a cache read (`0.1·C`) and answering it after the deadline is a cold
rebuild (`2.0·C`). The clock in the bar is the same clock, for the same reason.

### 6. Native interception on Claude Code (R14.a / R14.b)

`approve` gains a branch on `tool_name === 'AskUserQuestion'`: instead of opening an Approval, it maps
`input.questions[0]` onto a Question (`kind` from `multiSelect`, options from `options[]`), waits for
the operator, and returns the answer as `{behavior:'deny', message:<answer>}` per D5. The agent reads
it as the tool result and continues in the same turn.

⭐ This works whether or not the agent was ever told our tools exist, which makes it the path that
catches the case as the owner actually observed it — and after R14.b′ it costs no extra turn.

⚠️ `questions` is an array. The probe saw one element; a multi-question call must either open one
Question per element or be refused honestly. Nothing here should guess which.

### 6b. ✅ `post_turn_summary` — a blocked signal that needs no prompt contract (R14.c)

**Landed 2026-08-30.** `StreamEvent` gained `turn_status` (`category`, `detail`, `needsAction`);
claude-code decodes `system`/`post_turn_summary`; `scheduler.noteTurnStatus` holds the last one per
session, because the record arrives *before* the terminal one and `onSessionExit` is where it is
needed; `onSessionExit` quotes it. A blocked run now rests at `awaiting_human` **naming what the
agent was waiting for** instead of "nothing here can tell whether the work was finished".

⚠️ Fixed in passing: `captureQuotaAfter`'s tail was outside its own try/catch while every caller
invokes it as `void captureQuotaAfter(...)` — so `runQuota`/`setRunQuota` throwing was an unhandled
rejection with nobody to catch it. Surfaced by the new tests against a closed database.

⛔ This makes the `NEEDS DECISION:` prompt contract unnecessary on Claude Code. It is still the
fallback for `mcp: false` adapters with no equivalent record — Antigravity and codex — where the run
rests at `awaiting_human` with that line as the hold reason and the operator replies with **Send and
continue**.

⛔ We do **not** parse prose to detect a question and synthesise options. Reading intent out of
generated text is the inference this project refuses to make; both an anchored `NEEDS DECISION:`
prefix and a vendor's own `status_category` field are contracts, which is a different thing.

### 7. Fix the escalate/timeout dead zone (Finding 2)

Reconcile the two constants so escalation is reachable, and write the test for `escalateStale` that
was never written — an approval past `escalate_after` with no answer becomes `awaiting_human`, and one
already answered does not.

## Order of work

| Step | What | Why first |
|---|---|---|
| ~~0~~ | ~~R14 measurement~~ | ✅ done 2026-08-30, $0.20. See above |
| ~~0b~~ | ~~R14.b′ deny-message probe~~ | ✅ done 2026-08-30, $0.06. It does. See D5 |
| ~~1~~ | ~~`questions.ts` + RPCs + events + tests~~ | ✅ landed 2026-08-30. 14 tests, schema v20 |
| ~~2~~ | ~~`post_turn_summary` decode + `awaiting_human` reason~~ | ✅ landed 2026-08-30. 9 tests, 7 of them red against the previous code |
| ~~3~~ | ~~`ask_human` (the portable path)~~ | ✅ landed 2026-08-30. 7 checks over a real MCP client |
| ~~4~~ | ~~Attention bar + thread card~~ | ✅ landed 2026-08-30. 5 UI checks; the bar is covered end to end, the card is not — see below |
| ~~5~~ | ~~`task_messages` write-through~~ | ✅ landed. 4 tests, incl. the duplicate-delivery trap |
| ~~6~~ | ~~`AskUserQuestion` interception in `approve`~~ | ✅ landed. 5 checks against the verbatim R14 payload |
| ~~7~~ | ~~`checkpoint` + `completion_mode`~~ | ✅ landed. Schema v21, a third tri-state, 4 checks + 2 prompt tests |
| ~~8~~ | ~~`NEEDS DECISION:` fallback for codex / Antigravity~~ | ✅ landed. An anchored contract, and it blocks rather than completes |
| ~~9~~ | ~~Escalation fix + its test~~ | ✅ landed. `escalate_after` 30m → 5m, under the 10m wait |
| ~~10~~ | ~~Re-measure R14.d and correct `docs/adapters.md`'s usage row~~ | ✅ landed. Usage **is** in the stream on 2.1.251; we still meter from the transcript, by choice |

## What is done, and what is still not proven

Every step above has landed. ⚠️ **No agent has used any of it in flight.** L1 unit tests, L2 over a
real stdio MCP client and L3 against the real app all pass; what has never happened is a dispatched
task calling `ask_human` or `checkpoint` on its own initiative and a person answering it. That is the
next thing worth doing and it costs tokens.

⚠️ The **thread card still has no rendering test** — a question with a `taskId` needs a live run, and
the UI suite cannot seed one. ⚠️ **R15** is unmeasured: whether an MCP client tolerates a tool call
held for minutes.

## Open questions

- ⚠️ `AskUserQuestion`'s `questions` is an **array**. The probe saw one element. One Question per
  element, or an honest refusal — not a guess that takes the first and drops the rest.
- Does answering a question on a **parked** task resume it into the same conversation
  (`resumeSession`) or a fresh one? The lease and the workspace are both released at park
  (`docs/sessions.md:91`), so this needs deciding against the existing resume path, not invented here.
- Should a `choice` answer be remembered per project the way `allow_always` is? Probably never for a
  design decision — but "always use conventional commits" is the same shape and would be.
