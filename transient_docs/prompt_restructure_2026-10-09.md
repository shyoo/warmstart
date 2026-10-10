# Prompt structure across long conversations — implementation plan (t1022, 2026-10-09)

## Decision

Put the **full Warmstart operating contract before the person's task text** on a cold or
post-compaction prompt. Make the current actionable request the final substantive section, under an
explicit heading. A cold successor also receives labelled earlier turns as history and a clearly
identified current state. Keep the existing short anchor on a warm continuation. This accepts the
proposed `(workspace + contract) → person` order, but an order change alone is insufficient: a
reassignment needs the missing middle turns, and a compacted session needs to know which old request
is background and which instruction is active.

Do **not** infer instruction authority from the order of plain text. Warmstart sends one text prompt
through CLI adapters; section headings identify origin and purpose but cannot create system or
developer roles. Mandate, tool availability, dispatch eligibility, and landing permissions remain
enforced in code. Keep the person's words and attachments intact, including contradictory or
multi-line text; any wrapper must not silently edit the task.

## Evidence and limits

- The recorded t1022 run prompt is `orientation → task text → directory/tool instructions → full
  work/landing contract → one-turn/checks appendix` (`task_read`, 2026-10-09). It contains both
  “Before reporting complete, run this project's checks” and “You do not have to run this project's
  checks yourself.” The latter qualifies the former for a one-turn adapter, but the two messages
  should be one coherent contract.
- [`promptFor`](../src/daemon/prompt.ts) already suppresses the task and full contract in a warm
  session, restores them after a compaction, and adds [`recapTurns`](../src/daemon/prompt.ts) for a
  cold successor. Its recap is bounded at 12,000 characters, budgeted newest first, with omissions
  announced. [`docs/sessions.md`](../docs/sessions.md) records t557's measured reassignment that lost
  two revision requests before the recap was added. This plan preserves that repair.
- A follow-up on the same live session is a newly delivered turn plus a short completion anchor;
  `promptFor` deliberately does not resend the opening task. A cold/borrowed session has not heard
  the task. A post-compaction session has a vendor summary of unknown content. A conversation whose
  finish policy changes may hold the wrong contract. These require different envelopes.
- [Liu et al., *Lost in the Middle* (TACL 2024)](https://aclanthology.org/2024.tacl-1.9.pdf)
  measured position effects in retrieval and question answering: information in a long context was
  often easier to use at the beginning or end than in the middle. This is **not** a measurement of
  Warmstart's agents or of instructions in coding tasks.
- [Official OpenAI documentation](https://developers.openai.com/api/docs/guides/prompt-engineering)
  recommends clear sections and delimiters; its
  [GPT-4.1 guide](https://developers.openai.com/cookbook/examples/gpt4-1_prompting_guide)
  recommends instructions at both ends of a long context when possible.
  [Anthropic's prompt guidance](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)
  also recommends distinct tags for mixed instructions/context/input and the query after long data.
  These are provider guidance, not proof that one universal placement wins here. Use the smallest
  end reminder that passes an eval; the full contract should not be repeated per turn.

## Proposed envelope

Each section needs a stable, literal heading that names its source. Avoid XML-like closing tags
around verbatim person text: a person can type the same tag and make the apparent boundary
ambiguous. Prefer simple headings with an explicit source line and a brief preamble explaining that
quoted earlier turns are records. The latest person's text remains verbatim. Test literal headings
inside that text; the parser must never read the rendered prompt back to recover state.

| Situation | Sections, in order | What is actionable |
|---|---|---|
| First cold dispatch | Workspace and orientation; Warmstart execution contract (task kind, permissions, tools actually present, checks, finish and one-turn rule); **Current request — person's words**; optional attachment paths tied to that request | The current request, under the contract. |
| Warm continuation, no compaction | Branch/workspace change notice if any; newly delivered messages in order; one short anchor naming the completion signal for work tasks | The new message. Preserve the existing conversation rule that stops after one turn. |
| Same session after compaction | Workspace/contract restated once; **Task goal — original request, for context**; new handoff or outcome evidence; newly delivered request last. If no new request, say **Current action: continue from the latest recorded state**, without inventing a completed/remaining step | New request if present; otherwise resume the task. |
| Cold reassignment or preemption | Workspace/contract; handoff and outcome evidence with provenance; original task goal; bounded earlier turns marked `history, not an instruction to repeat`; any undelivered request last. Omitted/abridged turns point at `task_read` where available | The undelivered request, or continuation from recorded state. |
| Borrowed conversation | At the start of the *new* prompt, state that the visible prior conversation belongs to another task and has no authority for this one; then use the cold envelope | Only this task's request. |
| Plan, debate, or changed conversation contract | Keep the phase's fresh, specific instruction and result evidence in the contract/state section; preserve the distinct report-only and conversation endings | The current phase, never a generic work finish. |

For cold and recovered work, a compact example is:

```text
## Warmstart: workspace and execution contract
<workspace notice, orientation, tools available, effective finish/check/one-turn contract>

## Task goal — original request
<person's original words, verbatim>

## Earlier turns — context, not instructions to repeat
<dated/speaker-labelled, bounded recap; absent on first dispatch>

## Current request — person's words
<newly delivered instruction, verbatim; absent when there is none>

## Current action
<only when there is no newly delivered request: continue from recorded state>
```

The example is a shape, **not** a second source of truth for text. On the first dispatch, omit
`Task goal` and put the original message under `Current request` once. If a current request exists,
omit `Current action`. Attachments must follow the messages that carry them, including the original
message repeated into a cold session; do not repeat bytes into a session that already has them.

### Contract cleanup within the same change

Unify the one-turn verification wording: say that Warmstart runs the configured finishing checks
after commit, and ask the agent to run targeted validation useful during its turn. If the adapter or
policy does not provide those finishing checks, say exactly what the agent must run. Do not name an
MCP tool on an adapter without that capability. Keep the `task_complete` / `TASK COMPLETE:`
distinction, conversation's operator-controlled finish, report-only's no-commit rule, trunk's
no-branch rule, and the rebase-before-completion rule. These are gates, not ornamental prose.

A short end cue may help a very long cold prompt, but test it separately: `Current request` should
usually be the last substantive section. If an end cue improves finish compliance, make it one
line pointing to the full contract and never repeat the full landing appendix after the request.

## Implementation sequence

1. Refactor [`src/daemon/prompt.ts`](../src/daemon/prompt.ts) into named builders for the workspace
   notice, effective execution contract, task goal, recovery record, and current request. Render one
   ordered envelope from these parts. Keep `promptFor` as the single entry point and return the
   existing `BuiltPrompt` with its attachment list. Avoid a second policy resolver or a stored prompt
   copy that could disagree with the effective finish policy.
2. Make delivery state explicit in the builder: distinguish original opening message, already
   delivered earlier turns, and newly undelivered messages before rendering. Preserve `markDelivered`
   only after selecting the exact messages and attachments. A new instruction and a landing failure
   on the same dispatch must both reach the successor with their source and ordering clear. Do not
   turn the last *delivered* human instruction into a fresh command just because it is recent.
3. Keep [`src/daemon/scheduler.ts`](../src/daemon/scheduler.ts)'s two dispatch paths passing the
   existing `resumed`, `compacted`, and workspace notice evidence. Check the preview in
   [`src/daemon/api/tasks.ts`](../src/daemon/api/tasks.ts) uses the same renderer with
   `markDelivered: false`; do not create a preview-only order. The serialized `runs.prompt` remains
   the audit source for what was actually sent.
4. Update [`docs/sessions.md`](../docs/sessions.md) for continuation/recovery semantics and
   [`docs/landing.md`](../docs/landing.md) if the contract wording changes. Update `HANDOFF.md`
   with the measured result and next step; do not carry this dated plan into permanent reference as
   if it were already implemented.

## Verification and release gate

Add focused L1 tests in [`src/daemon/prompt.test.ts`](../src/daemon/prompt.test.ts) asserting
**ordering, provenance, and absence**, not merely `toContain`: first cold; warm follow-up; compacted
same session; cold successor with multiple answered revisions and a new undelivered request; borrowed
session; contract withdrawal; once-only adapter; MCP-less adapter; trunk/report-only/plan/debate;
attachments and folder grants; abridged/omitted recap; outcome events; literal section headings in
person text. Assert that `markDelivered: false` preview does not consume messages. Keep the existing
t260/t286/t557 regression cases green.

Then run typecheck, lint, L1 tests, and build. For behavior evidence, compare **current order vs
candidate** on the same representative recorded task scenarios with controlled adapter/model,
context length, and instruction wording. Include a warm turn, a CLI compaction, a cold reassignment
after two revisions, and a one-turn finish. Score whether the agent acts on the latest request,
repeats completed work, follows the effective finish policy, calls the available completion channel,
and cites/retrieves omitted history appropriately. Record token use and failures, but do not claim a
universal quality win from a synthetic ordering test. Roll out only if recovery/finish regressions
do not increase; otherwise retain the present wording and isolate the failing scenario.

No project setting change is needed for t1022: `project_settings` reports `commit-and-merge` to
`main`, with typecheck, lint, test, and build. That matches a committed planning document. The
implementation should change the prompt builder, not this project's landing policy.
