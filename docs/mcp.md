# The MCP server

`src/mcp` — the server the **agent CLI** spawns, not the daemon. Two tiers, chosen by the daemon.

> **Audience:** anyone adding, changing or removing an agent-facing tool.
> **Authority for:** the tier contract and the tool inventory.
> The RPC surface it calls is in [`architecture.md`](architecture.md).

⚠️ **Two files, and the split is what makes any of it testable.** `index.ts` is the wiring and ends by
connecting a stdio transport at the top level — so importing it *starts a server*, and nothing in it
could ever be loaded by a check. `payload.ts` is the pure half: what a tool result looks like, and how
the vendor's permission-hook payload is read (`questionsFrom`, which accepts four spellings of
*multi-select* and two each of *label* and *detail*, every one of them written from a payload somebody
watched arrive). ⛔ It must **degrade rather than throw** — this runs inside
`--permission-prompt-tool`, where a parse error is not a wrong answer on screen but an agent that
cannot act, with the reason buried in a CLI's stderr. `payload.test.ts` pins that with 21 L1 checks.

---

## 1. Why it exists as its own entry point

Its headline job is being the target of `--permission-prompt-tool`: when the CLI would have shown a
permission card, it calls `approve` here instead and blocks on the answer. That is what makes an
approval a **structured event** rather than something to read off a screen. ⛔ This app never parses a
terminal to decide whether an agent may act — a mis-read approval card is an unattended *yes*.

It holds **no state**. Everything routes to orchestratord over `POST /rpc`, using the port and bearer
token in `<dataDir>/orchestratord.json`. orchestratord owns the policy, the queue and the escalation
clock.

⚠️ It is a standalone bundle and deliberately shares no daemon module. `MCP_SERVER_NAME` is
duplicated as a literal in both `mcpconfig.ts` and `src/mcp/index.ts`; the daemon registers the server
under that key and tells the CLI to call `mcp__<key>__approve` (`APPROVE_TOOL`). The two must match.

## 2. The tier contract

⛔ **The tier is set by the daemon, never asked for by the caller.** `WARMSTART_TIER`
comes from the MCP config file `writeMcpConfig(sessionId, tier)` generated for that session; an agent
cannot promote itself by exporting an environment variable it does not control. Anything other than
`controller` reads as `worker`.

⛔ **There is no `task_delete` in either tier.** An agent that can delete the record of its own failed
work is an agent that can hide it.

⛔ **Unattended judgment gets no tools at all.** A consult replies with JSON the daemon validates
against a closed set. Tools go only to the chat session, where a person is watching — which is why the
controller tier is handed out there and nowhere else.

⚠️ **Two tiers means two prompt-cache prefixes on an install.** Changing tool definitions invalidates
the entire prompt-cache prefix, and a session's MCP config is frozen for its lifetime — which is why
workers on one project get identical configs. Adding a third tier adds a third prefix.

⛔ **A declarative adapter cannot be granted MCP tools**, and `external.test.ts` refuses it. See
[`adapters.md`](adapters.md).

## 3. Worker tier

Scoped to its own run, its own project, its own mandate and its own budget. ⛔ Deliberately absent:
raw process spawn, raw SQL, the filesystem outside its project, any way to widen its own mandate, and
any way to assign work directly to another worker.

⛔ **There is still no `commit` tool, and there will not be one.** The agent commits with `git`, in
its own workspace, the way it would in any repo, and the tool decides what happens to the branch
afterwards. Deciding what to stage and what a message says is the work, not plumbing.

⛔ **`land_work` exists, and it is for conversations only.** It refuses every other kind, because on
a `work` task landing *is* finishing and `task_complete` is already that call. The case it answers is
narrower and had no answer at all: in a conversation, a person says *land this*, and the agent has
committed on its branch and cannot safely do the next step by hand — rebase onto a target that has
moved, run the project's own checks, merge or push under the project's policy, all while landing is
serialised per project so two rebases cannot race. ⛔ It ends **nothing**: the run stays open, the
task stays an open conversation, and the reply names the next numbered branch to carry on in, because
the landing retired the one the work was on. See [`landing.md`](landing.md).

⚠️ **The t339 lesson still holds for work tasks, and is unchanged.** A *work* task that will not
land is never an agent missing a tool it was not told about. Read the hold reason: it names the
condition that failed, and every one of them ([`landing.md`](landing.md) §"What safe means") is either
something the agent can fix in `git` or something only a person can. `land_work` is not a way round
any of them — it runs the identical bar and hands the same reason back, verbatim.

| Tool | Does |
|---|---|
| `task_read` | read **this task only**: its task record, whole thread, and prior runs. The daemon derives the task from the caller's live session, so it is a route to recover a past reference, not a way to inspect the board |
| `approve` | the permission prompt tool. Called by the CLI in place of showing a card |
| `task_complete` | ⛔ **the only signal that a task succeeded.** A process exiting cleanly says nothing |
| `await_human` | ⛔ **the other terminal contract:** the agent has gone as far as it can and the rest is a person's. Ends the run `blocked`, rests the task at `awaiting_human`, claims nothing and lands nothing |
| `ask_human` | put a question to the operator and **wait** (single choice, multi-checkboxes via `multi_select`, or open text) |
| `checkpoint` | report a finished phase and wait for the go-ahead. `checkpointed` completion mode |
| `task_create` | file a follow-up, inheriting a **narrowed** mandate and a share of the budget |
| `handoff` | leave a note for whoever continues; prepended to the next run's prompt |
| `task_split` | file a whole plan at once — 2 to N pieces for a Plan & Split, with dependency edges encoding every required execution or landing order (edge-free pieces may run in parallel); **exactly one** for a Plan & Execute. ⛔ How many is decided by the task's own child cap (`planModeOf`), not by the agent, and the refusal names the shape. ⛔ Raises **one** approval and blocks on it; atomic |
| `task_depend` | add one edge between two pieces of **this task's own** split. ⛔ never an arbitrary task in the fleet |
| `debate_round` | ⛔ **a debate organizer's only move, called once per round.** Either `continue` with one brief per seat — the seats are re-queued and the organizer is stopped until they answer — or `converged` with the agreement, the dissent, the confidence and what is unresolved, which raises the five-verdict card and **blocks until a person answers**. ⛔ An empty dissent is refused |
| `land_work` | ⛔ **conversations only.** Rebase, check and land what this conversation has committed, because the person asked. Refuses anything else. Ends nothing — the reply names the branch to keep working on |

⚠️ `task_read` changes every worker session's tool-definition prefix. Existing sessions retain their
frozen MCP config until they end; fresh ones pay the new prefix so a worker can recover its own
recorded context without database access.

⛔ **`task_complete` and `await_human` are the only two ways a run can end, and an agent that calls
neither leaves the task reading `running` for ever.** An ordinary run stays open until completion is
reported — that is the whole of its contract — so a turn that simply ends leaves the run open, the
workspace held and the worker slot reserved until the daemon dies. `endConversationTurn` closes that
gap for a `conversation`; `await_human` is what closes it for a task.

⭐ Measured on t226, 2026-09-05. The agent landed its work by hand, the trunk tripwire in `finish.ts`
refused to close the task — correctly — and the operator replied *"go with option C: I will close it
out myself."* The agent obeyed and stopped, and had nothing to call that meant *"I have stopped"*:
`task_complete` would have asserted a success the tripwire had just refused, `handoff` records a note
and ends nothing, and `ask_human` asks a question it no longer had. The session sat live and idle and
the board showed the task running all evening.

⚠️ **It is one small step from being a quieter `task_complete`, and its description is what stops
it.** The tool says in as many words that it is not a way to finish early, and the prompt names it
*appended to* the sentence asking for completion rather than beside it — an exit offered as an
alternative to finishing is an exit an agent takes. The run ends `blocked`, never `completed`, so the
estimator is never fed a job that stopped half way through as though it measured the whole one.

⛔ **And the daemon no longer relies on the agent reaching for either one.** An agent that ends its
turn having called nothing is now noticed: the `result` record is written down and, once `quietSince`
proves nothing has happened for `IDLE_TURN_AFTER_MS` (3m), `runWatchdogs` performs the `await_human`
verdict on the agent's behalf — run `blocked`, task at `awaiting_human` carrying the agent's own last
words, session warm, nothing landed or committed. ⚠️ It is a **safety net, not a third contract**: the
prompt still asks for `task_complete`, this still refuses to read a completion out of prose, and an
agent that stops without saying so still costs three minutes and a person's attention. Measured on
t249 and t254, 2026-09-06 — the same run left open for forty-five minutes, twice. See
`idleturn.test.ts` and [`architecture.md`](architecture.md) §"An agent has two ways to end a run".

⚠️ `ask_human` blocks until somebody answers **or the session's prompt cache expires**. That is
deliberate: an answer arriving while the session is warm costs a cache read, where the same answer
after a restart costs a full rebuild. ⛔ It replaced `request_human`, which routed through the approval
path — an agent asking *"OAuth, session cookies, or magic link?"* got back `The operator agreed.`
It supports multiple selection via `multi_select: true` (or `multiSelect`), extracts embedded XML
attributes, and detects multi-select intent from phrasing.

⛔ **Whether a question gets buttons or a text box is decided from what it *has*, not from what the
asker claimed.** `normaliseAsk` (shared/policy.ts) runs inside `insertQuestion`, so every path in —
the MCP tools, the `NEEDS DECISION:` contract, the CLI's own `AskUserQuestion` — is repaired once:
a `choice` with no options becomes `text`, and options that arrived become `choice` even if the call
said otherwise. ⭐ Measured on t235, 2026-09-06: three `ask_human` calls in a row reached the daemon
with `header` intact, `options_json` null, and their choices still sitting in the question string as
a literal `<parameter name="options">["A - …", …]` block. Each was a three-way decision the agent had
made properly; each reached the operator as a text box full of XML and was answered by typing a
letter. So a leaked `<parameter>` block is now read back out of the question text — that is
recovering an argument the model demonstrably sent, not guessing choices out of prose, which is
still refused (see `needsDecisionIn`) — and `options` accepts a bare JSON string as well as an array,
because rejecting the call only teaches the model to flatten its choices into the question instead.

⚠️ **An adapter with no MCP has no `ask_human`.** Its prompt asks it to end with a `NEEDS DECISION:`
line plus one `- option — detail` bullet per choice, and the daemon files a real `Question` row from
it. Multiple choices are indicated with `NEEDS DECISION: [multi] <question>` or `(select all that apply)`.
The operator UI also includes a `+ select multiple` mode toggle on question cards.
⛔ However it arrived, a question that does not become a row is a question nobody can reply to.

⛔ **`task_split` blocks on a structural approval, and that is the point.** An agent told in its prompt
to ask before splitting can forget; an agent whose tool call does not return until a person has answered
cannot. ⛔ **One approval for the whole split, not one per piece:** every coding subtask trips `riskOf`'s
`controller` gate, so a split of five would otherwise raise five consults and leave five drafts — and on
an install with no controller turn available, none of them would ever run.

⚠️ Its reply text is load-bearing either way. On approval it names each piece as `t<seq>` and tells the
planner to **stop**, because an agent that carries on after splitting is spending a billed turn on work
it has just delegated; on refusal it carries the operator's own note, so the planner revises rather than
re-filing what was just turned down.

⚠️ **Two more tools is a bigger prompt prefix on every worker session, not only on plan tasks** — a
session's MCP config is frozen for its lifetime and workers on one project get identical configs (§2).
That is a real, recurring cost, paid to avoid a third tier and the third prompt-cache prefix it would
buy. `checkpoint` sets the precedent: registered for everyone, *named in the prompt* only where it
applies.

⛔ **`debate_round` blocks the same way, for the same reason, and it is one tool rather than three.**
A separate `debate_post` for seats buys nothing — a seat's position is already carried by
`task_complete`'s summary, which is already written onto the thread as an `agent` message — and a
third *tier* would buy a third prompt-cache prefix on the install, which §2 warns about by name.
⚠️ Its refusals are load-bearing: a missing dissent section, a brief count that does not match the
seats, and a request for more rounds than the operator authorised each come back with the reason, and
after three failures the debate is handed to a person with every position intact. ⛔ **It never
guesses a winner** — an unarbitrated debate is still N useful answers, and a fabricated agreement is
worse than none.

⚠️ **`land_work` pays exactly the same price, and it is worth saying out loud because it is used by
one task kind.** Adding it changed the tool definitions, which invalidates **every** worker session's
prompt-cache prefix on the install — not only conversations' — and every session opened before it
carries the old config until it ends (§2). It follows `checkpoint`'s mitigation: registered for
everyone, named in the prompt only where it applies, which is `conversationInstruction` in
`prompt.ts`.

⚠️ The approval window holds the planner's worker slot — `awaitingHumanReservations` counts an
`awaiting_human` task against `maxConcurrent` so the answer can resume a warm session. Same price
`ask_human` already pays, and worth knowing before a split is raised at midnight.

## 4. Controller tier

Read the fleet and move work about. Handed only to the chat session.

| Tool | Does |
|---|---|
| `fleet_status` | every worker, its quota reading **with the age of that reading**, and its live sessions |
| `task_list` | the board: status, origin, lineage, spend |
| `task_get` | one task, its whole thread, and every run against it |
| `task_create` | file work. Prefer `draft` for anything proposed rather than committed to |
| `task_update` | retitle, reprioritise, set an estimate. ⛔ Does not change status |
| `task_promote` | draft → ready. ⭐ **The moment to write the prompt**, from what the work before it learned |
| `task_cancel` | wind down into a resting state. ⛔ Cancel is not delete, and there is no delete here |
| `estimate` | the median of completed runs, with its confidence and **basis** |
| `approval_list` `approval_answer` | the open permission gates |
| `resource_status` | what is contended and by whom |

⚠️ `fleet_status` returns `sampledAt` beside every percentage. A quota percentage is never current;
check the age before reasoning about it ([`cost-model.md`](cost-model.md) §5).

## 5. Adding a tool

1. Register it inside the correct `if (TIER === …)` block.
2. It must reach the daemon over `rpc()` and hold no state of its own.
3. ⛔ It may not delete anything, widen a mandate, or reach outside the caller's project.
4. Say in the description what the tool is *for*, not what it does — these strings are the only
   documentation the agent ever reads, and they are how the fleet's contract is actually expressed.
5. Update the table above, and note that the prefix change invalidates every cached prompt.
