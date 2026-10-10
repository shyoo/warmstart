# Quality Review loading — t1043, 2026-10-10

## Goal and alignment

Show candidate rows within five seconds of opening Analytics → Quality Review,
changing a filter, or paging. Never present unchecked work as confirmed gradable.
The operator approved showing unchecked candidates within five seconds, explicitly marked as checking eligibility.

## Evidence

- The attached screenshot shows no candidate rows and no coverage totals, with
  **Filter out cannot be graded** checked.
- `reviewQueue` in `src/daemon/quality.ts` validates up to 1,000 tasks with
  `Promise.all` when that filter is checked, before selecting the visible 25.
  `reviewCoverage` separately repeats that validation with another 1,000-task cap.
- `isTaskGradable` checks peers and resolves Git ranges. `reviewRange` reloads each
  task through `getTask` despite the queue having already fetched tasks in bulk.
  Range caching stores finished results, without sharing an in-flight computation.
  The Git runner has no timeout by default.
- Read-only inspection of the live Windows database on 2026-10-10 found **1,017**
  completed, non-deleted, statistics-included tasks with a work run. The SQL count
  took **55 ms**; a simplified newest-1,000 candidate query with latest author
  lookup took **53 ms**. EXPLAIN used `tasks_review_queue` and `runs_task` indexes.
  These are single measurements, not full RPC or UI timings.
- Inferred main cause: full-history task hydration and cold Git validation, rather
  than the measured SQL selection. Confirm with phase timing before implementation.
- Renderer refresh suppression drops filter/page changes while a fetch is active;
  the earlier response can then overwrite the current selection.

## Proposed implementation

1. **Baseline:** measure queue selection, task hydration, peer checks, Git range
   validation, RPC response, and first table paint. Use read-only live-data
   inspection and isolated fixtures; do not mutate the live database or spend turns.
2. **Bound the opening path:** serve a lightweight candidate page from stored
   metadata and cached range verdicts. Remove per-task full hydration, timing,
   pricing and reviewer-menu work from this read. Batch authorship/reviewer lookups.
3. **Separate validation from reads:** maintain a persisted range-verdict cache
   with evidence fingerprint, checked time and explicit unknown state. Resolve cold
   or invalidated ranges in small background batches, sharing in-flight work and
   limiting concurrent Git processes. Bound each Git operation at its resource.
   A timeout means unknown/retryable, never non-gradable. Recompute peer eligibility
   from current configuration; it must not freeze in the persisted range verdict.
4. **Invalidate deliberately:** task commit/range changes, project root/target
   changes and repository ref changes invalidate range evidence. Worker changes,
   authorship changes and stored/deleted reviews refresh peer eligibility. A
   bounded refresh handles external repository changes. Batch/review execution
   revalidates authoritative evidence before spending a turn.
5. **Honest pagination and totals:** remove the silent 1,000-task truncation.
   Read indexed verdicts for confirmed-only filtering, paginate deterministically,
   and publish checked/pending counts and freshness while validation is incomplete.
   Unknown items must never be included in the non-gradable count.
6. **Renderer races and failure:** key requests to filter/page selection; discard
   old responses and ensure the latest selection gets fetched. Render candidates
   independently of coverage and batch status. Coalesce event refreshes. At five
   seconds, replace an indefinite loading message with an actionable retry/error
   state while preserving already rendered rows.
7. **Optimize SQL only where measured:** inspect the complete new queries and add
   replay-safe migrations/indexes as needed. No VACUUM or direct live DB writes.

## Design decision

Recommended: show unverified candidate rows marked **Checking eligibility** while
the cold cache fills, even with the gradable-only filter enabled; hide confirmed
refusals and label that temporary filter behavior explicitly. Once checks finish,
the filter shows confirmed gradable rows only. Exact totals can settle later.

Alternative: keep the filter strictly confirmed-only throughout. On a cold cache,
show validation progress and any confirmed rows within five seconds; the first
full page can take longer. This preserves strict filtering but weakens the
five-second requirement for actual candidate items.

## Acceptance and verification

- Define the five-second bound as opening/filter/page action → visible candidate
  items, including cold restart; report measured maxima, not an absolute claim
  about every host or an unavailable daemon.
- Benchmark cold and warm runs on the current live history and an isolated
  10,000-task fixture. Record phase timings, candidate count, environment and date.
- Exercise missing repositories, slow Git, changed refs, invalidation, review
  deletion and worker changes. Confirm unknown stays distinct from refusal.
- Verify all history contributes to coverage, and table/coverage/batch share
  eligibility rules without self-review or repeat-review regressions.
- Drive rapid filter switches and paging in the UI with delayed/out-of-order
  replies. Confirm the current selection wins and a slow coverage request cannot
  block candidate rendering. Mutation-check the regression assertions.
- Run targeted L1 plus built daemon/UI checks, then required typecheck, lint,
  full L1 and build. Update maintained UI/schema/architecture reference as the
  final design requires and replace the relevant HANDOFF state.

No landing or task completion is requested at this stage.

## Implementation decisions and measurements

- Persist only range evidence; recompute peer eligibility from batched author/reviewer facts
  and current workers on each read, using the same gate as review execution.
- External Git changes invalidate display evidence through a 60-second freshness bound
  and a once-per-minute idle refresh rather than synchronous ref reads in candidate RPCs.
  Task/project/commit evidence changes invalidate immediately on read. Execution resolves
  current repository state without the old indefinite in-memory range cache.
- No additional selection index was needed: existing indexes plus the cache primary key
  met the measured budget. The range cache is migration 91.
- Windows 11, 2026-10-10, online SQLite backup of the live history: five candidate RPC
  implementation reads returned 25 rows in 200.4–221.1 ms (291 no-review candidates;
  1,018 total finished work tasks). Coverage read: 197.5 ms. No live DB writes.
  Old batch hydration of 1,000 tasks: 649.1 ms; redundant individual hydration: 364.4 ms.
  These measurements exclude transport and paint and do not time old Git validation.
- Isolated 10,000-task cold fixture: 177.0 ms, 25 explicitly unchecked rows, no task
  hydration or Git started before response. This is one source-level measurement.
- Final built UI, 2026-10-10: **516 ms** from navigation to visible unchecked candidates
  with the persisted gradable-only filter enabled (60 seeded completed work tasks).
  Rapid filter changes and older-page navigation also passed. L3: **560 checks passed**,
  4 skipped. L2: **204 passed**, 7 skipped. L1: **4,676 passed**, 3 skipped;
  typecheck, lint and build pass.
- Mutation checks: treating unknown as refusal fails the cold-candidate test; accepting
  obsolete responses fails both selection tests. A real fixture ref move also proves
  authoritative range resolution ignores the old positive verdict.
