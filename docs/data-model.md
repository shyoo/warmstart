# Data model

The store, the migration contract, and every enum the rest of the system branches on.

> **Audience:** anyone adding a column, a status, or a migration.
> **Authority for:** the migration rules, the table map, and the load-bearing unions.
> Meanings live in [`glossary.md`](glossary.md); who reads each column is
> [`architecture.md`](architecture.md).

---

## 1. The store

`node:sqlite`, WAL, `foreign_keys = on`, at `<dataDir>/warmstart.db` (`daemon/db.ts`).

⛔ **`node:sqlite`, not better-sqlite3.** It ships inside the Node that Electron already carries, so
there is no native module to rebuild against Electron's ABI and nothing to go wrong at packaging
time. better-sqlite3 publishes no Electron 44 prebuild and would need a toolchain on every
contributor's machine. Measured working under Electron 44 (SQLite 3.53.1) on 2026-08-25.

Rows come back null-prototype; `rows<T>()` and `row<T>()` in `db.ts` make them ordinary objects.
Everything else in the daemon goes through those two, so swapping the driver is a one-file change.

## 2. The migration contract

`MIGRATIONS` in `db.ts` is a numbered, **append-only** array. `MIGRATION_COUNT` is its length and is
the `user_version` a current database sits at — **67** as of 2026-09-12.

- ⛔ **Never edit a migration that has shipped.** Add the next one.
- ⛔ **Every migration must survive being replayed.** `sessionstate.test.ts` rewinds `user_version`
  and reopens, which re-runs everything after the rewind point. SQL says this for itself with
  `if not exists`; `alter table … add column` has no such spelling in SQLite, so an additive column
  migration is written as a function guarded by `hasColumn()`.
- ⛔ **A function is for replay-safety and nothing else.** It is not an escape hatch for logic: a
  migration that has to *decide* something will decide it differently next year, against data nobody
  has any more.
- ⛔ **Rewind by text, never by number.** `versionBefore('<fragment>')` finds a migration by its own
  SQL and returns the `user_version` that re-runs exactly it. Measured 2026-09-01: two branches added
  a migration 27 in parallel, the rebase reordered them, and `MIGRATION_COUNT - 1` quietly began
  re-running somebody else's migration while asserting this one's outcome.
- A database at a **higher** `user_version` than this build throws rather than opening. Refusing beats
  silently corrupting a newer build's data.
- Migrations live in code, not `.sql` files, so the bundler has nothing to copy and the daemon has
  nothing to find at runtime.

⚠️ `repointIsolationRoots()` runs after `migrate()` on every open. It is the second half of the
data-directory renames — `agentyard` → `multi_agent_controller` → `warmstart` — and
`adoptLegacyDataDir()` in `paths.ts` is the first. Both are required and `paths.test.ts` fails if
either is removed. ⛔ It loops **every** legacy root rather than only the newest: an install that
skipped a release holds `isolation_root` values written under either older name, and checking one
would leave the oldest installs — the ones with the most history to lose — pointing at nothing.

## 3. The tables

| Table | Holds | Notes |
|---|---|---|
| `workers` | one account = one quota bucket | `isolation_root` is absolute; `role`, `health_json`, `sort_order`, `default_model(s)`, independent `grading_model` / `grading_effort` / `grading_enabled`, and **`summarising_model`** (migration 61: the cheap, optional title-only consult must not borrow a work or controller default); **`credits_json`** / **`credits_intent_json`** (migration 53) — ⛔ two columns because they answer different questions and are *allowed to disagree*: the first is what the vendor last said about this account spending past its plan limit, refreshed by the spend probe, the second is what the operator asked for. The gap between them is the thing worth reporting, and it is invisible unless both are written down. ⚠️ `credits_intent_json` also carries `reportedKind` (a `CreditsMismatchKind`, no migration — it is a key inside the blob, absent on older rows and read as *nothing reported yet*), because the gap is raised **once per cause** and not once per account: on 2026-09-13 a cause that changed underneath a `reportedAt` timestamp went unreported; **`routable_models_json`** — ⛔ `null`/`[]` both mean *only this worker's current default model*, never "every model the adapter can price"; see `routableModelsFor` in `workers.ts` |
| `quota_samples` | window readings | ⛔ upsert on `(worker, window, sampled_at)`; `window_group` is the pool |
| `spend_samples` | money-meter readings — the analogue of `quota_samples` | written by `spend.ts` off the quota poller's own pass. `direction` says whether the number falls (a credit purse) or rises (a cumulative counter); `balance` and `usd_per_unit` are nullable, and ⛔ null is *unknown*, never `0`. ⚠️ A probe that found nothing writes a row with `meter_id = ''` and an `error` — the analogue of `quota_samples`' empty `window_id`, and skipped by `price.ts` for the same reason. ⚠️ Identity is (worker, meter, the **vendor's** timestamp): re-reading one reading writes nothing |
| `rate_limit_samples` | the vendor's live `rate_limit_event` | `rateLimitType` names the window |
| `calibration` | percent → tokens, per (worker, model, tokenizer) | ⚠️ **zero rows**; R2 is still open |
| `sessions` | one live agent process | `state`, `purpose`, `vendor_session_id`, `current_branch`, `clock_move*` |
| `turns` | per-turn metering | the exact half of cost |
| `clock_events` | every cache-clock decision, including the no-ops | |
| `compactions` | a compaction as an **ask** with a before and an after | a row that never landed stays visible. ⭐ Migration 72: a clock ask names its session's latest run's task (open else last) — between runs there is no open run, and eleven asks fleet-wide had recorded null and never appeared on any thread. Backfilled from `runs` by session, newest first. |
| `projects` | a directory plus policy | policy is committed in `.warmstart/project.json`; state is private. ⛔ Nothing machine-specific goes in that file — `workspaces.root` is written **relative** to the project root, and the derived default as no key. ⚠️ `prompt.orientation` (`auto` · `off`) and `prompt.seed` are what a **cold** prompt says before the task; absent `prompt` is `auto` with no seed |
| `tasks` | the DAG | `status`, `kind`, `priority`, mandate, budget, the three inherited policies, `auto_compact`, `hold_until`, `quota_override_until`, **`quota_preempt_json`**, `title_summary`, `resolve_retry_asked_at`, `landed_base_sha`/`landed_head_sha`, `quality_review_*`, **`landing_target`**, **`branch_unit`** — ⛔ which *numbered* branch this task is on (migration 63): a conversation lands more than once and a landed branch is retired, so the next stretch of work needs a name nothing holds. 1 is `warmstart/t12-…`, 2 is `warmstart/t12.2-…`; null reads as 1, so every row written before it keeps the name `branchNameFor` has always given it. ⚠️ Migration 64 is the other half and is a deliberate **reset**: `finish_policy` back to `inherit` for every `conversation`, because the buttons that used to write a rung there no longer do and a row carrying one would hold an open chat under the one-shot work contract, **`child_defaults_json`**, **`debate_json`** — ⛔ migration 68: the roster (each seat's account, model, effort and optional **lens**), the round budget, the exchange rule and the verdict in **one** column, because they are read and written together and no query has ever needed to filter tasks by a debate's exchange rule. A malformed blob reads as *no debate* rather than throwing, on the rule `child_defaults_json` already keeps — a task that cannot be listed because its settings did not parse is worse than a debate that has to be re-filed, **`stats_excluded`** — ⛔ an operator's judgement that a *measurement* on this task is wrong, set from the thread's `statistics` row. `statistics.ts`, `pace.ts` and `quality.ts` skip it; `estimator.ts` deliberately does not, because a task excluded for an impossible duration still spent exactly the tokens it spent |
| `task_commits` | the commits a task actually landed | ⛔ the answer to *what did this task write*, and the one the quality review asks first. `(task_id, sha)` is the key and writes are `insert or ignore`, so a task that lands twice adds a row rather than replacing one. `source` is `landing`, `salvage`, or `pull-request`; the last names the accepted merge/squash commit after the exact PR is confirmed on `origin/<target>`. ⛔ `landed_base_sha`/`landed_head_sha` describe a **range**, which is exact for one landing and wrong for two. ⭐ `position` (migration 66) is target order, not author date. Landing is measured against `origin/<target>`, but `attributionBase` and `claimedByAnotherTask` prevent an unpushed local-trunk backlog being attributed to the task that happened to push it. |
| `task_deliveries` | exact pull-request identity and its lifecycle | Migration 67 persists the task/project, provider, URL, target, branch and observed head SHA before a PR-opening run completes. `open · merged · closed_unmerged` is delivery state, separate from task/run status; observations keep their timestamp/error, and `reconciled_at` makes merge attribution and cleanup restart-safe. One task may have several delivery attempts, but the URL is globally unique. ⭐ `retire_blocked` (migration 69) is why a merged PR's local branch was last kept — a checkout holding it, a commit after the merge — and changes to it are what the thread is told, so a refusal is said once rather than never or every sweep. ⚠️ Migration 69 also deletes any row whose URL is not `…/pull/<n>`: t389 had recorded an issue URL, and `recordPullRequestDelivery` now refuses one. |
| `task_deps` | prerequisite edges | cycle-checked on insert; **`require`** is what counts as met — see below |
| `task_messages` | the thread | `delivered_at` marks what has reached a session; migration 62 adds nullable `event` (a `MessageEvent`, §4) and `detail` so a concise system line keeps its supporting evidence without turning the thread into prose — a `role = 'system'` row with a null `event` is an ordinary notice |
| `attachments` | image metadata; bytes under `<dataDir>/attachments/` | `attachments.ts` is the only writer |
| `runs` | one attempt of a task on one session | ⛔ never deleted — the estimator's training data. `adapter_id`, `model`, `quota_before/after_json`, `trunk_sha_before`, `prompt`, `started_warm`, `plan_id`/`plan_raw`/`plan_source`, **`kind`**, `list_usd`/`on_overage`/`overage_status`, `activity_json` (intermediate stream steps recorded on finish) — ⛔ the plan and the three facts a probe stated about *this run alone* are stamped; **both** money layers are derived on read by `src/daemon/price.ts`, because an attribution changes the moment a later overlapping run is found — which is why there is no `overage_usd` column. ⚠️ All three money columns are nullable and null means *not known*. ⚠️ `ended_at` is *when the attempt stopped*, and before t317 a Plan & Split planner's run recorded the CLI's idle timeout instead: it was closed by `onSessionExit`, not by the split. Migration 57 moved those four runs (t191, t226, t292, t310 on this install, **47.3-47.9 minutes** of waiting reported as work each) back onto the newest child filed inside their own span, which is where `endPlannerForSplit` puts the end today. A run with no such child kept the end it had. ⚠️ **Three indexes, and each answers a different question**: `runs_task` (task, newest first), `runs_key` (adapter, model, outcome) and `runs_worker` (migration 59: worker, kind, outcome, newest first). *What has this account done lately* matched neither of the first two, so it planned as `SCAN runs` + a temp b-tree sort — measured 2026-09-09 at **5,225ms for 2,576 calls**, against **91ms** with the index |
| `quality_reviews` | one peer grade of one task's diff | ⛔ every review is kept with its immutable `rubric_version`; `tasks.quality_review_score` is the mean of all completed, scored reviews **and the operator's own rating** (`manual_reviews`), and `quality_review_count` states its denominator. `run_id` is the metering *and* the timeline entry. ⚠️ `blinding_leak` means an **attribution** survived blinding, not that a vendor was named — migration 50 re-decided every stored flag from `runs.prompt` after the old any-mention test turned out to be true of 30 of this fleet's 32 reviews; see *Blinding* in the glossary |
| `manual_reviews` | one direct 0–10 operator rating plus its explanation | ⛔ **At most one row per task**, enforced by `createManualReview`, not the schema: there is one operator, so a second rating is a changed mind and is an edit (`review.manual.update`) or a delete. No rubric dimensions, reviewer, or run is invented: it is an overall judgement. It records the task's last non-failed work adapter/model; mixed authorship remains visible and is excluded from clean agent comparison, just like peer review. It **counts in `tasks.quality_review_score`** alongside peer grades (migration 65 folded in the rows written before that was true); `TASK_QUALITY_RECOMPUTE_SQL` in `qualitysql.ts` is the one statement that derives every `quality_review_*` column, and `Task.qualityManualCount` says how many of the count are the operator's. |
| `approvals` `approval_rules` | the permission gate and its remembered answers | |
| `questions` | the third object: content answers, not allow/deny | born parked when the asker is gone |
| `resources` `resource_claims` | the broker | claims are reconciled at startup |
| `consults` | the controller's queue | `detail` carries the arithmetic, kept out of the prompt |
| `chat_messages` | the one tooled controller session | |
| `loose_end_dismissals` | what an operator has said to stop showing | |
| `settings` | fleet settings as JSON under string keys | a boolean today can become a shape tomorrow without a migration |
| `remote_config` | remote access as JSON under string keys, the same shape as `settings` | ⛔ **not** in `settings`: these are not scheduler preferences, and `remote.status` deliberately reads only `enabled`, `desktopsEnabled`, `bind` and `port` back out. The VAPID signing pair lives here too, under `vapidPublicKey`/`vapidPrivateKey`, written by `remote/push.ts` **without** firing the config-change listener — writing them through `setRemoteConfig` would restart the listener and drop every connected phone |
| `remote_projects` | which projects a paired phone may reach | ⛔ machine-local on purpose. `.warmstart/project.json` is pulled by every clone, and whether *this* computer is exposed to a phone is not a fact about the repository |
| `remote_devices` | one paired phone or desktop | `kind` (`phone` / `desktop`, migration 71) decides which policy the token gets, and is set by the pairing code the host issued — never by the redeeming client. ⛔ `token_hash` only — the token is shown once, at pairing, and never stored. Revoking **deletes** the row (t353): a revoked phone could do nothing, so keeping it only cluttered Paired devices. ⚠️ `revoked_at` remains for rows tombstoned by older builds, and every query still filters on it |
| `remote_push_subscriptions` | where to send a notification | keyed by `endpoint`, which is what the push service and the browser both treat as the subscription's identity. ⛔ `device_id` is what makes revocation complete: revoking a phone drops its subscriptions in the same call, or a lost handset keeps being told what the fleet is doing |
| `meta` | key/value bookkeeping | |

⚠️ **Fleet settings are JSON values under string keys**, read through `settings()` so a key never
written returns its default rather than `undefined` at the point of use.

## 4. The unions everything branches on

### Task status — `shared/tasks.ts` `TaskStatus`

```
draft · ready · blocked · scheduled · assigned · running
awaiting_human · paused_quota · paused_user · landing_queued
cancelling · cancelled · completed · failed
```

⛔ **Every held status needs something that ends the hold.** `blocked` ← `admitDependents()`, fired by
`setStatus` on the transition into any settled status and never by a call site, with `admitBlocked()`
on the tick as the backstop; `scheduled` ← `admitScheduled()`; `paused_quota` ← `resumeQuotaPaused()`, which
reads a clock **and** `quotaReleaseFor()`; `landing_queued` ← `retryQueuedLandings()`, which lands the
branch once the trunk lease is free and the checkout is clean (t401). A new held status owes a releaser, or it is a task nothing
will ever move.

⚠️ **`queued` is not a status.** A task the scheduler passed over is still `ready`, with a
`hold_reason` and — where the refusal has a known end — a `hold_until` beside it.

⛔ **And a `ready` task owes a releaser just as much as a held one.** t268 (2026-09-07): a task
pinned to a worker whose CLI the daemon could not find sat at `ready` reading *"Muse Code is not
installed"* for as long as the daemon ran, indistinguishable on the queue from one waiting behind a
busy account. `chooseTarget` now answers **`standing`** beside `holdUntil` — *no amount of waiting
changes this*, true when every refusal in the field was one of retired, not installed, signed out,
subscription expired, role held-out, or a capability no candidate has — and `tick` hands such a task
to a person as `awaiting_human` once the same standing reason has outlived `STANDING_HOLD_GRACE_MS`
(ten minutes, because a bridged adapter's `isInstalled()` is *false* until its first probe returns).
⚠️ Not `failed`: nothing was attempted and nothing was lost, and a reply re-queues it through
`continueTask`. ⚠️ The two refusals a person is already holding — **disabled** and
**human-occupied** — are deliberately *not* standing, nor is `suspect`, which a background usage
probe or a turn clears without anybody being asked. ⛔ That is only true because the probe is
*allowed* on a held-out account (t309); when it was not, `standing: false` was a promise the fleet
had no way to keep.

⚠️ `hold_until` is **descriptive only**. `not_before` is the one `admit()` reads; they were split
deliberately so a task could say *when* without changing what dispatches.

### Run outcome — `RunOutcome`

```
completed · blocked · failed · cancelled · terminated · preempted
```

⛔ **A run is one attempt; whether the task is done is a separate question.** `completed` on a run
beside `awaiting_human` on its task is not a contradiction. ⛔ `blocked` is *a run that stopped to
ask*, not one that broke.

### Session state — `shared/protocol.ts` `SessionState`

```
starting · live · idle · closed · abandoned · failed
```

⛔ **`state` is the *process*, not the work.** `closed` = asked to stop · `abandoned` = unwatched ·
`failed` = it died alone. `SESSION_ENDED` is the one list of the three that mean *over* — a dozen
call sites once asked `state !== 'closed' && state !== 'failed'` by hand, and adding `abandoned`
would have made every one of them count a dead session as live.

⚠️ **`sessions.purpose` is load-bearing, not a label.** A `consult` is exempt from `maxConcurrent`
(bounded separately at one per worker) and skipped by the cache clock; a `chat` session is very much
the clock's business; a `probe` opens a TUI for fifteen seconds, spends nothing, and holds no prefix
worth keeping warm. Changing a purpose changes what a session costs.

### The three inherited policies

Each resolves **task → project → fleet** and each stores `'inherit'` at the tiers that defer.

| Union | Values | Fleet default |
|---|---|---|
| `FinishPolicy` | `await-human` · `commit-only` · `commit-and-verify` · `commit-and-merge` · `commit-and-push` · `pull-request` · `custom` · **`report-only`** | `commit-and-merge` |
| `SessionSharing` | `off` · `on` | `off` |
| `CompletionMode` | `autonomous` · `checkpointed` | `autonomous` |

⚠️ `tasks.workspace_mode` (`inherit`/`worktree`/`trunk`, migration 70) is **task → project →
`worktree`**, with no fleet tier: where an agent may write is a fact about a repository. A non-git
project is always `worktree`. `runs.trunk_dirty_before_json` (same migration) is what a trunk run found
uncommitted when it started, so its finish does not call the operator's files its own.

⚠️ `tasks.auto_compact` (`inherit`/`on`/`off`) is **two tiers, not three** — task → fleet. The project
rung is an additive key if it is ever wanted.

### Others

| Union | Values |
|---|---|
| `TaskKind` | `work` · `plan` · `conversation` · **`debate`** — ⛔ `plan` carries **two shapes, not a fifth kind**, told apart by `planModeOf` from the child cap alone (`min(mandate.maxChildren, childDefaults.maxChildren)`): a cap of **1** is **Plan & Execute**, anything above it is **Plan & Split**. Derived, never a `plan_mode` column — the mandate is what `createTask` enforces, so a flag beside it would disagree with it the first time one was written and not the other, and every plan filed before the feature reads as `split` because the composer's fan-out pill has never offered below 2. A Plan & Execute files exactly one piece, writes **no** `settled` edge back onto itself, is completed at the handoff through the ordinary `completeTask` path (`report-only`, because it wrote no code), and its executor lands onto the **project's** target rather than a plan branch — see `docs/routing.md` §3.9. ⚠️ `plan` is otherwise **Plan & Split**: dispatched to a planning agent, not handed to the controller. ⛔ `conversation` is `work` with the single-turn contract removed: `resolveFinishPolicy`/`resolveSessionSharing` answer `await-human`/`on` from the **kind**, above project and fleet; its turn ends back at `awaiting_human` with the session and workspace kept; and `chooseTarget` returns it to the account it is already talking to (`basis: 'sticky'`) unless a person reassigns it or that window is spent. `isOpenConversation` — kind is `conversation` **and** `finish_policy` is still `inherit` — is the one flag that says which contract a turn runs under. ⛔ **Nothing in the thread writes a real rung any more**: Commit asks the agent to commit and then land, Land lands, `land_work` lands when the person asks the agent to, and all three leave the policy on `inherit` so the conversation stays open and can land again on the next numbered branch (`branch_unit`). Only **Finish** and **Stop** end one; an operator setting the task's own finish dropdown is the remaining way a conversation leaves `isOpenConversation`, and that is them asking for it to be finished like a work task. ⛔ A follow-up into the **same live session** is sent as the person typed it and nothing else: no restated opening prompt, no re-appended contract — that session read both on its first turn and has not stopped since. ⚠️ Since t286 that subtraction is no longer a conversation's alone: every kind gets it, with a one-line re-anchor in place of the contract, and the full framing returns for a fresh session after a preemption, a borrowed one, one that has compacted since this task last spoke, and one whose conversation contract Commit withdrew. See `docs/sessions.md`. ⛔ `debate` is an **organizer**: 2–5 *seats* (child tasks, each pinned to exactly one account/model/effort) answer the same question blind, the organizer arbitrates them and reports an agreement with its dissent, and a `choice` question asks the operator which of five verdicts follows. Its state is one column, `debate_json` (migration 68, `readDebateState`), and its phase is derived from the seats by `debatePhaseOf` in [`src/daemon/debate.ts`](../src/daemon/debate.ts) rather than stored. ⛔ **One kind transition exists in the whole schema and this is it**: `debate` → `conversation`, written only by `becomeConversation` from the verdict path, never by `updateTask` — which is what keeps `kind` safe to branch on in `promptFor`. ⚠️ A **seat** is an ordinary `work` task; nothing about it is a new kind |
| `DependencyRequirement` | `completed` · `settled` — ⛔ `completed` is the default and every pre-existing edge's meaning: *"do B after A"* means A succeeded. `settled` releases on `completed`/`failed`/`cancelled` and is written by `task_split` alone, because a planner must be woken by the pieces that failed too. ⚠️ `cancelling` is deliberately **not** settled: it is a wind-down in progress, not a resting state |
| `LandingStrategyId` | `auto-land` · `leave-branch` · `pull-request` · `verify-only` · `merge-local` · `merge-branch` · **`trunk`** — ⛔ the last two are chosen from *data* (a trunk-mode task on a rung that would move work verifies in place and pushes if asked); `merge-branch` (does this task's resolved target differ from the project's?), never from a task kind. See [`landing.md`](landing.md) |
| `DebateExchange` | `full` · `digest` — what a seat reads from round 2 on: every other position verbatim, or the organizer's brief alone. ⚠️ Data in `debate_json`, never a branch on a seat count |
| `DebateVerdict` | `execute` · `split` · `discuss` · `complete` · `stop` — the operator's five answers to *what now*, raised as one `choice` question the MCP tool blocks on |
| `Priority` | `P0` · `P1` · `P2` · `P3` |
| `MandateOperation` | `read` · `write` · `commit` · `push` · `spawn_tasks` · `land` |
| `ApprovalOrigin` | `permission_prompt` · `tool_gate` · `resource_gate` |
| `ApprovalDecision` | `allow` · `allow_always` · `deny` |
| `ApprovalPolicyResult` | `auto_allow` · `auto_deny` · `escalate` |
| `ConsultKind` | `decompose` · `triage` · `gate` · `route` · `title` |
| `ConsultStatus` | `pending` · `answered` · `fallback` · `failed` |
| `ResourceKind` | `exclusive` · `counted` · `rate_limited` |
| `SessionTransport` | `pty` · `stream` |
| `RunKind` | `work` · `quality_review` — ⛔ **not descriptive.** Every query that means *work* says so, or a one-turn grade lands in the estimator's training data, in `activeMs`, and in the task's "what ran on it" |
| `MessageEvent` | `worker.assigned` · `worker.switched` · `conversation.joined` · `conversation.resumed` · `landing.started` — the closed set of concise system thread lines (migration 62, `task_messages.event`). ⛔ **One line per material change, never one per run.** `announceWorker` in `scheduler.ts` writes `worker.assigned` on a task's first `work` run, **nothing at all** when a later run lands on the same account — ⭐ including a run dispatched on an untrusted quota reading, which used to earn a second *Worker assigned* line mid-conversation and read as the task changing hands (t369); that caveat rides `run.quotaUnverified` and the run row draws it — and `worker.switched … — <reason>` when the account does change; the reason is read off `WorkerChoice.refusals` (the gate that turned the previous account away) and never inferred from prose. `conversation.joined` marks the one warm continuation that is an information boundary — a *borrowed* conversation; a task continuing its own session writes nothing. `conversation.resumed` marks a resting conversation whose agent started speaking again unprompted (`resumeIdleConversation`). `landing.started` is the one event that describes something still happening, written before a landing an operator asked for runs. Everything the old *Started on X in <path> on <branch>* and *Controller routed this to X …* messages said now lives in `detail`, expandable and off the line |
| `ReviewStatus` | `pending` · `complete` · `failed` · `refused` · `cancelled` — ⚠️ `refused` means nothing was asked (no diff, no peer); `failed` means it was asked and the answer was unusable; `cancelled` means a person stopped an in-flight grade. None writes a score or changes the task's lifecycle |

## 5. Adding a column — the checklist

1. Append a migration. Additive columns go through a `hasColumn()`-guarded function so a replay is a
   no-op.
2. Add the field to the `shared/` type, with the comment explaining **why** it exists — the comments
   in `protocol.ts` and `tasks.ts` are the design record for these unions.
3. Give a new held status a releaser, and a new judgment event a deterministic fallback.
4. If it changes what a decision costs or what a score reads, update
   [`cost-model.md`](cost-model.md) or [`routing.md`](routing.md) in the same edit.
5. Bump the `MIGRATION_COUNT` figure in §2 of this page.
