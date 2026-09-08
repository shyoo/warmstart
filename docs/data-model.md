# Data model

The store, the migration contract, and every enum the rest of the system branches on.

> **Audience:** anyone adding a column, a status, or a migration.
> **Authority for:** the migration rules, the table map, and the load-bearing unions.
> Meanings live in [`glossary.md`](glossary.md); who reads each column is
> [`architecture.md`](architecture.md).

---

## 1. The store

`node:sqlite`, WAL, `foreign_keys = on`, at `<dataDir>/multi_agent_controller.db` (`daemon/db.ts`).

⛔ **`node:sqlite`, not better-sqlite3.** It ships inside the Node that Electron already carries, so
there is no native module to rebuild against Electron's ABI and nothing to go wrong at packaging
time. better-sqlite3 publishes no Electron 44 prebuild and would need a toolchain on every
contributor's machine. Measured working under Electron 44 (SQLite 3.53.1) on 2026-08-25.

Rows come back null-prototype; `rows<T>()` and `row<T>()` in `db.ts` make them ordinary objects.
Everything else in the daemon goes through those two, so swapping the driver is a one-file change.

## 2. The migration contract

`MIGRATIONS` in `db.ts` is a numbered, **append-only** array. `MIGRATION_COUNT` is its length and is
the `user_version` a current database sits at — **53** as of 2026-09-07.

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
`agentyard` → `multi_agent_controller` data-directory rename; `adoptLegacyDataDir()` in `paths.ts` is
the first. Both are required and `paths.test.ts` fails if either is removed.

## 3. The tables

| Table | Holds | Notes |
|---|---|---|
| `workers` | one account = one quota bucket | `isolation_root` is absolute; `role`, `health_json`, `sort_order`, `default_model(s)`, independent `grading_model` / `grading_enabled`, **`credits_json`** / **`credits_intent_json`** (migration 53) — ⛔ two columns because they answer different questions and are *allowed to disagree*: the first is what the vendor last said about this account spending past its plan limit, refreshed by the spend probe, the second is what the operator asked for. The gap between them is the thing worth reporting, and it is invisible unless both are written down; **`routable_models_json`** — ⛔ `null`/`[]` both mean *only this worker's current default model*, never "every model the adapter can price"; see `routableModelsFor` in `workers.ts` |
| `quota_samples` | window readings | ⛔ upsert on `(worker, window, sampled_at)`; `window_group` is the pool |
| `spend_samples` | money-meter readings — the analogue of `quota_samples` | written by `spend.ts` off the quota poller's own pass. `direction` says whether the number falls (a credit purse) or rises (a cumulative counter); `balance` and `usd_per_unit` are nullable, and ⛔ null is *unknown*, never `0`. ⚠️ A probe that found nothing writes a row with `meter_id = ''` and an `error` — the analogue of `quota_samples`' empty `window_id`, and skipped by `price.ts` for the same reason. ⚠️ Identity is (worker, meter, the **vendor's** timestamp): re-reading one reading writes nothing |
| `rate_limit_samples` | the vendor's live `rate_limit_event` | `rateLimitType` names the window |
| `calibration` | percent → tokens, per (worker, model, tokenizer) | ⚠️ **zero rows**; R2 is still open |
| `sessions` | one live agent process | `state`, `purpose`, `vendor_session_id`, `current_branch`, `clock_move*` |
| `turns` | per-turn metering | the exact half of cost |
| `clock_events` | every cache-clock decision, including the no-ops | |
| `compactions` | a compaction as an **ask** with a before and an after | a row that never landed stays visible |
| `projects` | a directory plus policy | policy is committed in `.multi_agent_controller/project.json`; state is private. ⛔ Nothing machine-specific goes in that file — `workspaces.root` is written **relative** to the project root, and the derived default as no key. ⚠️ `prompt.orientation` (`auto` · `off`) and `prompt.seed` are what a **cold** prompt says before the task; absent `prompt` is `auto` with no seed |
| `tasks` | the DAG | `status`, `kind`, `priority`, mandate, budget, the three inherited policies, `auto_compact`, `hold_until`, `quota_override_until`, **`quota_preempt_json`**, `title_summary`, `resolve_retry_asked_at`, `landed_base_sha`/`landed_head_sha`, `quality_review_*`, **`landing_target`**, **`child_defaults_json`**, **`stats_excluded`** — ⛔ an operator's judgement that a *measurement* on this task is wrong, set from the thread's `statistics` row. `statistics.ts`, `pace.ts` and `quality.ts` skip it; `estimator.ts` deliberately does not, because a task excluded for an impossible duration still spent exactly the tokens it spent |
| `task_commits` | the commits a task actually landed | ⛔ the answer to *what did this task write*, and the one the quality review asks first. `(task_id, sha)` is the key and writes are `insert or ignore`, so a task that lands twice adds a row rather than replacing one. ⛔ `landed_base_sha`/`landed_head_sha` describe a **range**, which is exact for one landing and wrong for two — seven tasks on this fleet landed twice and t124's pair has five other tasks' commits between them. `source` is `landing` when the landing recorded it and `salvage` when `salvageLandedCommits` read it back out of the thread's *"Landed as `<sha>` onto `<target>`"* message |
| `task_deps` | prerequisite edges | cycle-checked on insert; **`require`** is what counts as met — see below |
| `task_messages` | the thread | `delivered_at` marks what has reached a session |
| `attachments` | image metadata; bytes under `<dataDir>/attachments/` | `attachments.ts` is the only writer |
| `runs` | one attempt of a task on one session | ⛔ never deleted — the estimator's training data. `adapter_id`, `model`, `quota_before/after_json`, `trunk_sha_before`, `prompt`, `started_warm`, `plan_id`/`plan_raw`/`plan_source`, **`kind`**, `list_usd`/`on_overage`/`overage_status`, `activity_json` (intermediate stream steps recorded on finish) — ⛔ the plan and the three facts a probe stated about *this run alone* are stamped; **both** money layers are derived on read by `src/daemon/price.ts`, because an attribution changes the moment a later overlapping run is found — which is why there is no `overage_usd` column. ⚠️ All three money columns are nullable and null means *not known* |
| `quality_reviews` | one peer grade of one task's diff | ⛔ every review is kept with its immutable `rubric_version`; `tasks.quality_review_score` is the mean of all completed, scored reviews and `quality_review_count` states its denominator. `run_id` is the metering *and* the timeline entry. ⚠️ `blinding_leak` means an **attribution** survived blinding, not that a vendor was named — migration 50 re-decided every stored flag from `runs.prompt` after the old any-mention test turned out to be true of 30 of this fleet's 32 reviews; see *Blinding* in the glossary |
| `approvals` `approval_rules` | the permission gate and its remembered answers | |
| `questions` | the third object: content answers, not allow/deny | born parked when the asker is gone |
| `resources` `resource_claims` | the broker | claims are reconciled at startup |
| `consults` | the controller's queue | `detail` carries the arithmetic, kept out of the prompt |
| `chat_messages` | the one tooled controller session | |
| `loose_end_dismissals` | what an operator has said to stop showing | |
| `settings` | fleet settings as JSON under string keys | a boolean today can become a shape tomorrow without a migration |
| `meta` | key/value bookkeeping | |

⚠️ **Fleet settings are JSON values under string keys**, read through `settings()` so a key never
written returns its default rather than `undefined` at the point of use.

## 4. The unions everything branches on

### Task status — `shared/tasks.ts` `TaskStatus`

```
draft · ready · blocked · scheduled · assigned · running
awaiting_human · paused_quota · paused_user
cancelling · cancelled · completed · failed
```

⛔ **Every held status needs something that ends the hold.** `blocked` ← `admitDependents()`, fired by
`setStatus` on the transition into any settled status and never by a call site, with `admitBlocked()`
on the tick as the backstop; `scheduled` ← `admitScheduled()`; `paused_quota` ← `resumeQuotaPaused()`, which
reads a clock **and** `quotaReleaseFor()`. A new held status owes a releaser, or it is a task nothing
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
**human-occupied** — are deliberately *not* standing, nor is `suspect`, which a probe or a turn
clears without anybody being asked.

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
| `FinishPolicy` | `await-human` · `commit-only` · `commit-and-verify` · `commit-and-merge` · `commit-and-push` · `pull-request` · `custom` | `commit-and-merge` |
| `SessionSharing` | `off` · `on` | `off` |
| `CompletionMode` | `autonomous` · `checkpointed` | `autonomous` |

⚠️ `tasks.auto_compact` (`inherit`/`on`/`off`) is **two tiers, not three** — task → fleet. The project
rung is an additive key if it is ever wanted.

### Others

| Union | Values |
|---|---|
| `TaskKind` | `work` · `plan` · `conversation` — ⚠️ `plan` is **Plan & Split**: dispatched to a planning agent, not handed to the controller. ⛔ `conversation` is `work` with the single-turn contract removed: `resolveFinishPolicy`/`resolveSessionSharing` answer `await-human`/`on` from the **kind**, above project and fleet; its turn ends back at `awaiting_human` with the session and workspace kept; and `chooseTarget` returns it to the account it is already talking to (`basis: 'sticky'`) unless a person reassigns it or that window is spent. `isOpenConversation` — kind is `conversation` **and** `finish_policy` is still `inherit` — is the one flag that says which contract a turn runs under; the thread's Commit and Land buttons are the only things that write a real rung, and so the only things that end it — Commit by asking the agent, Land by doing it itself on a branch that is already committed. ⛔ A follow-up into the **same live session** is sent as the person typed it and nothing else: no restated opening prompt, no re-appended contract — that session read both on its first turn and has not stopped since. ⚠️ Since t286 that subtraction is no longer a conversation's alone: every kind gets it, with a one-line re-anchor in place of the contract, and the full framing returns for a fresh session after a preemption, a borrowed one, one that has compacted since this task last spoke, and one whose conversation contract Commit withdrew. See `docs/sessions.md` |
| `DependencyRequirement` | `completed` · `settled` — ⛔ `completed` is the default and every pre-existing edge's meaning: *"do B after A"* means A succeeded. `settled` releases on `completed`/`failed`/`cancelled` and is written by `task_split` alone, because a planner must be woken by the pieces that failed too. ⚠️ `cancelling` is deliberately **not** settled: it is a wind-down in progress, not a resting state |
| `LandingStrategyId` | `auto-land` · `leave-branch` · `pull-request` · `verify-only` · `merge-local` · **`merge-branch`** — ⛔ the last is chosen from *data* (does this task's resolved target differ from the project's?), never from a task kind. See [`landing.md`](landing.md) |
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
