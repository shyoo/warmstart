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

## The five policies

| policy | what happens when the agent reports it is finished |
|---|---|
| `await-human` | Stop. The branch is intact and the task waits for you. |
| `agent-lands` | Land it unattended — but only if it is [provably safe](#what-safe-means). Otherwise it stops and says which condition failed. |
| `pull-request` | Push the branch and open a pull request. A human merges. |
| `custom` | Send the agent this project's own finishing instructions and let it do the rest. The tool does not land afterwards — your policy owns that step. |
| `inherit` | Take the answer from the tier below. Only valid on a project or a task. |

## Three tiers

The policy is resolved **task → project → fleet**, taking the first that is not `inherit`.

- **Fleet** — Settings → Global. The default for everything with no opinion of its own. Ships as
  `agent-lands`.
- **Project** — `landing.finish` in `.multi_agent_controller/project.json`.
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

`agent-lands` is the only policy that pushes to a trunk with nobody watching, so it is the only one
with a bar. All of these must hold:

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
5. **The rebase onto the target applies** without conflict.

Any failure sends the task to `awaiting_human` naming the condition — never a bare "could not land".

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

## Loose ends

Three kinds of work that exists and is going nowhere, listed on **Overview**:

- **uncommitted** — files in a pooled workspace that no commit holds.
- **not landed** — a branch carrying commits `origin/<target>` does not have, whose task has
  finished. ⚠️ This is the one that is easiest to lose: nothing is dirty, nothing looks wrong, and the
  work is simply never mentioned again.
- **stashed** — work the tool moved out of the way to free a workspace for the next task. Recover it
  with `git stash list` and `git stash show -p` in the workspace.

Each offers **Land it** (branches with commits only), **Make a task** — which files a normal task to
go and deal with it — and **Dismiss**, which only hides the row.

⛔ None of the three deletes anything.

## Landed means pushed

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

## Configuring a project

```json
{
  "schema_version": 1,
  "landing": {
    "target": "main",
    "finish": "agent-lands",
    "finishInstruction": "Run /commit and follow every one of its six steps."
  },
  "check": ["npm run typecheck", "npm run lint", "npm test", "npm run build"]
}
```

- `landing.finish` — `await-human` · `agent-lands` · `pull-request` · `custom` · `inherit`.
- `landing.finishInstruction` — what `custom` sends the agent. Naming a slash command works on a CLI
  that has skills and still reads as a plain instruction on one that does not.
- `landing.target` — the branch to land on. Defaults to `main`.
- `check` — the commands that gate `agent-lands`. Keep them fast and deterministic; the heavier
  suites belong in the finishing instruction, where a human or an agent is watching the result.

⚠️ **`landing.strategy` is the old spelling** and is still read, so an existing file keeps working:
`auto-land` → `agent-lands`, `leave-branch` → `await-human`, `pull-request` unchanged. Write
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
