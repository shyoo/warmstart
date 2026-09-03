import { DatabaseSync } from 'node:sqlite'
import { dataDir, ensureDir, legacyDataDir, paths } from './paths.js'
import { dirname, join, sep } from 'node:path'
import { log } from './log.js'
import { costModel } from './costmodel.js'

/**
 * Storage.
 *
 * Deliberately `node:sqlite` rather than better-sqlite3: it ships inside the Node that Electron
 * already carries, so there is no native module to rebuild against Electron's ABI and nothing to go
 * wrong at packaging time. Measured working under Electron 44 (SQLite 3.53.1) on 2026-08-25.
 * The API surface used here is small and wrapped, so swapping the driver later is a one-file change.
 */

/**
 * One migration: SQL, or a function where the statement cannot express itself.
 *
 * ⛔ **A function is for making a migration *replay-safe*, and nothing else.** `sessionstate.test.ts`
 * rewinds `user_version` and reopens to drive the repair against real data, which re-runs every
 * migration after it — so each one has to survive being applied twice. SQL says that for itself with
 * `if not exists`; `alter table ... add column` has no such spelling in SQLite, and a duplicate
 * column then fails a suite that is not about columns at all. ⚠️ Not an escape hatch for logic: a
 * migration that needs to *decide* something is a migration that will decide it differently next
 * year, against data nobody has any more.
 */
type Migration = string | ((conn: DatabaseSync) => void)

/** Does this table already have this column? The guard an additive migration needs to be re-runnable. */
function hasColumn(conn: DatabaseSync, table: string, column: string): boolean {
  const cols = conn.prepare(`pragma table_info(${table})`).all() as { name: string }[]
  return cols.some((c) => c.name === column)
}

/**
 * Decide which subscription every unstamped run was billed against.
 *
 * ⛔ Self-contained on purpose: `runs`, `workers` and the compiled-in cost models, and nothing else.
 * Verified 2026-09-02 that every one of this install's 238 runs carries a `cost_model_id`, so no
 * adapter registry has to be reached for — which is what keeps this out of an import cycle.
 *
 * ⚠️ A function rather than SQL only because the decision needs the cost models' own `detect` and
 * `match` lists, which are data in `costmodels/*.json`. It decides nothing this file invents.
 */
function backfillRunPlans(conn: DatabaseSync, what: string): void {
  /** ⚠️ Read verbatim, never parsed. `WorkerIdentity.subscriptionType` is the vendor's own word. */
  const subscriptionOf = (identityJson: string | null): string | null => {
    if (!identityJson) return null
    try {
      return (JSON.parse(identityJson) as { subscriptionType?: string | null })?.subscriptionType ?? null
    } catch {
      return null
    }
  }

  interface Row {
    id: string
    worker_id: string
    started_at: number
    cost_model_id: string | null
    quota_before_json: string | null
    quota_after_json: string | null
  }
  const pending = conn
    .prepare(
      `select id, worker_id, started_at, cost_model_id, quota_before_json, quota_after_json
         from runs where plan_id is null order by started_at asc`
    )
    .all() as unknown as Row[]
  if (pending.length === 0) return

  const identities = new Map<string, string | null>()
  for (const w of conn.prepare('select id, identity_json from workers').all() as unknown as Array<{
    id: string
    identity_json: string | null
  }>) {
    identities.set(w.id, subscriptionOf(w.identity_json))
  }

  const windowsOf = (r: Row): string[] => {
    const ids = new Set<string>()
    for (const json of [r.quota_before_json, r.quota_after_json]) {
      if (!json) continue
      try {
        const q = JSON.parse(json) as { windows?: Array<{ id: string }> }
        for (const w of q.windows ?? []) if (w?.id) ids.add(w.id)
      } catch {
        // A snapshot that will not parse is a snapshot that says nothing. Not an error worth having.
      }
    }
    return [...ids]
  }

  interface Decision {
    planId: string
    source: string
  }
  const decided = new Map<string, Decision>()

  // 1 - the run's own window shape.
  for (const r of pending) {
    if (!r.cost_model_id) continue
    let cm
    try {
      cm = costModel(r.cost_model_id)
    } catch {
      continue
    }
    const ids = windowsOf(r)
    if (ids.length === 0) continue
    const plan = cm.resolvePlan({ windowIds: ids })
    if (plan && plan.source === 'window_shape') decided.set(r.id, { planId: plan.id, source: 'window_shape' })
  }

  // 2 - the nearest shape-resolved run on the same worker. ⭐ This is what carries the codex
  // free/paid split onto the runs either side of it that happened to take no reading of their own.
  const byWorker = new Map<string, Row[]>()
  for (const r of pending) {
    const list = byWorker.get(r.worker_id)
    if (list) list.push(r)
    else byWorker.set(r.worker_id, [r])
  }
  for (const [, list] of byWorker) {
    const anchors = list.filter((r) => decided.get(r.id)?.source === 'window_shape')
    if (anchors.length === 0) continue
    for (const r of list) {
      if (decided.has(r.id)) continue
      let best: Row | null = null
      let bestGap = Infinity
      for (const a of anchors) {
        const gap = Math.abs(a.started_at - r.started_at)
        if (gap < bestGap) {
          bestGap = gap
          best = a
        }
      }
      if (best) decided.set(r.id, { planId: decided.get(best.id)!.planId, source: 'neighbour' })
    }
  }

  // 3 and 4 - the vendor's own string, then the provider's paid default.
  for (const r of pending) {
    if (decided.has(r.id) || !r.cost_model_id) continue
    let cm
    try {
      cm = costModel(r.cost_model_id)
    } catch {
      continue
    }
    const plan = cm.resolvePlan({ subscriptionType: identities.get(r.worker_id) ?? null })
    if (plan) decided.set(r.id, { planId: plan.id, source: plan.source })
  }

  const stmt = conn.prepare('update runs set plan_id = ?, plan_raw = ?, plan_source = ? where id = ?')
  for (const r of pending) {
    const d = decided.get(r.id)
    if (!d) continue
    stmt.run(d.planId, identities.get(r.worker_id) ?? null, d.source, r.id)
  }
  log.info(`${what}: stamped a plan onto ${decided.size} of ${pending.length} run(s)`)
}

/**
 * Migrations are numbered and append-only. Never edit one that has shipped - add the next.
 * Kept in code rather than in .sql files so the bundler has nothing to copy and the daemon has
 * nothing to find at runtime.
 */
const MIGRATIONS: Migration[] = [
  // 1 - the fleet substrate. Workers hold quota; sessions hold context; turns hold the metering.
  `
  create table workers (
    id              text primary key,
    adapter_id      text not null,
    label           text not null,
    isolation_root  text not null,
    enabled         integer not null default 1,
    human_occupied  integer not null default 0,
    max_concurrent  integer not null default 1,
    identity_json   text,
    policy_json     text not null default '{}',
    created_at      integer not null,
    retired_at      integer
  );

  -- Quota is sampled, not computed. Percent is what the vendor reports; tokens are learned from it.
  create table quota_samples (
    id          integer primary key autoincrement,
    worker_id   text not null references workers(id) on delete cascade,
    window_id   text not null,
    label       text not null,
    percent     real not null,
    resets_at   integer,
    source      text not null,
    error       text,
    sampled_at  integer not null
  );
  create index quota_samples_worker_time on quota_samples(worker_id, sampled_at desc);

  create table sessions (
    id                       text primary key,
    worker_id                text not null references workers(id) on delete cascade,
    adapter_id               text not null,
    transport                text not null,
    project_id               text,
    cwd                      text not null,
    model                    text,
    effort                   text,
    state                    text not null,
    pid                      integer,
    transcript_path          text,
    context_tokens           integer,
    -- The cache TTL runs from the request start, not from the response record. cost-model.md §1.
    last_request_started_at  integer,
    cache_expires_at         integer,
    tokens_since_compact     integer not null default 0,
    started_at               integer not null,
    closed_at                integer
  );
  create index sessions_worker on sessions(worker_id, state);

  -- One row per assistant turn. Sums usage.iterations[], never the top-level counts, because a
  -- compaction's own sampling iteration is excluded from those. cost-model.md §6.
  create table turns (
    id                     integer primary key autoincrement,
    session_id             text not null references sessions(id) on delete cascade,
    request_id             text,
    ts                     integer not null,
    request_started_at     integer,
    model                  text,
    effort                 text,
    git_branch             text,
    input_tokens           integer not null default 0,
    output_tokens          integer not null default 0,
    thinking_tokens        integer not null default 0,
    cache_read_tokens      integer not null default 0,
    cache_write_1h_tokens  integer not null default 0,
    cache_write_5m_tokens  integer not null default 0,
    context_tokens         integer,
    tokenizer              text,
    cost_model_id          text
  );
  create unique index turns_session_request on turns(session_id, request_id);

  create table meta (key text primary key, value text not null);
  `,

  // 2 - the task domain. Projects, the DAG, runs, approvals and the resource broker.
  `
  create table projects (
    id            text primary key,
    name          text not null,
    root          text not null unique,
    vcs           text not null,
    config_json   text not null default '{}',
    config_path   text,
    created_at    integer not null,
    archived_at   integer
  );

  create table tasks (
    id                text primary key,
    seq               integer not null unique,
    project_id        text references projects(id) on delete set null,
    title             text not null,
    status            text not null,
    priority          text not null default 'P2',
    created_by_json   text not null,
    parent_task_id    text references tasks(id) on delete set null,
    lineage_depth     integer not null default 0,
    assignee          text,
    assignee_hint     text,
    mandate_json      text not null,
    budget_json       text not null,
    not_before        integer,
    deadline          integer,
    requires_json     text not null default '[]',
    constraints_json  text not null default '{}',
    verification      text not null default 'auto',
    preemptible       integer not null default 1,
    est_tokens        integer,
    cancel_json       text,
    handoff_note      text,
    branch            text,
    deleted_at        integer,
    created_at        integer not null,
    updated_at        integer not null
  );
  create index tasks_status on tasks(status, priority);
  create index tasks_project on tasks(project_id);
  create index tasks_parent on tasks(parent_task_id);

  -- Edges are rows, not a JSON blob, so a cycle check is a query rather than a graph walk in JS.
  create table task_deps (
    task_id     text not null references tasks(id) on delete cascade,
    depends_on  text not null references tasks(id) on delete cascade,
    primary key (task_id, depends_on)
  );

  create table task_messages (
    id        integer primary key autoincrement,
    task_id   text not null references tasks(id) on delete cascade,
    role      text not null,
    text      text not null,
    run_id    text,
    ts        integer not null
  );
  create index task_messages_task on task_messages(task_id, ts);

  -- ⛔ Runs are never deleted with their task. They are the estimator's training data and the record
  -- of real spend, so task_id is nulled on delete rather than cascading.
  create table runs (
    id                 text primary key,
    task_id            text references tasks(id) on delete set null,
    project_id         text,
    session_id         text,
    worker_id          text not null,
    started_at         integer not null,
    ended_at           integer,
    outcome            text,
    quota_unverified   integer not null default 0,
    input_tokens       integer not null default 0,
    output_tokens      integer not null default 0,
    cache_read_tokens  integer not null default 0,
    cache_write_tokens integer not null default 0,
    cost_model_id      text,
    note               text
  );
  create index runs_task on runs(task_id, started_at desc);
  create index runs_session on runs(session_id);

  -- ⚠️ No foreign key on session_id on purpose. An approval can arrive from a session this daemon
  -- has no row for - a restart, a session it did not spawn - and the right answer then is "no
  -- deadline known", not a constraint failure that denies the agent with an opaque database error.
  create table approvals (
    id                text primary key,
    session_id        text not null,
    run_id            text,
    task_id           text,
    project_id        text,
    origin            text not null,
    tool              text not null,
    target            text,
    summary           text not null,
    policy_result     text not null,
    matched_rule      text,
    asked_at          integer not null,
    deadline_at       integer,
    escalate_after_ms integer not null,
    answered_at       integer,
    answer            text,
    answered_by       text,
    escalated_at      integer
  );
  create index approvals_open on approvals(answered_at, asked_at);

  create table approval_rules (
    id          text primary key,
    project_id  text,
    tool        text not null,
    pattern     text not null,
    effect      text not null,
    created_by  text not null,
    created_at  integer not null
  );
  create index approval_rules_lookup on approval_rules(project_id, tool);

  create table resources (
    id           text primary key,
    project_id   text references projects(id) on delete cascade,
    kind         text not null,
    label        text not null,
    capacity     integer not null,
    members_json text not null default '[]',
    meta_json    text not null default '{}'
  );

  create table resource_claims (
    id           text primary key,
    resource_id  text not null references resources(id) on delete cascade,
    member       text,
    holder       text not null,
    amount       integer not null default 1,
    acquired_at  integer not null,
    released_at  integer
  );
  create index resource_claims_open on resource_claims(resource_id, released_at);
  `,

  // 3 - cost intelligence. Live quota signals, the percent-to-token calibration, and a record of
  // every cache-clock decision so "why did it do that" is answerable months later.
  `
  -- ⚠️ Free and live, unlike the config cache: the CLI emits one of these after each turn on the
  -- stream transport. A status and a real reset time, riding a turn already being paid for.
  create table rate_limit_samples (
    id          integer primary key autoincrement,
    worker_id   text not null,
    session_id  text,
    window_id   text not null,
    status      text not null,
    resets_at   integer,
    sampled_at  integer not null
  );
  create index rate_limit_worker on rate_limit_samples(worker_id, sampled_at desc);

  -- Percent is what the vendor reports; every gate needs tokens. Nobody publishes the conversion, so
  -- it is learned per (worker, model, tokenizer) - ⛔ never across tokenizer generations, which are
  -- not comparable. Sampled only while exactly one session was active on the worker.
  create table calibration (
    worker_id          text not null,
    model              text not null,
    tokenizer          text not null,
    tokens_per_percent real not null,
    samples            integer not null default 0,
    updated_at         integer not null,
    primary key (worker_id, model, tokenizer)
  );

  create table clock_events (
    id               integer primary key autoincrement,
    session_id       text not null,
    move             text not null,
    reason           text not null,
    context_tokens   integer,
    expected_idle_ms integer,
    estimated_cost   integer,
    ts               integer not null
  );
  create index clock_events_session on clock_events(session_id, ts desc);

  alter table runs add column objective_json text;
  alter table tasks add column objective_json text;
  `,

  // 4 - the controller. A judgment layer that the free loop reads but never waits on: every consult
  // is a queued question with a deterministic fallback, and every answer lands as ordinary data.
  `
  -- Which workers may be asked for judgment. Quota lives on the worker, so a controller running low
  -- simply stops being chosen - that is leadership delegation, not a special case.
  alter table workers add column role text not null default 'both';

  -- A "plan" task is decomposed rather than dispatched. Its output is draft children, so the most
  -- open-ended thing the controller produces lands in the one status that cannot dispatch.
  alter table tasks add column kind text not null default 'work';

  -- A message answered into a live session has already been paid for; repeating it in the next
  -- prompt would charge for it twice and confuse the agent about what is still outstanding.
  alter table task_messages add column delivered_at integer;

  -- Consults and chats spend quota but are not work: they hold no workspace and take no run.
  alter table sessions add column purpose text not null default 'work';

  -- ⛔ The queue between the free scheduler and the controller. The scheduler enqueues and moves on;
  -- nothing in a tick waits for an answer, and every row here has a deterministic fallback that
  -- fires on a timer whether or not the controller ever replies.
  create table consults (
    id              text primary key,
    kind            text not null,
    subject_id      text,
    status          text not null,          -- pending | answered | fallback | failed
    question        text not null,
    worker_id       text,
    session_id      text,
    answer_json     text,
    outcome         text,                   -- what was actually applied, in one line
    fallback_reason text,
    created_at      integer not null,
    started_at      integer,
    ended_at        integer
  );
  create index consults_pending on consults(status, created_at);
  create index consults_subject on consults(kind, subject_id, created_at desc);

  create table chat_messages (
    id          integer primary key autoincrement,
    thread_id   text not null,
    role        text not null,              -- human | controller | system
    text        text not null,
    session_id  text,
    ts          integer not null
  );
  create index chat_messages_thread on chat_messages(thread_id, ts);
  `,

  // 5 - repair every counter that was billed more than once.
  //
  // ⚠️ A transcript repeats usage records. Measured 2026-08-26 on claude 2.1.223: one 41-turn
  // session's JSONL carried **72 usage records with 41 unique request ids**. `turns` has a unique
  // index on (session_id, request_id) and was always exact; every accumulator reading the same
  // stream was not. On the machine this was found on, one run recorded 3,154,302 cache-read tokens
  // against an actual 1,848,902, its task's budget claimed 3.3M of spend that never happened, and
  // `tokens_since_compact` - which the compaction reserve and the cache clock both read before
  // deciding to spend money - stood at 144,133 against 73,987.
  //
  // `turns` is therefore the source of truth here, and everything else is recomputed from it.
  `
  -- A turn belongs to the most recent run that had started on its session. ⚠️ Not a
  -- started_at..ended_at window: the last turn of a run is routinely written *after* the run is
  -- closed (the transcript is flushed after the process goes), and a strict window drops exactly
  -- the turn that carries the largest context.
  update runs set
    input_tokens = coalesce((
      select sum(t.input_tokens) from turns t
       where t.session_id = runs.session_id and t.ts >= runs.started_at
         and not exists (select 1 from runs r2 where r2.session_id = t.session_id
                          and r2.started_at > runs.started_at and r2.started_at <= t.ts)), 0),
    output_tokens = coalesce((
      select sum(t.output_tokens) from turns t
       where t.session_id = runs.session_id and t.ts >= runs.started_at
         and not exists (select 1 from runs r2 where r2.session_id = t.session_id
                          and r2.started_at > runs.started_at and r2.started_at <= t.ts)), 0),
    cache_read_tokens = coalesce((
      select sum(t.cache_read_tokens) from turns t
       where t.session_id = runs.session_id and t.ts >= runs.started_at
         and not exists (select 1 from runs r2 where r2.session_id = t.session_id
                          and r2.started_at > runs.started_at and r2.started_at <= t.ts)), 0),
    cache_write_tokens = coalesce((
      select sum(t.cache_write_1h_tokens + t.cache_write_5m_tokens) from turns t
       where t.session_id = runs.session_id and t.ts >= runs.started_at
         and not exists (select 1 from runs r2 where r2.session_id = t.session_id
                          and r2.started_at > runs.started_at and r2.started_at <= t.ts)), 0)
  where exists (select 1 from turns t where t.session_id = runs.session_id);

  -- Budgets follow the runs, so this has to come second.
  update tasks set budget_json = json_set(budget_json, '$.spentTokens', coalesce((
    select sum(r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_write_tokens)
      from runs r where r.task_id = tasks.id), 0))
  where exists (select 1 from runs r where r.task_id = tasks.id);

  -- ⚠️ Recomputed from every turn on the session, which is exact for a session that has never
  -- compacted and too high for one that has - no compaction timestamp is stored, only a reset to
  -- zero. Too high is the safe direction: it compacts earlier than needed, where too low strands
  -- context at a window boundary, and that is the loss this whole cost model exists to prevent.
  update sessions set tokens_since_compact = coalesce((
    select sum(t.input_tokens + t.output_tokens + t.cache_write_1h_tokens + t.cache_write_5m_tokens)
      from turns t where t.session_id = sessions.id), 0)
  where exists (select 1 from turns t where t.session_id = sessions.id);
  `,

  // 6 - stop the fleet strip stacking a fresh copy of every quota window every five minutes, and
  // give a worker somewhere to record that work does not survive on it.
  //
  // ⚠️ `sampled_at` is **the vendor's fetch time, not ours** - `cachedUsageUtilization.fetchedAtMs`,
  // which is exactly right for staleness and exactly wrong as an insert key. Re-reading a cache the
  // CLI has not refreshed produces a row identical to the last one, and `lastQuota` selects *every*
  // row at `max(sampled_at)` - so a worker whose cache had not moved showed `session` and `weekly`
  // twice after ten minutes and three times after fifteen. Measured on this machine 2026-08-27:
  // ClaudeSecond, session 6% / weekly 0%, rendered three times over.
  //
  // A reading is identified by (worker, window, when the vendor fetched it), so that is the key.
  `
  delete from quota_samples where id not in (
    select max(id) from quota_samples group by worker_id, window_id, sampled_at
  );
  create unique index quota_samples_reading
    on quota_samples(worker_id, window_id, sampled_at);

  -- ⛔ Separate from identity_json on purpose. Identity is what the vendor's auth status says; this
  -- is what a dispatch proved. An account can answer the first perfectly and still fail every run.
  alter table workers add column health_json text;

  -- Why a ready task is not moving. Written only when it changes; cleared when the task moves.
  alter table tasks add column hold_reason text;
  `,

  // 7 - a run's cost needs a baseline, so a run gets one either side.
  //
  // ⛔ A single reading is not a measurement. A run that reports "this account is at 41% of its
  // window" says nothing about what the run spent, and 41% was the only thing this app could show -
  // which made the honest question "how much did that task cost me against my subscription?"
  // unanswerable from the UI. The scheduler now refreshes a stale reading *before* dispatching (one
  // tick of patience, no tokens) and takes another once the run has ended and nothing is waiting.
  //
  // ⚠️ Kept separate from the token columns rather than reconciled with them. The token counts are
  // exact assistant-turn metering; quota measures everything the account spent, classifier and title
  // generation included. The gap between the two is the measurement, so merging them destroys it.
  `
  alter table runs add column quota_before_json text;
  alter table runs add column quota_after_json text;
  `,

  // 8 - a cache-clock move is a request, not an outcome, and until this it was recorded as though
  // it were both.
  //
  // ⛔ The bug this closes, measured on this machine 2026-08-26: session c17ce7 sat at 68001 context
  // tokens and the clock sent it `/compact` on **every 10s tick for as long as it was watched** -
  // thirteen identical rows in two minutes, same session, same reason, same 35k estimate. Nothing
  // was wrong with the decision; what was missing was any memory that it had already been made.
  // `decide()` is a pure function of the session row, compaction takes ~2 minutes (measured 139k ·
  // 116k · 161k ms), and nothing in the session row changes in the meantime - so the same inputs
  // produced the same move twelve more times before the first one could possibly have landed.
  //
  // ⚠️ Worse than the noise: each repeat is a real user message pushed into a live session. A
  // *free* decision loop was writing a **billable** turn every ten seconds, which is precisely the
  // "a loop running every 10 seconds for weeks must not bill anything" invariant in AGENTS.md,
  // violated by the one component whose entire purpose is to not waste tokens.
  //
  // So a move is now written down when it is *issued*, with the evidence that would prove it
  // landed, and the clock declines to re-issue until it has settled. `clock_move_context` is
  // `tokens_since_compact` at the moment of the request: compaction resets that to zero, so a drop
  // is proof, whereas "a turn happened" is not - an agent replying "I don't understand /compact" is
  // also a turn.
  `
  alter table sessions add column clock_move text;
  alter table sessions add column clock_move_at integer;
  alter table sessions add column clock_move_attempts integer not null default 0;
  alter table sessions add column clock_move_context integer;

  -- ⛔ Global, deliberately, and there is exactly one of them. Per-worker or per-project compaction
  -- switches would be four places to look when a session is not compacting; the operator asked for
  -- one switch, and one switch is also the only kind whose state can be shown honestly in a header.
  -- Values are JSON so a boolean today does not need a migration to become a shape tomorrow.
  create table if not exists settings (
    key        text primary key,
    value      text not null,
    updated_at integer not null
  );
  `,

  // 9 - one answer to "what happens when the work is finished", instead of three halves of one.
  //
  // ⛔ The question was split across `project.landing.strategy` (project only), `tasks.verification`
  // (task only, and named after a different idea), and nothing at the fleet level - so "why did this
  // not land?" needed two fields checked in two files, and neither could be changed while a task was
  // running. Measured 2026-08-28: t5 finished, left two files uncommitted, was refused by
  // `canLand`, rested at `awaiting_human`, and the commit that eventually appeared on its branch
  // (ea05929) was never landed by anything and went unnoticed for a day.
  //
  // ⚠️ `verification` is migrated, not dropped. `required` meant "a person signs this off", which is
  // exactly `await-human`, and the column stays so a database written by an older build still
  // parses. Nothing writes it after this.
  `
  alter table tasks add column finish_policy text not null default 'inherit';

  update tasks set finish_policy = 'await-human' where verification = 'required';

  -- ⛔ One ask, ever. The finish path sends the agent an instruction - commit your work, or run this
  -- project's finish policy - and then waits for it to report completion again. Between those two
  -- moments the task is still running and still completing, which is exactly the state that decides
  -- to send the instruction. Without this the tool would re-send it on every completion, which is
  -- the preemption loop of 2026-08-28 in a different costume: 13 identical wrap-up prompts into a
  -- session that had already done the thing, each of them a billed turn.
  alter table tasks add column finish_asked_at integer;

  -- ⚠️ Only the dismissals are stored. A loose end itself is a fact about a repository right now -
  -- the branch got landed by hand, the stash got popped - and a cached copy would be stale within
  -- minutes and need its own reconciliation. "I know, leave me alone" is the one part git cannot
  -- tell us, so it is the only part written down.
  create table loose_end_dismissals (
    id           text primary key,
    dismissed_at integer not null
  );
  `,

  // 10 - the vendor's own name for the conversation, so a session can be started again holding it.
  //
  // ⛔ Measured on this install 2026-08-28: across the nine (task, adapter) pairs that have ever
  // run, distinct sessions equalled runs in every one - t8 alone burned four Antigravity
  // conversations on four turns of the same task. `warmSessionFor` has never once matched, because
  // `completeTask` closes the session a second after the turn ends and the next reply spawns cold.
  // The context was not being reused; it was being rebuilt from nothing every time, at 2.0·C.
  //
  // ⚠️ Distinct from `sessions.id` on purpose. Claude Code takes an id we mint, so the two agree;
  // Antigravity names its own conversation and reports it on the `init` record, so for that adapter
  // this is the only handle the CLI would recognise. Null until a session says what it is.
  `
  alter table sessions add column vendor_session_id text;
  `,

  // 11 - who a conversation belongs to, and whether a run had to build its context or inherited it.
  //
  // ⛔ `sessions.project_id` has existed since M2 and nothing ever wrote it. Measured 2026-08-28:
  // twenty work sessions in this install, **zero** with a project. So the only route from a
  // conversation to a project was through its runs, and a session that had not run yet had none -
  // which is no basis for grouping conversations by project, or for the residency work that follows.
  // The backfill reads the runs, which is where the answer has been hiding.
  //
  // ⚠️ `started_warm` is not bookkeeping. A run that inherited a live conversation costs a fraction
  // of the same run built from nothing - measured the same day, 41,542 cache-creation tokens against
  // 65 - and `estimateTask` averages every run of a kind together. Feeding both into one mean makes
  // the estimate meaningless in both directions, and the runaway watchdog fires at 3x that mean.
  // ⛔ Null for every run that predates this, which is honest: nothing recorded it at the time, and
  // defaulting them to 0 would assert a measurement nobody made.
  `
  update sessions
     set project_id = (
       select r.project_id from runs r
        where r.session_id = sessions.id and r.project_id is not null
        order by r.started_at limit 1
     )
   where project_id is null;

  alter table runs add column started_warm integer;
  `,

  // 12 - which branch the tree a conversation lives in is actually on.
  //
  // ⛔ A session outlives the task that opened it now, and the next task to borrow it wants a
  // different branch. Something has to know what the worktree is currently checked out to, because
  // the answer decides whether a switch is needed and - when the borrower is done - what to switch
  // *back* to. Reading it from git each time would answer a different question: git says what the
  // tree is on, not what the conversation believes it is on, and the gap between those two is
  // exactly the stale-context hazard the switch notice exists to warn about.
  //
  // ⚠️ Null for a session with no branch at all - a `vcs: none` project, a consult, a chat.
  `
  alter table sessions add column current_branch text;
  `,

  // 13 - may this task borrow a conversation somebody else has been having?
  //
  // ⛔ `inherit` for every existing task, and `off` at the fleet, so a database written before this
  // migration behaves afterwards exactly as it did before. Sharing changes who can see whose work;
  // switching that on for every project in an install by upgrading it would be a change nobody asked
  // for, made everywhere at once.
  `
  alter table tasks add column session_sharing text not null default 'inherit';
  `,

  // 14 - where the trunk's landing target stood when this run was dispatched.
  //
  // ⛔ Recorded per run rather than held in memory, because the check it feeds has to survive a
  // daemon restart: a run can outlive the process that started it, and a tripwire that forgets on
  // restart is one that is absent exactly when something went wrong unattended.
  //
  // ⚠️ Null for every run written before this, and null is not "the trunk did not move" - it is "no
  // reading was taken". The comparison declines rather than guessing.
  `
  alter table runs add column trunk_sha_before text;
  `,

  // 15 - the model and effort this account reaches for when nothing more specific says otherwise.
  //
  // ⛔ On the **worker**, not the project or the fleet. A model id belongs to one CLI - `opus` means
  // nothing to Antigravity and `gemini-3.1-pro-high` means nothing to Claude Code - so a default
  // held anywhere that can route to more than one adapter is a value that is invalid most of the
  // time. The worker is the narrowest place that always knows which CLI it is.
  //
  // ⚠️ Null means "whatever the CLI does by itself", which is what every install did before this and
  // what every worker keeps doing after it. Null is not a missing default; it is the CLI's own.
  `
  alter table workers add column default_model text;
  alter table workers add column default_effort text;
  `,

  // 16 - default models per quota pool on multi-pool workers.
  //
  // Enables automatic budget-aware balance scheduling across pools (e.g. Gemini vs Claude/GPT on
  // Antigravity).
  `
  alter table workers add column default_models_json text;
  `,

  // 17 - the order a person put the fleet in.
  //
  // ⛔ A stored position, not a sort key derived from anything the daemon computes. Every ordering
  // the fleet strip could derive for itself - by quota, by busyness, by label - reorders the cards
  // underneath the operator while they are reading them, and the strip is a thing people learn the
  // shape of. The one ordering that stays still is the one somebody chose.
  //
  // ⚠️ Backfilled from `created_at` so an existing install opens looking exactly as it did: the
  // rank of each row in the order `listWorkers` already returned. Retired workers are ranked too,
  // so un-retiring one does not drop it at position zero.
  `
  alter table workers add column sort_order integer not null default 0;
  update workers set sort_order = (
    select count(*) from workers other
    where other.created_at < workers.created_at
       or (other.created_at = workers.created_at and other.id < workers.id)
  );
  `,

  // 18 - the exact prompt sent to the agent CLI for this run.
  //
  // Records what the CLI was actually told - including prepended handoff notes from previous
  // sessions, branch switch notices, and completion instructions (e.g. MCP task_complete vs commit).
  // Null for runs predating this column.
  `
  alter table runs add column prompt text;
  `,

  // 19 - the agent was asked to resolve a rebase conflict.
  //
  // ⛔ A **second** guard, not a reuse of the first, and they have to stay independent.
  // 'finish_asked_at' means *we asked this agent to commit its work*; this means *we asked it to
  // resolve a rebase conflict*. Different questions, asked at different moments. Sharing one column
  // would silently deny a conflict ask to any task that had already been asked to commit - it would
  // arrive at 'awaiting_human' carrying a conflict nobody ever asked it to fix. One ask each, then
  // a person.
  //
  // ⚠️ Null for every existing task, which is correct: none of them was ever asked.
  `
  alter table tasks add column conflict_asked_at integer;
  `,

  // 20 - a question a person has to answer, which is not an approval and not a task.
  //
  // ⛔ **Not a widening of `approvals`.** An approval's answer set is closed at allow/deny, its
  // answer can be remembered as a project rule, and deny wins by default. Every one of those is
  // wrong for "OAuth, session cookies, or magic link?": the answer set is written by whoever asks,
  // it can never be a rule, and a default of "no" is not an answer at all. Measured 2026-08-30
  // (R14.a): the vendor hands us `questions[]` with labels and per-option prose, and the old path
  // flattened all of it to three buttons.
  //
  // ⚠️ `answered_at` stays null across a park, on purpose. D1: when nobody answers before the
  // session's cache expires the session dies and the task rests at 'awaiting_human', but the
  // question is still open and still answerable an hour later. `parked_at` records that the thing
  // that was going to consume the answer has gone; it does not close the row.
  //
  // ⚠️ No foreign key on session_id, for the same reason as approvals: a question can outlive the
  // session that asked it, and that is the normal case rather than the error case.
  `
  create table questions (
    id           text primary key,
    session_id   text not null,
    run_id       text,
    task_id      text,
    project_id   text,
    origin       text not null,
    kind         text not null,
    question     text not null,
    header       text,
    options_json text,
    asked_at     integer not null,
    deadline_at  integer,
    answered_at  integer,
    answer_json  text,
    answered_by  text,
    parked_at    integer
  );
  create index questions_open on questions(answered_at, asked_at);
  create index questions_task on questions(task_id, asked_at desc);
  `,

  // 21 - how far a dispatched agent is expected to get before it stops.
  //
  // ⛔ Not a permission setting. `autonomous` (the default, and what every existing task gets)
  // means *finish the task*, and such an agent still stops to ask when a decision changes what it
  // builds. `checkpointed` means *report at each phase boundary and wait* - a different contract,
  // chosen for work worth steering, and the reason the column exists rather than being assumed.
  //
  // ⚠️ `inherit` is a real value, not a blank: a task left on it follows its project as the
  // project changes, and one set explicitly to the same value does not.
  `
  alter table tasks add column completion_mode text not null default 'inherit';
  `,

  // 22 - the arithmetic behind a routing question, kept out of the question itself.
  //
  // ⛔ The score legend and each candidate's term-by-term derivation are *debugging evidence*, not
  // instructions: a person reading a judgment call afterwards needs them to see why the numbers
  // landed where they did, and the controller needs only the totals to pick an id. They used to be
  // pasted into `question`, which billed every routing consult for them. Same lines, same
  // arithmetic, stored beside the question instead of inside it.
  //
  // ⚠️ Nullable, and null on every row written before this: consults that have no arithmetic behind
  // them (decompose, triage, gate) never set it.
  `
  alter table consults add column detail text;
  `,

  // 23 - which agent and which model actually spent a run's tokens.
  //
  // ⛔ Measured on this install 2026-08-30, 73 completed runs: the median run on
  // `antigravity-cli/gemini-3.7-flash-medium` totalled 12,477,352 tokens against 153,091 on
  // `claude-code/claude-sonnet-5` — **81x**, and 93x after pricing. One median across all of them,
  // which is what `estimateTask` computed until now, is a central tendency of nothing: it called
  // every agy run a runaway before it had done anything unusual and under-estimated every one of
  // them for the parent-budget gate. The estimator cannot condition on a key it cannot read.
  //
  // ⛔ Denormalised out of `sessions` on purpose, and this is the whole reason the columns exist.
  // Runs are never deleted, sessions are closed and rewritten constantly, and 17 of the 52
  // Antigravity runs on this install had already lost their model that way. The record of what a run
  // cost must not depend on the conversation still being there.
  //
  // ⚠️ `model` stays null on runs whose session never learned one. Antigravity names its own model
  // on the transcript's first usage record, so a run that died before saying anything has no answer
  // — and null is that answer. `estimateTask` falls back to the adapter-only key for those.
  `
  alter table runs add column adapter_id text;
  alter table runs add column model text;

  update runs
     set adapter_id = (select s.adapter_id from sessions s where s.id = runs.session_id),
         model      = (select s.model      from sessions s where s.id = runs.session_id)
   where session_id is not null;

  update runs
     set adapter_id = (select w.adapter_id from workers w where w.id = runs.worker_id)
   where adapter_id is null;

  create index runs_key on runs(adapter_id, model, outcome, started_at desc);
  `,

  // 24 - a compaction, as an event with a before and an after.
  //
  // ⛔ **Because "did it compact?" had no answer.** The clock sent `/compact` down a session's input
  // and wrote one line to a log file; the boundary record reset `tokens_since_compact` to 0, and
  // that was the entire trace. Nothing the operator can see ever said a compaction was asked for,
  // landed, or was ignored. Measured 2026-08-31: `autoCompact` was switched on at 07:48Z, and by
  // 23:30Z `clock_events` still held nothing newer than 2026-08-27 - so the honest answer to "is it
  // working?" was that nobody could tell, which is the same shape of defect as a number with no
  // provenance.
  //
  // ⚠️ `post_tokens` is null until a turn measures it, and stays null if none ever does. The
  // boundary record carries `preTokens` and no counterpart, so the compacted size is genuinely
  // unknown until the next turn reports a context. A "post" computed by subtracting an estimate
  // would be the one number on this row that nobody measured.
  //
  // ⚠️ `task_id` is copied rather than reached through the session: a session outlives the run that
  // borrowed it, and a shared session serves more than one task.
  `
  create table compactions (
    id          integer primary key autoincrement,
    session_id  text not null,
    task_id     text,
    trigger     text not null,
    reason      text,
    pre_tokens  integer,
    post_tokens integer,
    duration_ms integer,
    asked_at    integer,
    landed_at   integer,
    ts          integer not null
  );
  create index compactions_task on compactions(task_id, ts desc);
  create index compactions_session on compactions(session_id, ts desc);
  `,

  // 25 - the two clocks a held task never had: when it could next move, and until when a person
  // said to go anyway.
  //
  // ⛔ **`hold_until` exists because `hold_reason` is prose.** The scheduler already knew the answer
  // and threw it away: t71, 2026-09-01T00:31Z, was held with *"ClaudeThird at 92% of its Claude 5h
  // window"* against a reading whose `resets_at` was 2h29m out. Nothing downstream could read that
  // sentence, so `expectedIdleMs` counted the task as `ready now` and told every live session in the
  // fleet that work was imminent - which is exactly the input that suppresses moves 2, 3 and 4 of
  // the cache clock. A queue that cannot move for two and a half hours was being priced as a queue
  // about to move. ⚠️ Descriptive only, like `hold_reason` beside it: nothing gates on it, and it is
  // deliberately **not** `not_before`, because `admit()` reads that field and would flip a held
  // `ready` task to `scheduled` - a status change nobody asked for as a side effect of an
  // explanation.
  //
  // ⛔ **`quota_override_until` is the operator overruling a percentage, and only a percentage.**
  // `QUOTA_HIGH_WATER` is a cliff at 92% with nothing on the far side of it: a pinned task whose one
  // account is at 92% waits for the window with no way to say *"92% is plenty for this"*. A person
  // can see what the fleet cannot - that the remaining 8% is more than the task needs - and until
  // now had no way to say so. ⚠️ A wall-clock deadline, not a flag: it is written from the reset of
  // the very window it overrules, so it expires with that window whether or not anything ran. A
  // permission that outlives its reason is one nobody remembers granting.
  `
  alter table tasks add column hold_until integer;
  alter table tasks add column quota_override_until integer;
  `,

  // 26 - ⛔ **Which pool a window belongs to, kept.** The whole per-pool gate rests on
  // `QuotaWindow.group` — Antigravity meters Gemini apart from Claude/GPT, and `sessionWindowFor`
  // finds a task's own window by asking which group it is in. That field was parsed, carried
  // through the adapter, used once, and then **dropped on the way into this table**, so every
  // reader that goes through the store (which is every gate: `chooseTarget`, the mid-run watchdog,
  // the resume check) saw windows with no group and silently fell back to the *busiest* pool.
  //
  // ⚠️ The effect was a refusal with no cause, and an invisible one: a Gemini task held out because
  // the Claude/GPT window was nearly spent, on pools that do not share. The pool logic was measured
  // against in-memory windows on 2026-08-27 and has been inert against stored ones ever since.
  //
  // ⛔ Nullable, and null keeps its meaning: a single-pool provider's window has no group and must
  // not acquire one.
  `
  alter table quota_samples add column window_group text;
  `,

  // 27 - repair the sessions that were blamed for their own shutdown.
  //
  // ⛔ **`state` was recording an exit code, not an outcome.** `handleExit` marked a session `failed`
  // whenever the process exited non-zero, and killing a process *always* does — so winding a task
  // down, reclaiming its worktree, or the cache clock closing a cold conversation each recorded a
  // failure. Beside it, `reconcileOrphans` marked every still-open row `failed` at startup, and the
  // daemon restarts for reasons the agent has no part in. Measured 2026-08-31 on the author's
  // install: **81 runs with `outcome: 'completed'` sat inside sessions marked `failed`**, against 7
  // whose run had genuinely failed. The Conversations page was a wall of red describing work that
  // had succeeded.
  //
  // ⛔ The runs are the evidence, so the runs decide, and **only where there is evidence**. A session
  // every one of whose runs ended `completed`, `blocked`, `cancelled` or `preempted` was not a
  // process that died on its own; it was one that was asked to stop, which is `closed`. `failed`
  // stays wherever a run actually failed, and `closed`, `live`, `idle` and `starting` rows are not
  // touched at all.
  //
  // ⛔ A session that served **no** run is left exactly as it is. That is every `consult`, `login`
  // and `probe` row, and a dispatch that died before its first turn — there is nothing to read a
  // verdict off, and rewriting those would be inventing one. On the install this was measured
  // against, all 75 wrong work rows have runs, so the conservative rule loses nothing.
  //
  // ⚠️ This rewrites recorded history, which is not a thing to do lightly. It is done because the
  // old value was not a record of anything — it was a restatement of `kill()`'s exit status under a
  // column name that claimed to be a verdict, and leaving 75 wrong rows in place would have meant
  // the repaired UI still looked broken for months.
  `
  update sessions
     set state = 'closed'
   where state = 'failed'
     and exists (select 1 from runs r where r.session_id = sessions.id)
     and not exists (
           select 1 from runs r
            where r.session_id = sessions.id and r.outcome = 'failed'
         );
  `,

  // 28 - the two indexes active time needs, and neither table had one.
  //
  // ⛔ **`questions` and `approvals` are now read by run, and were only ever indexed by task and by
  // openness.** `activetime.ts` asks "what was waiting on a person during these runs" on the path
  // that renders the task ledger, which re-renders on every daemon event — without these, every one
  // of those is a full scan of two tables that are append-only and never pruned. The cost is
  // invisible on this install's 54 tasks and is exactly the kind that is discovered a year later.
  //
  // ⚠️ `runs(task_id, started_at desc)` already exists (`runs_task`), so the other half of the same
  // query was fine. These are the two that were missing.
  `
  create index if not exists questions_run on questions(run_id);
  create index if not exists approvals_run on approvals(run_id);
  `,

  // 29 - a one-line label for a task whose title is a paragraph.
  //
  // ⛔ **A new column rather than a rewrite of `title`, and that is the whole design.** `title` is
  // what `promptFor()` sends to the agent, verbatim, and the task form files an entire textarea into
  // it - so summarising in place would silently shorten the instruction the fleet is working from.
  // This column is written by the controller and read by nothing but the UI, which renders
  // `title_summary` where there is one and `title` where there is not.
  //
  // ⚠️ Nullable, with no default and no backfill. A task that has never been summarised is not a
  // broken row, it is an unsummarised one, and the renderer already has the right thing to show for
  // it - the prompt itself.
  (conn) => {
    if (!hasColumn(conn, 'tasks', 'title_summary')) {
      conn.exec('alter table tasks add column title_summary text;')
    }
  },

  // 30 - default models per pool for Antigravity workers (Gemini: gemini-3.7-flash-medium, Claude/GPT: claude-sonnet-4-6).
  //
  // Automatically enables budget-aware pool balancing across Gemini and Claude/GPT out of the box.
  `
  update workers
     set default_models_json = '{"gemini":"gemini-3.7-flash-medium","claude":"claude-sonnet-4-6"}'
   where adapter_id = 'antigravity-cli'
     and (default_models_json is null or default_models_json = '{}');
  `,

  // 31 - an image pasted onto a message, as a row of its own.
  //
  // ⛔ **Metadata here, bytes on disk.** A pasted screenshot is 1-3 MB and this database is opened
  // by the daemon on every tick; a blob column would bloat the WAL for data that is only ever read
  // whole, by path, and mostly by a CLI rather than by us. `file` is absolute, under
  // `<dataDir>/attachments/`, and is the same path that travels in the prompt text.
  //
  // ⚠️ `message_id` and `task_id` are nullable because an attachment exists *before* the message
  // that carries it does - it is uploaded while somebody is still typing. An unbound row whose
  // form was abandoned is what `prunePending` collects; without the nullable columns the upload
  // would have to invent a message to hang off.
  //
  // ⚠️ `kind` is a column rather than an assumption, so that audio is a value and not a migration.
  //
  // ⛔ `if not exists`, like migration 28 and for the same reason: `versionBefore` lets a test
  // rewind `user_version` and reopen, which replays every migration after the one it wanted — so
  // any migration added later has to survive being run twice. Without it, adding this one broke
  // seven assertions in `sessionstate.test.ts` about a repair three migrations earlier.
  `
  create table if not exists attachments (
    id         text primary key,
    message_id integer references task_messages(id) on delete cascade,
    task_id    text    references tasks(id) on delete cascade,
    kind       text not null,
    media_type text not null,
    file       text not null,
    bytes      integer not null,
    width      integer,
    height     integer,
    created_at integer not null
  );
  create index if not exists attachments_message on attachments(message_id);
  create index if not exists attachments_task on attachments(task_id);
  `,

  // 32 - per-task override of the fleet's automatic-compaction switch.
  //
  // ⛔ **`'inherit'` is the default and is a real value, not a blank.** A task on it follows
  // Settings > Global as that switch changes; a task set explicitly to the same value does not.
  // Backfilling every existing row to `on` or `off` would have frozen the whole board against
  // whatever the switch happened to say on the day of the upgrade.
  //
  // ⚠️ Guarded by `hasColumn` rather than written as a bare `alter table`, like migrations 28 and
  // 31: `versionBefore` lets a test rewind `user_version` and reopen, which replays every migration
  // after the one it wanted, so anything added later has to survive being run twice.
  (conn) => {
    if (!hasColumn(conn, 'tasks', 'auto_compact')) {
      conn.exec("alter table tasks add column auto_compact text not null default 'inherit';")
    }
  },

  // 33 - deduplicate replayed compactions in recorded history.
  //
  // ⛔ **A resumed session re-tailed its transcript from offset 0**, and every `compact_boundary`
  // line written by earlier runs was re-emitted to `noteCompactionLanded`. Without deduplication,
  // each resume created a duplicate row in `compactions` with trigger='auto' and posted a duplicate
  // system message ("Compacted from ... The CLI did this on its own...").
  //
  // This cleans up duplicate landed compaction records for the same session at the same timestamp.
  `
  delete from compactions
   where id not in (
     select min(id) from compactions
      group by session_id, landed_at, coalesce(duration_ms, -1), coalesce(pre_tokens, -1)
   )
   and landed_at is not null;
  `,

  // 34 - Claude Code's `<synthetic>` entries are JSONL bookkeeping, not assistant turns.
  //
  // They carry zero-token `usage` objects, which made older builds store the marker as a session's
  // observed model (and sometimes its effort). Clear that false observation so the Tasks UI falls
  // back to the requested model until a real transcript turn arrives. Safe to replay: updating an
  // already-null value changes nothing.
  `
  update sessions
     set model = null,
         effort = null
   where model = '<synthetic>';

  update turns
     set model = null,
         effort = null,
         tokenizer = null
   where model = '<synthetic>';
  `,

  // 35 - one automatic resolve-and-retry per task.
  //
  // ⛔ A landing failure is often actionable, but retries spend a real agent turn. Persist the ask
  // before re-queueing so a second failure reaches a person instead of recreating the same run forever.
  (conn) => {
    if (!hasColumn(conn, 'tasks', 'resolve_retry_asked_at')) {
      conn.exec('alter table tasks add column resolve_retry_asked_at integer;')
    }
  },

  // 36 - which subscription each run was billed against, so a run can be priced in money.
  //
  // ⛔ **Three columns rather than one JSON blob.** `plan_id` is grouped by, `plan_raw` keeps the
  // vendor's own string unparsed so a future catalogue entry can be matched against history that
  // was written before it existed, and `plan_source` is the *basis* every cost belief in this repo
  // has to carry (AGENTS.md).
  //
  // ⛔ **The plan is stamped, the price is not.** A run's dollars change the moment a *later*
  // overlapping run is discovered, so money is derived on read (daemon/price.ts). What a run was
  // *billed against* does not change, and is the one part worth freezing.
  //
  // The backfill, in priority order — see costmodel.ts `resolvePlan`:
  //
  //   1. the run's own window **shape**, through a catalogue entry's `detect`. ⭐ This is what
  //      splits Codex's free era from its paid one exactly: measured 2026-09-02, every codex run up
  //      to 2026-09-01 21:28Z carried a single `30d` window and every one after carried `5h` + `7d`.
  //   2. the nearest shape-resolved run on the same worker (`neighbour`), which carries that split
  //      across the runs either side that happened to take no reading.
  //   3. the worker's own `identity_json.subscriptionType` (`identity`).
  //   4. the provider's `default_plan` (`default`). ⚠️ Always a paid plan. Guessing *free* would
  //      silently print `n/a` over real money, and this fleet's operator asked for the opposite.
  //
  // ⚠️ Guarded by `hasColumn` and scoped to `plan_id is null`, like migrations 28/31/32: a test can
  // rewind `user_version` and reopen, which replays this, and a second pass must change nothing.
  (conn) => {
    // ⚠️ A string rather than a comment, and one that is actually used. `versionBefore` finds a
    // migration by its own source text, and the bundler strips comments out of a function body —
    // so a function migration that names itself in a comment is a migration no test can rewind to.
    const what = 'which subscription each run was billed against'
    if (!hasColumn(conn, 'runs', 'plan_id')) {
      conn.exec('alter table runs add column plan_id text;')
    }
    if (!hasColumn(conn, 'runs', 'plan_raw')) {
      conn.exec('alter table runs add column plan_raw text;')
    }
    if (!hasColumn(conn, 'runs', 'plan_source')) {
      conn.exec('alter table runs add column plan_source text;')
    }
    backfillRunPlans(conn, what)
  }
]

/**
 * How many migrations this build carries, which is the `user_version` a current database is at.
 *
 * ⛔ Exported so a test can rewind to "just before the last one" without hard-coding its number.
 * `sessionstate.test.ts` drives the repair migration by rewinding and reopening — the only way to
 * exercise the SQL that actually ships rather than a copy of it — and a literal there would quietly
 * become a test of whichever migration somebody adds next.
 */
export const MIGRATION_COUNT = MIGRATIONS.length

/**
 * The `user_version` to rewind to in order to run a particular migration again.
 *
 * ⛔ **Found by its own text, not by counting from either end.** A test that re-runs a data repair
 * has to name *which* migration it means, and both obvious ways of doing that go stale: an index
 * typed in as a number turns into a test of somebody else's migration the moment one is inserted,
 * and `MIGRATION_COUNT - 1` — "the last one" — turns into a test of somebody else's migration the
 * moment one is appended. Measured on 2026-09-01: two branches added a migration 27 in parallel,
 * the rebase made the repair 27 and an index migration 28, and `MIGRATION_COUNT - 1` quietly began
 * re-running the indexes and asserting the repair's outcome.
 *
 * Returns the index *before* the matching migration, which is exactly the `user_version` that makes
 * `migrate()` run it and nothing earlier. Throws rather than returning -1: a fragment that matches
 * nothing means the test is pinning a migration that no longer exists, and silently rewinding to 0
 * would try to re-create every table.
 */
export function versionBefore(fragment: string): number {
  // ⚠️ A function migration is searched by its own source. `Function.prototype.toString` returns
  // the body verbatim, comments included, so a migration that has to be a function to be
  // replay-safe is still nameable by a test — which the string-only version quietly was not.
  const index = MIGRATIONS.findIndex((m) =>
    (typeof m === 'string' ? m : m.toString()).includes(fragment)
  )
  if (index < 0) throw new Error(`no migration contains ${JSON.stringify(fragment)}`)
  return index
}

let handle: DatabaseSync | null = null

export function openDb(path = paths.db): DatabaseSync {
  ensureDir(dirname(path))
  const db = new DatabaseSync(path)
  db.exec('pragma journal_mode = wal')
  db.exec('pragma synchronous = normal')
  db.exec('pragma foreign_keys = on')
  migrate(db)
  handle = db
  repointIsolationRoots(db)
  return db
}

/**
 * Fix worker paths left behind by the `agentyard` -> `multi_agent_controller` data-directory rename.
 *
 * ⛔ `isolation_root` is stored absolute, so moving the data directory would otherwise point every
 * worker at a path that no longer exists - and an isolation root is where a vendor CLI keeps that
 * account's credential. The move happens in paths.ts before this database is even open; this is the
 * other half of it.
 *
 * ⚠️ Prefix-matched against the *legacy* root only, and skipped entirely when the user has pointed
 * MULTI_AGENT_CONTROLLER_DATA_DIR somewhere of their own. A worker whose root the user chose by hand
 * is theirs, wherever it lives, and must not be rewritten.
 */
export function repointIsolationRoots(conn: DatabaseSync): void {
  const legacy = legacyDataDir()
  const current = dataDir()
  if (legacy === current) return
  const stale = conn
    .prepare('select id, isolation_root from workers where isolation_root like ?')
    .all(`${legacy}${sep}%`) as { id: string; isolation_root: string }[]
  if (stale.length === 0) return
  const update = conn.prepare('update workers set isolation_root = ? where id = ?')
  for (const w of stale) {
    update.run(join(current, w.isolation_root.slice(legacy.length + 1)), w.id)
  }
  log.info(`repointed ${stale.length} worker isolation root(s) from ${legacy} to ${current}`)
}

export function db(): DatabaseSync {
  if (!handle) throw new Error('database not open')
  return handle
}

export function closeDb(): void {
  handle?.close()
  handle = null
}

function migrate(conn: DatabaseSync): void {
  const row = conn.prepare('pragma user_version').get() as { user_version: number } | undefined
  const current = row?.user_version ?? 0
  if (current > MIGRATIONS.length) {
    // A newer build has already been here. Refusing beats silently corrupting its data.
    throw new Error(
      `database schema v${current} is newer than this build understands (v${MIGRATIONS.length}). ` +
        'Upgrade Multi Agent Controller, or point MULTI_AGENT_CONTROLLER_DATA_DIR somewhere else.'
    )
  }
  for (let v = current; v < MIGRATIONS.length; v++) {
    const migration = MIGRATIONS[v]
    if (!migration) continue
    conn.exec('begin')
    try {
      if (typeof migration === 'string') conn.exec(migration)
      else migration(conn)
      conn.exec(`pragma user_version = ${v + 1}`)
      conn.exec('commit')
      log.info(`migrated database to v${v + 1}`)
    } catch (err) {
      conn.exec('rollback')
      throw err
    }
  }
}

/** `node:sqlite` returns null-prototype rows; this makes them ordinary objects for the rest of the code. */
export function rows<T>(list: unknown[]): T[] {
  return list.map((r) => ({ ...(r as object) }) as T)
}

export function row<T>(value: unknown): T | null {
  return value == null ? null : ({ ...value } as T)
}
