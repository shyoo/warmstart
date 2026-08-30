# Landing defaults — commit locally, push on purpose (2026-08-30)

A plan, not a record. Status lives in `HANDOFF.md`; when a phase lands, delete its section here and
move anything worth keeping to `changes_history.md`.

## The problem

⛔ **The default finish policy pushes to the remote, and every push to `main` starts a CI run.**

`DEFAULT_FLEET_FINISH` is `agent-lands` → `auto-land`, whose last act before retiring the branch is:

```ts
await git(ctx.workspacePath, ['push', 'origin', `HEAD:${target}`])   // landing.ts:547
```

`.github/workflows/ci.yml` triggers on `push: branches: [main]`. So **one completed task = one push =
one CI run**, and a CI run is **10 jobs**: one Ubuntu job plus a 3×3 matrix of
`ubuntu · windows · macos`.

Measured on this install, 2026-08-30:

| | |
|---|---|
| CI runs, 2026-08-26 → 2026-08-30 | **103** (16 · 11 · 14 · **39** · 23 per day) |
| Commits on `main` in that window | 97 |
| Jobs per run | 10 |
| Of those, **macOS** | 3 |
| Billing weight per run | 4×1 (Linux) + 3×2 (Windows) + 3×10 (macOS) |
| CI blocked on billing since | **2026-08-29T21:54Z** — the day of 39 runs |

⚠️ macOS runners bill at 10× and Windows at 2×, so **the three macOS jobs are roughly three quarters
of the billable weight of every run**. Nothing about the tool's own work needed a remote at all.

⚠️ Not every run is an agent landing — agents commit under the operator's git identity, so the two
cannot be told apart by author, and the operator's own `/commit` pushes are in the same total. What
*is* certain is the mechanism: the default policy pushes, and each push costs a full matrix.

## What exists already, and what does not

⭐ **The three tiers are already built.** `resolveFinishPolicy(task, project, fleetFinish)` reads
task → project → fleet with `inherit` as a real value, `settings.finishPolicy` is the fleet tier, and
`task.finish_policy` the task one. **No new plumbing is needed for the override chain** — this plan
changes the *vocabulary* and the *default*, not the resolution.

| Policy today | What it does | Remote traffic |
|---|---|---|
| `agent-lands` *(fleet default)* | rebase onto target, run checks, **push to `origin/<target>`**, retire branch | ⛔ every task |
| `pull-request` | push the branch, open a PR | ⛔ every task, and a `pull_request` CI run |
| `await-human` | stop; branch and work intact | none |
| `custom` | an instruction to the agent, never a command the daemon runs | whatever it says |

⛔ **There is no policy that means "commit it properly and stop".** `await-human` is the closest and
it is not the same thing: it does not require a commit, does not run the checks, and reads to an
operator as *something needs deciding* rather than *this is done and waiting to be pushed*.

## The ladder

**Five** rungs, each doing everything the rung below does **plus one thing**. That is what keeps this one
decision rather than five.

| Policy | Agent commits | Daemon verifies | Merges clean trunk | Deletes branch | Pushes |
|---|---|---|---|---|---|
| `await-human` | - | - | - | - | - |
| `commit-only` | ✔ | - | - | - | - |
| `commit-and-verify` | ✔ | ✔ | - | - | - |
| **`commit-and-merge`** ⭐ *default* | ✔ | ✔ | ✔ | ✔ | - |
| `commit-and-push` *(today's `agent-lands`)* | ✔ | ✔ | ✔ | ✔ | ✔ |

And two that are **not rungs**, which is worth saying rather than pretending:

- `pull-request` - pushes the *branch* and opens a PR. It never touches the trunk, so it is not "one
  more than push"; it is a different destination.
- `custom` - an instruction to the agent, not a daemon action. A different authority entirely.

⛔ **`commit-after-verified` was considered and cannot exist.** The daemon never authors a
commit - the agent does - so verification can only happen after there is something to verify. Gating
the commit on it would need the daemon to write one, or the agent's own word that checks passed, or a
second turn to ask for the commit, which a one-shot CLI cannot give. `commit-and-verify` is the
achievable shape: the commit is unconditional, the **verdict** is what the check decides. A red check
rests the task with the output and the commit stays, because destroying committed work is the one
thing this tool refuses to do.

⚠️ Verification is not named in `commit-and-merge` or `commit-and-push` because **merging always
verifies** - merging unverified work into the trunk is worse than leaving it on a branch. The name
hides nothing; the rung below is where verification is the headline.

⚠️ **`commit-only` and `commit-and-verify` are the same thing on a project with no `check`
commands**, which is every project on day one. They diverge as a suite grows. So a project that
declares no checks must be *warned* - on the task and in the picker - that `commit-and-verify` and
`commit-and-merge` will verify nothing until it does.

⚠️ There is already a `Task.verification` field (`required | not_required | auto`) meaning *a
**human** should check this before it lands*. Two different questions, one word. The glossary has to
separate them or a later session will conflate them.

## ⛔ The constraint that shapes the default

```
$ git fetch . main:main
fatal: refusing to fetch into branch 'refs/heads/main' checked out at 'C:/Dev/multi_agent_controller'
```

The operator works **in the trunk with `main` checked out**, and git will not let anything update a
branch a worktree holds. That is why `auto-land` pushes whenever a remote exists, and why the local
fallback works only against a detached trunk - which `landing.test.ts` arranges deliberately in its
fixture. Any design that merges into the local trunk has to answer this first. See D4.

## Decisions taken (owner, 2026-08-30)

| # | Decision |
|---|---|
| D1 | The ladder above. **`commit-verify-and-merge` is the new fleet default**; `commit-only` is the rung below it, for early-phase or single-trunk work |
| D2 | `commit-only` **does not run checks**. Each rung does strictly more than the one below, and the early-phase case it exists for often has no suite yet |
| D3 | The daemon runs the project's **declared** `check` commands on the verifying rungs - `runChecks` shells `project.json`'s list verbatim, in order, stopping at the first non-zero exit. No inference. A red check rests the task carrying the last 8KB of output, and spends no tokens |
| D4 | Merge **only when the trunk is clean**: `git -C trunk merge --ff-only <branch>`, and if the trunk has uncommitted work, skip it, keep the branch, and rest the task saying so. ⛔ The tool never stashes, resets or otherwise reaches into the checkout the operator is typing in |
| D5 | This repo's `project.json` migrates to the new default, and `finishInstruction` loses *"and pushed"* |
| D6 | CI keeps Linux and Windows on every push and PR; the three **macOS** jobs move to `workflow_dispatch` and tags. Roughly three quarters of the billable weight, made deliberate rather than constant |
| D7 | The `check` list is **proposed** from `package.json` scripts when a project is added (never silently written), **editable in Project settings**, and there is a **"File a task for an agent to update the checks"** button. ⚠️ The agent's proposal arrives as an ordinary task with a reviewable diff - it never edits the gate in place |

⛔ **An empty `check` list must not read as a clean verification.** A project that declares
nothing gets no verification, and `commit-verify-and-merge` has to say *that* rather than reporting a
verified landing. Otherwise the policy's name is a lie on every new project.

## Implementation

1. **`FinishPolicy` gains `commit-only` and `commit-verify-and-merge`**; `agent-lands` becomes
   `commit-and-push`, with the old name accepted on read. `FINISH_LABELS`, `DEFAULT_FLEET_FINISH`,
   the settings default and both dropdowns follow.
2. **`LandingStrategyId` gains the two new rungs**, implemented beside `autoLand`/`leaveBranch`.
   ⛔ Neither writes a commit - the tool never authors one. They verify, merge, and report.
3. **`decideFinish` learns them** (`finish.ts`): uncommitted files still produce the one `ask-agent`
   then rest; a clean branch with passing checks rests as **done**, not as `awaiting_human`.
4. **The clean-trunk gate** (D4), with its own resting state and message.
5. **Migration** of this repo's `project.json` (D5).
6. **`ci.yml`** (D6).
7. **The check list** (D7): seed-on-add, a settings panel, the file-a-task button, and the first
   write path the app has ever had into `project.json`.
8. Docs: `docs/landing.md` is the spec, `docs/glossary.md` has **finish**, `AGENTS.md` the default.

## Adjacent, and arguably the larger half

⚠️ **Even with `commit-only`, the operator's own pushes still cost a full 10-job matrix**, three of
them macOS at 10×. 103 runs in five days is ~20/day at ~120 billable minute-equivalents each on a
3,000-minute allowance. Trimming *when* the expensive matrix runs — rather than only *how often* it is
triggered — is the other half of the fix and is one edit to `ci.yml`.
