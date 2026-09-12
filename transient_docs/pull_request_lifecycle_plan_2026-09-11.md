# Pull-request lifecycle — research and implementation plan

**Date:** 2026-09-11
**Status:** implemented; the operator chose §6A, exact merged PR as retirement authority.

## 1. The observed gap

t372 used the `pull-request` finish policy successfully: Warmstart pushed
`warmstart/t372-please-address-issue-reported-in-https-g`, opened a GitHub pull request, and the
operator squash-merged it on GitHub. Warmstart then reported two commits on that task branch that
`origin/main` did not contain.

That report is internally consistent, but not useful. Today `pull-request` is a one-shot landing
strategy. Success means only **branch pushed + PR opened**. Warmstart persists neither the PR identity
nor its later state, and the loose-ends scan consequently compares the original commit identities to
`origin/main`. A squash merge creates a new commit, so those two source commits correctly remain
absent even though their change was accepted.

The fix is not “pull local `main` after opening a PR.” A PR can remain open for days, be closed without
merging, have more commits pushed, change base, or be squash/rebase merged. It needs a durable
delivery lifecycle.

## 2. Samples checked

These are product/repository sources read on 2026-09-11, not claims inferred from feature lists.

### Untrivial Agent Orchestrator

AO models the PR after creation and observes SCM state. It has a per-session “terminate on merge”
policy and merge-driven cleanup. Its issue history is especially useful because it documents the
failure modes: merge cleanup must be terminal and serialized against Resume, a stale positive PR
lookup must be invalidated, matching a PR from a branch name alone can attach an unrelated fork, and
post-merge work must start from a fresh default-branch worktree because the PR branch may already be
gone.

Sources: [terminate-on-merge policy](https://github.com/Untrivial-ai/agent-orchestrator/issues/3154),
[lifecycle races](https://github.com/Untrivial-ai/agent-orchestrator/issues/3087),
[wrong-PR attachment after merge](https://github.com/Untrivial-ai/agent-orchestrator/issues/1724),
[post-merge workspace semantics](https://github.com/Untrivial-ai/agent-orchestrator/issues/1349).

**Lesson for Warmstart:** persist immutable PR identity, make the terminal transition monotonic and
idempotent, and do not keep or restore an agent workspace merely to observe SCM state.

### GitHub Copilot coding agent/app

Copilot separates the coding session from PR delivery. The agent opens a PR and requests human
review; review comments and failing checks can start follow-up work on the same PR. Its optional
Agent merge runs in the background, survives app restarts, and turns itself off only once the PR is
merged.

Sources: [coding-agent workflow](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/overview),
[PR review, fixes, and Agent merge](https://docs.github.com/en/copilot/how-tos/github-copilot-app/managing-issues-and-pull-requests).

**Lesson for Warmstart:** “agent finished coding” and “change merged” are separate facts; waiting for
the latter is durable background state, not a live agent task.

### OpenHands

OpenHands' published iterate skill polls current PR CI, review, and QA state; it pushes fixes back to
the same branch, stops when the PR is closed/merged, and treats pending checks as a reason to keep
observing rather than a task failure. Its automation documentation uses SCM webhook payloads for
event-driven PR work.

Sources: [iterate skill](https://github.com/OpenHands/extensions/blob/main/skills/iterate/SKILL.md),
[event-driven PR review](https://github.com/OpenHands/docs/blob/main/openhands/usage/use-cases/code-review.mdx).

**Lesson for Warmstart:** normalize provider observations into a small closed state machine and let
new review/CI work create a run only when judgment or code changes are actually needed.

## 3. Recommended product model

Do **not** keep the task in `running` or `awaiting_human` merely because its PR is open. Once the
branch is pushed and the PR identity is persisted:

- finish the coding run and release its session/workspace normally;
- show the task as completed work with a separate delivery badge, initially **PR open**;
- keep a durable delivery row under observation at zero token cost;
- let an explicit review-fix request reopen work as a new run on the same task/thread and branch;
- settle delivery as **merged** or **closed unmerged** without inventing an agent turn.

This preserves the existing invariant that work is visible and billed only as a run. It also avoids
making task status carry two clocks: agent execution and an external review process.

Suggested closed states:

```
opening -> open -> merged
                -> closed_unmerged
        -> unknown (observation failed; last known state and age remain visible)
```

`unknown` is an observation verdict, never a terminal state. A reopened PR moves
`closed_unmerged -> open`. A replacement PR creates a new delivery attempt; it does not overwrite
the old identity.

## 4. Durable identity and observations

Add append-only migration 67 with `task_deliveries` (one task may have multiple PR attempts):

- `id`, `task_id`, `attempt`, `provider`;
- repository identity captured from the canonical `origin` remote, not inferred later;
- PR number and URL returned by `gh`;
- base ref, head ref, and **head SHA observed at creation**;
- `state`: `open | merged | closed_unmerged`;
- `merge_sha`, `merged_at`, `closed_at`;
- `observed_at`, `observation_error`, `created_at`, `updated_at`.

Use `(provider, repository, pr_number)` as the external identity and `(task_id, attempt)` as the
task identity. Never rediscover by head name after the initial create/recovery; AO's #1724 shows why
that is unsafe. Persist the row in the same successful landing path before the task is declared
complete. If persistence fails after `gh pr create`, recover by exact repo + head, persist, then
return success; the existing idempotent retry is the starting point.

## 5. Observation and reconciliation

Add a deterministic `deliveryReconciler`, following the scheduler's zero-token rule:

1. On daemon startup and a bounded cadence, select nonterminal or unreconciled delivery rows.
2. Fetch exact PR facts with `gh pr view <number> --repo <owner/name> --json
   state,isDraft,baseRefName,headRefName,headRefOid,mergeCommit,mergedAt,closedAt,url`.
3. Write the observation and its timestamp transactionally. Keep the previous fact plus age if the
   command fails. Back off per delivery; do not hold the scheduler tick on network I/O.
4. On `OPEN`, update presentation only. CI/review monitoring is a later slice and must not be needed
   to solve branch cleanup.
5. On `CLOSED` without `mergedAt`, mark **closed unmerged** and surface the branch as actionable work,
   with “Reopen/replace PR” and normal Land/Make-a-task choices.
6. On `MERGED`, fetch `origin/<base>`, record the target's merge SHA as the landed commit, reconcile
   the loose-end classification, and attempt safe resource cleanup once.

Polling is the portable first implementation because Warmstart already delegates GitHub auth to
`gh`. A later GitHub webhook may enqueue the same idempotent reconciler, but must not become a second
state-transition implementation.

## 6. The major decision: authority to retire a squash-merged branch

The current `retireBranch` deletes only when every branch commit is an ancestor of the landing
target. That proof cannot pass after a squash merge. There are three coherent choices:

### A. Merged PR is sufficient authority (recommended)

When the exact persisted PR reports `mergedAt`, its observed head SHA equals the local/remote task
branch tip, and its base equals the task's resolved target, treat GitHub's merged record as authority
to retire the local branch. Record the merge SHA first. Refuse automatic retirement if the branch
advanced after the observed head, is checked out, or has dirty workspace state. Remote-branch
deletion remains GitHub/user policy; Warmstart only prunes the tracking ref on fetch.

This produces the expected t372 result and works for merge, rebase, and squash strategies. It is a
narrow, explicit exception to ancestry-based retirement: the unique source commit identities go
away locally, while the exact PR remains their durable audit record.

### B. Archive before retirement

Before deleting the local branch, create a namespaced archive ref such as
`refs/warmstart/merged/t372/<head-sha>`, then remove the branch name. This preserves source commits
locally and clears Loose ends, but accumulates hidden refs and requires a retention/GC policy.

### C. Never auto-retire non-ancestor history

Mark the delivery merged and suppress the false “not landed” warning, but keep the branch as
“merged PR archive” until the operator explicitly retires it. This preserves today's strongest
no-destruction interpretation but does not deliver the automatic cleanup requested for t372.

Whichever is chosen, local `main` should **not** be pulled automatically. Warmstart may fetch and
report “local `main` is N behind `origin/main`,” but an operator checkout can be dirty, on another
branch, or have unpublished commits. Existing landing rules correctly treat that checkout as outside
background mutation authority.

## 7. Implementation slices

1. **Persistence and exact identity.** Migration, shared delivery types, store helpers, and creation
   persistence in `landing.pullRequest.land`; prove create, already-exists recovery, restart, and
   multiple-attempt behavior at L1.
2. **Read model and UI.** Return delivery with task detail and Overview; show PR URL, state, and
   observation age. Teach Loose ends that an open PR is **in review**, not abandoned, while a closed
   unmerged PR remains actionable.
3. **Reconciler.** One exact-identity query path with startup/cadence scheduling, bounded timeout and
   backoff. Unit-test every normalized response and L2-test restart/idempotence with a fake `gh` on
   PATH.
4. **Merged attribution.** Fetch base, record `mergeCommit.oid` in `task_commits` with a new
   `pull-request` source (or a delivery-to-commit relation if authorship semantics require both
   source and squash commit), then update Quality Review to diff the accepted target commit.
5. **Cleanup policy.** Implement the chosen §6 authority in one branch-retirement function. Prove
   unchanged tip, advanced tip refusal, wrong base/repo refusal, checked-out refusal, dirty-tree
   refusal, squash merge, rebase merge, normal merge, deleted remote branch, and repeated reconcile.
6. **Follow-up work.** A review/CI “Fix” action creates a new run on the existing task and branch;
   it is deliberately not part of the initial cleanup fix.

## 8. Acceptance scenario for t372

Given a persisted PR for t372 whose base is `main`, whose recorded head is the task branch tip, and
whose exact GitHub record is squash-merged:

- the task remains completed and no agent/session is kept alive;
- delivery reads **Merged as `<merge-sha>` into `main`**, with observation age;
- the accepted merge commit is recorded for later quality review;
- Loose ends does not claim the two source commits still need landing;
- local `main` is left untouched and reports its measured distance from `origin/main`;
- branch cleanup follows the chosen §6 policy and is safe to retry after restart.
