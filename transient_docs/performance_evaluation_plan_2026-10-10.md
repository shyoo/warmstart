# Parallel-work responsiveness — t1046, 2026-10-10

## Outcome sought and alignment

Keep navigation, typing and task control responsive with four work runs plus background
reviews. Diagnose the whole path, rather than treating a faster empty screen as proof.
The operator resumed this task; the recommended first delivery was implemented.

## Evidence collected

Windows 11, 2026-10-10; source at local main `77551ce8`, Node 22.19.0 for isolated
source benchmarks. Runtime health reported `0.3.10+5.g77551ce8`. Timings below are
observations, not guarantees about every computer. No real review was commissioned.

- Recording `warmstart_lagging_2026_10_10_17_12_24.mp4`: H.264, 1920×1080,
  26.602 seconds. Sampled frames show project/task navigation responding while lists
  and threads say Loading. Inferred: data latency dominates the visible incident;
  cursor/navigation movement is not a measurement of renderer input latency.
- Read-only run-history overlap with the recording's timestamp: three quality-review
  runs and one work run. Overlap counts do not prove all four used CPU simultaneously.
- Read-only live snapshot: 1,047 tasks, 4,045 runs, 79,513 quota samples and 12,735
  thread messages; database 217 MB, WAL about 4 MB; WAL mode already enabled.
- Ten sequential authenticated health probes, about half a second apart: 20.1, 1.2,
  1.5, 1.0, **1,943.6**, 151.3, 4.8, 177.1, 1.9, 1.3 ms. Two work runs were open.
  The observation window included task/project/resource changes. This proves a
  stall/delay outside the renderer; it does not attribute that individual spike.
- On an online SQLite backup, without a scheduler or credentialed agent:

  | Read | Measured time | Response size |
  |---|---:|---:|
  | Raw non-deleted task rows (1,025) | 8.6–9.0 ms | 2.93 MB |
  | Full `task.list`, warm pricing | 176.2–185.4 ms | 3.21 MB |
  | Cold pricing pass | 420.3–433.0 ms | one requested price |
  | Full `task.list`, cold pricing | 560.3–589.7 ms | 3.21 MB |
  | `task.get`, warm pricing | 7.9–8.0 ms | 57 KB |
  | `task.get`, cold pricing | 383.4–399.5 ms | 57 KB |
  | `task.page`, 25 rows, warm pricing | 20.8–21.9 ms | 60 KB |
  | Pricing quota projection (77,606 rows) | 68.4 ms | 8.98 MB if serialized |

  Task-list JSON serialization adds about 10–13 ms. These measurements exclude HTTP,
  Electron IPC and React paint. Raw work-run `select *` includes prompts and is not
  the pricing projection; its 30 MB result must not be confused with pricing's query.
- V8 sampling across three cold pricing passes: the largest self-sample buckets were
  `attribute` (311), row conversion in `db.ts` (136), GC (127), native `all` (85),
  `build` (58), `addReading` (31). Counts are samples, not exact milliseconds.

## What is wrong

1. **Event fan-out and overlapping refreshes.** `App.refreshProjects` serially asks
   for both project lists, resources, the entire task history and pending deliveries
   on *every* task/run/project/resource event. It has no in-flight guard. The Tasks
   page also refreshes on every task/run event, including other projects; thread
   reads are scoped to the task but permit overlapping requests. Three related
   events can therefore trigger three 3.2 MB historical reads plus visible-page work.
2. **Cold global pricing on ordinary reads.** `toTask → withPrice → priceForTask`
   rebuilds pricing for all work runs after any pricing epoch change. Quota probes,
   run boundaries and token/usage writes invalidate the epoch. Review traffic shares
   these same accounts and control-plane callbacks. A read of one thread can thus
   pay for historical account-wide attribution.
3. **Allocation-heavy attribution.** Every reading segment maps and filters every
   run span, even when none overlaps. Anchor lookups also scan the full reading
   series per run. Most historical spans are inactive in any particular segment.
4. **One shared daemon event loop.** Synchronous SQL and JavaScript pricing execute
   where RPC, stream handling and scheduler timers also run. `async` RPC handlers
   do not make these synchronous portions parallel. Long work delays all clients.
5. **Secondary suspects need instrumentation.** Process identity/termination uses
   synchronous child-process calls in lifecycle paths; logging is synchronous;
   transcript/file work and event serialization share the loop. No observation yet
   establishes any of these as the leading cause of this recording.

## Measurement gap

The source has no routine event-loop-delay/ELU monitor, successful RPC timing,
bounded per-method latency report, renderer long-task/input timing, or regression
workload combining parallel streams with reviews. The existing UI suite proves
behavior mostly with uncredentialed, idle workers. Transport failures carry elapsed
time, but successful slow calls leave no timing evidence. t1043's candidate timing
does not measure the other screens or a four-run fleet.

## Node.js, Rust and SQLite

**Keep Node and SQLite for the first delivery.** This recommendation is an inference
from the measurements, not a Rust-versus-Node benchmark. SQLite is native code already.
The raw task query took 9 ms while the enriched historical read took 176–185 ms;
profiling found substantial JS attribution/allocation work. No SQLITE_BUSY/lock
contention evidence was gathered for the video. Do not treat file size as a diagnosis.

Node's shared event loop makes blocking work consequential, but worker threads or a
read-only helper process can isolate heavy reads without a language rewrite. Rust
could speed a proven CPU kernel or permit explicit parallelism; it would not remove
duplicate requests, oversized payloads, historical recomputation, or SQLite's single
writer. A rewrite also adds packaging, lifecycle and protocol migration work.

SQLite WAL permits concurrent readers with one writer; retain the daemon as mutation
authority. A later analytics read worker must own its connection, use bounded reads
and honor WAL snapshots. Never move scheduler decisions or mutation ordering to an
uncontrolled worker pool. Do not prune quota/history or loosen evidence to go faster.

Primary references checked 2026-10-10:

- [Node: do not block the event loop](https://nodejs.org/learn/asynchronous-work/dont-block-the-event-loop)
- [Node SQLite: synchronous database APIs](https://nodejs.org/api/sqlite.html)
- [Node performance hooks](https://nodejs.org/api/perf_hooks.html)
- [SQLite WAL concurrency](https://www.sqlite.org/wal.html)
- [Browser interaction timing](https://web.dev/articles/inp)

## Proposed implementation

### First delivery: diagnostics and the measured hot paths

1. **Bounded local diagnostics:** per-method RPC count/latency/payload size, pending
   requests, daemon loop delay/utilization, event counts/bytes, renderer RPC duration,
   long-task and interaction duration where supported. Store metadata in bounded
   memory; never prompts, results, tokens or transcript content; no network telemetry.
   Provide an explicit diagnostic snapshot/export, without diagnostic reads creating
   another event-driven refresh storm. State which stage each number measures.
2. **Stop full-history refresh fan-out:** patch task/project/resource events from
   their supplied rows; run events refresh only affected task metadata where needed.
   Coalesce outstanding reads with one latest follow-up. Narrow page invalidations
   to the relevant project/task. Preserve deletions, reconnect reconciliation,
   archived projects, unassigned counts, routing and context menus. Consider a small
   sidebar projection if the initial snapshot remains expensive after patching.
3. **Faster exact pricing:** replace full-span scans with an interval sweep and
   binary-search anchors, preserving ordering, floating arithmetic, shared-window
   attribution, resets/corrections, partial evidence, in-flight runs and `unknown`.
   Compare all results against the old algorithm on randomized fixtures and the
   live backup. Never freeze an old price or add a guessed approximation to the UI.
4. **Repeatable loaded benchmark:** emulate four independent stream producers plus
   two review lifecycles through isolated fixtures, with non-empty work/history.
   Measure health/RPC queueing and actual navigation/paint. Record p50/p95/max,
   request counts, payload volume and loop delay; assert both data and responsiveness.
   It must be safe to run without vendor accounts and twice concurrently.

### Escalation if first delivery misses the target

5. Partition pricing invalidation by account/evidence rather than global epoch,
   with cross-run window attribution preserved. Batch remaining correlated SQL and
   add indexes only where EXPLAIN and timings justify them.
6. Move proven long analytics work to a read-only worker/sidecar, preserving a single
   mutation owner. Audit synchronous lifecycle/process/file calls nearest the
   resource and replace measured hot ones with bounded asynchronous work.
7. Consider Rust only with a profile proving a remaining CPU kernel dominates and
   a prototype showing improvement large enough to justify a new binary/protocol.

## Acceptance criteria to align

- Proposed normal target: local input/navigation paint p95 ≤200 ms, task data
  arrival/paint p95 ≤1 s and max ≤2 s under the isolated four-work/two-review load.
  These are product budgets; browser input timing and asynchronous data arrival are
  separate measurements. Quality Review keeps its agreed five-second outer budget.
- At most one in-flight read plus one pending refresh per view/key; events about
  another project do not refetch a task page. Terminal streaming remains immediate.
- Prices/bases agree with the reference; controls still act on the selected task.
- Bounded memory and no hidden telemetry/billing. No real CLI/review for tests.
- Targeted L1, built daemon/UI/load checks; typecheck and lint; final project checks
  run again by the finishing tool. Update maintained docs/HANDOFF and commit.

## Operator decision

Recommended: implement the first delivery in this task, retaining Node/SQLite, with
bounded local metadata diagnostics and the proposed response budgets. Escalation is
conditional on its measured result, rather than an unbounded architecture migration.

Alternative: implement diagnostics and the repeatable load test only, then evaluate
a captured live incident before changing refresh or pricing behavior. This provides
stronger incident attribution but leaves the measured amplification in place longer.

## First-delivery implementation and measurements

- Shell/Attention share event-patched task data; the Attention bar was a second full-history
  amplifier found by the loaded test. One initial history read remains; dependency candidate
  snapshots on opening a thread are intentional. No history is reloaded on idle event bursts.
- Pages narrow by project and serialize reads; thread guards retain task/visit identity and
  coalesce per task. Cross-computer late snapshots cannot poison routing metadata.
- Exact pricing sweep/binary anchors match the frozen reference on 500 generated histories.
  Online backup comparison, Windows 11/Node 22.19, 2026-10-10: all prices and bases match for
  1,050 tasks and 4,051 runs. Three cold before/after pairs (ms): 527.5/289.5,
  491.1/286.2, 490.4/277.6. Other attribution and invalidation rules are unchanged.
- Global → Status captures/exports bounded metadata: latest 128 samples per stage, up to 512
  labels, counts/bytes, pending/peak, p50/p95/max, loop delay/utilization and open-run counts.
  No prompts/results/tokens/transcripts or network telemetry. Unknown size/timing is null.
  RPC sync is initial synchronous work, not an assertion that later async work is all I/O.
- Loaded benchmark: 1,000 history tasks, 80,000 readings, four synthetic streams at 10 Hz
  plus two review lifecycles at 2.5 s. A built UI/Main talks to an isolated source fixture
  backend on Node 22.19; PTYs/vendor probes are blocked, scheduler/poller absent.
  Native click → second-frame p95/max 42.6 ms; navigation → data p95/max 181.5 ms;
  health p95/max 265.2 ms. All eight checks passed before adding the diagnostics UI check.
- Hidden normal windows capped RAF at 1 Hz: those two-second frame results were a harness
  artifact and are not a before/after comparison. A test-only offscreen foreground-cadence
  flag fixes this. Frame barriers are proxies, not physical presentation or full-session INP;
  actual vendor/compiler/teardown pressure remains outside this free fixture's claim.

## Validation after rebase onto local main

- Rebased cleanly onto local main a9b0e139, retaining one coherent task commit.
- Typecheck, lint and build pass; 104 targeted tests pass, including pricing arithmetic,
  coalescing/visit ordering, unknown diagnostics, remote denial and documentation guards.
- Deliberately restoring task-event history refreshes fails the loaded regression check and
  returns a failing process status. Touching source without rebuilding also fails the explicit
  main/preload/renderer freshness guard, even when fresh log files exist under out.
- Two copies of the load suite ran simultaneously alongside the ordinary full UI suite;
  both passed all 10 checks. Frame-proxy p95/max: 51.5 and 36.4 ms. Data p95/max:
  383.7 and 315.2 ms. Health p95/max: 23.7 and 210.1 ms. Both snapshots verified the
  real diagnostics UI and open-run counts; no idle event-driven history reloads occurred.
- Counters retain metadata only and include last-sample times. Unmeasured payload sizes
  are null; utilization is a separately typed percent with its sampling timestamp.

- Full UI: all 560 checks passed (4 skipped). A bulk direct-SQL fixture now explicitly
  reconciles its snapshot; a single event no longer pretends every other seeded row changed.
