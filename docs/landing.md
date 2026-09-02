# Finishing a task — what happens to the work

When an agent says it is done, something has to decide what becomes of the branch it was working on.
This page is that decision: who commits, what has to be true before anything reaches your trunk, and
where work goes when the answer is "not yet".

⛔ **The tool never writes a commit.** Not on your behalf, not on the agent's. Deciding what to stage,
what to leave out, and what to run before any of it counts as finished is judgement that differs per
project and per person — it is what a `/commit` skill or a `CONTRIBUTING.md` encodes — and a daemon
applying a heuristic at the one moment nobody is watching is a worse copy of that judgement with less
context. Every orchestrator we surveyed lands in the same place: the agent commits, the tool decides
what happens next.

⛔ **And it never destroys work.** Not a dirty workspace, not a branch, not a stash. Anything the tool
declines to land stays exactly where it is and appears under **Loose ends** on the Overview page.

---

## The ladder

Five rungs, each doing everything the one below does **plus one thing**. That is what keeps this one
decision rather than five.

| policy | agent commits | daemon verifies | merges local trunk | deletes branch | pushes |
|---|---|---|---|---|---|
| `await-human` | | | | | |
| `commit-only` | ✔ | | | | |
| `commit-and-verify` | ✔ | ✔ | | | |
| **`commit-and-merge`** ⭐ default | ✔ | ✔ | ✔ | ✔ | |
| `commit-and-push` | ✔ | ✔ | ✔ | ✔ | ✔ |

And two that are **not rungs**:

| policy | what happens |
|---|---|
| `pull-request` | Push the *branch* and open a pull request. Never touches the trunk, so it is not "one more than push" — a different destination. |
| `custom` | Send the agent this project's own finishing instructions and let it do the rest. The tool does not land afterwards — your policy owns that step. |
| `inherit` | Take the answer from the tier below. Only valid on a project or a task. |

⛔ **`commit-after-verified` cannot exist**, and was asked for. The daemon never authors a commit, so
verification can only happen once there *is* one. `commit-and-verify` is the achievable shape: the
commit is unconditional and the **verdict** is what the check decides. A red check rests the task with
the output and the commit stays, because destroying committed work is the one thing this tool refuses
to do.

⚠️ Verification is not named in `commit-and-merge` or `commit-and-push` because **merging always
verifies** — merging unverified work into a trunk is worse than leaving it on a branch.

⚠️ `agent-lands` is the pre-2026-08-30 spelling of `commit-and-push` and is still read from an
existing `project.json`. A rename that silently changed what a config *does* would be worse than the
bug it fixed.

## Three tiers

The policy is resolved **task → project → fleet**, taking the first that is not `inherit`.

- **Fleet** — Settings → Global. The default for everything with no opinion of its own. Ships as
  **`commit-and-merge`**. ⛔ It changed from `commit-and-push` on 2026-08-30: every push to `main`
  starts a ten-job CI matrix, three of them macOS at 10x billing. Measured on this repository, 103
  runs in five days and an exhausted allowance. Nothing about finishing a task needed a remote, so a
  push is now something a person does on purpose.
- **Project** — the project's **Settings** tab → **Policy** → *Finish policy*, which writes
  `landing.finish` into `.multi_agent_controller/project.json`. Editing that file by hand is the same
  thing; the page writes the same key in the same spelling and drops the legacy `landing.strategy`
  when it does, so the file never carries two answers to one question.
- **Task** — the **finish** dropdown in the task's detail pane, changeable at any time, including
  while the task is running and after it has finished.

⚠️ `inherit` is a real value, not a blank. A task set to `inherit` follows its project as the project
changes; a task set explicitly to the same value does not. That difference is the reason the dropdown
offers it rather than showing an empty box.

⭐ **Changing a finished task's policy to a landing one lands it.** A task resting in
`awaiting_human` with a good branch is one decision away from the trunk, and making that decision is
what the dropdown is for. The same bar below is applied again — a task that is not safe to land comes
straight back with the reason.

## What "safe" means

The two rungs that move work — `commit-and-merge` and `commit-and-push` — do it with nobody watching,
so they are the ones with a bar. All of these must hold:

1. **The workspace is clean** — no modified files, no untracked files.
2. **The branch carries commits** `origin/<target>` does not already have — the remote, not your
   local copy of it, for the reason [below](#landed-means-pushed). A task that answered a question
   and changed no file is finished, and reporting it as *landed* would be false.
3. **The task's mandate allows `land`.** ⛔ This is authority, not preference: it is inherited down a
   lineage so an agent-spawned subtask cannot grant itself more than its parent had, and **no
   dropdown can widen it**.
4. **The project defines `check` commands, and they pass.** A project with no checks has nothing
   proving the work builds, so landing it unattended would be a guess. It stops and tells you to add
   them.
5. **The rebase onto the target applies.** If it does not, the task is not stopped — the agent is
   asked to resolve it, once. See [below](#when-the-branch-will-not-rebase).
6. **The branch tip is not a rescue** — not a `wip:` commit the tool itself made of work an
   interrupted run left uncommitted. ⚠️ Only the tip: a rescue the resumed run built on top of is
   ordinary history, and 4 is what judges the result.

Any failure sends the task to `awaiting_human` naming the condition — never a bare "could not land".

### 1 and 2 together are not evidence that the work was done

⛔ A task that answered a question and changed no file leaves a clean tree on a branch level with the
trunk. **So does a task whose whole afternoon was stashed out from under it by a preemption.** The
*nothing to land* verdict read the first and was equally true of the second: the task completed, the
branch was retired, and the work was never mentioned again (t91, t92, 2026-09-01).

⭐ So before declaring nothing to land, the tool asks `git stash list` whether this repository holds
anything taken **off this branch**. If it does, the task rests at `awaiting_human`, the branch is
kept, and the message says how to get the work back. ⚠️ Attributed by branch, never counted globally:
stashes live in the repository's shared object store, so every pooled workspace reports the same list
and a global count would let one unrelated leftover hold every future task in the project. Git's own
`On <branch>:` prefix is the tie.

## When the branch will not rebase

The commonest reason a finished task does not land is that the target moved underneath it. Two tasks
cut from the same trunk, both touching the same lines: the first lands, and the second no longer
rebases. Nothing is wrong with either one.

⭐ **This is asked before the decision to land, not discovered during it.** `git merge-tree` merges
the branch and the target **in memory** — it writes no index and no working tree — so the question
*would this rebase?* is safe to ask while the agent is still working in that workspace. That timing
is the whole point: it means the conflict can be handed back to the conversation that wrote the code,
instead of surfacing after the session is gone.

When it conflicts, the tool starts the rebase and **leaves it stopped at the conflict**, then asks:

> Your branch no longer rebases onto `origin/main` — it moved while you were working.
>
> I have started the rebase for you and left it stopped at the conflict. These files are conflicted:
>
>     src/renderer/src/components/FleetStrip.tsx
>
> Resolve each one, `git add` it, then `git rebase --continue` until the rebase finishes, and report
> the task complete again. ⛔ Keep both sides' intent — the other change landed on purpose. Do not
> `git rebase --abort`, do not force-push, and do not start new work.

⚠️ **The markers are left in the tree deliberately.** An agent handed an *aborted* rebase has to
reproduce the conflict before it can start on it, which is most of the round trip.

⚠️ **Once, and only once** — the same rule as the uncommitted-work ask, and a **separate** counter.
A task that was already asked to commit still gets its one conflict ask; sharing one counter would
drop it into `awaiting_human` carrying a conflict nobody had ever asked it to fix.

⛔ **A task whose mandate excludes `land` is never asked.** Resolving a merge is authoring a commit on
somebody's trunk by a longer route, and authority is checked first.

If the agent cannot be reached, or is asked and the branch still does not rebase, the rebase is put
back and the task rests in `awaiting_human` naming the conflicting files. Nothing is discarded either
way — aborting a rebase returns the branch to exactly where it started.

## When the agent leaves work uncommitted

The tool asks it to commit, **once**:

> You have 3 uncommitted file(s). Commit them on `multi-agent-controller/t12-fix-dialog`, then report
> the task complete again. Do not start new work.

On a `custom` project, it sends your instructions instead of that sentence.

⚠️ **Once, and only once.** Between the instruction and the agent's next report nothing about the
task has changed, so the same decision would be reached again — and each repeat is a real billed turn
spent telling an agent to do what it just did.

If the work is still loose after that ask — the agent ran out of window, was preempted, or could not
comply — the task rests at `awaiting_human`, the files stay exactly where they are, and the workspace
appears under **Loose ends**.

### When the workspace has to be taken away first

A preemption or a cancel ends with the workspace being parked, and a parked workspace is detached
from the branch. Whatever the run had not committed has to go somewhere first.

⭐ **It is committed onto the task's branch**, with a `wip:` subject and a
`Multi-Agent-Controller-Rescue` trailer, so the next run of that task inherits it by doing nothing
more than checking the branch out — in whichever workspace it is later dispatched into. The run that
picks it up is told, in its first prompt, what the commit is and that the tool wrote it.

⛔ **Such a commit will not land** — condition 6 of the bar above, because nothing in it has been
compiled and a rescue leaves a *clean* workspace that the rest of the bar would wave through.

⚠️ **Only if there is a branch to commit to.** A pool member at rest has a detached HEAD; there the
work is stashed as it always was, which is what condition 1's note is about.

⛔ Measured 2026-09-01 (t91, t92): both runs were preempted with everything uncommitted, both had it
stashed, both branches were left at the base commit. The resumed runs saw empty branches and started
over — one spent 13.3M tokens re-deriving work that was in `git stash list` the whole time.

## Loose ends

Four kinds of work that exists and is going nowhere, listed on **Overview**:

- **uncommitted** — files in a pooled workspace that no commit holds.
- **not landed** — a branch carrying commits `origin/<target>` does not have, whose task has
  finished. ⚠️ This is the one that is easiest to lose: nothing is dirty, nothing looks wrong, and the
  work is simply never mentioned again.
- **stashed** — work the tool moved out of the way to free a workspace for the next task. Recover it
  with `git stash list` and `git stash show -p` in the workspace.
- **branch left behind** — a task branch carrying nothing `origin/<target>` does not already have.
  No work is at risk; the name is all that is left of a task that finished, or was cancelled before
  it wrote anything.

Each offers **Land it** (branches with commits only), **Retire it** (branches left behind only),
**Make a task** — which files a normal task to go and deal with it — and **Dismiss**, which only
hides the row.

⛔ Nothing here deletes work. **Retire it** deletes a *name*, and the daemon re-derives the proof
that the branch carries nothing before it does — the panel may be minutes old, and a branch that has
gained a commit since it was scanned comes back refused, with the reason.

⛔ **The branch scan is repository-wide, and until 2026-09-01 it was not.** Every other row here
comes from reading a *pooled workspace* and reporting the branch that workspace has checked out — so
a branch at rest, which is exactly what a finished task leaves, was invisible to all of it.
Measured: `t23` (finished 2026-08-29) and `t79` (cancelled 2026-08-31) were both still in this
repository days later, both carrying zero commits, neither reported anywhere.

## Merging locally, and the trunk you are standing in

⛔ **`commit-and-merge` will not merge into a trunk you are working in, and cannot.** Git refuses
outright to update a branch a worktree holds — measured 2026-08-30:

```
fatal: refusing to fetch into branch 'refs/heads/main' checked out at 'C:/Dev/multi_agent_controller'
```

So the merge is a `git merge --ff-only` **inside the trunk**, attempted only when the trunk is on the
target and has nothing uncommitted in it. When it is not, the branch is kept, and the task says which
of the three it was: a dirty tree, a detached HEAD, or another branch checked out.

⚠️ **This means `main` stops moving on the days you are mid-edit in it**, and finished tasks queue as
branches saying *"committed and verified, waiting for a clean trunk"*. That is the cost of the safe
default. ⛔ The alternative — stashing your work to make room — is not on offer: the tool does not
reach into a checkout somebody is typing in.

## Landed means pushed

⚠️ This section describes `commit-and-push` and `pull-request`. The default no longer pushes.

⭐ **Landing is `git push origin HEAD:<target>`.** The tool never moves your local branch — it has no
business writing to a checkout you are standing in — so `origin/<target>` is the only ref that
answers "did this work land?", and everything asks it: the safety bar, the loose-ends scan, and the
message you get back. Your own trunk only catches up when you `git pull`.

⚠️ **Which means the agent may have landed the work itself, and that is fine.** A project whose
finishing instruction ends in a push — most `/commit` skills do — leaves a branch with nothing left
to land. That is success, not a refusal, and the message says so and tells you how far your trunk is
behind:

> `t22-…` carries no commits `origin/main` does not already have. The work reached `origin/main`
> without passing through here — your local `main` is 2 commit(s) behind it, so run `git pull` in the
> trunk to see it.

⛔ Measured 2026-08-29: while the two refs were compared inconsistently, this read as *"carries no
commits that `main` does not already have"* — true of the ref it named, false of the ref it used, and
indistinguishable from work that had vanished.

⭐ **The branch is deleted, exactly as it is when landing succeeds.** Nothing is lost — every commit
on it is already on `origin/<target>`, which is what the count above establishes — and a branch kept
past that point is a dead name the pool accumulates one of per task. ⚠️ If another worktree still
holds the branch, it is left alone and the finish is still a success — but it is now **reported**, as
a *branch left behind*. ⛔ Before that it was reported nowhere at all: the delete is best-effort and
swallows every failure, nothing retried, and the only trace a stranded branch left was an absent
sentence in a finish message.

⭐ **A cancelled task gives its name back too**, under exactly the same licence: only when the
resting state is `cancelled` — *not at all*, as opposed to `paused_user`, which resumes into its
branch — and only when the branch carries no commit the trunk does not have. ⚠️ Best-effort: a task
cancelled while running still has its workspace, so the branch is still checked out and git declines;
it shows up as a *branch left behind* instead.

⚠️ **Continuing the task afterwards re-creates it under the same name**, cut from `origin/<target>`,
so a resumed task opens on top of the work that landed rather than behind it. The branch *is* the
task's name — every log line and every loose end reads it — so it comes back as itself, not as
`-2`.

## Two tasks finishing at once

⭐ **They queue, and both land.** Landing is serialised per project — two rebases onto a target that
is moving underneath them race, and one of them loses work — so a task that arrives while another is
landing **waits for its turn** rather than being refused. The wait happens inside the run that was
already waiting: nothing is re-dispatched, and no agent starts a second time over work that is
already committed.

You see it as one extra message, then the ordinary one:

> Waiting to land: t26 (…) is landing right now, and landing is serialised per project so that two
> rebases cannot race for the trunk. This one is queued behind it and now depends on it, and will
> land by itself.
>
> Landed as `a41f9c2` onto `main`. It queued behind t26 and landed once that finished.

⭐ **The queued task gains a dependency on the one it waited for**, so "t27 landed after t26" is still
answerable tomorrow. ⚠️ The edge is a *record*, not an instruction: the task is deliberately **not**
moved to `blocked`, because `blocked` means work waiting to be dispatched and would send a finished
task back to an agent the moment its blocker completed.

⚠️ **The wait is bounded at 15 minutes**, sized against a landing that runs the project's own checks.
If it runs out, or you cancel the task while it is queued, you get the ordinary hand-off — and the
message says the branch is fine and that landing it again is all it needs, because a queue that ran
out is a retry rather than an investigation.

⛔ Measured 2026-08-29: t26 and t27 were run in parallel and finished within the same second. One
landed; the other was told *"Landing failed: another task is landing right now"* and parked on a
person's desk with a perfectly good commit on an intact branch. The lock was doing its job — the
caller was reporting a queue as a failure.

## Configuring a project

```json
{
  "schema_version": 1,
  "landing": {
    "target": "main",
    "finish": "commit-and-merge"
  },
  "check": ["npm run typecheck", "npm run lint", "npm test", "npm run build"]
}
```

- `landing.finish` — `await-human` · `commit-only` · `commit-and-verify` · `commit-and-merge` ·
  `commit-and-push` · `pull-request` · `custom` · `inherit`.
- `landing.finishInstruction` — what `custom` sends the agent, and **read only under `custom`**.
  Set it beside any other `finish` and it is inert; the example above therefore omits it.
  ⛔ It is sent verbatim, so it is yours to keep honest. Naming a slash command binds the project
  to a CLI that has that skill — measured on t56, 2026-08-30, `"Run /commit and follow every one of
  its six steps. Do not push."` reached codex, which has no `/commit`, and whose sixth step is the
  push the same sentence forbids. Under every other rung the tool composes the sentence itself and
  says plainly whether to push.
- `landing.target` — the branch to land on. Defaults to `main`.
- `check` — the commands every verifying rung runs. ⛔ An **empty list verifies nothing**, which
  is every project on day one; the tool says so on the task rather than reporting a clean result.
  Edit them in Project → Settings, or file a task to work them out.
  ⚠️ Keep them fast and deterministic; the heavier
  suites belong in the finishing instruction, where a human or an agent is watching the result.

⚠️ **`landing.strategy` is the old spelling** and is still read, so an existing file keeps working:
`auto-land` → `commit-and-push`, `leave-branch` → `await-human`, `pull-request` unchanged. Write
`finish` in new files. Where both appear, `finish` wins.

## Why it is built this way

Measured on 2026-08-28, from one task (t5) that produced both failures this page exists to prevent:

- The agent finished with two files uncommitted. Landing was refused, the task rested at
  `awaiting_human`, and the message naming the files was the only record.
- The work was then committed by hand as `ea05929` — a clean commit, on a good branch, in a pooled
  workspace — and **nothing in the app ever looked at that branch again.** It was recovered a day
  later by cherry-picking it out of the worktree.

Neither is a bug in landing. Both are the absence of an answer to *what happens to work the tool
declines to take*, which is what this page now specifies.
