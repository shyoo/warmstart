# Model and effort tags — implementation plan (2026-10-10, t1024)

Status: design agreed; runtime behavior has not changed. This is a dated plan, not the maintained
reference. Replace the affected descriptions in `docs/routing.md`, `docs/data-model.md`, `docs/ui.md`,
`docs/mcp.md`, and `HANDOFF.md` as the implementation lands.

## Decisions

The operator chose **one multi-tag system**: Low, Med and High become ordinary tags alongside XHigh,
ZDR and Audio. A task that asks for several tags requires **every** one on the *same* model/effort
pair. A missing tag is a failed match, and no matching eligible pair means a visible hold; dispatch
must never silently drop a requirement. These choices were recorded through `ask_human` on 2026-10-10.

Tags are operator-maintained routing assertions, not verified adapter capabilities or vendor privacy
certifications. In particular, Warmstart must not infer ZDR or Audio from a provider or model name.
The operator can put ZDR on pairs they permit for that work; a task requiring ZDR cannot route to an
untagged Muse contributor pair. A plain Auto Model task retains its current candidate set, including
any contributor pair the operator has enabled. An Audio task requires the Audio tag; its prompt and
attachment still have to be supported by the selected adapter's existing capability gates.

## Current behavior to preserve

- `ModelRoute` in `src/shared/modelroutes.ts` stores one `(model, effort)` with one `modelClass` and an
  `auto` flag. `routeClass` fills a null class using `defaultModelClass` in `modelclass.ts`.
- `autoCandidates` filters before taking one row per model. `pairInClass` and `classBoundEffort` carry
  the matching row's effort through warm-session selection and dispatch. This matters: t809/t810 ran
  an effort outside their selected class before the second dispatch check was added.
- An untouched worker table stores no rows. If it has no auto rows, `routableCandidatesFor` uses the
  worker default; auto routing remains opt-in. A tag filter must also check that default *pair*.
- Model selection is wider than the composer: `NewTask`, plan pieces and split, MCP `task_split`,
  thread reassign, `task.setModel`/`task.setWorker`, saved composer preferences, task labels and the
  scheduler all carry `modelClass`. The project UI suite's worker has no credentials, so assertions
  against actual runs there would be vacuous.

## Data and compatibility

1. Add a canonical tag value type and helpers in `src/shared/` for trimming, case-insensitive
   identity, duplicate removal, case-preserving display and bounded input. Derive the fleet's
   suggestions from row assignments plus the three built-in tags. A tag is created by adding it to
   a row; editing an assignment is also how its spelling changes. No empty catalogue entries or
   extra settings RPC are needed. Show a task's saved tags even if its last matching row has since
   been removed.
2. Replace `ModelRoute.modelClass` with `tags: string[]`, preserving `model`, `effort`, `auto`, and row
   order. Materialize each old row's *effective* class as exactly one tag: its explicit override,
   otherwise `defaultModelClass(model)`. Untouched display-only rows also show that inferred tag but
   are not stored until edited. The migration must not make an untouched table opt into Auto Model.
   Do not infer new custom tags. Use a numbered, replay-safe DB migration for stored worker rows.
3. Add `modelTags?: string[]` to task constraints, child defaults and piece constraints. Migrate
   stored `modelClass` values in task JSON to a one-tag requirement; keep the old RPC/MCP input
   readable during transition, then write the new shape. Migrate the renderer's saved composer
   preference on read. Existing unfinished tasks, saved composer choices
   and split pieces must still resolve Low/Med/High after upgrade. Validate malformed and duplicate
   tag inputs at the daemon boundary. The new-task picker offers tags present on a configured pair
   and warns when none of those pairs is auto-routable; a previously saved tag that loses its last
   pair remains visible and unmatched. Quota exhaustion still files the task and produces its normal
   hold rather than making a tag disappear from the picker.
4. Keep tags scoped to a worker's pair, never to a model globally. Do not create additional rows for
   tags. Preserve the existing pair uniqueness and effort validation. A row with zero tags is valid
   for plain Auto Model, but does not satisfy a tagged request.

## Routing and user flows

1. Implement one `pairHasAllTags` predicate and use it for auto rows, worker-default fallback,
   pinned-model and warm-session candidates. Filter rows by all requested tags **before** reducing
   to one pair per model. Carry the matched row's effort into `resolveModelChoice` and check the
   actual `(worker, model, effort)` again immediately before dispatch, as `classBoundEffort` does
   today. A worker with no matching pair is ineligible for that task; if none is eligible, record a
   specific hold such as `no routable model/effort pair with ZDR + Audio` and the normal wake path.
2. Preserve plain Auto, explicit model pins, inherit, quota and capability gates. For a pinned model
   with required tags, prefer its requested effort if that exact row matches; otherwise choose a
   matching effort row of the *same model*, as `pairInClass` does today. Show the effective effort in
   the task and dispatch. Never label a pair as matching merely because another effort row has the
   tags.
3. Give the composer, plan-piece editor, task thread and reassignment control a multi-tag filter for
   Auto Model. Show the selected tags on the model pill and in the task/dispatch explanation. A
   pinned worker can preview whether its auto rows (or fallback default pair) satisfy the selection;
   no worker pin means the full fleet is eligible to be checked at dispatch. Keep an invalidated
   saved selection visible with an actionable explanation rather than silently clearing it. Extend
   split/MCP input with tag arrays while accepting the old single `class` value for existing callers.

## Settings → Workers matrix

Keep one line per model/effort and the current columns and horizontal scroll. Replace the Label
`<select>` with a **Tags** button in the same cell. The closed cell is one line high and has a fixed
maximum width: show at most two short chips, then `+N`; ellipsize long names. Its accessible name
and tooltip list every tag. Clicking it opens a popover anchored to that cell with existing fleet tag
checkboxes, an add-tag input, and remove actions for this pair. The popover has its own scroll and
stays within the viewport; it does not enlarge the table row. Keep it usable by keyboard, with focus
returning to the button on close. A row with many tags remains the same height as a row with one.

Retain Auto-route and purpose ticks where they are. Unoffered model rows keep their stored tags
visible and removable, but cannot be newly opted into routing. Editing an inferred tag turns only
that row into a stored row; merely opening or closing the popover writes nothing. Save the full row
order on change so the strongest matching effort remains first. On a narrow window, let the existing
table scroll horizontally rather than wrap the chips or purpose columns. Use the renderer's tokens
for focus, border and text colors.

## Verification and delivery

- L1: tag normalization, exact-pair AND matching, filter-before-dedupe, effort binding, no-match
  hold, default fallback, no silent downgrade, legacy data migration and replay, and atomic
  reassignment. Add a case with two effort rows of one model where only the weaker row has Audio.
- L1 renderer tests: adding/removing tags leaves an untouched table null; saving multiple tags does
  not alter purpose ticks or row order; saved tags survive removal of the last matching route.
- L3 after a fresh build: open Settings → Workers, add at least six tags to one pair, assert the row
  height is unchanged within a small measured tolerance at normal and narrow widths, the full list
  is accessible, keyboard edit persists through `fleet.list`, and the matrix still scrolls. Open the
  composer and reassign controls to verify the same multi-tag choice persists. Assert non-empty
  workers/routes before making claims about them; the UI test worker has no credentials.
- Run `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`; build before L3. Do not run
  `test:e2e` without a separately authorized real-account check. Update the maintained reference
  pages and `HANDOFF.md` in the implementation commit.

Implementation order: normalization and migration → shared predicate and routing/dispatch gates →
task/RPC/MCP propagation → worker matrix popover → composer/reassign/plan UI → regression and layout
checks. Each phase can land only after its cross-boundary tests demonstrate the old class choices
still route to the same pair.
