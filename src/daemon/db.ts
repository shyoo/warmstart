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
