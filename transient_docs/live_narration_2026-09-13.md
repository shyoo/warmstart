# Live narration and the Session TUI — t423, 2026-09-13

Dated design record. Status lives in `HANDOFF.md`; the maintained reference is `docs/adapters.md`
(what the CLI does), `docs/ui.md` (what the pane draws) and `docs/cost-model.md` (the quota reading).

## The report

> (1) Looking at t420, when Claude was working on a task, it remained mostly silent. Antigravity
> usually produces a thinking bubble in the meanwhile. … (2) Another issue is the Session TUI. Other
> orchestrators show the full TUI session of the tool, where the user can directly interact.

## What was measured, and against what

All of it on this machine, 2026-09-13, `claude` **2.1.270**, plus one read of a real 1,679-record
Claude Code transcript from this repository.

| Question | Answer |
|---|---|
| Is Claude Code quiet, or is our decoder quiet? | **Our decoder.** `textBlocks` keeps `type: "text"` blocks; `decodeStream` mapped a prose-less `assistant` record to `other`. In the sampled session **1,310 of 1,679 assistant records (78%) had no text block at all** — 814 tool calls, 496 thinking |
| Can the thinking text be recovered? | **No.** A stream `thinking` block carries `thinking: ""` and a signature. `--include-partial-messages` gives `thinking_delta.thinking === ""` too. The transcript agrees: 490 of 496 thinking blocks empty |
| Is there anything about thinking to show? | **Yes, free.** `{"type":"system","subtype":"thinking_tokens","estimated_tokens":147,"estimated_tokens_delta":97}`, emitted with **no flag** |
| What does `--include-partial-messages` buy? | Prose word by word. One turn went from 7 stream lines to **81**. It does not unlock thinking text and does not unlock the estimate |
| Could a dispatched agent run in a real TUI instead? | **Only by going quota-blind.** `rate_limit_event` appears in the stream-json output and **nowhere in the transcript** (checked all 1,679 records: zero). That record is the signal preemption runs on. `--permission-prompt-tool` is also stream-only |
| Can a real terminal be opened on a *running* conversation? | **Yes.** `--resume <old> --fork-session --session-id <new>` honoured the minted id and read 31,372 tokens from cache |
| Is *take the keyboard* safe on a dispatched session? | ⛔ **No.** Three raw keystrokes ahead of the next message: `Error parsing streaming input line (type=user, 112 chars): SyntaxError`, **exit 1**. The identical control run exited 0 |
| Does anything else write raw bytes at a pipe? | ⛔ **Yes** — `cancel.ts`'s `askForWrapUp`, with a carriage return. So every soft cancel of a dispatched task waited out its 90 seconds and logged *did not wrap up in time* about a prompt the agent had never seen |
| Anything else free on the wire? | ⭐ `rate_limit_info.unifiedWindows` — a utilization per window, on every turn, where the alternative is a cache measured 19 days stale |

## The decisions the operator made

1. **Session TUI**: rich reconstructed view **and** a PTY sidecar. Not work-in-a-PTY — the
   rate-limit measurement above is the reason, and it is a measurement rather than a preference.
2. **Narration fidelity**: tool lines and a thinking indicator always; `--include-partial-messages`
   behind a fleet setting, default **off**.
3. **`unifiedWindows`**: wire it in as a real quota reading, not display-only.

## The shape that came out

- **One vocabulary, two adapters.** `StreamEvent.tool_use` and `StreamEvent.thinking` are declared
  events. Antigravity's `[Tool: …]` lines moved onto the first of them **unchanged in wording**,
  because `activity.proseOf` skips them by prefix and respelling one would start quoting tool calls
  onto threads as the agent's own words. `toolLine` in `stream.ts` is now the one speller.
- **Two tiers, and neither pretends to be the other.** `renderForHuman` still renders into
  `scrollback` — `turnend.ts` reads that to find a completion an MCP-less adapter could not report.
  `describeStream` is the new one: the same events as `SessionStreamLine` records, which a pane can
  collapse and a terminal cannot.
- **The capability, not the name.** `streamsPartialOutput` is declared per adapter and
  `Settings.liveNarration` is the operator's standing preference; `wantsPartialMessages` reads both,
  in one place, and an adapter that cannot simply runs as it always did.
- **The guard on the free quota reading.** A snapshot is atomic (`sampleAt` groups by `sampled_at`),
  so a live record naming two windows would delete a third. `publishStreamWindows` declines rather
  than losing one.

## What is still unproven

- **Nothing here has been driven in the packaged app.** L1 covers the decoders, the merge, the quota
  guard and the refusals; the pane itself, the disclosure rows and the **Open a real terminal**
  button have not been looked at with a real run behind them.
- **Whether `unifiedWindows` carries an Opus window** on an account that has one. No Max account was
  available. `UNIFIED_WINDOWS` maps a key for it on the assumption it is spelled like the others, and
  the publish guard is what makes being wrong cost nothing.
- **Whether `--include-partial-messages` is worth its traffic** in practice. It is off by default and
  has not been run for a whole task.
- **The fork terminal has never been opened against a live dispatched run.** The flag combination was
  measured on a resting conversation in a scratch directory, not on a worktree with an agent in it.

⛔ One decision worth recording because the obvious alternative is wrong: `attachTerminal` **always
forks**, never resumes, even for a conversation that is resting. `spawnSession`'s resume path reuses
the same row, so the conversation would come back marked `pty` while still reading `purpose: 'work'`
— and `warmSessionFor` walks a task's own runs and offers any live, idle session it finds, so the
next dispatch would write scheduled unattended work into the terminal a person is sitting at.
