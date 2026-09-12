# Conversations — when a task reuses one, and when it starts fresh

Every task an agent runs begins by rebuilding the same thing: the project's instructions, its skills,
its file layout. Measured on 2026-08-28 with `claude 2.1.250`, saying *"remember this number"* in an
**empty directory** cost **41,542 cache-creation tokens**. In a real repository it is larger, and
every task was paying it.

This page is what the tool does about that, and what it costs you to let it.

> **Audience:** anyone touching continuation, resume, conversation reuse or sharing.
> **Authority for:** when a task reuses a conversation, the lease, and what a borrower is told.
> What a reuse *saves* is [`cost-model.md`](cost-model.md); how the scheduler scores warmth is
> [`routing.md`](routing.md); session state as a union is [`data-model.md`](data-model.md) §4.

---

## Three things, in order of how much they save

**1. Continuing.** A task replied to while its session is still alive goes straight back into it.
Always on, nothing to configure — the workspace, the branch and the context already belong to that
task and nothing is disclosed to anyone.

**2. Resuming.** A task whose session has *exited* — the normal case, since completing a task closes
it — reopens the same conversation rather than starting a new one. `--resume` on Claude Code,
`--conversation` on Antigravity. Also always on.

> Measured the same day: the resumed turn read back **41,542** cached tokens and wrote **65**.
> ⚠️ On Antigravity the conversation is restored but no cache read is reported and input tokens roughly
> double, so there it buys *context*, not a discount. See `docs/adapters.md`.

**3. Sharing.** A task uses a conversation **another task** has been having. ⛔ **Off by default**,
because this one has a cost that is not measured in tokens. It takes two forms, and the second is the
one that will fire on most fleets:

- **joining a live one** — the lender is parked (`awaiting_human`, say) and its session is still up;
- **reviving a finished one** — the lender is done, its session closed, and the borrower reopens that
  conversation with `--resume` instead of starting cold. Since completing a task closes its session,
  nearly every warm prefix in a project belongs to a task that has finished, which is why this is the
  common case rather than the exotic one.

## What sharing actually costs

An agent that joins a conversation **sees everything said in it** — the other task's instructions, its
files, its mistakes. That is the point (it is why the context is worth having) and it is also the
risk. So:

- Sharing never crosses a **project**. One repository's work never appears in another's conversation.
- It never crosses an **account**, because a conversation lives inside one worker's isolation root.
- It changes **nothing about authority**. A task's `mandate` still decides what it may do. Sharing
  lets a task *read* a conversation; it never lets one act beyond what it was granted.

⛔ Because it widens who sees what, it ships **off at every tier**. Upgrading into a build that has
this feature does not turn it on.

## Turning it on

| tier | where | values |
|---|---|---|
| Fleet | Settings → Global → **Reusing conversations** | `off` · `on` |
| Project | the project's **Settings** tab → **Policy** → *Reusing conversations*, or `session.share` in `.warmstart/project.json` | `off` · `on` · `inherit` |
| Task | the **Reuse / Fresh** pill under the New Task prompt, and its **Thread** tab | `inherit` · `on` · `off` |

Resolved **task → project → fleet**, taking the first that is not `inherit`.

⚠️ `inherit` is a real value, not a blank. A task left on it follows its project as the project
changes; a task set explicitly to the same value does not.

⚠️ Changing a task's setting takes effect on its **next** run. Unlike the finish policy — where
switching a finished task to a landing policy lands it — this only records a preference. A task
already talking in a conversation is never moved out of it, because moving an agent mid-thought is
the one thing this must not do.

```json
{
  "schema_version": 1,
  "session": { "share": "on" }
}
```

## When a conversation will not be offered

All of these must hold, and each refusal is named in the log rather than reported as "no suitable
session":

1. **Same project** and **same account**. A task pinned to a particular worker or adapter is never
   handed a conversation on another one: a constraint that held everywhere except when a warm
   conversation was available would mean *unless it is inconvenient*.
2. **Same model, and same effort.** ⭐ A prompt sent into a conversation is served by the process
   already running it — the model and the reasoning effort were fixed when that process was spawned,
   and there is no argument that changes them mid-conversation. So an Opus task is never quietly
   served by a Sonnet conversation because that one happened to be warm. ⚠️ Compared against what
   this task *would resolve to on that account* (task → worker → the CLI's own default), which is the
   same answer the dispatch itself reaches. ⚠️ Unknown is not a mismatch: a session whose CLI chose
   its own model records none, and reading that as "different" would refuse a real saving over a
   fact nobody wrote down.
3. **It holds a workspace** — for a live conversation, since one with no worktree has nothing to
   lend. A finished one is reopened in the borrower's own tree, and it must be *the same directory*:
   Claude Code files transcripts under an encoding of the cwd, so `--resume` from anywhere else
   finds nothing and starts cold while reporting success. A lendable conversation is therefore also
   a preference about which worktree to claim — the borrower asks the pool for that one, after its
   own.
4. **Nobody else has it.** Never one with a run in flight, and never one already handed to another
   task — see *the lease* below.
5. **Its CLI can resume.** Codex declares it cannot, today, because the flag is unwired here.
6. **It has room.** Past **60%** of its context window it is not offered: a borrowed conversation
   about to need compaction is a false economy, since you pay to read a large prefix and then pay
   again to compact it. ⚠️ A fraction, not a token count — windows across the fleet differ by an order
   of magnitude.

The emptiest qualifying conversation is offered first, since it has the most room for the borrower's
own work.

## Too full to lend, and what the clock does about it

Past **70%** of its window, a conversation a queued task was refused becomes something the cache
clock will **compact** — move 5b. ⭐ This is the one compaction argued from the queue rather than
from a clock: every other one asks *how long until this session is likely to be wanted*, and a
conversation a ready task has already been turned away from is not idle in that sense at all. It is
wanted now, and shrinking it converts a conversation that can serve nobody into one the queue can
use — typically letting the borrower skip a ~41.5k-token cold start on its next tick.

⛔ Only when the borrower has nothing else it could join, only when being full is the *sole* refusal,
and only with compaction permitted — a compaction bought for a conversation the task still could not
have is the fleet paying for a saving nobody can collect. ⚠️ Asked once, not every tick: a landed
compaction zeroes `tokensSinceCompact`, and the clock's outstanding-move check holds the request
open while it lands.

⚠️ The gap between 60% and 70% is deliberate. In that band a conversation is merely not worth
borrowing; compacting it would spend a full read of a context nobody has asked for.

## The lease, and what happens to the branch

One task at a time may speak in a conversation. That is an exclusive claim rather than a check, so
two tasks in one conversation is not merely discouraged — it cannot be represented.

⚠️ A task resting at **`awaiting_human` does not hold the lease**. Its conversation may be borrowed
while it waits for you, and it takes the lease back when you reply.

When a borrower takes over, the worktree moves to **its** branch, and three notices go out:

- the parked task's thread gets a note saying where its tree went and that its branch is untouched;
- the borrower's thread gets *Joined t<seq>'s conversation — this agent can see that task's work*
  (`event: conversation.joined`, the saving in its detail). ⛔ A task continuing its **own**
  conversation writes nothing — this line exists because a borrow is an information boundary;
- the agent is told, at the top of its next prompt, that **files it read earlier came from a different
  branch** and must be re-read;
- the log records the switch.

Coming back is the same move in the other direction. ⛔ **A worktree holding uncommitted work is never
moved** — the borrower starts a fresh conversation instead. Stashing to make room would take work that
is visible under **Loose ends** and hide it inside a stash you would have to know to look for.

## When the agent comes back on its own

⭐ **A resting conversation can start speaking again without anybody prompting it** (t369,
2026-09-11). An agent that leaves a command running in the background — a CI watch, a long build —
ends its turn, and its own CLI hands it the result minutes later and re-invokes it. The task is at
`awaiting_human` by then and its run is closed, so `runForSession` finds nothing and every assistant
message was dropped on the floor: no peephole, no thread line, no metering, and a task reading *your
turn* with its agent mid-sentence.

⛔ **The answer is a run**, because that is what work is here: `resumeIdleConversation` in
`scheduler.ts` opens one on the first assistant message, which puts the turn back on the path that
already handles all of it — the peephole finds the run, the metering finds the run, and the ordinary
turn end closes it and writes the agent's words into the thread. The task goes to `running`, a
`conversation.resumed` line marks the boundary, and it rests again when the turn ends.

⛔ **It is not a dispatch and asks no dispatch question** — no quota gate, no scoring, no eligibility.
The agent is already talking on an account that is already spending; refusing would not save a token,
only the record of one. ⚠️ Four refusals, each a way this would be wrong: the conversation must still
be open, the task must be resting rather than running, the **daemon** must not be the one who spoke
(a cache-clock keepalive's reply is our turn, not the task's — `sendPrompt`'s `housekeeping` option),
and the last run must have ended more than five seconds ago, because the tail of a turn can arrive
after the record that ended it.

## What a returning agent is told, and what it is not

A run into a session **that has already heard this task** is sent the new message and nothing else. No
restated title, no re-appended contract, no re-sent orientation — that session read all of it on its
first turn and has not stopped since. What it does get is one sentence re-anchoring it: *your
instructions from the start of this task still apply*, plus how this run is to be reported finished
(`task_complete`, or the `TASK COMPLETE:` line for an adapter with no MCP).

⛔ **Re-teaching a session what it already knows is not free and not neutral.** It costs ~200 tokens a
turn, and it reads to the agent as new instruction — an agent told its task afresh alongside a
follow-up has to work out which of the two it is being asked to do. Conversations have been sent this
way since t260; ordinary work tasks joined them in t286.

Three things put the full framing back, and each is a case where the session genuinely does not hold
it:

| case | why |
|---|---|
| a **cold or borrowed** session | it has never heard this task |
| a **compaction** landed since this task last spoke | the framing may have been summarised away with everything else — read from the `compactions` table, against the start of this task's last run in that session |
| the conversation **contract was withdrawn** | the turn is now under a different contract from the one it was told, so it is told the new one. ⚠️ Neither Commit nor Land withdraws it any more — both leave the task an open conversation — so the one thing that reaches this is an operator setting the task’s own **finish** dropdown |

⚠️ Plan tasks are the deliberate exception: a planning or resolving turn always carries its full
instruction, because that instruction rolls up what the children actually did and is new every time.

## What a cold agent is told first

Ahead of the task itself, a cold prompt names the orientation documents this project actually keeps —
`AGENTS.md` (how to work in this codebase), `HANDOFF.md` (where the work stands), `README.md` (what
the project is) — one clause each, rules first.

⛔ **Only the ones on disk are named.** Telling an agent to read a `HANDOFF.md` a repository has never
had sends it looking, finding nothing, and spending a paragraph deciding whether the tool is wrong or
the checkout is. The three names are the same set the add-project wizard offers to scaffold, so a
project that took the scaffolding gets the sentence and one that declined it is untouched.

A project may also add a **seeding prompt** of its own — *Read CLAUDE.md before you start*, *the API
contract lives in docs/api.md* — carried verbatim, after the doc line rather than instead of it. Both
live under `prompt` in `.warmstart/project.json` and are set from the project's
**Settings** tab → **Cold start**:

| tier | where | values |
|---|---|---|
| Project | **Settings** → **Cold start** → *Orientation docs*, or `prompt.orientation` | `auto` (default — name the ones that exist) · `off` |
| Project | **Settings** → **Cold start** → *Seeding prompt*, or `prompt.seed` | any text, or empty for none |

⚠️ Both travel on exactly the prompts that restate the task — which is to say cold, borrowed, and
post-compaction runs, and no others. A project that turns orientation `off` and writes no seed is back
to the prompt as it was before t286.

## What a borrower is told

An agent reopening another task's conversation is told so **at the top of its first prompt**: that
everything above belongs to a different task, that it is background rather than instructions, and
that any file it means to rely on must be re-read. ⛔ And its own prompt is restated in full, which
a resumed conversation of its *own* would not be — there the conversation already contains it. The
failure this prevents is not a stale file: it is an agent that carries on somebody else's work
believing it is its own.

The lender's thread is told too, by name, on the run that borrowed it. ⛔ *Who else has been in this
conversation* is the one question sharing makes unanswerable from every other screen.

## Reading what happened

A task's **Thread** tab lists its runs. Each is marked **warm** or **new**, and carries **the id of
the conversation that served it** — click it to copy. That is the string to pass after `--resume` or
`--conversation`, so it is the vendor's own id where the CLI named its conversation and ours where it
took the one we gave it.

⛔ Per run, not per task. A task that ran three times may have run in three different conversations —
which is the whole point of resuming and sharing — and the ledger beside the thread names only the
latest. ⚠️ Runs recorded before this existed show no warm/new marking, rather than guessing.

⚠️ **Thread is not Conversation.** The tab holds a task's messages; a conversation is the agent
session those messages were said in. One thread can be served by several conversations, and one
conversation can serve several threads. See `docs/glossary.md`.

**Settings → Conversations** is the other direction: every conversation the fleet has opened, which
account and worktree it belongs to, what branch its tree is on, and — expanded — **which tasks it
served**. The header counts how many served more than one task, which is what sharing looks like from
the outside.

⛔ That count is the reason the page exists. A task's own pane says which conversation it is in;
nothing else says who *else* has been in it, and once a conversation outlives the task that opened it
that is the difference between the saving working and an agent having read work nobody meant to show
it. Both look identical from the task list.

⚠️ Read-only, deliberately. The only honest actions would be *run a task in it*, which the task pane
already offers, and *close it*, which the cache clock owns — and a close button beside a live agent
is an invitation to kill a run by tidying up.

## Why it is built this way

The gates above are mechanical — no scoring, no model judgement about whether two tasks are "related".
That was deliberate. A topic score has no ground truth: when it misfires there is nothing to check it
against, and being wrong means an agent has quietly read work it was not given. A rule you can predict
from the outside is worth more here than one that is right slightly more often.

⚠️ Scoring is not ruled out — the gate returns a ranked list precisely so a score can join the
comparator later — but it is not what decides whether two tasks may see each other's work.
