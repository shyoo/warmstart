import { DatabaseSync } from 'node:sqlite'
import { dataDir, ensureDir, legacyDataDir, paths } from './paths.js'
import { dirname, join, sep } from 'node:path'
import { log } from './log.js'

/**
 * Storage.
 *
 * Deliberately `node:sqlite` rather than better-sqlite3: it ships inside the Node that Electron
 * already carries, so there is no native module to rebuild against Electron's ABI and nothing to go
 * wrong at packaging time. Measured working under Electron 44 (SQLite 3.53.1) on 2026-08-25.
 * The API surface used here is small and wrapped, so swapping the driver later is a one-file change.
 */

/**
 * Migrations are numbered and append-only. Never edit one that has shipped - add the next.
 * Kept as strings rather than .sql files so the bundler has nothing to copy and the daemon has
 * nothing to find at runtime.
 */
const MIGRATIONS: string[] = [
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
  `
]

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
    const sql = MIGRATIONS[v]
    if (!sql) continue
    conn.exec('begin')
    try {
      conn.exec(sql)
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
