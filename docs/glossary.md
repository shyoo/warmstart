# Glossary

These words mean specific things in agentyard. Using them loosely makes the scheduler incoherent, so
they are worth pinning down.

---

**Fleet** — every worker agentyard knows about, across all providers and accounts.

**Worker** — *an account or endpoint, i.e. a quota bucket.* One Claude subscription is one worker; a
second subscription is a second worker. A local model with no quota is also a worker. Each has an
**isolation root** holding its own credentials, written by the vendor's CLI and never read by
agentyard.

**Session** — *one live agent process.* Has a model, an effort level, a workspace, a minted session
id, a context size, a cache expiry and a topic fingerprint.

> ⛔ **A worker is not a session, and the distinction carries the whole design.** *Quota* lives on the
> worker; *context* lives on the session. A task must be routed to a worker that can afford it **and**
> a session that already knows about it. Most orchestrators model only one of the two.

**Human-occupied worker** — an account whose quota agentyard tracks but never spends, because a
person is using it by hand. Keeps the budget arithmetic honest without taking the account over.

---

**Project** — *a directory plus policy.* Git is **optional**: `vcs: git | none`. Branching,
committing and parallel workspaces are per-project **capabilities**, not universal assumptions, so a
media-generation or research project is a first-class citizen with no repo fiction. Policy lives in a
committed `.agentyard/project.json`; runtime state stays private in the OS app-data directory.

**Workspace** — *where a run executes.* For a git project, a pooled **git worktree** — a permanent
checkout, created once and reused, sharing one `.git` object store. For a plain directory, the
directory itself, as a pool of one.

**Trunk** — the project's main checkout. Used for integration and landing. ⛔ **Agents never work
here.** The task branch is created inside the claimed worktree, never in the trunk.

**Landing** — what happens to a task's branch when its work finishes, expressed as a
`LandingStrategy`. v1 ships `auto-land` (rebase onto `origin/main`, run the project's checks, push,
delete the branch). `leave-branch` and `pull-request` implement the same interface. Landing takes an
exclusive `land:<project>` resource, because three workspaces finishing at once would otherwise each
rebase onto a main the other two are about to move.

---

**Resource** — *anything contended for.* Kinds: `exclusive` (capacity 1), `counted` (capacity N),
`rate_limited`. Workspaces are just a counted Resource, which collapses two mechanisms into one. So
are: a single browser profile, a credit-metered external API, a dev-server port range, a physical
device, a flaky test that must not run twice at once.

> The point of modelling these: **if the scheduler owns the claim, the lock is unnecessary.** Agents
> do not have to coordinate, because nothing dispatches two claimants at once. Hand-rolled locks in
> agent prompts are a symptom of the scheduler not knowing about a resource.

**External resource service** — an MCP server fronting something contended (credits, a browser, a
queue). Registered with a `probe` tool that reports availability; agentyard then stops dispatching
contenders rather than letting them collide.

---

**Task** — *a thread of work with an assignee*, not just a prompt. Carries a multimodal message
thread, priority, deadline, dependencies (a DAG), a schedule (`not_before`), resource requirements,
constraints, a verification policy, and a status.

**Run** — *one attempt of a task on one session.* Carries the actuals: tokens, wall time, cost, and
the effective objective it ran under. Runs are what the estimator learns from.

**Assignee** — a worker, or `'human'`. The human is modelled as a worker with infinite quota and
terrible latency.

**Approval** — *an interrupt on a session*, not a task: a permission or tool gate that blocks one
live session, with a closed answer set supplied by the adapter and a deadline equal to that session's
cache expiry. Answered by project policy where possible, by one keystroke on the **Approvals bar**
otherwise. ⛔ Never captured by parsing the terminal — a mis-read approval card is an unattended
*yes*. Becomes an `awaiting_human` task only after it goes unanswered past `escalate_after`.

**Resting state** — where a cancelled task comes to rest: `paused_user` (*not now*), `draft` (*not
like this* — re-enters admission), or `cancelled` (*not at all*, terminal but on the record).
**Cancel is not delete**: cancel winds a run down through the preemption protocol and destroys
nothing. Delete is a separate, human-only, soft-by-default operation, and it never removes runs —
they are the estimator's training data and the record of real spend.

**`awaiting_human`** — the task needs a person. Its question lands in **My Queue**. The session
holding the context is a prime candidate for a keepalive, because human latency routinely straddles
the one-hour cache TTL — and a reply into a warm session costs `0.1·C` against `2.0·C` into a dead
one.

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
`/compact` fails at true 100%, which strands the context entirely. See `cost-model.md` §5.

**Preemption** — stopping a run before a quota window closes: wrap up, commit what compiles, write a
handoff, then compact or close. The task returns to the queue with `not_before = resets_at`.

**Handoff** — the note a preempted run leaves so its successor can continue. Prepended to the
successor's prompt.

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

**Transport** — how agentyard talks to a session. `stream` (`-p` with stream-json over real pipes)
gives structured events, a programmatic approval channel, and free live rate-limit records; `pty`
hosts the real TUI and lets a human take the keyboard. A minted session id lets one session move
between them via `--resume`.

> ⛔ Not interchangeable plumbing, and measured rather than assumed: `--print` **exits immediately
> under a pseudo-terminal**, and the CLI's **workspace-trust dialog is skipped only in
> non-interactive mode** — so unattended work runs on `stream`, and `pty` is for a human at the
> keyboard.

**`task_complete`** — the worker-tier MCP call that reports a task finished. ⛔ The *only* signal that
a task succeeded. A clean exit code says nothing about whether the work was done, and reading the
terminal to guess is what this design refuses to do; a session that ends without it lands in
`awaiting_human`.

**Controller** — the LLM agent that makes judgment calls: decomposition, ambiguous routing, failure
triage, risk-gating agent-created work. It is itself a worker in the fleet with its own quota, so when
its window runs low its next decision routes elsewhere. ⛔ It is **not** in the scheduling loop —
that loop is deterministic and costs nothing.

**orchestratord** — the long-lived daemon holding all of the above. Survives the UI closing, which is
the entire point.
