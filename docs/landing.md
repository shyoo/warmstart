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

> **Audience:** anyone changing finishing, landing, rescue or the loose-ends scan.
> **Authority for:** the finish policies and how they resolve, the landing bar, rescue commits,
> and what happens to work the tool declines to land.
> Branch and worktree mechanics are [`architecture.md`](architecture.md) §4; the commit workflow
> a *human or agent* follows in this repo is [`development.md`](development.md) §7.

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

And three that are **not rungs**:

| policy | what happens |
|---|---|
| `pull-request` | Push the *branch* and open a pull request. Never touches the trunk, so it is not "one more than push" — a different destination. |
| `custom` | Send the agent this project's own finishing instructions and let it do the rest. The tool does not land afterwards — your policy owns that step. |
| `report-only` | The deliverable is on the **thread**. Nothing is expected on the branch, so a clean branch with no commits completes rather than being handed back to a person. It starts from the **local landing target**, even when project delivery follows `origin/<target>`: research has to see the code the operator sees (t385 was cut six commits back, before debate mode existed). ⭐ And because the thread is the deliverable, `landCompletion` writes the run's **closing prose** (the peephole's run tail, last `REPORT_PROSE_CHARS`, minus lines the summary already holds) *after* the reported summary — a debate seat that obeyed a one-line completion hint was leaving a sentence where its position should be (t382). |
| `inherit` | Take the answer from the tier below. Only valid on a project or a task. |

⛔ **`report-only` is the one policy that exempts a task from the empty-branch guard, and it does so
only because the operator said in advance that this task was never going to write a commit.** The
guard (t17) is correct and stays: an empty branch is otherwise indistinguishable from an agent that
committed in the trunk. The check sits **before** the uncommitted-work step as well as before the
guard — a report-only task is never asked to *commit* — and **after** the rebase-in-progress guard,
which outranks everything.

⛔ **`done` means the branch is exactly as it started, and then the branch is retired.** This rung
lands nothing, so a commit or a file left behind can only become a loose end (t393–t395, 2026-09-12).
So: a clean tree with no commit of its own is `done`, and `landCompletion` deletes the branch through
`finishWithoutLanding`. Anything left is `ask-agent` **once** — keep what matters in the summary, undo
the edits, `git reset --keep` its own commits off — and still anything left on the second report is
`await-human`, with the work intact. The tool discards nothing itself. ⚠️ "Its own" is
`commitsOnlyOn` (commits on neither the local target nor `origin/<target>`), never `landedRef`: the
branch is cut from the local target, so on a trunk ahead of its remote the `landedRef` count is the
trunk's unpushed history. ⚠️ The closing contract in `prompt.ts` drops the squash, rebase and "commit
what you have" clauses for this rung on every adapter.

⭐ **It is wider than the debate that motivated it.** Migration 51 added `non_gradable` because *"some
tasks complete valid work with no commits"* and the only answer was an operator ticking a box
afterwards. A research task, a question, a review can now be filed as what it is. ⚠️ It is offered in
the composer's finish menus and refused by the thread's **Commit** button, where it is the one option
guaranteed to do nothing (`COMMIT_RUNGS`, `src/renderer/src/lib/finishrung.ts`).

⛔ **`commit-after-verified` cannot exist**, and was asked for. The daemon never authors a commit, so
verification can only happen once there *is* one. `commit-and-verify` is the achievable shape: the
commit is unconditional and the **verdict** is what the check decides. A red check rests the task with
the output and the commit stays, because destroying committed work is the one thing this tool refuses
to do.

⚠️ Verification is not named in `commit-and-merge` or `commit-and-push` because **merging always
verifies** — merging unverified work into a trunk is worse than leaving it on a branch.

⛔ **A `conversation` task answers `await-human` from its kind, above all three tiers.** Not a default
it starts on — a chat filed into a project set to `commit-and-merge` would otherwise land the
repository every time the agent said something conclusive. The override holds only while the task's own
policy is `inherit` (`isOpenConversation`), and **nothing in the thread writes a real rung**: the only
thing that does is an operator setting the task's own **finish** dropdown, which is them saying to
finish this like a work task.

⛔ **A conversation lands as often as it is asked to, and a landing never ends it.** This is the
2026-09-10 change, and it is a correction: Commit and Land both used to write the chosen rung onto
`finish_policy` first, and that write took the task out of `isOpenConversation` **for ever**. One
landing and the chat stopped being a chat — the kind stopped answering `await-human`, the turn
contract switched to the one-shot work contract, and the next `task_complete` completed the task. So
a conversation could reach `main` exactly once. Only **Finish** and **Stop** end a conversation now.

- **The agent commits on its own branch whenever that helps**, which is how work survives a
  preemption, and is told so in `conversationInstruction`. What it may never do is merge or push to
  the landing target by hand.
- **It lands only when the person asks**, by calling the `land_work` MCP tool
  ([`mcp.md`](mcp.md) §3). The rung comes from the ask, or — absent one — from the project's own
  policy with the conversation-kind override skipped, which is what the thread shows as
  *inherited*. It is passed *through* the landing rather than persisted.
- **Commit** still asks the agent rather than committing — the daemon does not author commits, the
  same rule `commit-after-verified` runs into above — and the instruction now carries the rung: commit,
  then `land_work` with it. On an MCP-less adapter it says to report the commit ready so the person can
  press **Land**, decided from `capabilities.mcp` and never from an adapter name.
- **Land** does the same thing from the operator's side, spending no turn.

⛔ **Each landing cuts the next numbered branch**, because the landing retires the one the work was
on. `warmstart/t343-<slug>` → `warmstart/t343.2-<slug>` → `.3`, cut from the target the landing just
moved, so the next stretch of work starts on top of what landed rather than behind it. The counter is
`tasks.branch_unit` ([`data-model.md`](data-model.md)); `branchNameFor(seq, title, unit)` writes the
name and both readers that parse a seq back out of a branch skip the unit, because the task is the
same task however many times it has landed.

⚠️ **A conversation's own landings are subtracted from the trunk tripwire**, exactly as a Plan &
Split sibling's are and for the same reason: *empty branch + target moved* stops being evidence of
anything once the task itself is the thing that moved the target. See the tripwire below.

⚠️ **Nothing about the landing bar is relaxed.** `land_work` and **Land** both run the identical
`decideFinish` — the mandate, a clean tree, real commits, the project's checks read from disk, the
rescue-tip rule — under the same per-project landing lease. A refusal moves nothing at all: it does
not write a rung, does not rest the task, does not touch the branch, and hands back the reason
verbatim.

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
  `landing.finish` into `.warmstart/project.json`. Editing that file by hand is the same
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
   them. ⛔ **Read from disk at the moment of the decision, never from `projects.config_json`** —
   that column is a *cache* of a file in your own repo, refreshed only on a cold dispatch, so a task
   running all afternoon on one warm conversation would otherwise be judged against a config read
   hours earlier. ⭐ t338, 2026-09-10: the Warmstart rename moved `.multi_agent_controller/project.json`
   to `.warmstart/project.json` under a running pre-rename daemon, which cached an empty config; the
   next build could read the new path and never did. Three runs of that branch were verified against
   real checks and the next two stopped at *"this project defines no check commands"* — a bar the
   work met, failed by a stale copy. `reloadProjectIfPresent` in
   [`projects.ts`](../src/daemon/projects.ts) is the reader; `projectpolicy.test.ts` pins it.
   ⭐ **And the pre-rename `.multi_agent_controller/project.json` is read again** (2026-09-11). It is
   the one thing the rename could not migrate, because it is a *tracked file in your own repository*
   and moving it is not the tool's to do — so `projectConfigPath` tries the new spelling, then the
   old, and only ever **writes** the new one. ⛔ The write path is the half that bites: an edit seeds
   from whichever file was read and promotes it, because starting from a bare `{schema_version: 1}`
   just because the *new* path was absent would drop every key the read had reported to the UI a
   moment earlier. The old file is left exactly as it was, and `writeStarterConfig` will not shadow
   it.
   ⭐ **A red check is handed back clean and whole** (2026-09-11). The checks run with
   `NO_COLOR=1`/`FORCE_COLOR=0` and their output is passed through `stripAnsi` regardless, because
   t344 and t347 put vitest's escape codes verbatim into the thread (`←[31m←[1m FAIL`) and into the
   instruction the agent was sent; the thread keeps the last **4,000** characters rather than 2,000,
   which is what it takes for a runner's summary to still name the failing test. ⛔ **And the retry
   that follows is routed by one classifier, `resolveRetryCauses` in `@shared/tasks`, read by the
   card and by `resolveRetryOnTask` alike.** The daemon used to keep its own copy whose first rule
   was `/conflict|rebase/` — matching *"the project checks failed after rebase"*, the very reason a
   red check writes — so both of those tasks were told three times to rebase a branch whose rebase
   was a no-op, reported complete each time, and hit the same red test on the next landing without
   ever having been told its name. The check-fix instruction now also says the bar in full: the
   named failure first, then every `check` command exactly as written and in full, because *"focused
   daemon tests"* green is what t347 reported over a suite the landing found red.
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

### When the trunk moved while the branch stayed empty

⭐ **The trunk tripwire.** A branch with no commits is ordinary when a task only answered a question, and
the trunk moving is ordinary when an operator is working. But together — an empty task branch and a trunk
that gained commits during that run — they are the signature of an agent that committed directly to the
trunk instead of its assigned branch.

Because commits on the trunk bypass checks, rebases and landing policies, the task is handed to human
review at `awaiting_human`.

⛔ **A third condition, because Plan & Split makes the first two ordinary.** A split's pieces land onto
their shared plan branch *while their siblings run* — by design, and constantly — so for a piece the
pairing above stops being evidence of anything. Movement that is attributable to a **sibling's** landing
(matched against each sibling's recorded `landed_head_sha`) is subtracted before the rule is applied.
⛔ Not an exemption for children: a piece that commits onto the plan branch instead of its own branch is
the same failure one level down, so anything left unaccounted for still fires, and the report names only
the unexplained commits.

⛔ **And a fourth, because a conversation that lands makes them ordinary too.** A conversation lands,
carries on talking, and then answers a question without writing a file — which is an empty branch and a
target that moved during the same run, moved by *this task*, on purpose, minutes earlier. So the
commits this task's own landings are recorded as having put there (`task_commits`) are subtracted as
well. Same shape as the sibling rule, one relationship over: movement with a known author is not
evidence against anybody, and anything left over still fires.

In the UI, you can:
- **Mark done** — if you inspected the commits in trunk and accept them as the finished work.
- **Resolve & retry** — sends the branch back to an agent to rebase onto the moved trunk, ensure all
  intended changes are committed and verified on the task branch, and report complete. One button
  however many causes match: a landing that failed two ways (conflict plus failing checks, e.g.)
  stacks every matching explanation under it instead of asking the same question twice.
- **Stop here** or reply directly in the thread.

⛔ **"Retry landing" is never offered for an empty branch.** `relandTask` requires unlanded commits on
the branch and fails if there is nothing to land.

## When the branch will not rebase

The commonest reason a finished task does not land is that the target moved underneath it. Two tasks
cut from the same trunk, both touching the same lines: the first lands, and the second no longer
rebases. Nothing is wrong with either one.

⭐ **This is asked before the decision to land, not discovered during it.** `git merge-tree` merges
the branch and the target **in memory** — it writes no index and no working tree — so the question
*would this rebase?* is safe to ask while the agent is still working in that workspace. That timing
is the whole point: it means the conflict can be handed back to the conversation that wrote the code,
instead of surfacing after the session is gone.

⭐ **And the agent is asked to look before it says it is finished.** The closing contract every work
task gets (`integrationClause`, [`src/daemon/prompt.ts`](../src/daemon/prompt.ts)) requires the agent,
immediately before `task_complete`, to fetch the landing target, rebase onto it if the branch has
fallen behind or diverged, resolve every conflict, and **re-run the validation** on the rebased branch
— and forbids reporting complete while a conflict is unresolved or a rebase is in progress. The target
named is the one the landing will really use (`landingTargetFor`), so a task landing on a release
branch is not told to rebase onto `main`.

⚠️ **This narrows the window; it does not close it.** The target can still move between the agent's
check and the landing, so the reading below remains the backstop and nothing here is allowed to assume
the branch is current. What it removes is the *stale* case — a divergence that sat on disk, unlooked-at,
for the length of the run — which is what t363 (2026-09-11) was: sound work, `task_complete` sent, the
conflict found afterwards by the tool, with the one agent holding the context of the change already
gone. ⛔ Withheld where it cannot be acted on: a non-git project, a planning turn that has written no
code, and an open conversation (which lands through `land_work`, and that does the rebase itself).

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

> You have 3 uncommitted file(s). Commit them on `warmstart/t12-fix-dialog`, then report
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

⛔ **And the slot has to be a repository first.** t410 (2026-09-13): an agent rewrote ws3's `.git`
pointer to a spelling Windows git cannot follow, the park failed, the slot was released still holding
the branch, and the operator's **Reassign** died on *"already used by worktree at ws3"*. Every park
and every prepare now begins with `ensureWorktreePointer`, which runs `git worktree repair` on a
pointer that does not resolve — measured to mend exactly this — before anything asks git about the
directory. See `docs/adapters.md` for why a bridged agent was tempted.

⭐ **It is committed onto the task's branch**, with a `wip:` subject and a
`Multi-Agent-Controller-Rescue` trailer, so the next run of that task inherits it by doing nothing
more than checking the branch out — in whichever workspace it is later dispatched into. The run that
picks it up is told, in its first prompt, what the commit is and that the tool wrote it.

⛔ **Such a commit will not land** — condition 6 of the bar above, because nothing in it has been
compiled and a rescue leaves a *clean* workspace that the rest of the bar would wave through.

⚠️ **Only if there is a branch to commit to.** A pool member at rest has a detached HEAD; there the
work is stashed as it always was, which is what condition 1's note is about.

⛔ **And only if nothing was hidden from `git status`.** Before it looks, `rescueDirt` clears
`assume-unchanged` and `skip-worktree` off every index entry (`unhideIndexEntries`), because `status`
honours those bits and `switch` does not. Measured on t353/t355, 2026-09-11: Codex, refused a file
write by its sandbox, staged straight into the index, committed, and marked all eleven files
`assume-unchanged` — `status` read clean, the rescue did nothing, and the next two `switch`es in that
slot died on *"local changes would be overwritten"*. Whatever was behind the bit is **stashed, never
committed**: in that case the working tree *lagged* the commit, and a `wip:` of it would have put a
revert of the agent's own work at the tip. The stash label says how many were hidden.

⛔ Measured 2026-09-01 (t91, t92): both runs were preempted with everything uncommitted, both had it
stashed, both branches were left at the base commit. The resumed runs saw empty branches and started
over — one spent 13.3M tokens re-deriving work that was in `git stash list` the whole time.

## When the run committed in another repository

Both ladders measure the task's own checkout — its worktree, or the trunk — so an agent that committed
somewhere else used to finish as *nothing to land*. ⛔ Measured on t491 (2026-09-16): filed on
`sunghwanyoo-site` about a commit in `warmstart-site`, the agent committed its rephrase **there**; the
trunk finish saw no commits on `sunghwanyoo-site`'s `main`, wrote *"no commits reached `main`"*, and
completed a task whose work sat unpushed in another repository. An agent running with the operator's
own authority (Antigravity, an unattended Claude) can do this; a sandbox only narrows it.

`strayCommits` (`straycommits.ts`) now runs **before either ladder**:

- **Where to look comes from the run, what happened comes from git.** Every absolute path in the run's
  recorded tool lines is a candidate; its repository counts only if that repository's `HEAD` reflog has
  a `commit` entry timestamped inside the run. A repository the agent merely read produces nothing.
- **Excluded:** the project checkout and every worktree sharing its git directory (another task's pool
  member is not this run's stray), the task's workspace, and every directory granted to it.
- **An unpushed stray holds the task** at `awaiting_human`, naming each commit and repository. ⛔ It is
  never pushed for you: another repository's checks and remote are no project's policy here. A stray the
  agent already pushed is named on the thread and the ordinary finish continues.

⚠️ **Best effort in both directions.** It misses a repository reached only by a relative `cd`, or named
before the bounded activity tail (`RUN_KEEP`) rolled over; and it counts a commit somebody else made in
the same repository during the run. The second costs a click; the first is the silent completion this
exists to stop, so a task that finished with nothing to land while the work plainly happened still
deserves a look at the repositories it touched.

## Loose ends

Five kinds of work that exists and is going nowhere, listed on **Overview**:

- **uncommitted** — files in a pooled workspace that no commit holds.
- **not landed** — a branch carrying commits that neither `<target>` nor `origin/<target>` has, whose
  task has finished. ⚠️ This is the one that is easiest to lose: nothing is dirty, nothing looks wrong,
  and the work is simply never mentioned again.
- **stashed** — work the tool moved out of the way to free a workspace for the next task. Recover it
  with `git stash list` and `git stash show -p` in the workspace.
- **branch left behind** — a task branch carrying nothing the local or remote target does not
  already have.
  No work is at risk; the name is all that is left of a task that finished, or was cancelled before
  it wrote anything.
- **merged, branch left** — a branch whose recorded pull request GitHub reports merged, and whose
  local tip is still the head it merged. A squash or rebase merge leaves every commit "ahead" of the
  trunk, so before 2026-09-12 this read as *not landed* (t389). The row says why the sweep kept it,
  when it did.

Each offers **Land it** (branches with commits only), **Delete it** (branches with commits only, the
same row as **Land it**), **Retire it** (branches left behind only), **Clean up** (merged branches
only — the same re-checked retirement the pull-request sweep does, run now, with the reason back if
it still refuses), a panel-wide **Check merged PRs** that runs the sweep without waiting five minutes,
**Make a task** — which files a normal task to go and deal with it — and **Dismiss**, which only
hides the row.

⭐ **Finishing a conversation releases its worktree before Finish reports success.** A conversation
keeps a live session and workspace while it waits for another turn. When the operator finishes it,
Warmstart asks that session to stop, waits up to 15 seconds for the process to exit, then parks and
releases the workspace. This ordering matters to **Retire it**: before t467, Finish returned after
only asking the process to stop, so Loose ends could show the empty branch while the session still
claimed its checkout and the immediate retirement refused. Measured on t466 (2026-09-15): the task
and run were completed while session `753261d2` remained live with ws2's open claim.

⛔ **Delete it is the one button on this panel that discards work, and it does so on purpose.**
Everything else here either does nothing destructive or re-derives its own proof that nothing is
being lost before it acts. **Delete it** is the opposite case: the operator is looking at a branch
with real commits and saying, explicitly and after a confirmation prompt, that they are not needed.
It still refuses a branch a worktree holds, exactly as **Retire it** does — a checked-out branch is
somebody working, and the daemon does not switch a checkout to get at it — unless that worktree is an
idle, unclaimed, clean pool member, which is exactly what `parkWorkspace` would detach anyway
(`idlePoolHolder`, the same licence the merged-PR sweep steps off on, [below](#landed-means-pushed)).
It does not require `ahead === 0` the way **Retire it** does, because the whole point is to remove
commits the trunk does not have.

A refusal names the action that failed and the remedy. An operator checkout says to switch that
checkout to another branch; a claimed pool member says to stop or finish its work; a dirty pool
member says to commit or move its files. The UI says **Could not retire/delete/clean up**, never the
ambiguous *kept it*.

⛔ Everything else here leaves work intact. **Retire it** deletes a *name*, and the daemon re-derives
the proof that the branch carries nothing before it does — the panel may be minutes old, and a branch
that has gained a commit since it was scanned comes back refused, with the reason.

⛔ **The branch scan is repository-wide, and until 2026-09-01 it was not.** Every other row here
comes from reading a *pooled workspace* and reporting the branch that workspace has checked out — so
a branch at rest, which is exactly what a finished task leaves, was invisible to all of it.
Measured: `t23` (finished 2026-08-29) and `t79` (cancelled 2026-08-31) were both still in this
repository days later, both carrying zero commits, neither reported anywhere.

⛔ **A row counts what deleting the branch would lose, not what has shipped** — `commitsOnlyOn`, not
`landedRef`. Measured 2026-09-12: debate seats t393–t395 each sat exactly on local `main` with no
commit of their own, and each was listed as carrying 15 unlanded commits, because local `main` was 15
ahead of `origin/main`. A finish verdict still asks `landedRef`; only this panel changed question.

## Merging locally, and the trunk you are standing in

⛔ **`commit-and-merge` will not merge into a trunk you are working in, and cannot.** Git refuses
outright to update a branch a worktree holds — measured 2026-08-30:

```
fatal: refusing to fetch into branch 'refs/heads/main' checked out at 'C:/Dev/multi_agent_controller'
```

So the merge is a `git merge --ff-only` **inside the trunk**, attempted only when the trunk is on the
target and has nothing uncommitted in it. When it is not, the branch is kept, and the task says which
of the three it was: a dirty tree, a detached HEAD, or another branch checked out.

⭐ **The trunk is checked before the rebase and the checks run, not after.** Until t259 the dirty
trunk was discovered past both — so a landing spent the rebase and up to thirty minutes of checks and
then failed with a bare file count. `merge-local` now refuses in `canLand` when the trunk cannot take
the merge, and re-checks inside the landing before rebasing (the post-checks gate stays, because the
trunk can become dirty while the checks run). A dirty trunk names its files — how many are
modified/tracked versus untracked, the first five by name — and says to commit, stash, or clear them
in the trunk checkout.

⛔ **A fourth answer, *the trunk could not be read*, is git refusing to start there at all — and the
one time it happened it was not the operator's doing.** t446 and t447 (2026-09-14) both finished and
both stopped on `fatal: Invalid path '/mnt'`: the trunk's `.git/config` carried
`core.worktree = /mnt/c/…/ws3`, written by an `npm test` a WSL-bridged agent ran with `GIT_DIR`
leaked into its environment (`docs/adapters.md`, the muse table). The landing now runs
`repairTrunkConfig` before it asks the trunk anything, which removes a `core.worktree` naming
anywhere but the trunk and logs what it removed; the same repair runs before a dispatch's base
lookup, a prepare and a park. Only that one key: a `[user]` the same leak wrote is left for the
operator to judge.

⛔ **A Plan & Execute executor is the one child of a plan task that does not.** Where a child is cut
from and where it lands are two questions, and this shape answers them differently: the executor is
still cut from the planner's branch — that costs nothing, and anything the planner did leave behind
travels with the work rather than being stranded — but its `landingTarget` is `null`, which resolves
to the **project's** target. There is no resolution turn to carry a plan branch any further, and a
piece that merged into a branch nobody will ever land is work that has quietly gone nowhere. So
`plannerBranchFor` keeps asking `isIntegrationParent` (the base) and `createTask` asks
`integratesChildren` (the target). ⭐ `strategyFor` then picks the project's ordinary strategy rather
than `merge-branch`, without being told to — it chooses from **data**, the task's resolved target
against the project's, and never from a task kind.

⭐ **Split work merges into the planner's branch, not the trunk.** When a task is a child of a plan task,
its target ref is the planner's branch (`plannerBranchFor()`). Merging updates the planner branch directly
via `git branch -f <planner-branch> <commit>` without touching the trunk, keeping `main` clean until the planner
or user merges the plan.

⚠️ **This means `main` stops moving on the days you are mid-edit in it**, and finished tasks queue as
branches saying *"committed and verified, waiting for a clean trunk"*. That is the cost of the safe
default. ⛔ The alternative — stashing your work to make room — is not on offer: the tool does not
reach into a checkout somebody is typing in.

## Merging into a branch nobody is standing in

⛔ **`merge-branch` is the sixth strategy, and it exists because `merge-local` structurally cannot land
a split's piece.** A piece lands onto its **planner's** branch, so under `merge-local` every piece would
require the operator's own checkout to be sitting on that plan branch — which is never acceptable.

So the fast-forward is done with `git update-ref` from inside the piece's own worktree, against a branch
that is checked out nowhere:

0. ⭐ **Free any of this tool's own pooled workspaces still sitting on the target**, and only those.
   Whatever an interrupted run left in such a slot is committed onto the branch first, so nothing is
   discarded to make room. ⛔ **Before the rebase**, because that commit moves the target — parking
   later would move it out from under a piece that had just been rebased onto it, and step 4 would
   then refuse the landing this step had made possible.
1. Rebase the piece onto its target. ⭐ This is also what absorbs a **sibling that landed while the piece
   ran**, which is the common case rather than an edge one.
2. Run the project's checks.
3. ⛔ Verify the target is checked out in **no** worktree — asked of `git worktree list`, never assumed.
   A failure to read the list counts as *held*: the safe direction is to decline the merge.
4. ⛔ Prove the fast-forward with `merge-base --is-ancestor`, then write it with the three-argument
   `update-ref`, which is a **compare-and-swap**: a sibling that landed between the proof and the write
   makes this fail rather than silently discarding its commits.

⛔ **Step 0 is what stops a split wedging, and the wedge was real.** Phase 1 parks the planner's slot off
the plan branch, but parking is best-effort — a slot that is busy, dirty, or caught by a daemon restart
keeps the branch. Step 3 then refuses *every* piece for ever; the pieces rest at `awaiting_human`, which
is not a settled status, so the planner stays `blocked` on children that can never settle and no part of
the plan can move again without a person at a git prompt. ⚠️ The narrowness is the safety: only members
of this project's workspace pool are freed. The operator's trunk, and any worktree they made by hand, are
left exactly where they are and step 3 still refuses for them — a worktree holding a branch is somebody
working, unless it is one of ours.

⚠️ **Chosen from data, never from a task kind.** `strategyFor` picks it when the task's resolved landing
target differs from the project's own — and only in place of a strategy that was going to merge anyway.
A task told `commit-only` or `pull-request` keeps that answer whatever its target is.

⚠️ Two pieces finishing together contend for the same branch, so the landing lease is keyed on the
**branch** rather than the project — the same queue mechanism `merge-local` uses, under a different key,
so an ordinary task landing onto `main` never waits behind them.

⛔ **Every prompt that names a ref names *this task's* target.** A piece's recovery prompts — the one
sent when its landing conflicts, and the one sent when its target moved under an empty branch — resolve
the base through the task, not the project. Measured on t192: both resolved it from the project, so a
piece was told to rebase onto `main` and land on `main`, and it did exactly that — putting a subtask's
work on the trunk while its planner waited for a branch that never moved. A wrong ref in a prompt is not
a wrong sentence; it is work on the wrong branch, by an agent doing as it was told.

⛔ **A plan branch is never pushed.** `landedRef` prefers `origin/<target>` when it verifies, so a pushed
plan branch would start being measured against the remote and local merges into it would read as
unlanded.

## Landed means pushed

⚠️ This section describes `commit-and-push` and `pull-request`. The default no longer pushes.

⭐ **Landing is `git push origin HEAD:<target>`.** The tool never moves your local branch — it has no
business writing to a checkout you are standing in — so `origin/<target>` is the only ref that
answers "did this work land?", and everything that asks that asks it: the safety bar and the message
you get back. (The loose-ends scan asks a different question — see above.) Your own trunk only catches up when you `git pull`.

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

## What the landing remembers

⛔ **A successful landing writes the commits it made into `task_commits` before the branch is
retired.** `retireBranch` deletes the branch seconds later, so the sha is only knowable at that
moment; the row is the task's own answer to *what did I write*, and the quality review's first
question. Multiple commits are all recorded, oldest first — `git log base..head`, or the tip alone
when the strategy could not name a base — and a task that lands a second time **adds** to its list.

⛔ **A range is not a list, and for a task that landed twice the range is wrong.** The older
`landed_base_sha`/`landed_head_sha` pair spans everything between two landings, which on this fleet
means grading five other tasks' commits as t124's. `resolveRange` therefore asks `task_commits`
first and only falls back to the range; where the recorded commits are not exactly what `base..head`
contains, the diff is taken as one `<sha>^!` patch per commit instead.

⛔ **A landing's range is not the same question as a task's authorship, and conflating them graded
other people's work.** Landing is measured against `origin/<target>` — that is the invariant, and it
is right, because a landing that only moved a local branch has not landed. But on a machine whose
local trunk is *ahead* of the remote, the push carries every earlier task's commits too, and
`origin/main..HEAD` names all of them: measured on t369 (2026-09-11), one landing recorded **23**
commits for a task that wrote **one**. `attributionBase` in `landing.ts` therefore reads
`refs/heads/<target>` **before** the rebase and starts the range there when that commit is both
downstream of the pushed base and an ancestor of what landed — the two conditions that make it a
provably tighter floor rather than a guess. Fail either and the base the landing already had is used,
because a narrower range nobody can prove is worse than a generous one. `claimedByAnotherTask` is the
backstop beneath it, dropping a commit some other task already recorded as its own — never the tip,
which a landing must always record for itself.

⛔ **The message says what the landing did, one clause per fact it actually knows.** For most of
this tool's life it said *"Landed as a166a6a onto main."* and nothing else — while the landing had
just rebased the branch onto the trunk, run every check the project declares and waited for them,
fast-forwarded the trunk without pushing, and deleted a branch it had proved held nothing new. Four
facts, known at the moment they were worth stating, discarded; and the one thing the sentence did say
is the one thing a person cannot check by looking. `landedMessage` in `landing.ts` composes it from
`LandingResult`, and a clause is written **only** when the fact behind it is known: a strategy that
does not verify says nothing about verification rather than implying it happened, and `checksPassed:
0` reads *"nothing was verified — this project declares no check commands"*, which is the opposite of
verified rather than a smaller amount of it.

⛔ **The headline keeps its exact shape** — sha, `onto`, target — because `salvageLandedCommits`
reads it back off the thread. The sha and the target are now fenced as code (the thread renders
inline code spans; see `lib/codespans.ts`), and that parser was taught both spellings in the same
change: a wording change it did not know about would have stopped it recovering commits **silently**,
since salvage reports what it recognised and has no way to report what it did not. ⚠️ A clause may be
*appended* to the headline — `LANDED_AS` matches a prefix and the salvage query is a `like 'Landed
as %'` — but nothing may go in front of the sha or between it and the target.

⭐ **And where the work went is on the headline, not behind the expander** (t369, 2026-09-11). *"Landed
as `5ebb3b42` onto `main`"* left an operator who had asked for commit·verify·merge·**push** unable to
tell whether the push had happened — `main` is both the local branch and the name of the thing on the
remote, and the one clause that distinguished them was inside a ⓘ nobody opens. A landing that pushed
now reads *"…onto `main` and pushed to `origin/main`"*; one that only moved the local branch reads
*"…onto `main` — local only, **not pushed**"*, because that is the case where the operator's own
checkout is ahead of the remote and nothing else will tell them. A strategy that cannot know says
neither.

⚠️ **The local-only wording is a fact about that landing, not a prediction of the repository forever.**
If an operator later pushes the trunk, Warmstart fetches `origin` at startup and every five minutes;
once it proves the named commit is an ancestor of `origin/<target>`, it adds *“Later observed: … is
now on `origin/<target>`”* beneath the original message. The historical line remains intact: the
follow-up must not claim Warmstart made that later push.

⭐ **`pull-request` landing announces the PR and recovers on retry** (t373, 2026-09-12). A task landing
under the `pull-request` strategy pushes the branch and opens a GitHub pull request via `gh pr create`.
Its headline states *"Pull request opened for `<sha>` into `<target>`: <url>"* and its detail reports
*"Pushed to `origin/<branch>`."*, rather than claiming work merged onto trunk. If `gh pr create` fails
because the pull request already exists on the remote, the error URL (or `gh pr view`) is recovered,
the push is acknowledged, and the landing succeeds idempotently on retry. ⛔ Only a `/pull/<n>` URL,
and the **last** one (`pullRequestUrlIn`): that error quotes the whole `gh pr create` command line,
title and body included, ahead of gh's own URL, and on t389 (2026-09-12) the first-URL rule recorded
the issue the title named, `…/issues/133`, as the delivery. Migration 69 removed such rows.

⛔ **Updating an already-open PR retries the push force, and that is deliberate** (t509, 2026-09-17).
The closing contract every run gets forbids rewriting commits already on the *landing target*
(`prompt.ts`), but says nothing about the task's own branch — so a later run legitimately squashes
commits its earlier run already pushed as an open, unmerged PR, and a plain `git push` then rejects
as non-fast-forward. `pullRequest.land` retries once with `--force-with-lease` when the first push is
rejected, never on any other failure; nobody but this task pushes to its own branch, so the retry is
safe and a lease still refuses if the remote moved for an unrelated reason. Before this, that
rejection surfaced as an ordinary landing failure ("…may already be pushed"), which was misleading —
the push had *not* landed — and repeated identically on every **Retry landing** press, because
`canRelandTask` (`taskview.tsx`) hid the button after the first such failure: a blanket
`/Retry landing failed/` exclusion, meant to stop a truly empty branch from being retried forever,
also caught every retriable cause. Only the specific unfixable ones (no commits, a conflict, failing
checks, uncommitted files, the trunk tripwire) hide the button now.

⭐ **Opening finishes the coding run; delivery continues without an agent** (t375, 2026-09-12).
Before success is reported, Warmstart persists the exact PR URL, target, branch and head SHA. A
zero-token five-minute reconciler asks `gh pr view <url>` for that identity, survives restarts, and
records an observation error and age instead of treating an unavailable GitHub as success. An open
PR keeps neither a task nor a session running. Closed without merge keeps the branch and says so on
the thread. Merged first fetches `origin/<target>`, proves GitHub's merge commit is there, records it
for quality review, and says so on the thread; it never pulls or moves the operator's local trunk.
Whenever a delivery is recorded, reconciled, or its branch cleaned up, the daemon emits `project.changed`
and `task.changed` so attached UIs immediately refresh pending PR state, update sidebar project dots, and
clear the Tasks PR banner.

⛔ **An exact merged PR is authority to retire squash/rebase history.** An ordinary branch is still
deleted only by ancestry. The PR exception applies only when the persisted URL reports merged, its
base and head branch are unchanged, and its tip is exactly the head SHA GitHub says it accepted. A
later local commit, changed identity, missing merge commit or unfetched target keeps the branch and
retries rather than guessing. This is why a squash-merged PR no longer remains forever as “commits
the trunk does not have.”

⛔ **A worktree holding the branch is stepped off it only if it is an idle pool member** — unclaimed
and clean, exactly what `parkWorkspace` would detach anyway (`holderVerdict`). A claimed member, a
dirty one, and above all the operator's own checkout are never switched. ⭐ **And a refusal is said,
once.** t389 (2026-09-12) merged while `C:\Dev\awardtracker` had its branch checked out; the refusal
left no trace, so it was re-refused every five minutes and Loose ends offered to land it. Now the
reason is kept in `task_deliveries.retire_blocked` and written to the thread only when it changes —
*"`C:\Dev\awardtracker` has `warmstart/t389-…` checked out. Switch it to another branch there
(`git switch main`), then clean up again"*. A merge is monotonic, so an unavailable `gh` does not stop
a delivery already recorded as merged from being settled. Design and alternatives are archived in
[`../transient_docs/pull_request_lifecycle_plan_2026-09-11.md`](../transient_docs/pull_request_lifecycle_plan_2026-09-11.md).

⭐ **A landing an operator asked for says so before it runs.** Pressing **Land** or **Retry landing**
writes a `landing.started` line — *"Landing `warmstart/t369.2-…` — commit, verify, merge and push…"* —
and only then fetches, rebases, runs the project's checks and pushes. Until t369 the only feedback for
minutes of work was the buttons going grey and a status in a pane the operator had to scroll away from
the conversation to reach. ⚠️ It is written to the **thread**, not flashed: a landing that takes four
minutes and then fails leaves two rows that read in order, and the first is the timestamp that says how
long the failure took to arrive. ⚠️ It is written after the cheap refusals, so a rung that cannot land
does not produce a landing that started and vanished.

⭐ **Everything that landed before any of this existed was recovered from its own thread.** The
*"Landed as `<sha>` onto `<target>`"* message above outlives the branch, the workspace and the
columns, and `salvageLandedCommits` parses it back on daemon start. It is idempotent and additive:
commit rows are `insert or ignore` and the range columns are only filled where they are null, so a
second run costs one `git log` per project and writes nothing. ⚠️ It attributes **only the commit the
message named** — a landing that put two commits on the target announced only its tip, and walking
back from that tip would be a guess: 141 of the 347 commits on this repository's `main` were landed
by no task at all. Measured against a copy of this fleet's database on 2026-09-05: **207 commits
across 200 tasks**, **148** ranges filled in, **8** shas that no longer resolve, and the gradable
count moving from **51 of 233 tasks to 199**.

## Two tasks finishing at once

⭐ **They queue, and both land.** Landing is serialised per project — two rebases onto a target that
is moving underneath them race, and one of them loses work — so a task that arrives while another is
landing **waits for its turn** rather than being refused. The wait happens inside the run that was
already waiting: nothing is re-dispatched, and no agent starts a second time over work that is
already committed.

You see it as one extra line, then the ordinary one. Each is a single sentence on the thread; what
follows it here is its `detail`, behind the expander:

> **Waiting to land behind t26**
> t26 (…) is landing now; landing is serialised per project so rebases cannot race for the trunk.
> This task is queued behind it and now depends on it, and will land by itself.
>
> **Landed as `a41f9c2` onto `main` — local only, not pushed**
> Verified first: 4 project checks passed on the rebased branch, before anything moved.
> Your local `main` was fast-forwarded and is now ahead of the remote. `warmstart/t27-…` held
> nothing `main` does not now have, so it was deleted. It queued behind t26 and landed once that
> finished.

⛔ **Every system line on a thread is one short sentence, and what it used to say is its `detail`.**
Nothing is dropped: a red check reads *"Not landed: the project checks failed after rebase"*, with
where the work is and the check output behind it. Code that reads a message back matches on text and detail
together (`messageBody` in `threadline.ts`), except salvage, which reads the headline alone — so the
headline keeps its shape.

⭐ **Retry landing preserves red-check output too.** A retry is a second caller of the landing bar,
not a shortcut around it: if its project check fails, the same tail of the command output is retained
in the resulting `landing.failed` detail. **Resolve & retry** then includes that detail in the new
agent prompt, so the next run starts from the failing test rather than merely being told that checks
failed (t347, 2026-09-11).

⭐ **Resolve & retry can change its next worker or model.** The selector applies the new routing
choice before it dispatches the corrective run, but retains the landing failure as its classifier and
prompt evidence. The replacement agent is told this is a landing repair, the failed check output or
conflict, the task branch and landing target, and the complete rebase/verify/commit procedure; it is
not asked to restart the original task without context.

⭐ **The queued task gains a dependency on the one it waited for**, so "t27 landed after t26" is still
answerable tomorrow. ⚠️ The edge is a *record*, not an instruction: the task is deliberately **not**
moved to `blocked`, because `blocked` means work waiting to be dispatched and would send a finished
task back to an agent the moment its blocker completed.

⚠️ **The wait is bounded at 15 minutes**, sized against a landing that runs the project's own checks.
If it runs out, or you cancel the task while it is queued, you get the ordinary hand-off — and the
message says the branch is fine and that landing it again is all it needs, because a queue that ran
out is a retry rather than an investigation.

⛔ Measured 2026-08-29: t26 and t27 were run in parallel and finished within the same second. One
landed; the other was told *"Waiting to land behind t26"* and parked on a
person's desk with a perfectly good commit on an intact branch. The lock was doing its job — the
caller was reporting a queue as a failure.

## Working in the trunk

⭐ **A task can work in the project's own checkout instead of a worktree** (t401, 2026-09-12). t400
showed the cost of not having that: an agent asked to pull `main` and resolve a conflict did it by a
detour through a task branch, which confused the agent and left the tool a branch to clean up. The
choice is the **workspace mode** — `worktree` (the default) or `trunk` — set per project in Project →
Settings (`workspaces.mode`) and per task in the composer or the task pane, fixed once the task runs.
Five decisions were taken with the operator and each is enforced in code:

1. **One trunk task at a time.** The trunk is a resource of one (`claimTrunk`); a second trunk task
   holds, visibly, exactly as a task waiting for a pool member does.
2. **A worktree landing into a busy trunk queues, and lands by itself.** `merge-local` refuses a trunk
   that a trunk task holds (`trunkOccupiedBy`, asked *before* `git status`, because a clean moment
   between an agent's edits is not a free trunk; resolves session holders via `taskOfSession`, never
   self-blocks, and sweeps dead leases from settled tasks) or that is dirty or off-target. That refusal carries
   `trunkBusy`, and `landTask` rests the task at **`landing_queued`** — not `awaiting_human` — with one
   thread line. `retryQueuedLandings` on the tick re-runs the landing in the background once the trunk
   is free. ⚠️ A conflict or a red check on that retry rests at `awaiting_human` as any landing would,
   with **Resolve & retry**; no agent is dispatched for a queue alone. Fatal trunk read errors also
   rest at `awaiting_human` instead of looping in queue.
3. **A trunk task is dispatched onto whatever the checkout holds, and told.** `surveyTrunk` reads the
   branch, uncommitted files and a merge/rebase/cherry-pick in progress; the first prompt says each
   (`trunkArrivalNotice`), and the files already there are stored on the run
   (`runs.trunk_dirty_before_json`) so the finish never asks the agent to commit them.
4. **`pull-request` cannot run in the trunk** — there is no branch to push. Refused where it is chosen
   (`task.create`, `task.setWorkspaceMode`, `task.setFinishPolicy`, `setProjectPolicy`) and refused at
   dispatch if it arrives anyway (`trunkPolicyConflict`).
5. **Nothing of the agent's is stashed or committed for it.** A paused, preempted or questioning trunk
   task keeps its lease, so nothing lands over its files; a settled one gives it back
   (`sweepTrunkLeases`). A cancelled or failed trunk task that left files behind is listed under
   **Loose ends** as *uncommitted*, counting only files that were not there when its run began.
   ⛔ `parkWorkspace` refuses the project root outright.

**The finish ladder is shorter, because half of it has already happened** (`decideTrunkFinish`). An
operation left in progress, or files the agent changed and did not commit, are asked about once; a
checkout left on another branch goes to a person. There is **no trunk tripwire** — it exists to catch an
agent working in the trunk, which is what this mode is — so a run that committed nothing is simply
`done`. The rungs map as: `await-human` rests, `commit-only` is done, and `commit-and-verify`,
`commit-and-merge` and `commit-and-push` all land with the **`trunk` strategy**: under the landing lease,
run the checks in the trunk and, for push, `git push origin <target>`. ⚠️ A red check undoes nothing —
the commits are on `main` already — and the retry that follows asks an agent to fix forward. Commits
are recorded in `task_commits` as the run's own (`<trunk_sha_before>..HEAD` minus anything another task
recorded), so the diff and the quality review work without a branch.

⚠️ **Known limit.** A *worktree* task whose branch stays empty while a trunk task commits can still trip
the trunk tripwire, because a trunk task's commits are recorded only at its finish. The tripwire hands
it to a person with the commits listed, which is the right outcome for evidence it cannot attribute.

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
  `commit-and-push` · `pull-request` · `custom` · `report-only` · `inherit`.
- `landing.finishInstruction` — what `custom` sends the agent, and **read only under `custom`**.
  Set it beside any other `finish` and it is inert; the example above therefore omits it.
  ⛔ It is sent verbatim, so it is yours to keep honest. Naming a slash command binds the project
  to a CLI that has that skill — measured on t56, 2026-08-30, `"Run /commit and follow every one of
  its six steps. Do not push."` reached codex, which has no `/commit`, and whose sixth step was then
  the push the same sentence forbids. ⚠️ This repo's `/commit` has since been split — it commits
  locally and `/push` publishes — which fixes that one sentence and not the hazard: the instruction
  still names a skill the receiving CLI may not have, and a skill's steps can be renumbered under a
  project that quoted them. Under every other rung the tool composes the sentence itself and says
  plainly whether to push.
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
