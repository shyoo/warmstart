# Conversations — when a task reuses one, and when it starts fresh

Every task an agent runs begins by rebuilding the same thing: the project's instructions, its skills,
its file layout. Measured on 2026-08-28 with `claude 2.1.250`, saying *"remember this number"* in an
**empty directory** cost **41,542 cache-creation tokens**. In a real repository it is larger, and
every task was paying it.

This page is what the tool does about that, and what it costs you to let it.

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

**3. Sharing.** A task joins a conversation **another task** has been having. ⛔ **Off by default**,
because this one has a cost that is not measured in tokens.

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
| Project | the project's **Settings** tab → **Policy** → *Reusing conversations*, or `session.share` in `.multi_agent_controller/project.json` | `off` · `on` · `inherit` |
| Task | the **conversation** dropdown on New Task and its **Thread** tab | `inherit` · `on` · `off` |

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

1. **Same project** and **same account**.
2. **It holds a workspace.** A conversation with no worktree has nothing to lend.
3. **Nobody else has it.** Never one with a run in flight, and never one already handed to another
   task — see *the lease* below.
4. **Its CLI can resume.** Codex declares it cannot, today, because the flag is unwired here.
5. **It has room.** Past **60%** of its context window it is not offered: a borrowed conversation
   about to need compaction is a false economy, since you pay to read a large prefix and then pay
   again to compact it. ⚠️ A fraction, not a token count — windows across the fleet differ by an order
   of magnitude.

The emptiest qualifying conversation is offered first, since it has the most room for the borrower's
own work.

## The lease, and what happens to the branch

One task at a time may speak in a conversation. That is an exclusive claim rather than a check, so
two tasks in one conversation is not merely discouraged — it cannot be represented.

⚠️ A task resting at **`awaiting_human` does not hold the lease**. Its conversation may be borrowed
while it waits for you, and it takes the lease back when you reply.

When a borrower takes over, the worktree moves to **its** branch, and three notices go out:

- the parked task's thread gets a note saying where its tree went and that its branch is untouched;
- the agent is told, at the top of its next prompt, that **files it read earlier came from a different
  branch** and must be re-read;
- the log records the switch.

Coming back is the same move in the other direction. ⛔ **A worktree holding uncommitted work is never
moved** — the borrower starts a fresh conversation instead. Stashing to make room would take work that
is visible under **Loose ends** and hide it inside a stash you would have to know to look for.

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
