# t1049 — Routing pills: one mode control, then the pair it chose (plan, 2026-10-10)

Status: **plan, awaiting approval.** Nothing in `src/` has changed yet.

## 1. What is wrong today (read from the code at `90ae525a`)

The operator's screenshot (thread composer, t1045) reads `CodexFirst · GPT 6.1 Sol · High · Med · Delegate on`.
Here is what each pill shows and where the label comes from:

| Pill | Shows | Source | Why it confuses |
|---|---|---|---|
| Worker | `CodexFirst` | `pillLabels().workerLabel`, `thread/Reassign.tsx` | fine |
| Model | `GPT 6.1 Sol` (muted) | the latest run's model, because the pin is `__auto__` (t674) | Nothing says the router chose it. Muted is the only clue. |
| Tags | `High` | `TagsPill`, drawn only while model is `__auto__` (t1042) | `High` is a built-in **tag** (the old capability class, `BUILTIN_TAGS` in `shared/modeltags.ts`). Nothing tells it apart from an effort level. |
| Effort | `Med` (muted) | `current.effort`, the latest run's observed effort | It sits next to `High`. Read left to right, that is "High, then Med". |

Further defects in the same area:

- **New Task repeats the tags inside the model label.** `NewTask.tsx:701-707` sets `modelPillLabel` to
  `Auto Model (${tagsLabel(modelTags)})`, so the screen shows `Auto Model (Med)` *and* a Tags pill
  reading `Med`. `pillLabels()` does the same in the composer (`Auto Model (High)`) whenever no run
  has happened yet. In both places, `(Med)` reads as an effort level, which is the old t1042 meaning.
- **Manual has no name.** "I pick the model and effort" exists only as a *side effect*: choosing a
  concrete model in the Model pill hides the Tags pill (`showsTags: model.startsWith('__auto__')`)
  and clears the tags. No control *says* Manual, and the account default (`inherit`) is a third
  state hidden inside the Model menu.
- **The order is backwards.** The tags decide which models are eligible, but the Tags pill sits
  *after* the Model pill.

## 2. Proposed shape

```
[Worker] [Route] [Model] [Effort]      [Delegate]
```

**Route** replaces the Tags pill and is always drawn. It owns the mode question, so the Model and
Effort pills only ever report or pin a pair:

| Route reads | Means (filed as) | Model pill | Effort pill |
|---|---|---|---|
| `Auto` | `modelPolicy: 'auto'`, `modelTags: []` | the router's pair, muted (see §3) | same |
| `#High` / `#ZDR #Audio` | `'auto'` + those tags | the router's pair among tagged rows, muted | same |
| `Default` | `modelPolicy: 'inherit'` | the account's default model, muted | the account's default effort, muted |
| `Manual` | `model` pinned, `effort` pinned or CLI default | the pinned model, **bold** | the pinned effort, **bold** |

- **Its menu:** `Auto (any tags)`, `Account default`, `Manual`, then the tag checklist that
  `TagPicker` draws today. Ticking a tag implies Auto. Ticking `Manual` clears the tags.
- **The Model and Effort pills stay clickable in every mode.** Picking a concrete model there turns
  Route into `Manual`. This keeps the one-click override the operator already uses ("the user can
  still override by pinning"), and the Route pill now says that it happened. Picking
  `Auto` / `Account default` in the Model menu is removed, because Route owns that choice.
- **Tags read as tags.** Chips get a `#` prefix (or a tag glyph, rendered by `TagChips`, so the
  Settings table matches). With that, `#High` cannot be read as an effort. The effort pill keeps its
  bare level, and its `title` says "Effort".
- **No tags inside a model label, ever.** `Auto Model (Med)` goes from `NewTask.tsx`, from
  `pillLabels()` and from the plan row's per-piece model pill (`NewTask.tsx:1931-1945`).

Nothing in the stored data or the RPC changes. `model`, `modelPolicy`, `modelTags` and `effort`
already express all four rows, and `filedModelChoice` / `task.setWorker` already file them in one
write. This is a renderer change, plus one optional read-only RPC (§3).

## 3. What the muted Model/Effort pills say before anything has run

Which pair the router picks is a scored decision (`scoring.ts:471`, `routableCandidatesFor` and then
the objective), so the renderer cannot compute it purely. In priority order:

1. **A run exists on this account:** the run's model and effort. This is the t674 behaviour and is
   kept as it is.
2. **The candidate list has one pair** (`autoCandidates` / `routableCandidatesFor` logic, already in
   `shared/modelroutes.ts`): name it, muted. It is a fact, not a guess.
3. **Several pairs:** `Auto · 3 pairs`. The menu hint lists them (`routeLabel`).
4. **No account pinned:** `Auto`.

*Optional phase 2:* add a `route.preview` RPC that runs the zero-token scorer for a hypothetical task
and returns the top pair *with its arithmetic*. This would replace case 3 with a real answer. The
scorer spends no tokens, so the invariant holds. It is a second caller of scoring, though, so I
recommend doing it only if case 3 turns out to be common in practice.

## 4. Work, in order

1. `TagControls.tsx`: add the `#` prefix to `TagChips`. Add a `RoutePill` built from `PillSelect` +
   `TagPicker` that takes `mode: 'auto' | 'default' | 'manual'` + `tags`.
2. `thread/Reassign.tsx`:
   - derive `mode` from `model` / `modelPolicy`;
   - drop the tags branch of `pillLabels().modelLabel` (the "Auto Model (…)" text);
   - draw the pills in the order Worker → Route → Model → Effort;
   - `showsTags` becomes "always". `setModel(concrete)` already clears tags, so it only needs to set
     `mode = manual`.
3. `NewTask.tsx`:
   - apply the same split to `modelPillLabel` / `modelPillOptions` / `modelTagsPill`. The three call
     sites at lines 1435, 1680 and 1826 move the pill ahead of the Model pill;
   - the plan row's per-piece pill gets the same treatment;
   - `showsEffortPicker('', 'auto')` stops hiding Effort. It shows the routed effort, muted (§3),
     and choosing one pins the pair (Manual).
4. Tests. L1: `pillLabels` for each mode × {ran, not ran}. Also `Reassign.test.tsx`,
   `composerprefs.test.ts` (`showsEffortPicker` flips), and a regression that no model label
   contains a tag. L3: `test/ui.test.mjs` asserts the New Task pill order and that `Auto Model (`
   appears nowhere. Mutate the label code and watch it go red first, because that suite never opens
   a project (AGENTS.md, Tests).
5. Docs: `docs/ui.md` (composer and New Task pills), `docs/glossary.md` (*Route*), HANDOFF.

Estimate (*inferred* from the size of the t1042 change to the same files): one task, single agent.
Splitting it would not help: the three files share `pillLabels` and the prefs record.

## 5. Decisions for the operator

1. **Name of the mode pill:** `Route` (recommended), `Tags`, or no name (it just reads
   `Auto` / `#High` / `Manual`).
2. **Should `Account default` stay a separate mode or fold into Manual?** I recommend keeping it.
   It follows the account's default when that default changes, which a Manual pin does not.
3. **Should the built-in tags be renamed** (for example `Tier 1/2/3`) to end the clash with effort
   names outright? I recommend not renaming yet: the `#` prefix plus the new order may be enough,
   and a rename touches stored rows (`classTag` / `tagClass`). Revisit after seeing it.
4. **Phase 2 `route.preview`:** later, as described in §3.
