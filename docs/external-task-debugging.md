# Inspecting a task from outside Warmstart

Use this when an operator asks an agent running outside Warmstart to investigate something like
“fix t426”. The database is useful evidence, but it is not an API: read it; make product changes in
the task's repository and branch; let Warmstart own task state.

## Find the live database

In the app, open **Settings → Global → Status** and copy the **database** path. This is the safest
answer because `WARMSTART_DATA_DIR` may override the platform default. Without the app, the defaults
are:

| Platform | Database |
|---|---|
| Windows | `%APPDATA%\warmstart\warmstart.db` |
| macOS | `~/Library/Application Support/warmstart/warmstart.db` |
| Linux (unsupported) | `${XDG_DATA_HOME:-~/.local/share}/warmstart/warmstart.db` |

The adjacent `orchestratord.json` contains the loopback daemon endpoint and its bearer token. Treat
it as a credential: do not print, paste, or commit it. An agent inside a desktop-hosted session may
see a redirected `%APPDATA%`; prefer the path shown in Status.

## Open SQLite safely

Warmstart uses SQLite in WAL mode. The `sqlite3` shell can read the live database and its WAL safely:

```text
sqlite3 "C:\path\to\warmstart.db"
.mode box
.headers on
.timeout 5000
PRAGMA query_only=ON;
```

Keep the `-wal` and `-shm` files beside the database. Do not copy only `warmstart.db` while the daemon
is running; use the live database read-only, stop Warmstart gracefully first, or inspect a complete
backup from the adjacent `backups/` directory. Do not run `UPDATE`, `DELETE`, schema changes, or
`VACUUM`: direct writes bypass migrations, events, scheduler invariants, and in-memory state.

Node 22+ can inspect it when the `sqlite3` executable is unavailable:

```bash
node -e "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(process.argv[1],{readOnly:true}); console.table(db.prepare('select seq,title,status,branch from tasks where seq=?').all(Number(process.argv[2])))" "/path/to/warmstart.db" 426
```

## Resolve `t426`

The human task name is `t` plus `tasks.seq`; internal joins use the UUID in `tasks.id`.

```sql
-- Task, project checkout, and recorded branch.
SELECT t.id, t.seq, t.title, t.status, t.priority, t.branch,
       t.handoff_note, t.created_at, t.updated_at,
       p.name AS project, p.root AS project_root
FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
WHERE t.seq = 426;

-- Human, agent, controller, and system messages in order.
SELECT datetime(ts / 1000, 'unixepoch', 'localtime') AS at,
       role, text, run_id, event, detail
FROM task_messages
WHERE task_id = (SELECT id FROM tasks WHERE seq = 426)
ORDER BY ts, id;

-- Every attempt, including worker/session identity, token totals, and the exit note.
SELECT r.id, r.worker_id, r.session_id,
       datetime(r.started_at / 1000, 'unixepoch', 'localtime') AS started,
       datetime(r.ended_at / 1000, 'unixepoch', 'localtime') AS ended,
       r.outcome, r.input_tokens, r.output_tokens,
       r.cache_read_tokens, r.cache_write_tokens, r.note
FROM runs r
WHERE r.task_id = (SELECT id FROM tasks WHERE seq = 426)
ORDER BY r.started_at;

-- The session and workspace used by those attempts.
SELECT s.id, s.adapter_id, s.model, s.effort, s.state, s.cwd,
       s.transcript_path, s.context_tokens, s.closed_at
FROM sessions s
WHERE s.id IN (
  SELECT session_id FROM runs
  WHERE task_id = (SELECT id FROM tasks WHERE seq = 426)
);
```

Epoch columns are milliseconds. JSON columns such as `mandate_json`, `budget_json`,
`constraints_json`, and project `config_json` can be selected verbatim or expanded with SQLite's
`json_extract`.

## Follow the code and logs

### Investigating responsiveness

Separate interaction paint, the Electron IPC/HTTP round trip, daemon queueing, synchronous
handler work, SQLite reads, and result serialization. A responsive sidebar beside a Loading
thread suggests delayed data; it does not establish whether the renderer or database is healthy.
Open **Global → Status → Performance diagnostics**, reproduce the delay, then **Capture timings**
and **Export timings**. Bounded local memory retains up to 512 stage labels and 128 recent samples
per label; counters are cumulative for retained labels. No prompts, results, tokens or transcript
content are recorded. Open run counts describe the capture instant, not CPU activity.

**UI RPC** includes IPC, daemon queueing and response delivery. **RPC total** begins at handler
dispatch; **RPC sync** measures its initial synchronous work; **RPC encode** measures serialization.
**pricing rebuild** separates cold pricing from the surrounding handler. Loop delay includes the
20 ms sampling interval, is summarized every five seconds, and carries its sampling time beside
utilization. Browser event/long-task timing is present only where supported; event durations below
16 ms are not reported and the table is not a full-session INP score. Missing sizes/timings are
unmeasured, not zero. A large UI/daemon gap warrants checking IPC/renderer work; a large loop gap
without a slow RPC warrants profiling background callbacks, lifecycle/file work and GC.

`npm run test:performance` drives a built UI against an isolated fixture with four synthetic
streams, two review lifecycles, 1,000 historical tasks and 80,000 readings. It records native input
to a second-frame barrier, data arrival and health p50/p95/max, and rejects event-driven history
reloads. Offscreen foreground cadence avoids the hidden window's 1 Hz RAF cap; this is a frame
proxy, not physical display latency or a test of vendor inference/compiler pressure. The fixture
starts no scheduler, poller or vendor CLI. Use live exported timings to investigate those cases.

For historical-data profiling, use SQLite's online `backup()` API through a read-only source
connection, then profile the isolated copy. Preserve real history and include cold pricing
epochs: a warm `task.get` can be cheap while its first read after a quota/run change recomputes
account-wide pricing. Compare the raw query with full task hydration and response bytes.
V8 CPU sampling can distinguish attribution/GC from native SQLite calls. It is a diagnostic,
not proof that the same function caused an earlier unrecorded incident.

Count task/run event bursts and the reads each view starts. Repeated full `task.list` reads from
sidebar refreshes can contend with the visible page even though `task.page` itself is fast.
Authenticated health timings provide evidence outside the renderer; they include queueing and
transport and cannot identify a single expensive callback. Do not log the endpoint token,
prompts, transcript content or RPC parameters in a performance report.

### Task evidence

`projects.root` is the landing checkout, not necessarily the task workspace. Prefer the `sessions.cwd`
used by the latest run; confirm its current branch with `git -C <cwd> status --short --branch` and
compare it with `tasks.branch`. Never assume a clean checkout proves the task landed.

Daily daemon logs are beside the database under `logs/orchestratord-YYYY-MM-DD.log`. Search them by
`t426`, task UUID, run UUID, and session UUID. The app's **History → Logs** view is the easier live
equivalent. For current schema names, `.schema tasks`, `.schema task_messages`, `.schema runs`, and
`.schema sessions` are authoritative; [`data-model.md`](data-model.md) explains their contracts.

If the requested fix is in the Warmstart source, use this evidence to locate the failure, then follow
that repository's `AGENTS.md` and `HANDOFF.md`. Do not “repair” a task by editing its database row.
