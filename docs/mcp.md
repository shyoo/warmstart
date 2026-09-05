# The MCP server

`src/mcp` — the server the **agent CLI** spawns, not the daemon. Two tiers, chosen by the daemon.

> **Audience:** anyone adding, changing or removing an agent-facing tool.
> **Authority for:** the tier contract and the tool inventory.
> The RPC surface it calls is in [`architecture.md`](architecture.md).

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

⛔ **The tier is set by the daemon, never asked for by the caller.** `MULTI_AGENT_CONTROLLER_TIER`
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

| Tool | Does |
|---|---|
| `approve` | the permission prompt tool. Called by the CLI in place of showing a card |
| `task_complete` | ⛔ **the only signal that a task succeeded.** A process exiting cleanly says nothing |
| `ask_human` | put a question to the operator and **wait** (single choice, multi-checkboxes via `multi_select`, or open text) |
| `checkpoint` | report a finished phase and wait for the go-ahead. `checkpointed` completion mode |
| `task_create` | file a follow-up, inheriting a **narrowed** mandate and a share of the budget |
| `handoff` | leave a note for whoever continues; prepended to the next run's prompt |
| `task_split` | file a whole Plan & Split at once — 2 to N pieces with dependency edges encoding every required execution or landing order; edge-free pieces may run in parallel. ⛔ Raises **one** approval and blocks on it; atomic |
| `task_depend` | add one edge between two pieces of **this task's own** split. ⛔ never an arbitrary task in the fleet |

⚠️ `ask_human` blocks until somebody answers **or the session's prompt cache expires**. That is
deliberate: an answer arriving while the session is warm costs a cache read, where the same answer
after a restart costs a full rebuild. ⛔ It replaced `request_human`, which routed through the approval
path — an agent asking *"OAuth, session cookies, or magic link?"* got back `The operator agreed.`
It supports multiple selection via `multi_select: true` (or `multiSelect`), extracts embedded XML
attributes, and detects multi-select intent from phrasing.

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
