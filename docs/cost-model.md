# Cost model — the measured facts

**This is the load-bearing knowledge in Multi Agent Controller.** Every scheduling decision reduces to arithmetic
over these numbers. Several are counter-intuitive and at least one contradicts what a reasonable
person would assume, so ⛔ **do not re-derive any of this from memory.**

Every row says where it came from and when. If you change a number, change its provenance in the same
edit. If a fact can no longer be verified, delete it rather than leaving it unsourced.

---

## 1. Prompt caching (Anthropic)

Source: Claude docs, *Prompt caching* / *Context windows* / *Compaction* / *Context editing* /
*Token counting*, read 2026-08-24.

| Fact | Value |
|---|---|
| Cache **write**, 5-minute TTL | **1.25×** base input |
| Cache **write**, 1-hour TTL | **2.0×** base input |
| Cache **read**, either TTL | **0.1×** base input |
| **A read refreshes the TTL, free** | *"The cache is refreshed for no additional cost each time the cached content is used."* |
| TTL is counted from | the **start of the request** that writes or reads it — not the end of the response |
| Minimum cacheable prefix | 512 tok (Opus 5, Fable 5) · 1,024 (Sonnet 5) · 4,096 (Haiku 4.5). Below this, **no caching and no error** |
| Cache breakpoints per request | max 4 |
| Invalidation | cascades `tools → system → messages`. **Changing tool definitions invalidates everything.** Effort and thinking params are model-dependent |
| Cache scope | **isolated per workspace within an organization** (org-level on Bedrock / Google Cloud) |
| Concurrency | a cache entry exists only **after the first response begins** — parallel requests on one prefix each pay a write |

**The free-refresh row is the single most consequential fact in this document.** It means a session
that is *used* never pays a rebuild, and it creates the keepalive move in §3.

**The request-start row is a correctness trap.** A four-minute response has already consumed four
minutes of the hour. Measuring idle from the last assistant turn record is optimistic by roughly one
response length, and the error is in the unsafe direction.

## 1b. Prompt caching (OpenAI / Codex)

Source: OpenAI *Prompt caching* guide, read **2026-09-02**. ⛔ This section replaces the claim this
document and `costmodels/openai.codex.2026-08.json` both carried until that date — that OpenAI
caching is *"automatic and server-side"* with *"no TTL a scheduler can extend"*, and therefore
`unpriced`. The first half is true. The second half is not, and the difference is a scheduling lever
that was switched off for a whole provider.

| Fact | Value |
|---|---|
| Cache **read** | **0.1×** base input |
| Cache **write**, GPT-5.6+ | **1.25×** base input |
| Cache **write**, older than GPT-5.6 | **no additional charge** |
| **Prefix lifetime, GPT-5.6+** | **30 minutes**, *"after its most recent write or reuse"* |
| **A reuse refreshes the lifetime, free** | *"reusing the prefix refreshes its lifetime without another cache-write charge"* |
| TTL is counted from | the **request** that writes or reuses it — same as Anthropic, same trap |
| Minimum cacheable prefix | **1,024** tok (GPT-5.6+) · **2,048** (older) |
| Invalidation | the *entire rendered prefix* must match. Model, tool definitions and ordering, output format, reasoning effort, verbosity and compaction all break it |
| Cache scope | not shared across organizations, and not across regional processing boundaries |
| Steering | `prompt_cache_options.ttl`, whose **only** supported value is `"30m"` |

**This is the same lever Anthropic sells, at half the length.** Read it against §1: 0.1× reads, a
write multiplier, and a TTL that reuse extends for free. So `cache.kind` is `ttl_multiplier` in both
files and the arithmetic in §3 applies unchanged — only `n` is smaller.

**Older models are a different mechanism that lands in the same place.** GPT-5.5 and GPT-5.4-mini
predate `prompt_cache_options` and use `prompt_cache_retention`. The non-ZDR default is `"24h"`,
which *"typically keeps entries available for around 30 minutes and can retain them for up to 24
hours"*. So 30 minutes is exact for the newer pair and typical for the older pair, and the cost model
carries one TTL for all four. ⛔ **It is not a floor.** An organization with Zero Data Retention
enabled defaults to `"in_memory"` instead — *"around 5 to 10 minutes of inactivity"* — and against
that the file is optimistic. A ZDR fleet should measure its own reuse rate before trusting it.

**Codex cannot compact, so its clock is a two-move clock.** `codex exec` is one-shot and there is no
documented way to drive compaction from a headless run (`manualCompact: false`,
`compaction.available: false`), so `costOfCompact` returns null and every compaction move is skipped.
What remains is the pair in §3 that needs no compaction: **reuse the prefix inside the 30 minutes**,
or **let it lapse and start cold**. Half an hour measured from the request start lapses between
ordinary dispatches, so the second happens often and is not a failure.

**Consequence for every window derived from a TTL.** `keepaliveFloorMs` was 55 minutes on the
reasoning *"below this, the TTL covers it anyway"* — a sentence that is only true relative to a
particular TTL, and which against 30 minutes sets a floor above the entire window. Likewise a
15-minute decision window is a quarter of Anthropic's prefix and *half* of OpenAI's. Both are now
fractions of `CostModel.cacheTtlMs()`, anchored so an hour reproduces the old constants exactly.

## 2. Context

| Fact | Value |
|---|---|
| 1M-token window | Opus 5, Opus 4.8 / 4.7 / 4.6, Sonnet 5, Sonnet 4.6, Fable 5, Mythos 5 — default, no beta header, standard pricing |
| 200k window | Sonnet 4.5 and older |
| **Context rot is documented** | *"As token count grows, accuracy and recall degrade."* Not folklore — this justifies the context-degradation penalty in scoring |
| **Context awareness is per-model** | Sonnet 5 / 4.6 / 4.5 and Haiku 4.5 receive injected `<budget:token_budget>` and `<system_warning>Token usage: X/Y` tags. **Opus 4.7+, Fable 5 and Mythos 5 do not** |
| **Tokenizer changed** | Claude 4.7+ / Fable 5 / Mythos 5 produce **~30% more tokens for the same text**. Counts are **not comparable across generations** |
| Cached prefixes | still occupy the context window. Caching changes what you pay, not what fits |

Consequences: a wrap-up instruction sent to Opus must **state the remaining budget explicitly**,
because that model is not told it. And any stored estimate whose tokenizer generation no longer
matches is **discarded, not scaled**.

## 3. The four states of a session, priced

For a session holding context `C`, with output billed at 5× input, in input-token-equivalents:

| Move | Cost | Effect |
|---|---|---|
| **Keepalive** — one trivial turn | `0.1·C` + ε | read refreshes the TTL; buys another full hour; context unchanged |
| **Compact** | `0.1·C + 5·S` ≈ `0.1·C + 28k` | context drops to `P ≈ 12k`; takes ~2 min |
| **Expire, then resume** | `2.0·C` | full cold rebuild |
| **Expire, never resume** | `0` | context gone |

Worked at `C = 300k`:

```
keepalive        30k per hour, indefinitely
compact          58k once, then 1.2k per hour
expire + resume  600k
```

**Compaction overtakes keepalive at ≈ 2 hours of expected idleness:** `58 + 1.2n = 30n → n ≈ 2.0`.

So the decision is three-way on *expected time until this session is next needed*:

```
< ~1h        do nothing — it will be resumed inside the TTL anyway
~1h .. ~2h   keepalive
> ~2h, C > 60k, tokens_since_compact > 25k   compact
never        do nothing — both moves are pure waste
```

Two things keep keepalive honest: it does **not** reduce context, so it does nothing for context rot;
and it **spends quota**, which under a tight window can cost more in scheduling freedom than it saves
in tokens.

⛔ **The whole three-way decision rests on "expected time until next needed", so what feeds that
number matters more than the arithmetic above it.** `ready` is the scheduler's word for *eligible*,
not for *dispatchable*: a task it passes over on every tick keeps that status, and reading the
status as availability answered the question with **0ms** — the one answer that skips all three
branches, on every live session at once. Measured on t71 (2026-09-01): a queue held behind a quota
window for **2h29m** was the input arguing that no session had time to compact, when 2h29m is
comfortably past the ~2h break-even and is precisely the case compaction exists for. A held `ready`
task now contributes `hold_until − now`, and a `paused_quota` task contributes its `not_before` —
that second one was not counted at all, so a fleet whose entire queue had been parked by a closing
window read as *"nothing queued"* and let every warm prefix lapse.

## 4. Compaction

Source: 118 real local compactions measured by the author with a private predecessor tool, plus
transcripts sampled 2026-08-24.

| Fact | Value |
|---|---|
| Summary size `S` | ≈ **5,631** output tokens (min 1,733, max 11,435) |
| Post-compaction context `P` | ≈ **12,243** tokens (min 4,834, max 22,165) |
| **Duration** | **~2 to 2.7 minutes.** `compactMetadata.durationMs` = 139,207 · 116,245 · **160,862** on three real runs (preTokens 549k · 329k · 332k). The third was measured 2026-08-25 and is the slowest, so treat ~2 min as the optimistic end |
| Break-even context | **60,000** tokens absolute, not a percentage — corresponds to a resume probability of ~0.36 |
| Post-compaction size lives in | a later `compact_boundary` record, **not** the last assistant turn |

⚠️ Read `max(last assistant turn, last compact boundary)` or a freshly compacted session looks like
the large one it just stopped being, and gets compacted again.

⚠️ The ~2-minute duration puts a hard floor under any deadline ending in a compaction. The
last-chance-to-compact moment is **T+53m**, not T+58m.

### ⛔ A conversation between runs is one the clock cannot see (2026-09-01, t92)

`runCacheClock` iterates sessions in `live` or `idle`, and it has to: **every move it owns is a
prompt, and a prompt needs a process to receive it.** A conversation whose process has exited —
preempted, closed, crashed — is invisible to it. That is also exactly the conversation that sits
still for hours and is then resumed.

Measured on t92 from this install's database. Run 2 was preempted at **21:35** on a vendor quota
warning and the process exited. The conversation sat `closed` until **23:40**, when run 3 revived it:
two hours in which `clock_events` gained **not one row** for session `59eda2c6` and `compactions`
gained nothing either. Run 3 resumed into **84,254** tokens of context carrying **345,708** tokens
since its last compaction — over both halves of the break-even — and read **15.7M** cache tokens
across the next twenty minutes. Nothing was broken. The session was simply not one the clock was
allowed to look at.

⭐ **The moment matters more than the policy, because a compaction is not one price.** It has to read
the whole conversation, and what that read costs depends entirely on whether the vendor still holds
the prefix:

| When it is compacted | What the read costs |
|---|---|
| **T+45m**, prefix still warm | a cache read — **0.1·C** |
| T+2h, prefix has lapsed | rebuild the prefix first (~**1.25·C**), then read it |

So a task parked on a five-hour window is the worst case there is: the TTL runs out at T+1h and the
task does not come back until T+2h, and every chance to compact cheaply has expired before anything
looks at the conversation.

⭐ **Move 7 — `revive_compact`.** A second pass in `runCacheClock` over
`warmClosedConversations()`: conversations with no process whose prefix has **not** lapsed. Inside the
same 15-minute window a live session gets, the clock starts a process on the conversation, sends
`/compact`, and closes it again on the boundary. On a one-hour TTL that decision is taken at about
**T+45m**, which leaves room for a ~30s spawn and a compaction measured at 110 · 115 · 139 · 161s.
Below **5 minutes** of TTL it declines: a compaction that lands after the prefix has lapsed bought
nothing.

⛔ **Only a conversation somebody is provably coming back to, and provably not yet** — a task in
`paused_quota` or `scheduled` whose `not_before` is further out than the compaction window. That one
test does three jobs: it proves the conversation has a future, it proves the spend is not speculative,
and it removes the race where the scheduler dispatches into the session mid-compaction and the agent
reads its instructions out of a summary. A `ready` task is deliberately excluded — the dispatch path
compacts what it revives, so the honest answer is to let it.

⛔ **Put back down, always.** The session is closed again on the boundary and on the timeout. A live
work session with no run and no workspace claim is a state nothing else expects: the claim was
released when the conversation ended, so leaving the process up would offer the scheduler a warm
session in a worktree another task may since have claimed. ⚠️ `post_tokens` is therefore null for
this move — the size a compaction leaves behind is only knowable from a *later* turn, and buying one
would mean paying for a turn to learn a number nothing acts on.

⚠️ **`compactOnResume()` remains, as the last resort.** It applies the same `worthCompactingNow` test
at the moment a conversation is revived for work — for the cases the early move cannot reach: a
daemon that was not running, a prefix that had already lapsed, a task with no clock on it. `/compact`
goes in first and the task's own prompt waits for the `compact_boundary`. Late is more expensive than
early; it is not more expensive than reading 84k tokens on every turn of a twenty-minute run.

⛔ **The two cannot both fire.** A landed compaction zeroes `tokens_since_compact`, which is the growth
half of `worthCompactingNow`, so a conversation shrunk before its prefix lapsed is left alone at resume.

⚠️ **The prompt is sent exactly once, boundary or no boundary.** Whether `/compact` is honoured on
the `stream` transport is still unmeasured (R6), so both paths bound the wait with
`RESUME_COMPACT_WAIT_MS` (= `COMPACT_SETTLE_MS`, 4 min): the resume starts the run on the full context
and the revive closes the conversation again. The unlanded ask stays on the record, which is the
finding.

## 5. Quota

| Fact | Value | Source |
|---|---|---|
| ⛔ **`claude -p /usage` is NOT free and does NOT report usage** | The slash command is taken as a **prompt**. It spends a real assistant turn and answers in prose. A poller built on it bills every account on every interval | measured 2026-08-25, CLI 2.1.223 — **corrects an earlier claim inherited from a private predecessor tool** |
| No `usage` subcommand exists | `claude usage` is likewise treated as a prompt | same |
| `.claude.json` → `cachedUsageUtilization` | `{fetchedAtMs, accountUuid, utilization.limits[]}`, each limit `{kind, group, percent, severity, resets_at, is_active}`. Shape confirmed | same |
| ⚠️ …but it is a **cache the CLI refreshes on its own schedule** | The reading on the development machine was **19 days old**. Neither an interactive start nor a `-p` run refreshed it | same |
| `claude auth status --json` | **Free and local, ~0.3s.** `{loggedIn, authMethod, apiProvider, email, orgId, orgName, subscriptionType}`. **Exits 1 when not logged in but still prints valid JSON** | same |
| `.claude.json` → `oauthAccount` | `{accountUuid, emailAddress, organizationUuid, billingType, subscriptionCreatedAt}` — identity without spending anything | same |
| **`/compact` succeeds below true 100%** | a displayed 100% may be 99.99% and compaction still works. At *true* 100% it fails | owner, from operation |

### A live signal does exist — in the stream

**Measured 2026-08-25.** A session running `--output-format stream-json` emits, after each turn:

```json
{"type":"rate_limit_event","rate_limit_info":{
  "status":"allowed","resetsAt":1787684400,"rateLimitType":"five_hour",
  "overageStatus":"rejected","isUsingOverage":false}}
```

and a final `result` record carrying `total_cost_usd`, `modelUsage` per model, and the same
`usage.iterations[]` the transcript has.

This is **free and live** - it arrives with a turn already being paid for. It is not a percentage, so
it does not replace the calibration in §5; what it gives is a **status** (`allowed` / warning /
rejected) and a **real `resetsAt`**, which is most of what a preemption deadline actually needs. The
`overageStatus` field also says whether spilling past the window is even possible on this account.

⛔ **`rateLimitType` is not one window.** The same account emits `five_hour` and `seven_day` records
on the same stream, minutes apart and disagreeing - measured 2026-08-31 on ClaudeThird, claude-code
2.1.251: `allowed` on `five_hour` at 22:00:50Z, `allowed_warning` on `seven_day` at 22:01:02Z. Any
reader that takes "the latest sample" gets whichever arrived last, which is how a weekly advisory
came to park a task against a five-hour deadline. **Every consumer must say which window it means.**

⚠️ It only exists on the `stream` transport. A session hosted in a PTY for a human to watch emits
nothing of the sort, which is one more reason scheduled work does not run that way.

**Wired at M3.** `stream.ts` parses it, `quota.ts` records it, and `windowResetsAt()` prefers it over
the config cache — which is what makes preemption possible at all, since a reset time from a window
that has already turned over is worse than none.

⭐ **R7 is closed, and the answer is *yes, but it is not a countdown*** (2026-08-31, claude-code
2.1.251, from this install's own `rate_limit_samples` and daemon log). `allowed_warning` is real and
does arrive before `rejected` - so the signal is an early warning rather than an obituary. ⛔ But it
**does not track the utilisation this tool measures**: t71 was warned on `five_hour` while the probe
read the same window at **17%**, and warned on `seven_day` while `/usage` read the weekly at **25%**.
Whatever the vendor is warning about - a per-model sub-limit is the likeliest explanation - it is not
the number on the fleet strip.

⚠️ **So a warning is evidence, never a verdict.** It is enough to lower a worker's routing score,
and *not* enough on its own to end a run in flight: three runs were preempted at 17%, 0% and 19% of
the very window being warned about, each throwing away a resumed 278k-token session. A refusal
(`rejected`) is the vendor declining and needs no corroboration; a warning now has to be seconded by
this fleet's own reading of the same window before it can stop anything.

### What this costs the design

There is **no free live quota probe** on this CLI. That is not a gap to route around quietly, because
two things downstream depend on knowing how much window is left: the compaction reserve below, and
the preemption deadline in the plan §8.7.

So the probe is a **ladder, and its rung is always reported**:

| Rung | Source | Trust |
|---|---|---|
| 1 | `cachedUsageUtilization` with a fresh `fetchedAtMs` | current |
| 1b | the same, fresh, but the window's own `resetsAt` has passed | ⛔ **expired — unknown, never zero.** Age is not the only way a percentage stops being true |
| 2 | the same, stale | **reported as *unknown*, with its age** — never as a number |
| 3 | nothing | unknown; degrade conservatively. ⚠️ Two distinct causes, and the UI separates them: **never probed**, and **probed but the account has no usage cache yet** — the CLI writes `cachedUsageUtilization` only after real work, so a freshly signed-in worker reports nothing until it has been used once |

⚠️ **Rung 1b is fresh and wrong at the same time**, which is why it is not a special case of rung 2.
A reading taken two minutes before a reset is as fresh as a reading gets, and every number in it
expires with the window it counted — while `STALE_AFTER_MS` keeps vouching for it for hours.
Measured on t60, 2026-08-31: a 5h window read `percent: 88` with `resetsAt` 06:39:59Z and was still
being offered as 88% at 06:46Z, on an account whose window had emptied. `windowExpired()` is the
test; `windowResetsAt` had always discarded a reset in the past, and this applies the same rule to
the percentage beside it. ⛔ Expired means the new window's contents are **unknown**, so the run is
marked `quotaUnverified` — deriving *empty* from *reset* would be inventing a number.

⛔ **A stale percentage rendered as current is worse than no percentage.** It makes the compaction
reserve look satisfied when it is not, and that failure strands context — the one loss the whole cost
model exists to prevent. `quota.ts` carries `stale` on every snapshot for exactly this reason, and
the fleet strip renders "quota unknown · last seen 19d ago" rather than "12%".

⚠️ **Refusing to show a number is not the same as saying nothing.** Every numberless state carries
what produced it and what would fix it (`quotaGap()` in the renderer): a stale reading says how old
it is, a missing usage cache says to run a session on that account, and a failed probe keeps the
adapter's own error text. Measured 2026-08-26: neither commissioned worker on this machine had ever
written `cachedUsageUtilization`, and both had been rendering the bare word "unknown" since
commissioning.

### Rung 0 — making the cache current, for free (2026-08-27)

⭐ **There is a free live probe after all, and the reason it took three months to find is worth more
than the probe.** `claude -p /usage` spends a turn — that measurement is correct and still holds.
But it is a fact about **print mode**, and it was written down as a fact about the product: *"there
is no free live quota probe."* Every later decision inherited the broader claim without re-testing
the narrower one.

Measured on claude 2.1.223 by driving a PTY:

| | |
|---|---|
| before | `fetchedAtMs = 2026-08-06T23:35:18Z` — 20 days stale |
| action | typed `/usage` and a carriage return into an interactive session |
| after | `fetchedAtMs = 2026-08-27T00:16:52Z` |
| tokens spent | **none** — a slash command is handled by the client |
| what it said | weekly window **79%**, resets Aug 30 — against the stale cache's **98%** |

That last row is the point: the stale number was not merely old, it was wrong in the direction that
makes a fleet stop dispatching to an account with a fifth of its window left.

⚠️ **Two dialogs stand between a signed-in worker and that reading**, and both were found only by
testing on a commissioned worker rather than the author's own profile: the CLI's first-run screens
(`hasCompletedOnboarding`), and the folder-trust question, which is asked per account *and* per
folder and **swallows every keystroke until answered**. Sessions with no project therefore run in
`<dataDir>/scratch`, an empty directory this app owns, whose trust is pre-answered for that
directory alone. `WorkerIdentity.setupComplete` reports the rest, and the Workers panel offers
**Finish setup**.

`refreshUsage()` in `quota.ts` does this **at the gate that needs the number** — the dispatch gate,
via `ensureFreshQuota()` — again when a run ends, and on the Probe button. It is free of tokens, not
of everything: it starts a real process for ~30s. ⛔ Never awaited in a scheduler tick; the task is
held for one pass with a reason on its row instead.

⛔ **There was a clock, and it is gone (2026-08-31).** The background sweep refreshed one worker per
pass whose reading had aged past a floor — 30 minutes until 2026-08-30, then two hours. The 30-minute
version spent far more than it bought: **150 probe PTY sessions against 14 that did any work** over
four days, each registering with the vendor's bridge and accumulating in the desktop app until
archived by hand. Raising the floor cut the count and fixed nothing else, because a reading is
*trusted* for fifteen minutes: an idle worker read `stale` for **1h50 of every 2h05** (measured on
ClaudeSecond, 2026-08-31), while the operator's 5-minute probe setting looked like a promise of a
5-minute-old number. It never was — the sweep re-reads the vendor's cache, and only the vendor
rewrites that.

⭐ **So the question moved from "is this number old?" to "is anything about to use it?"** A worker
nothing is dispatching to keeps whatever reading it has, at no cost and with no pretence: an idle
account's window is not moving. A worker about to take a task gets a fresh reading first. And what
makes the cheap rung still worth running every few minutes: the vendor's on-disk cache is refreshed
by **any** use of that account, including this fleet's own work sessions, so a busy account keeps
its own reading current for the price of a file read. The command is declared per adapter as
`usageRefresh`, never branched on an adapter name; only `claude-code` declares one today.

⛔ **`REFRESH_BACKOFF_MS` is keyed on the attempt, not on the reading's age**, and that is a bug fix
rather than a detail. A refresh that produces nothing fresher stores the *vendor's* old `sampledAt`
— correctly, since inventing a timestamp for a number nobody re-read is worse than an old number —
so anything deriving "try again?" from the age says *yes* forever on exactly the worker that cannot
answer. Under the old one-refresh-per-sweep rule that worker re-claimed the single slot every five
minutes and starved every worker behind it in `listWorkers()` order, indefinitely.

⚠️ **`stale` is a gate, not a label.** Nothing the scheduler gates on uses a reading older than
`STALE_AFTER_MS`, and that is unchanged. The UI stopped *printing* the word: an old reading on an
idle account is ordinary, so the strip shows `read 2h ago` and reserves the warning colour for the
case that is a fault — every check since has failed.

### ⭐ The poller paces itself, and the cadence means a refresh (2026-08-31)

⛔ **The claim above — that a working account keeps its own cache current for free — is not reliable
enough to build a display on.** Measured on t70: a run was preempted at the top of its five-hour
window while the fleet card over that account read **63%**, because the card was the last thing the
vendor happened to write and the trigger was a live `rate_limit_event` riding the turn. Both numbers
were honestly reported and there was nothing in the app that could reconcile them.

So the poller no longer runs on one interval. It asks the scheduler (`probeDemand()` in
`scheduler.ts`) what the fleet is doing and computes its own next delay:

| state | what happens |
|---|---|
| a run in flight on an account | `probeIntervalMinutes` (**5m**), and on that account a **refresh**, not a re-read — the account whose window is actually being spent is the one worth a terminal, so the ten-minute backoff yields to the operator's own cadence there |
| nothing running | `idleProbeIntervalMinutes` (**20m**), a re-read only. ⛔ No refresh at all: an idle account's window does not move, and the clock that used to refresh one was retired the same day (above) |
| a task parked `paused_quota` | a forced refresh **`RELEASE_PROBE_GRACE_MS` (30s) after its `not_before`**, so an unattended resume happens on the window's clock and not on the poller's |
| a live rate-limit warning, or a quota preemption | a forced refresh **at once** (`requestUrgentProbe`), because the operator has just been shown a decision made on a number their screen does not have |

⭐ **All four rows go through one ledger.** The sweep asks `refreshNow()`, which shares
`refreshAttempts` with `ensureFreshQuota()` — so the dispatch gate and the poller wanting the same
account inside a minute open **one** terminal between them, not two. What the sweep may vary is the
floor: `REFRESH_BACKOFF_MS` (10m) for a one-off reason, the active cadence for a run in flight, and
never below `MIN_FORCED_GAP_MS` (60s) whatever the setting says.

⚠️ These two changes are the same rule read from opposite ends. Freshness is worth a terminal exactly
when something is about to act on the number: the gate knows *a task is about to run here*, and the
poller knows *a run is in flight / a park is due back / the vendor just warned us*. Neither is a
clock, and there is no longer one anywhere.

### ⛔ A quota park ends on *either* its clock or a measurement (2026-08-31)

`not_before` on a `paused_quota` task is a **prediction made at the moment of parking**, and on the
overrun path it is not even that: a rate-limit warning with no reset time attached parks the task
`now + 5h` by arithmetic. Measured by hand on 2026-08-31 — a probe read the window at **0% used** and
every task waiting on that account stayed parked, because the only question anything asked was *is it
time yet*.

`quotaReleaseFor()` is the second test, held to exactly the dispatch gate's standard: the reading must
exist, be fresh (`stale` is an age test), describe a window that has not since rolled over, and sit
below `QUOTA_HIGH_WATER`. ⛔ An **expired** window releases on its own terms — that is the thing the
task was waiting for. Anything looser would release a task the next tick would immediately hold again.

### ⛔ A window's pool survives being stored (2026-08-31)

`QuotaWindow.group` is what `sessionWindowFor` finds a task's own pool by, and it was parsed, carried
through the adapter, and then **dropped on the way into `quota_samples`** — so every reader that goes
through the store (which is every gate) saw windows with no group and silently fell back to the
*busiest* pool on the account. The per-pool logic was measured against in-memory windows on
2026-08-27 and was inert against stored ones from that day until migration 26 added the column.

### ⛔ An account that cannot authenticate is not asked again (2026-08-27)

Rung 0 is free in tokens and **not** free in processes: it opens a real interactive session and types
into it. So `mayRefreshUsage()` skips any worker a dispatch has already proved work dies on
(`health.state === 'suspect'`), and the cheap sweep skips it too. Before this, a lapsed subscription meant a CLI spawned on every eligible sweep, forever, to watch it fail to authenticate - and the reading stayed `unknown` either way.

⚠️ The *automatic* paths only. Pressing Probe still refreshes: it is one of the two things that lift
the hold, and a quarantine nobody can attempt to clear by hand is worse than the fault it prevents.

### A reading either side of a run (2026-08-27)

⛔ **One reading is a state; a cost is a difference.** Until now a run recorded only what it *metered*
from the transcript, and the fleet strip showed a single percentage — so the honest question "what did
that task cost me against my subscription?" was unanswerable from the product, and a first run on a
never-probed worker had no baseline at all.

A run now carries two readings:

| | when | how |
|---|---|---|
| `quotaBefore` | at dispatch | the scheduler finds the chosen worker's reading stale or missing, starts `refreshUsage()` **in the background**, and holds the task for **one tick** with the reason on its row |
| `quotaAfter` | once the run has ended and nothing is waiting on it | the same refresh, then read |

⚠️ The tick never awaits either. `refreshUsage()` opens a terminal for ~30s and the scheduler loop is
arithmetic; a half-minute stall in it would be a worse bug than the one this fixes. And it **gives
up**: after one attempt per worker per 10 minutes the run goes ahead marked `quotaUnverified`, because
a worker that cannot answer `/usage` (§ Rung 0's two dialogs) would otherwise hold its tasks forever.
A run that metered nothing is not re-read at all — no spend, no difference to take.

⭐ **This is R1's instrument, made visible.** The window delta and the transcript token count are shown
side by side in the task's detail pane and ⛔ **never reconciled**: transcript metering is exact for
assistant turns, while quota covers everything the CLI spent that never reached a transcript — the
auto-mode classifier (§9), title generation, whatever else. Their difference *is* the measurement, so
merging them destroys it. R1 no longer needs an experiment run by hand; it needs a quiet worker and a
look at the pane.

### Rung 0 on Antigravity — the same probe, with the answer in a different place (2026-08-27)

⭐ **R9 is closed, the opposite way round from how it was asked.** The question was whether
`agy -p /usage` runs the slash command for free in *print* mode. It does not — measured 2026-08-25,
it is taken as a prompt and spent 14,603 input + 264 output tokens listing directories. But `/usage`
typed into the **interactive** session is client-side and free, exactly as on Claude Code.

⛔ **The difference that hid it for three months is where the answer lands.** Claude Code writes it to
`cachedUsageUtilization` on disk and `probeQuota()` reads the file. `agy` writes it nowhere.
Measured by driving `/usage` in a PTY and diffing every file under `~/.gemini` before and after: only
`cli.log` moved (it logs `doRefreshQuota: starting reload (force=true)` and a `loadCodeAssist` call,
and no numbers) and `history.jsonl` (which logs the command text). The quota lives in
`quota_manager.go` in memory.

So this adapter declares `usageRefresh.answer: 'screen'` and parses the rendered panel — the single
declared exception to *the TUI is for humans*, permitted for a quota reading and nothing else. See
AGENTS.md for the boundary.

Measured on agy 1.1.22, Windows, Google AI Pro, 2026-08-27 — a live reading through the adapter:

| Group | Window | Used | Resets |
|---|---|---|---|
| Gemini (Flash, Pro) | weekly | 5.48% | 138h |
| Gemini (Flash, Pro) | 5-hour | 32.80% | 1h 40m |
| Claude and GPT (Opus, Sonnet, GPT-OSS) | weekly | 42.80% | 44h |
| Claude and GPT (Opus, Sonnet, GPT-OSS) | 5-hour | 0% | — |

⭐ **Two pools mean two answers to "how full is this account?", and the gate now picks the right one
(2026-08-29).** The parser has produced all four windows since the day above. What consumed them was
one line asking for a window whose id is `session` or `5h` — which on this provider matches neither,
so the adapter renamed the *busiest* five-hour window to the bare `5h`. That is correct for a caller
with no model in hand, and the reset countdown and the reserve's sample query still get it. It was
wrong for the dispatch gate: with Gemini at 96% and Claude/GPT untouched, a Claude/GPT task was held
out against a pool it does not draw on. ⚠️ The gate can only do better because the model became
knowable before the spawn — `resolveModelChoice` resolves task → worker → CLI *before* dispatch, so
the pool is a lookup rather than a guess. `pool` on each model in the cost model is that lookup.

⛔ **Matched by containment, not equality — and the table above is why.** The panel's heading here
reads *"Claude and GPT"*, which slugifies to `claude-and-gpt`; the CLI also writes it `CLAUDE & GPT`
and `CLAUDE/GPT`, giving `claude-gpt`. A pool token of `claude` or `gpt` is a substring of all three
and of none of Gemini's. Equality against any one spelling would have passed every test written
against the other and failed on a real panel.

⚠️ **Two traps, both found by running it rather than reading it.**

- The panel reports **remaining**; `QuotaWindow.percent` is **used**. Inverted in the parser. Storing
  it verbatim reports a nearly-exhausted account as nearly empty — the one direction the gate cannot
  survive, since `QUOTA_HIGH_WATER` would never trip.
- The panel is **taller than a default terminal and scrolls**. The first live run returned three
  windows of four: at 30 rows the last group's five-hour window fell below the fold, silently, and
  that window is a candidate for the `5h` id the gate reads. The probe session now takes its geometry
  from the adapter (110×60), and the parser refuses any group showing one of its two windows rather
  than under-reporting.

⚠️ **Two five-hour windows, one gate.** Gemini and Claude/GPT are metered separately and a snapshot
cannot know which group the next run will use, so the **busiest** is promoted to the `5h` id the
scheduler and reserve look for. Over-stating pressure delays a dispatch; under-stating it strands a
run at a window boundary holding context it cannot save.

### Codex — the reading was on disk the whole time (2026-08-29)

**Measured against codex-cli 0.151.0 on Windows.** For three months this adapter declared
`quotaProbe: 'none'`, reasoning that Codex has no non-interactive usage command. The command does not
exist — openai/codex#10233 is still open — and the conclusion drawn from that was wrong. Every turn
writes an `event_msg` / `token_count` record into the session's rollout JSONL, and that record
carries the server's `rate_limits` verbatim:

```json
{"type":"event_msg","timestamp":"2026-08-30T01:23:30.316Z","payload":{"type":"token_count",
  "rate_limits":{"limit_id":"codex","plan_type":"free",
    "primary":{"used_percent":0.0,"window_minutes":43200,"resets_at":1790645009},
    "secondary":null,
    "credits":{"has_credits":false,"unlimited":false,"balance":null}}}}
```

⭐ **And there is a better rung, which is what the TUI's `/status` uses.** `codex app-server` speaks
JSON-RPC over stdio and answers **`account/rateLimits/read`** — no params, **~600–700ms measured**, no
turn, no token:

```json
{"rateLimits":{"limitId":"codex","planType":"free",
  "primary":{"usedPercent":0,"windowDurationMins":43200,"resetsAt":1790646320},
  "secondary":null,"credits":{"hasCredits":false,"unlimited":false,"balance":null}},
 "rateLimitsByLimitId":{"codex":{…}}, "rateLimitResetCredits":{"availableCount":0,"credits":[]}}
```

⛔ **This is a live server call, not a cache**, which is the whole reason it outranks the rollout: two
readings taken minutes apart returned `resetsAt` values **1311s apart**. A cache cannot do that. The
protocol is discoverable locally and for free — `codex app-server generate-json-schema --out <dir>`
writes `v2/GetAccountRateLimitsResponse.json`, which is where the field names below come from.

So `probeQuota` has two rungs, both free, and they report **different `source` values on purpose**:

| | Rung 0 — `account/rateLimits/read` | Fallback — the rollout |
|---|---|---|
| How | `codex app-server` over stdio, `initialize` then one request | `$CODEX_HOME/sessions/**/rollout-*.jsonl`, newest first, last `event_msg` → `token_count` |
| Cost | a local subprocess, ~700ms, one network call | a file read |
| `source` | `'cli'` | `'config-cache'` |
| `sampledAt` | now — the reading is current | the record's own `timestamp`, never ours |
| Freshness | current whenever asked | ⚠️ **as old as the worker's last turn**; an idle worker's ages without limit |
| Fails when | offline, or not signed in | the worker has never taken a turn |

⚠️ **Spelling.** The app-server answers in camelCase (`usedPercent`, `windowDurationMins`, `resetsAt`)
and the rollout in snake_case (`used_percent`, `window_minutes`, `resets_at`). Same server payload,
two writers; one normaliser reads both so no caller has to know which rung answered.

⛔ **Still no `usageRefresh`.** That field means *drive a command into a PTY session*, which is not
what this is. This is a local subprocess like `claude auth status --json`, and it belongs in
`probeQuota` itself.

⚠️ Measured on a window at **0% used**, `resetsAt` tracked the moment of the call — consistent with a
rolling 30-day window that has not started. Not yet observed on a window with usage in it.

⭐ **Quota is not withheld from free accounts, and the window ids must not assume a plan.** Measured on
a free account: `plan_type: "free"`, **one 30-day window** (`window_minutes: 43200`) and a null
`secondary`. A paid plan puts a five-hour window in `primary` instead. Since `reserve.ts` and
`controller.ts` gate on the id `5h`, reading `primary` as *the five-hour window* would be right on
one plan and silently wrong on the other — so the id is derived from `window_minutes` and never from
the slot. `used_percent` is the server's snapshot **at request time**, so it lags by one turn.

⭐ This also answers **R10**: the rollout carries `total_token_usage` and `last_token_usage` with
`cached_input_tokens`, so per-turn metering off the rollout is available. `metering` stays `'stream'`
until that path is written and measured.

⛔ **R12 is closed, and the answer is no** (2026-08-30, codex-cli 0.151.0). Headless compaction is not
reachable on `codex exec` and the obstacle is not compaction — it is that **there is no second input**.
`exec` reads its prompt from stdin **to EOF**, runs that one turn and exits, so `/compact` has nowhere
to go: no live session, no open pipe, nothing to send it on. `manualCompact` stays `false` for a
reason stronger than the conservative default it was set to, and no cache-clock move applies to a
codex session. ⚠️ This would change if the adapter moved to `codex app-server`, which holds a real
JSON-RPC conversation; that is a rewrite, not a flag.

### What else was tried, and why it is not what we use

Kept because the vendor surface moves, and each of these becomes right the moment one fact changes.

| Path | Verdict | Revisit when |
|---|---|---|
| `claude -p /usage` | ⛔ **Spends a turn** and answers in prose. Measured 2026-08-25; independently corroborated by a third-party tool on this machine, which stored `error: unparsed: Total cost: $0.0000…` — print mode's cost summary, returned instead of a usage report | Print mode starts expanding slash commands client-side |
| `claude auth status --json` | ⛔ No usage fields. Keys are `loggedIn, authMethod, apiProvider, email, orgId, orgName, subscriptionType` | A usage field appears |
| A `claude usage` subcommand | ⛔ Does not exist. Subcommands on 2.1.223: agents, auth, auto-mode, doctor, gateway, import, install, mcp, plugin, project, setup-token, ultrareview, update | One is added — this is the cleanest possible answer if it ever ships |
| **statusLine hook `rate_limits`** | ⚠️ **Documented since 2.1.80, measured absent on 2.1.223.** A capture on this machine returned `session_id, transcript_path, cwd, effort, model, workspace, version, output_style, cost, context_window, exceeds_200k_tokens, fast_mode, thinking` — no `rate_limits`. ⚠️ The hook fired once at session start with `current_usage: null`, so it may populate after a turn; that was not tested, because testing it costs one | Re-test after a turn has run, or on a newer CLI. **This would be the best option of all** — push-based, per-turn, no process to start |
| Read `.credentials.json`, call `api.anthropic.com` | ⛔ **Closed to this project on principle, not difficulty.** It is what every community monitor does and it works. But this app never reads, stores, copies or proxies a credential — the same rule that makes D7 wrap `gh` instead of holding a GitHub token | Never, while that invariant stands |
| A community usage package | ⛔ Rejected on D7: external services are wrapped, never vendored, and an undocumented internal surface behind a third-party wrapper is two things that can go stale rather than one | Never |

**Still owed:** `tokens_per_percent` (R2), which turns a percentage into the token count every gate
actually needs. ⭐ R3 — *what refreshes `cachedUsageUtilization`* — is **closed** by the above, and so
is R9, on Antigravity, in the section before it.

### ⛔ The reserve is a gate, not a routing input

Until R2 lands, `remainingTokens` is null on every Claude account, so the reserve's token rung can
only answer `ok` (this worker holds no live sessions) or `unknown` (it holds some) — the `at_risk`
verdicts a real fleet sees today all come from the percentage rung above. Feeding that into scheduler
scoring at 0.5 therefore did not express caution — it expressed **"penalise any worker that has a
session"**, at a weight several times larger than every term that actually compares candidates.
Measured 2026-08-27: an account nobody had ever signed in to won a dispatch over two working ones on
that term alone, and failed in 0s.

The verdict is still `unknown` and the watchdog still reads it. What changed is that scoring moves
only on evidence somebody checked: `at_risk` (a real number, below a real requirement) or a live
rate-limit status the vendor sent. ⚠️ Worth remembering when R2 does land — a term that is uniform
across the fleet contributes nothing, and one that varies as a side effect of unrelated state is a
bias, not a measurement.

### Quota is a slope, and for three days it was nothing at all (2026-08-30)

Making `quotaRisk` move only on checked evidence was right, and it left the term with **no reachable
trigger**. `at_risk` needs `remainingTokens` in tokens, which is R2; the live rate-limit status only
turns after the vendor has already refused. So the term read `0` for every worker on every tick, at
weight 0.908 — and quota stopped being a routing input entirely.

⛔ **What that cost, measured.** Four consecutive routing consults (t39–t42) were spent choosing
between `-0.120` and `-0.120`. The two accounts were not alike: one stood at 64% of its weekly, the
other at 98% of a five-hour pool. Every answer reasoned from the worker *labels* — *"since Claude is
the assistant running this controller"* — because the numbers gave the controller nothing else. A
real turn, four times, to break a tie the scorer had manufactured.

The fix is a slope under the existing evidence, not a replacement for it:

```
windowRisk(percent) = clamp01((percent − 50) / (92 − 50))
quotaRisk           = max(vendor evidence, windowRisk(trusted window))
```

| | |
|---|---|
| Below **50%** | 0. ⛔ A term rising from the first token is a *load balancer*, not a risk model, and it would fight the warm-session preference this whole model exists to express |
| 50% → 92% | linear |
| At **92%** | exactly 1.0 — ⭐ the same percentage at which the hard gate excludes the candidate, so the slope hands over to the cliff **with no step in between**. A worker is never simultaneously nearly-excluded and cheap |
| No trusted reading | 0. ⛔ Unknown is not bad news, and a stale percentage may not move a score |
| Vendor says `at_risk` or not `allowed` | 1.0, overriding the slope |

⚠️ **It reads the window the gate read**, hoisted out of the gate rather than looked up again — on a
two-pool account (Antigravity) the answer depends on which pool the task's model draws from, and a
fleet whose hard cut and soft preference disagree about that is worse than either alone.

⭐ On the t39–t42 readings this separates the candidates by `(1.00 − 0.33) × 0.908 = 0.61`, six times
`ROUTE_EPSILON`. **No consult would have been asked at all.**

#### The cliff a person may step over (2026-09-01)

⛔ **The 92% cut is a caution of ours, not the vendor declining anything** — every turn up to it was
served. It is also a cliff with nothing on the far side, and a task **pinned** to one account cannot
route around it by definition: t71 waited 2h29m at exactly 92% for a gate its operator did not agree
with. `task.overrideQuota` lets a person say *"8% is more than this needs"*, dated from the reset of
the window it overrules so the permission expires with its reason.

| lifted | untouched |
|---|---|
| the 92% dispatch cut | a disabled, signed-out, human-occupied or quarantined account |
| the 95% mid-run preempt — ⛔ dispatching under an override and preempting three points later buys a cold start and nothing else | the worker's concurrency cap |
| | the **window boundary** preempt, which is a clock and not a percentage |
| | a turn the vendor **refused**. There is no setting that makes a refused turn a served one |
| | `windowRisk` itself — ⚠️ an overridden account must still score last, or a fleet with a free account elsewhere would start feeding the full one |

### Every score shows its own derivation (2026-08-30)

⛔ **A number nobody can check is a number nobody can correct.** The dead `quotaRisk` term survived
because a rendered `-0.120` looks exactly like a working measurement. Routing decisions now publish
the arithmetic — on the consult's `detail`, which the Controller panel renders under *Score
derivation*, and in the daemon log on *every* dispatch, not only the consulted ones:

- a legend, printed once, stating that **higher wins**, that the scale is **linear and unitless**
  (nothing logarithmic, normalised or capped), and that gaps at or below `ROUTE_EPSILON` mean nothing;
- each weight beside the arithmetic that produced it — `1.249 = 0.8 + 2.0×cost − 0.7×velocity` — and
  the objective vector it came from, with where to change it;
- per candidate, every term's value, weight, contribution and **the basis for that value** in words.

⚠️ **Zero rows are printed, not dropped.** A table showing only what contributed reads as *"the rest
were weighed and found small"*; `quotaRisk` was not small, it was unmeasurable, and only its basis
line could say so.

⛔ **The derivation is for a person; the controller is shown the totals** (2026-08-30). The legend
and the term tables are how a decision gets *checked*, and they are not what a controller needs to
pick between two ids — sending them charged every routing consult for the lot. `routeQuestion` now
carries each candidate's total, one line saying the scale is linear and higher wins, and one line
per candidate naming the live terms with their contributions and the dead ones by name
(`briefScore`); `routeDetail` builds the full legend and tables from **the same breakdown**, and it
is stored on the consult rather than sent. The t39–t42 fix survives — two equal numbers still come
with something to reason from — at roughly a third of the prompt.

⛔ **The published formulas cannot drift from the code.** `WEIGHT_FORMULAS` sits beside `weights()`,
and `cost.test.ts` parses each string and evaluates it against the real weight across all four
presets — so editing the arithmetic without editing the derivation fails the suite rather than
somebody's reading of a routing decision.

### The compaction reserve

The last row creates a **point of no return**. If a worker reaches true exhaustion holding a large
session, that context is stranded — it cannot be compacted, cannot continue, and its cache expires
long before the window resets. The loss is `2.0·C` on the far side.

So this is a **standing gate**, checked continuously and not merely at assignment:

```
worker.remaining  >=  Σ over live sessions on that worker of (0.1·C + 5·S)
```

Running out of room to *finish* a task is recoverable. Running out of room to *save* one is not.

⭐ **Two rungs, because the first one has never been able to answer** (2026-08-31, t73). The formula
above needs `remaining` in tokens, which needs the `tokens_per_percent` conversion of R2 — and on
this install the `calibration` table is empty, so `reserveState` answered `unknown` for every worker
holding a session and the clock's move 5 had never once fired. The second rung is the percentage
itself: at or above `WINDOW_HIGH_WATER` (92%, the same number the dispatch gate refuses on) the
worker's live sessions are `at_risk`, per metered pool, on a reading that is neither stale nor from a
window that has already reset.

⚠️ **The percentage is not converted into tokens anywhere.** It cannot say whether what is left
covers what saving costs; `remainingTokens` stays null and says which rung it is on. It says the one
thing a percentage can: this account is at the mark where the fleet has already stopped sending it
work, so what it still holds should be saved while there is window left to pay for saving it. R2 is
still owed for the arithmetic above.

⚠️ **A full window stays full for hours**, unlike a token breach that one compaction resolves — so
move 5 also requires the context to be past the break-even *and* to have grown since the last
compaction. Without that second half the clock would re-send `/compact` every four minutes until the
window reset, which is the 2026-08-26 repeat with a new trigger.

### Percent → tokens

`/usage` reports percent; every gate needs tokens, and no vendor publishes the conversion. Learn it:
fit a rolling `tokens_per_percent` per `(worker, model, tokenizer_generation)` from exact transcript
token counts against periodic percentages. **Sample only while exactly one session is active on that
worker.** Attribution of tokens *to a task* is always exact from that session's own transcript; only
the calibration needs isolation.

## 6. Metering correctness

Three traps, all avoidable — the transcript carries what is needed.

1. **Sum `usage.iterations[]`, not the top-level counts.** A compaction's own sampling iteration is
   *excluded* from the top-level `input_tokens`. A naive reader undercounts exactly the events that
   matter most. Confirmed present in local transcripts, 2026-08-24.
2. **Read `cache_creation.ephemeral_1h_input_tokens` separately from `_5m`** — they price at 2.0× and
   1.25×. Claude Code writes 1h today; do not assume it always will.
3. **Never compare token counts across tokenizer generations** (see §2).

Fields confirmed available per assistant record: `usage.iterations[]`,
`cache_creation.{ephemeral_1h,ephemeral_5m}_input_tokens`, `cache_read_input_tokens`,
`output_tokens_details.thinking_tokens`, plus `effort`, `gitBranch`, `requestId`, `cwd`, `version`.

## 7. Cross-account continuation

**Measured 2026-08-24:** a transcript copied into another account's config root **is** discovered by
`--resume` — the error moves from *No conversation found with session ID* to *Not logged in*.

**But the cache does not travel** (§1: scope is per workspace within an organization). So:

| Route for a ~300k context | Billed-equivalent |
|---|---|
| Raw transplant to account B | **~600k** |
| Compact on A while warm, then transplant `P ≈ 12k` | **~82k** |
| HANDOFF.md, successor starts cold | **~40–80k** |

⛔ **Never transplant a raw transcript.** It looks like a free lunch and costs ~7×. Shrink first, move
second. Both routes must exist regardless, because not every agent has `/compact`.

*Not yet measured:* a second account actually completing a resumed turn.

## 8. Cost models are data, not code

Anthropic prices a **multiplier on a TTL**. Google Vertex prices context caching partly as **storage
over time**, and distinguishes implicit from explicit caching — a structurally different formula, not
a different constant. All of them move.

So no pricing arithmetic is written inline. `costmodels/*.json` are versioned files carrying
`effective_from`, and the scheduler asks the loaded model object:

```
costOfKeepalive(session)   costOfCompact(session)   costOfColdStart(tokens)   cacheExpiryFor(session)
```

`effective_from` is load-bearing: historical runs stay priced by the model in force at the time, so a
price change does not silently rewrite the estimator's training data.

## 9. Auto mode's classifier — an unmeasured cost

Claude Code's `auto` mode runs a second model (Claude Sonnet 5 by default) over each non-read action
before it executes. The docs state those calls **count toward token usage on Enterprise plans and on
API / Bedrock / Vertex / Foundry accounts**, and say nothing about Pro/Max/Team.

⛔ **Silence is not "free".** Multi Agent Controller defaults every Claude worker to `auto` (see the plan §9.1), so
if the classifier bills on a subscription it is a per-action tax on every scheduled run, and the
percent→token calibration in §5 would absorb it as noise rather than name it.

Bounded before it is measured: reads and working-directory edits skip the classifier, and a sandbox
network verdict is reused per host and port — so the cost tracks *shell and network calls*, not turns.

**Measure at M3**, the same task run twice on an idle worker under `--permission-mode auto` and
`--permission-mode default`, comparing `/usage` deltas. Until then, no gate may assume it is zero.

*Source: Claude docs, "Choose a permission mode" → Cost and latency, read 2026-08-25.*

---

## 10. What M3 can and cannot do with all this

Implemented: the cache clock's six moves, the compaction reserve as a standing gate, the objective
vector in its two consumers, an estimator over completed runs, preemption at a window boundary, and
watchdogs for stalls and runaways.

⚠️ **But be precise about what is live.** The reserve's *token* gate needs `remaining` in tokens,
which needs a fresh percentage **and** a learned `tokens_per_percent`; that conversion is still R2, so
that rung still answers **`unknown`** on a real worker and the code says so everywhere it surfaces.
⭐ Since 2026-08-31 the reserve is load-bearing anyway, on the percentage rung: at the 92% high-water
mark a worker's live sessions are `at_risk` and the clock compacts them. That was the difference
between a *reporting* gate and one that acts, and it is why `/compact` now runs at all.

What does work without any of that: the cache clock (context size and the TTL are both exact from the
transcript), preemption (the reset time is exact from the live rate-limit record), and the estimator
(runs are exact). Those are the three that matter most, and none of them depends on a percentage.
⚠️ *Exact* is not the same as *meaningful* — see below.

### Duration is agent time, not wall-clock (2026-09-01)

A run's tokens are exact. Its **duration** was not, and until now the only duration anybody could
read was `lastRunEnded - firstRun` — the span a task *existed inside*. That number counts every
minute the task spent queued behind a busy workspace pool, parked on a quota window, waiting for a
worker to come free, and — the large one — waiting for a person to answer a question. `ask_human`
holds the calling tool open until somebody answers or the prompt cache expires, so a task whose
agent worked four minutes and whose question was answered the next morning reported **fifteen
hours**. The two numbers do not differ by a correction factor; they differ without limit, and any
per-agent or per-model duration read off the wall-clock is a measurement of the operator's evening.

`daemon/activetime.ts` computes **active time**: the union of intervals in which a run was open and
nothing was waiting on a person. It excludes everything between runs, and the stretches *inside* a
run covered by an open question or an escalated approval — the half that a plain
`sum(ended_at - started_at)` silently keeps.

It deliberately **includes** dispatch, routing, spawn, workspace preparation and the CLI's own
start-up, because `startRun` is written at dispatch. That is time the fleet spent on this task, and
it is what a cost model wants.

⚠️ **It cannot see a wait that never became a row**: a vendor-side rate limit inside a turn, a
`run_command` blocked on the network, a controller consult. Those read as active, which is the
honest answer — the fleet *was* holding the session open — but it means active time is an upper
bound on work, not an exact one.

⛔ **Nothing routes or estimates on it yet.** `estimateTask` still medians tokens, and this is the
instrument that has to exist before a duration-aware estimate can be argued for at all. Two facts
it makes newly available: `Task.activeMs` per task, and `Run.blockedMs` per attempt — both derived
from `questions` and `approvals` rather than stamped, so a question answered an hour later corrects
the number instead of leaving a stale copy. ⚠️ Every run that predates this reads correctly, because
nothing was stored: the rows it derives from were already there.

### The estimator counts tokens, and tokens are not cost (2026-08-28)

`estimateTask` medians `input + output + cache_read + cache_write` over completed runs, and
`overrunFactor` divides a live run's same sum by it. Both numbers are exact. The ratio is not what it
looks like.

Measured on this machine, 2026-08-28, from the `runs` table — every completed or preempted run on
record, claude-code on the `stream` transport:

| run | total | input | output | cache read | cache write | cache read % |
|---|---|---|---|---|---|---|
| 08-27 03:35 | 524,758 | 22 | 6,840 | 483,490 | 34,406 | 92.1% |
| 08-27 04:39 | 1,193,058 | 56 | 7,702 | 1,156,672 | 28,628 | 97.0% |
| 08-27 05:26 | 2,146,654 | 78 | 9,599 | 2,092,524 | 44,453 | 97.5% |
| 08-28 01:40 | 4,870,842 | 130 | 28,645 | 4,759,779 | 82,288 | 97.7% |
| 08-28 02:30 | 6,271,722 | 154 | 27,338 | 6,155,066 | 89,164 | 98.1% |

⛔ **Cache reads are 92–98% of every total, and the share rises with the length of the run.** Each
turn re-reads the whole prefix, so the sum grows with turn count against a growing prefix — roughly
quadratically — while output, the thing the agent actually produced, stays in the tens of thousands.
A run is therefore called a runaway for being *long*, not for being *wasteful*, and cache reads are
billed at a fraction of input (§1).

⚠️ **And the estimate cannot correct itself.** `completedRunTotals` filters `outcome = 'completed'`,
so a preempted run contributes nothing. The median above stayed at **1,557,974** — the middle of the
four completed runs — while the two runs that were actually stopped were 3–4× it. Stop enough long
runs and the estimator's picture of "work like this" gets *shorter*, not more accurate.

This is why `settings.autoRunawayStop` ships **off** and `settings.autoPreempt` ships **on**: a
window reset time is measured, an overrun factor in raw tokens is inferred from a metric that does
not mean what the gate needs it to mean.

### Both halves of that were fixed on 2026-08-30, and the switch still ships off

`overrunFactor` now divides **priced** cost by an estimate **for the run's own agent and model**.
`CostModel.priceRun` is where the arithmetic lives, per §8.

The second half is the larger one. Measured on this install, 2026-08-30, 73 completed runs, median
**total tokens** per run by the run's `(adapter, model)`:

| adapter / model | completed runs | median total | median priced | warm starts |
|---|---:|---:|---:|---:|
| antigravity-cli / gemini-3.7-flash-medium | 35 | 12,477,352 | 2,033,366 | 7 |
| antigravity-cli / (model unrecorded) | 17 | 8,630,903 | 1,431,917 | 3 |
| antigravity-cli / claude-sonnet-4-6 | 1 | 7,656,282 | 1,078,598 | 0 |
| claude-code / claude-opus-5 | 3 | 2,672,121 | 305,605 | 1 |
| openai-compatible / (unrecorded) | 3 | 322,805 | 61,490 | 0 |
| claude-code / claude-sonnet-5 | 14 | 153,091 | 21,948 | 8 |

⛔ **81x between the two best-sampled keys, and 93x priced — so pricing does not explain it.** The old
single median (2,921,371 raw) sat between the humps and described neither: every Antigravity run
started life at ~4x its estimate before doing anything unusual, against a watchdog that fires at 3x,
while a Sonnet run could not reach 3x by being genuinely wasteful. `estimateTask` now answers
`size(task) × factor(adapter, model)`; running the new estimator over that same snapshot gives:

| key | n | factor | estimate for one task (raw / priced) |
|---|---:|---:|---|
| antigravity-cli / gemini-3.7-flash-medium | 35 | ×2.96 | 8,651,360 / 1,403,769 |
| claude-code / claude-opus-5 | 3 | ×0.79 | 2,316,886 / 375,938 |
| claude-code / claude-sonnet-5 | 14 | ×0.10 | 286,153 / 46,431 |
| *fleet-neutral (what every one of them used to get)* | 73 | ×1 | 2,921,371 / 474,022 |

⚠️ **Three things about those factors are load-bearing, and all three are in `estimator.ts`.**
Factors are shrunk toward 1 in **log space** by `n/(n+5)` — linear shrinkage flattened the measured
80x spread to 5x, because ×8 and ×⅛ are the same distance from 1 only multiplicatively. They are
measured against the fleet's **geometric mean**, not its median: run counts are lopsided (35 against
14) and a pooled median lands inside whichever hump is busier. And warmth is divided out first
(measured ×0.92 warm over 19 runs, ×1.21 cold over 47), because 8 of Sonnet's 14 completed runs were
warm against 1 of Opus's 3.

⛔ **What none of this measures: zero of the 54 tasks with runs has ever run on two different keys.**
Nothing in this data separates *that agent is expensive* from *that agent gets the big tasks*. The
shrinkage and the published sample counts are the honest response to that, not a fix for it.

⚠️ Google and OpenAI publish no cache multipliers (§12), so their runs are priced with Anthropic's
standing in — `priceRun` marks those results `assumed` and the Cost screen says so on the row. And
the estimate still cannot correct itself: the sample query reads `outcome = 'completed'` as it always
did, so a preempted run contributes nothing and stopping long runs makes the picture of "work like
this" *shorter*, not more accurate. Turning `autoRunawayStop` on remains the operator's call.

---

## 11. Changing model or effort inside a conversation

A model and an effort level are chosen at launch and read once. Changing either **while a
conversation is open** is a different act from choosing one for a new task, and it costs something the
UI has to say out loud before the operator commits.

Anthropic publishes the invalidation as a three-tier hierarchy. Two rows matter here (`Yes` = that
cache survives the change):

| Change mid-conversation | Tools cache | System cache | Messages cache |
|---|:--:|:--:|:--:|
| **Model switch** | No | No | No |
| **Effort / thinking change** | model-specific | model-specific | **No** |
| A normal turn (message content) | Yes | Yes | No |

⛔ **A model switch is a full rebuild, and there is no escape hatch.** Caches are *scoped to one
model*, so the new model does not inherit a degraded cache — it inherits nothing. In this repo's own
units (§1) the next turn pays a cold rebuild at **2.0·C** where it would have paid a warm read at
**0.1·C**. That is the number the task pane shows, against the session's live `contextTokens`.

⚠️ **An effort change is cheaper and still not free.** It always drops the message history, and on
some models takes tools and system with it. Worth doing when the work changed character; not worth
doing to shave a level off a run already in flight.

⭐ **Which is why both controls apply to the next run and never to a live session.** The alternative —
sending `/model` or `/effort` into a running agent — spends the cache immediately and mid-thought,
and the operator who wanted "think harder from here" gets a bill for the conversation so far. The
same argument `sharing.ts` makes for never moving an agent between worktrees mid-run.

⚠️ **Setting a model's *default* effort explicitly is free.** Anthropic states that passing the
default is equivalent to omitting it, so a per-worker default that matches the model's own default
costs nothing to send — which is what makes an always-sent default safe.

⛔ **Unverified for Antigravity.** The hierarchy above is Anthropic's, and this fleet applies it to
Claude Code only. agy reports `cache_read_tokens: 0` on every turn measured to date (2026-08-28), so
there may be no cache there to lose — the honest position is that nobody has checked, and the pane
says nothing about cache cost on that provider rather than guessing.

## 12. Owed

**Owed:** Vertex and Antigravity cache pricing numbers. The pricing page truncated on two fetch
attempts on 2026-08-24 and the numbers were deliberately **not guessed**. The schema has the slot;
fill it when the adapter is built.

**Owed:** the far side of a codex resume. `codex exec resume <thread_id>` is measured as far as an
unauthenticated machine can take it (§1b, and `openai-compatible.ts`): the argv parses, `-` reads the
prompt from stdin, and a bad id is refused with `no rollout found for thread id`. What needs a
signed-in account is whether a *successful* resume re-emits `thread.started` carrying the **same**
`thread_id`. If codex mints a fresh id per resume, this fleet accumulates one session row per turn
and stops finding the conversation on the next dispatch — degrading to the cold starts it did before,
not to a wrong answer, which is why it shipped ahead of the measurement.

**Owed:** a measured reuse rate for a Zero Data Retention org, whose codex prefixes live *"5 to 10
minutes of inactivity"* rather than 30 (§1b). The cost model would be optimistic for such a fleet.
