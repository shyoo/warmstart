# Glossary

These words mean specific things in Multi Agent Controller. Using them loosely makes the scheduler incoherent, so
they are worth pinning down.

---

**Fleet** — every worker Multi Agent Controller knows about, across all providers and accounts.

**Worker** — *an account or endpoint, i.e. a quota bucket.* One Claude subscription is one worker; a
second subscription is a second worker. A local model with no quota is also a worker. Each has an
**isolation root** holding its own credentials, written by the vendor's CLI and never read by
Multi Agent Controller.

**Session** — *one live agent process.* Has a model, an effort level, a workspace, a minted session
id, a context size, a cache expiry and a topic fingerprint.

> ⛔ **A worker is not a session, and the distinction carries the whole design.** *Quota* lives on the
> worker; *context* lives on the session. A task must be routed to a worker that can afford it **and**
> a session that already knows about it. Most orchestrators model only one of the two.

**Human-occupied worker** — an account whose quota Multi Agent Controller tracks but never spends, because a
person is using it by hand. Keeps the budget arithmetic honest without taking the account over.

**Worker health** — *whether work survives on this account*, which is a different question from
**identity** (*who is signed in*) and answered by different evidence. Identity is free and local and
cannot tell a live subscription from a lapsed one; health comes from a dispatch that produced **no
metered turn**, which is charged to the account rather than to the task. A `suspect` worker is a hard
gate on **work and judgment alike** - both read the same list in `src/daemon/eligibility.ts` - and it
also stops the background usage probe, since a refresh opens a real session and an account that
cannot authenticate simply fails to, every thirty minutes. Lifted by re-probing it by hand, which is
deliberately still allowed, or by one real turn.

---

**Project** — *a directory plus policy.* Git is **optional**: `vcs: git | none`. Branching,
committing and parallel workspaces are per-project **capabilities**, not universal assumptions, so a
media-generation or research project is a first-class citizen with no repo fiction. Policy lives in a
committed `.multi_agent_controller/project.json`; runtime state stays private in the OS app-data directory.

**Resident session** — *the conversation currently holding a workspace.* ⛔ **The session owns the
worktree, not the run and not the task**, so it keeps it for as long as it lives — which is what lets
a task resting at `awaiting_human` be replied to in the tree its own branch is checked out in. ⚠️ The
claim is taken under the task's name (there is no session until there is a directory to put one in)
and transferred the moment there is one. A pool with nothing free **evicts** rather than refusing: the
conversation whose prompt cache has already lapsed goes first, because its context is no cheaper to
reach than a cold start, and one with an open run is never touched.

**Session sharing** — *may a task join a conversation another task has been having?* Resolved task →
project → fleet, `off` at every tier until somebody says otherwise. ⛔ **An information boundary, not
a performance switch**: an agent that joins a conversation sees everything said in it, so sharing
never crosses a project or an account — and it changes nothing about **authority**, which is still
`mandate`'s to decide. See `docs/sessions.md`.

**Session lease** — *the right to be the task speaking in a conversation.* An exclusive Resource held
by the task, so two tasks in one conversation is unrepresentable rather than merely discouraged, and
`releaseAllFor(task)` returns it at the end of every run. ⚠️ A task parked at `awaiting_human` does
**not** hold one - its conversation may be borrowed while it waits, and it takes the lease again when
it is replied to. Borrowing moves the worktree to the borrower's branch and back again; ⛔ a tree
holding uncommitted work is never moved, and the borrower starts cold instead.

**Workspace** — *where a run executes.* For a git project, a pooled **git worktree** — a permanent
checkout, created once and reused, sharing one `.git` object store. For a plain directory, the
directory itself, as a pool of one. ⭐ A task filed into a project whose pool is full is **held at
`ready` with a reason on its row**, never failed, and never given a dependency on whoever holds the
tree — the hold is re-decided against `schedulingOrder` every tick, so a P0 filed later takes the
next free workspace. ⚠️ `workspaces.poolSize` (default 3) is the operator's cap and nothing grows it
automatically; when the fleet can run more sessions than the pool has trees, the hold says so.

**Trunk** — the project's main checkout. Used for integration and landing. ⛔ **Agents never work
here.** The task branch is created inside the claimed worktree, never in the trunk.

**Landing** — moving a finished task's branch onto the trunk: rebase, run the project's checks,
`git push origin HEAD:<target>`. ⛔ **A push, never a local ref move** — so `origin/<target>` is what
"landed" is measured against everywhere, and your own trunk is behind until you pull.
Implemented as a `LandingStrategy`; landing takes an exclusive `land:<project>` resource, because
three workspaces finishing at once would otherwise each rebase onto a main the other two are about to
move. ⭐ A task that finds that resource held **waits its turn** and records a dependency on
whoever was landing, rather than being refused — see `docs/landing.md`. ⚠️ *Whether* to land is a separate question from *how* — see **finish policy**. ⭐ **The branch
is retired afterwards** — by any finish that leaves nothing to land, not only a successful one — and
continuing the task cuts it again under the same name from `origin/<target>`.

---

**Resource** — *anything contended for.* Kinds: `exclusive` (capacity 1), `counted` (capacity N),
`rate_limited`. Workspaces are just a counted Resource, which collapses two mechanisms into one. So
are: a single browser profile, a credit-metered external API, a dev-server port range, a physical
device, a flaky test that must not run twice at once.

> The point of modelling these: **if the scheduler owns the claim, the lock is unnecessary.** Agents
> do not have to coordinate, because nothing dispatches two claimants at once. Hand-rolled locks in
> agent prompts are a symptom of the scheduler not knowing about a resource.

**External resource service** — an MCP server fronting something contended (credits, a browser, a
queue). Registered with a `probe` tool that reports availability; Multi Agent Controller then stops dispatching
contenders rather than letting them collide.

---

**Task** — *a thread of work with an assignee*, not just a prompt. Carries a multimodal message
thread, priority, deadline, dependencies (a DAG), a schedule (`not_before`), resource requirements,
constraints, a verification policy, and a status. ⭐ *Multimodal* stopped being aspirational on
2026-09-01 — see **Attachment**.

**Title, and title summary** — ⛔ **A task's title *is* its prompt.** `promptFor()` sends it to the
agent verbatim and the New Task form files the whole textarea into it, so a title is routinely a
paragraph and nothing may shorten it for the sake of a table — a truncated title is a truncated
instruction. ⭐ Since 2026-09-01 a separate `titleSummary` (**migration 29**) carries a one-line label the controller
writes, and every list, header and chip renders `titleSummary ?? title`. Most tasks have none, and
that is not a broken row: showing the prompt is the correct answer for them. The task thread's first
entry is always the full text, whatever the header says. Written for free by the four judgment calls
the scheduler already makes (each answer may carry a `summary`), and by a dedicated **`title`**
consult for everything else — the one judgment call that spends a turn without changing what runs, so
it is off by default behind the **Ask the controller to name long tasks** fleet setting, files one
question per tick, and never asks twice about the same task. ⚠️ Editing a title drops its summary: a
label for text nobody asked for any more is worse than no label, because the board still looks
authoritative.

**Prerequisite** — *an edge in the DAG somebody drew by hand.* `task_deps`, the cycle check and
`admit()` have been in the daemon since M2, and the only way to put an edge in was to be an agent
calling `task_create` with `depends_on`. ⭐ Since 2026-09-01 a person can too: the New Task form takes
prerequisites at filing — the task is born `blocked`, because `createTask` writes the edges *before*
it admits — and the task ledger adds or drops one afterwards through `task.addDependency` /
`task.removeDependency`, which re-run admission on the same call rather than leaving a `ready` row
the scheduler may dispatch a tick later, and hand back the redrawn list beside the task. ⛔ Refused
rather than recorded when it would close a cycle: a cycle found at the door is an error message, a
cycle found by the scheduler is a deadlock. ⚠️ A task already **running** is not clawed back — the
edge applies to its next dispatch, and the thread says which of the two happened. ⚠️ Only `completed`
releases a dependent, so the picker never offers a `cancelled` or `failed` task; a `completed` one it
does, because an edge satisfied the moment it is drawn is an ordinary thing to want to record.

**Attachment** — *an image on a message*, with its bytes on disk and its row in sqlite
(**migration 31**). Pasted or dropped into the New Task form or a thread note, downscaled by the
renderer to **1568px** on the longest edge before a byte leaves it, and stored under
`<dataDir>/attachments/<taskId>/`. ⛔ **Belongs to a message, not to a task**, which is what decides
when it travels: `promptFor` already computes which messages are outstanding, and the attachments of
those same messages are what rides with that prompt. Any other rule either replays a screenshot on
every run of a long task or drops it on the fresh session a preemption starts. ⛔ **Never trusted on
its label** — the magic number of the bytes decides what it is, because the file written is one an
agent is separately told by name to open. An upload whose form was abandoned is collected by
`prunePending`; see **Image input** for how the bytes actually reach each CLI.

**Image input** — *how a CLI can be handed an image, if at all*, declared per adapter as
`imageInput: 'inline' | 'spawn-flag' | 'none'`. ⛔ **Not a boolean, because the answer is not
yes/no.** Claude Code takes a base64 block in the stream envelope it is already sent (`inline`);
codex has no stdin channel at all and takes `-i <file>` on the process that runs the turn
(`spawn-flag`, so **initial prompt only**); Antigravity takes none — and does not ignore an image
block but **fails the entire turn** on one, `num_turns: 0`, measured 2026-08-31. That last fact is
why this is a gate in `sendPrompt` rather than a courtesy each adapter keeps for itself: a run that
died that way would read as the agent having failed the task. ⚠️ It replaced `multimodalInput`,
which was `true` on all three built-ins, read by nothing, and wrong about one of them. ⛔ **The
absolute path goes into the prompt text on every adapter regardless** — ~20 tokens, all three read a
PNG off disk with their own view tool, and on Antigravity it is not a fallback but the only channel
there is.

**Thread** — *a task's messages*, human and agent, in the order they were said. ⛔ **Not a
conversation.** A conversation is the agent's own session — it has a vendor id, you resume it with
`--resume` or `--conversation`, it can outlive the task that opened it and be borrowed by another.
A thread belongs to exactly one task and is never shared. One thread can be served by several
conversations, and one conversation can serve several threads, which is precisely why the two need
different words: the UI tab is **Thread** and the Settings page is **Conversations**, and naming both
of them "conversation" would make *"which conversation is this task in?"* ambiguous on the one screen
that answers it.

**Continuation** — *another run on a task that had stopped*, started by somebody replying to it. ⛔ A
run, never a new task: same thread, same budget, same branch. Nothing routes it by hand — the session
still holding its context scores highest, so the same worker, workspace and session are chosen because
they are cheapest. ⚠️ And when that session has already **exited** — which is the normal case, because
completion closes it — the run **resumes its conversation** rather than opening a new one: same row,
same id, `--resume` / `--conversation`. See `resumeSession` in `adapters.md`.

**Trunk tripwire** — *a run that produced nothing on its branch while the trunk moved is handed to a
person instead of being reported as finished.* Both halves are required and that is what makes it
usable: an operator committing to their own trunk is constant and blameless, and an empty branch is
the ordinary shape of a task that only answered a question. Together they are the signature of work
done in the trunk directly, which every check, rebase and landing policy sits downstream of and
therefore never sees. ⚠️ Detection, not containment — it says something already happened.

**Run** — *one attempt of a task on one session.* Carries the actuals: tokens, wall time, cost, and
the effective objective it ran under. Runs are what the estimator learns from.

**Assignee** — *who a task is with*, a worker or `'human'`. The human is modelled as a worker with
infinite quota and terrible latency. ⛔ **Not the answer to "which account did this."** Being handed a
decision is a temporary assignment, so every hand-off to a person overwrites it — which is why the
Worker column reads `ranOn` instead.

**`ranOn`** — *the account the task's most recent run was on*, derived from the runs and never stored
on the task. The one field that survives a hand-off, and therefore the only honest answer to which
account is spending on a task.

**`ranModel`** — *the model that same run was dispatched with*, derived from the same run `ranOn`
names, so the Worker column can stack the two in one cell. ⛔ Never re-resolved: what a task *would*
be given next is a different question (`resolveModelChoice`), and the two diverge the moment an
account's default changes under work that has already finished. ⚠️ Null until something has run, and
null on a run whose session had not learned a model yet — the UI then falls back to what the next
dispatch would ask for, and says which of the two it is showing.

**Approval** — *an interrupt on a session*, not a task: a permission or tool gate that blocks one
live session, with a closed answer set supplied by the adapter and a deadline equal to that session's
cache expiry. Answered by project policy where possible, by one keystroke on the **Attention bar**
otherwise. ⛔ Never captured by parsing the terminal — a mis-read approval card is an unattended
*yes*. Becomes an `awaiting_human` task only after it goes unanswered past `escalate_after`.

**Question** — *the third object.* An interrupt on one live session, like an **Approval** — but with
an answer set written by **whoever asked**, and an answer that is *content returned into the tool
result*, not a verdict. ⛔ That is why it is not an approval: you cannot remember "OAuth" as a project
rule, and a default of *no* answers nothing. Asked with `ask_human`, intercepted from a CLI's own
question tool, or — on an adapter with no MCP and therefore no `ask_human` — read off the
`NEEDS DECISION:` line that adapter's prompt asks it to end with, with one `- option — detail` bullet
per choice beneath it. ⛔ Those arrive **already parked**: the turn that asked is over, so there is
no waiter and nothing to return into. That is the only kind antigravity and codex can ask. Answered on the **Attention bar** where the options are few and short, in the task
thread otherwise — and always with a text box, because an option plus a caveat is a better answer
than either alone.

**Parked** — *a question that outlived its session.* Nobody answered before the session's cache
expired, so holding the process stopped paying for itself: the task rests at `awaiting_human` and the
question **stays open**. ⛔ Not an answer and not a refusal — timing out has never been either.
Answering a parked question writes it into the thread and **re-queues the task**, so the answer has a
run to arrive in: the same task, the same thread, a new run, with the answer left undelivered so the
next prompt carries it.

**`blocked`** — *a run that stopped to ask, not one that broke.* A `RunOutcome` beside `completed`
and `failed`. ⛔ It did the work up to the question and metered its turns, so it does not count
towards triage and does not bench the worker; ⚠️ it is not `completed` either, and the estimator
medians only completed runs.

**Completion mode** — *how far a dispatched agent is expected to get before it stops.* Resolved
task > project > fleet, like **finish** and **sharing**, and ⛔ defaulting to `autonomous` because
unattended progress is the premise of the tool. ⚠️ **Not a care setting**: an autonomous agent still
stops to ask when a decision changes what it builds. `checkpointed` is the other contract — report at
each phase boundary via `checkpoint` and wait — chosen per task, for work worth steering.

**Resting state** — where a cancelled task comes to rest: `paused_user` (*not now*), `draft` (*not
like this* — re-enters admission), or `cancelled` (*not at all*, terminal but on the record).
**Cancel is not delete**: cancel winds a run down through the preemption protocol and destroys
nothing. Delete is a separate, human-only, soft-by-default operation, and it never removes runs —
they are the estimator's training data and the record of real spend.

**Resolve** — *a person recording that a task is finished.* ⛔ A judgement, not a verification, and
written into the thread as one; `task_complete` stays the only signal that an **agent** finished. It
is the answer `awaiting_human` is asking for, and admits dependents exactly as an agent completion
does.

**`awaiting_human`** — the task needs a person. Its question lands in **My Queue**. The session
holding the context is a prime candidate for a keepalive, because human latency routinely straddles
the one-hour cache TTL — and a reply into a warm session costs `0.1·C` against `2.0·C` into a dead
one.

**`queued`** — ⛔ *not a status.* A task the scheduler passed over is still `ready` — it would be
dispatched this second if a worker could take it — and the reason it was passed over is written to
`holdReason`, not into the DAG. The UI renames `ready`-with-a-reason to **queued** at render time,
because inventing a status for "ready but nothing free" would put a lie in the graph to fix a gap in
the display.

**`maxConcurrent`** — *how many tasks one account may run at once.* Shown as **Max** on the Workers
row and editable there. Commissions at **1**, which is a cost decision rather than a provider limit:
parallel requests against one cached prefix each pay a cache write (`docs/cost-model.md` §1). ⛔ At
least 1 — a max of 0 leaves the worker enabled, its quota counted and its role honoured, and silently
never taking a task; the switch for *"do not use this one"* is `enabled`. ⚠️ No upper bound is
imposed: the ceiling is the account's own rate limits, and a number invented here would be a guess
presented as a rule. ⚠️ Bounds unattended **work** only — a `consult` is exempt and bounded
separately, and a session a task would *reuse* does not fill a slot because reusing one starts no
process.

**Model and effort** — *what answers a turn, and how hard it thinks.* Resolved **task → worker → the
CLI's own default**, and deliberately not through the project or the fleet: a model id belongs to one
CLI, so a default held anywhere that routes to several adapters is invalid most of the time. ⚠️ `null`
at the end is an answer — the vendor picks — not a missing setting. ⛔ Effort is dropped whole where
`selectableEffort` is false, because the CLI *refuses* the flag rather than ignoring it. ⭐ Both are
read at launch and apply to the **next** run: changing them inside a live conversation discards its
prompt cache, which `docs/cost-model.md` §11 prices.

**Quota pool** — *a separately metered allowance on one account.* Antigravity meters **Gemini apart
from Claude/GPT** — two five-hour windows and two weeklies on one login — so "how full is this
account?" has two answers and the right one depends on the model. ⛔ The dispatch gate resolves the
task's model first and asks for that pool; every other caller has no model in hand and gets the
**busiest** window, which the adapter aliases to the bare id `5h`. ⚠️ A model's pool is data on the
cost model, matched against the window's group by containment, because the vendor writes the panel
heading three different ways. Every other provider here has one pool and no group.

**Mandate** — *the authority a task runs under.* Inherited from its creator and **narrowed, never
widened**: allowed operations, project scope, remaining lineage depth, fan-out cap. A task that has
lost `spawn_tasks` cannot create children — not because a heuristic caught it, but because it has no
such authority.

**Budget** — a token grant, inherited as a *share* of the creator's remaining budget, so an
agent-generated subtree cannot outspend its root however many nodes it grows.

**Lineage depth** — how many agent generations a task sits from a human intent. Drives risk gating:
deeper means more scrutiny.

---

**Objective** — *the weight vector `{cost, velocity, quality}`*, summing to 1. Presets are just named
vectors (Economy, Balanced, Velocity, Quality). Resolution order: global → project → task. Consumed in
exactly two places — a `weights()` function feeding scheduler scoring, and a `policy()` object
consulted by the cache clock, model selector and preemption. ⛔ Anything else reading the objective,
or any code branching on a preset's *name*, is a bug.

**Cache clock** — the countdown to a session's prompt-cache expiry, and the decision made just before
it lapses: send it queued work, keepalive, compact, or let it go. See `cost-model.md` §3.

**Keepalive** — a trivial turn sent purely to refresh a cache TTL, which reads do for free. Costs
`0.1·C`, buys another hour, does not reduce context.

**Compaction reserve** — quota held back so every live session on a worker can still be compacted.
`/compact` fails at true 100%, which strands the context entirely. Two rungs: a token comparison
(needs R2, still unanswerable here) and the **percentage** — at the 92% `WINDOW_HIGH_WATER`, the same
reading that stops the fleet dispatching to an account says to save what it is holding. See
`cost-model.md` §5.

**Refusal vs caution** — what the vendor's live `rate_limit_event` `status` is saying. **`rejected`**
is a refusal: the turn did not happen, and one is enough to stop a run. **`allowed_warning`** is a
caution attached to a turn that *was served* — evidence that quota is moving, never proof the next
call fails. ⛔ Treating them alike preempted three runs at 17%, 0% and 19% of the window being warned
about (t71, 2026-08-31). A caution now lowers a routing score on its own but must be seconded by this
fleet's own reading of **the same window** before it ends anything. See `cost-model.md` §5.

**Preemption** — stopping a run before a quota window closes: wrap up, commit what compiles, write a
handoff, then compact or close. The task rests at `paused_quota` with `not_before = resets_at` **of
the window that stopped it** — a worker reports several and a weekly one is not a five-hour one, so a
reset borrowed from the wrong window parks a task for days. And
`resumeQuotaPaused()` — a clock tick beside `admitScheduled()` — puts it back to `ready` when that
time arrives. ⛔ It returns to the **queue**, not to a worker: the dispatch gate reads the quota again
and may still hold it, which is honest and visible in a way `paused_quota` for ever was not.
⛔ A window can also close **without warning**, and then it arrives as an error at the end of a turn
rather than as a signal before one: `api_error` carrying *"You've hit your session limit · resets
4am"*. That is the same event and it now has the same consequence — the adapter recognises its own
CLI's wording (`outOfQuota`), the run ends `preempted`, and the task parks on the window's reset. It
used to take the ordinary failure path to `awaiting_human`, a hold only a person can end, and on t108
(2026-09-02) a task sat there for three hours after its window had reopened.
⚠️ The same protocol also serves a **runaway stop** (`settings.autoRunawayStop`, default off), which
ends differently: no window is closing, so there is nothing to resume after and the task rests at
`awaiting_human` with no `not_before`. Preemption pauses; a runaway stop hands back.

**Handoff** — the note a preempted run leaves so its successor can continue. Prepended to the
successor's prompt.

**Finish policy** — what happens to the work when an agent reports a task complete, as a ladder of
five rungs each doing one thing more than the last: `await-human` · `commit-only` ·
`commit-and-verify` · **`commit-and-merge`** (the default) · `commit-and-push`. Plus two that are not
rungs: `pull-request` (a different destination) and `custom` (an instruction to the agent, not a
daemon action). Resolved task → project → fleet, each of the lower two able to say `inherit`.
⛔ **Preference, not authority** — `mandate.allowed ⊇ 'land'` still decides whether a task may land at
all, and no UI control may widen it. ⚠️ Not the same as **`Task.verification`**, which asks whether a
*person* should look before it lands. See `docs/landing.md`.

**Check commands** — the ordered shell commands a project declares in `project.json`, run in the
task's workspace after the agent commits, stopping at the first failure. They are what the verifying
rungs mean by *verified*. ⛔ **An empty list verifies nothing** — every project on day one — and the
tool says so rather than reporting a clean result. Proposed from `package.json` when a project is
added, edited in Project → Settings, or worked out by an agent as an ordinary task with a diff you
review.

**Rescue** — what becomes of work an interrupted run never committed, when its workspace has to be
taken away. ⭐ **Committed onto the task's branch** with a `Multi-Agent-Controller-Rescue` trailer, so
the next run inherits it wherever it is dispatched; stashed only when HEAD is detached and there is no
branch to commit to. ⛔ A rescue is not a result: while the branch tip still *is* one, nothing will
land it, and the run that picks it up is told what the commit is and that the tool wrote it. ⚠️ The
distinction earns its name — a stash belongs to a *repository*, a commit belongs to a *branch*, and
only one of the two travels (t91/t92, 2026-09-01). `landing.md`.

**Loose end** — work that exists and is going nowhere: uncommitted files in a pooled workspace, a
branch carrying commits nobody landed, a stash taken to free a slot, or a **branch left behind** —
a task branch carrying nothing the trunk does not already have, where only the name is at stake.
⚠️ Derived from git on demand, never stored — only dismissals are. ⛔ The branch rows are read
repository-wide rather than off a pooled workspace, because a branch at rest is what a finished task
leaves and no workspace has it checked out. Listed on Overview.

---

**Adapter** — the integration for one agent CLI (`claude-code`, `antigravity-cli`,
`openai-compatible`). Declares **capabilities** (what it can do — `manualCompact`, `resumeSession`,
`streamJson`, `classifierBackedAuto`, …) and **policy** (how it behaves — context management, quota
windows, preemption protocol, default permission mode, which cost model applies).

> ⛔ The scheduler asks `capabilities` and `policy`. It never asks *which* adapter. Antigravity having
> no `/compact` must express itself as a missing capability that removes two cache-clock moves, not as
> a special case in scheduling code. The same goes for its lack of an auto mode.

> **`gemini-cli` is not an adapter.** Google stopped serving individual accounts on **2026-06-18**;
> **Antigravity CLI (`agy`)** replaces it and is the Google adapter. The old CLI survives only under a
> Gemini Code Assist Standard/Enterprise licence.

**Transport** — how Multi Agent Controller talks to a session. `stream` (`-p` with stream-json over real pipes)
gives structured events, a programmatic approval channel, and free live rate-limit records; `pty`
hosts the real TUI and lets a human take the keyboard. A minted session id lets one session move
between them via `--resume`.

> ⛔ Not interchangeable plumbing, and measured rather than assumed: `--print` **exits immediately
> under a pseudo-terminal**, and the CLI's **workspace-trust dialog is skipped only in
> non-interactive mode** — so unattended work runs on `stream`, and `pty` is for a human at the
> keyboard.

> ⛔ **A stream transport is not automatically a conversation.** `codex exec` reads one prompt from
> stdin **to EOF**, runs that turn and exits, so its pipe must be closed for work to begin and there
> is no second prompt to send. Adapters say which they are (`streamPrompts`), because a scheduler that
> assumes a conversation will hold the pipe open and wait forever — and a session that will not take a
> follow-up cannot be steered, wrapped up, or asked to resolve a conflict.

**`task_complete`** — the worker-tier MCP call that reports a task finished. ⛔ The *only* signal that
a task succeeded. A clean exit code says nothing about whether the work was done, and reading the
terminal to guess is what this design refuses to do; a session that ends without it lands in
`awaiting_human`.

**Controller** — the LLM agent that makes judgment calls: decomposition, ambiguous routing, failure
triage, risk-gating agent-created work, and naming a task whose prompt is a paragraph. It is itself a worker in the fleet with its own quota, so when
its window runs low its next decision routes elsewhere. ⛔ It is **not** in the scheduling loop —
that loop is deterministic and costs nothing.

**orchestratord** — the long-lived daemon holding all of the above. Survives the UI closing, which is
the entire point.
