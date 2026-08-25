import { DatabaseSync } from 'node:sqlite'
import { ensureDir, paths } from './paths.js'
import { dirname } from 'node:path'
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
  return db
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
    // A newer agentyard has already been here. Refusing beats silently corrupting its data.
    throw new Error(
      `database schema v${current} is newer than this build understands (v${MIGRATIONS.length}). ` +
        'Upgrade agentyard, or point AGENTYARD_DATA_DIR somewhere else.'
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
  return value == null ? null : ({ ...(value as object) } as T)
}
