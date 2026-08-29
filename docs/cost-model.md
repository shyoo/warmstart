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

⚠️ It only exists on the `stream` transport. A session hosted in a PTY for a human to watch emits
nothing of the sort, which is one more reason scheduled work does not run that way.

**Wired at M3.** `stream.ts` parses it, `quota.ts` records it, and `windowResetsAt()` prefers it over
the config cache — which is what makes preemption possible at all, since a reset time from a window
that has already turned over is worse than none.

**Still owed:** whether `status` passes through an intermediate value before `rejected`. If it does,
it is an early warning; if it does not, it is an obituary, and preemption can only ever be driven by
the clock. Watch a window fill to find out.

### What this costs the design

There is **no free live quota probe** on this CLI. That is not a gap to route around quietly, because
two things downstream depend on knowing how much window is left: the compaction reserve below, and
the preemption deadline in the plan §8.7.

So the probe is a **ladder, and its rung is always reported**:

| Rung | Source | Trust |
|---|---|---|
| 1 | `cachedUsageUtilization` with a fresh `fetchedAtMs` | current |
| 2 | the same, stale | **reported as *unknown*, with its age** — never as a number |
| 3 | nothing | unknown; degrade conservatively. ⚠️ Two distinct causes, and the UI separates them: **never probed**, and **probed but the account has no usage cache yet** — the CLI writes `cachedUsageUtilization` only after real work, so a freshly signed-in worker reports nothing until it has been used once |

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

`refreshUsage()` in `quota.ts` does this on a **30-minute** floor (`REFRESH_AFTER_MS`, deliberately
longer than the 15-minute `STALE_AFTER_MS`) and on the Probe button. It is free of tokens, not of
everything: it starts a real process for ~30s, so at most one worker is refreshed per sweep. ⛔ Never
in a scheduler tick. The command is declared per adapter as `usageRefresh`, never branched on an
adapter name; only `claude-code` declares one today.

### ⛔ An account that cannot authenticate is not asked again (2026-08-27)

Rung 0 is free in tokens and **not** free in processes: it opens a real interactive session and types
into it. So the background sweep skips any worker a dispatch has already proved work dies on
(`health.state === 'suspect'`). Before this, a lapsed subscription meant a CLI spawned every thirty
minutes, forever, to watch it fail to authenticate - and the reading stayed `unknown` either way.

⚠️ The *background* sweep only. Pressing Probe still refreshes: it is one of the two things that lift
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

Until R2 lands, `remainingTokens` is null on every Claude account, so `reserveState` can only answer
`ok` (this worker holds no live sessions) or `unknown` (it holds some). Feeding that into scheduler
scoring at 0.5 therefore did not express caution — it expressed **"penalise any worker that has a
session"**, at a weight several times larger than every term that actually compares candidates.
Measured 2026-08-27: an account nobody had ever signed in to won a dispatch over two working ones on
that term alone, and failed in 0s.

The verdict is still `unknown` and the watchdog still reads it. What changed is that scoring moves
only on evidence somebody checked: `at_risk` (a real number, below a real requirement) or a live
rate-limit status the vendor sent. ⚠️ Worth remembering when R2 does land — a term that is uniform
across the fleet contributes nothing, and one that varies as a side effect of unrelated state is a
bias, not a measurement.

### The compaction reserve

The last row creates a **point of no return**. If a worker reaches true exhaustion holding a large
session, that context is stranded — it cannot be compacted, cannot continue, and its cache expires
long before the window resets. The loss is `2.0·C` on the far side.

So this is a **standing gate**, checked continuously and not merely at assignment:

```
worker.remaining  >=  Σ over live sessions on that worker of (0.1·C + 5·S)
```

Running out of room to *finish* a task is recoverable. Running out of room to *save* one is not.

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

⚠️ **But be precise about what is live.** The reserve gate needs `remaining` in *tokens*, which needs
a fresh percentage **and** a learned `tokens_per_percent`. There is no free fresh percentage (§5), so
on a real worker today `reserveState()` returns **`unknown`**, not `ok`. That is the honest answer and
the code says so everywhere it surfaces — but it means the reserve is a *reporting* gate right now,
not a load-bearing one. It becomes load-bearing the moment R2 or R3 lands.

What does work without any of that: the cache clock (context size and the TTL are both exact from the
transcript), preemption (the reset time is exact from the live rate-limit record), and the estimator
(runs are exact). Those are the three that matter most, and none of them depends on a percentage.
⚠️ *Exact* is not the same as *meaningful* — see below.

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
not mean what the gate needs it to mean. Turning the switch on is the operator's call until the
factor is computed in cost — the cost model already prices cache reads separately, so the arithmetic
exists; nothing has wired it into `overrunFactor` yet.

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
