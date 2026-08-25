# Cost model — the measured facts

**This is the load-bearing knowledge in agentyard.** Every scheduling decision reduces to arithmetic
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

Source: 118 real local compactions (precompact `DESIGN.md` §5) plus transcripts sampled 2026-08-24.

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
| ⛔ **`claude -p /usage` is NOT free and does NOT report usage** | The slash command is taken as a **prompt**. It spends a real assistant turn and answers in prose. A poller built on it bills every account on every interval | measured 2026-08-25, CLI 2.1.223 — **corrects the earlier claim from precompact `usage.py`** |
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

**Owed:** wire this into the quota ladder as a rung above the config cache (M3), and check whether
`status` moves through an intermediate value before `rejected` - that is what would make it an early
warning rather than an obituary.

### What this costs the design

There is **no free live quota probe** on this CLI. That is not a gap to route around quietly, because
two things downstream depend on knowing how much window is left: the compaction reserve below, and
the preemption deadline in the plan §8.7.

So the probe is a **ladder, and its rung is always reported**:

| Rung | Source | Trust |
|---|---|---|
| 1 | `cachedUsageUtilization` with a fresh `fetchedAtMs` | current |
| 2 | the same, stale | **reported as *unknown*, with its age** — never as a number |
| 3 | nothing | unknown; degrade conservatively |

⛔ **A stale percentage rendered as current is worse than no percentage.** It makes the compaction
reserve look satisfied when it is not, and that failure strands context — the one loss the whole cost
model exists to prevent. `quota.ts` carries `stale` on every snapshot for exactly this reason, and
the fleet strip renders "quota unknown · last seen 19d ago" rather than "12%".

**Still owed:** a way to refresh that cache without spending a turn, and — failing that — a
token-accrual estimate built from the transcripts agentyard already meters exactly, calibrated against
whatever percentage readings do arrive. M3.

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

⛔ **Silence is not "free".** agentyard defaults every Claude worker to `auto` (see the plan §9.1), so
if the classifier bills on a subscription it is a per-action tax on every scheduled run, and the
percent→token calibration in §5 would absorb it as noise rather than name it.

Bounded before it is measured: reads and working-directory edits skip the classifier, and a sandbox
network verdict is reused per host and port — so the cost tracks *shell and network calls*, not turns.

**Measure at M3**, the same task run twice on an idle worker under `--permission-mode auto` and
`--permission-mode default`, comparing `/usage` deltas. Until then, no gate may assume it is zero.

*Source: Claude docs, "Choose a permission mode" → Cost and latency, read 2026-08-25.*

---

## 10. Owed

**Owed:** Vertex and Antigravity cache pricing numbers. The pricing page truncated on two fetch
attempts on 2026-08-24 and the numbers were deliberately **not guessed**. The schema has the slot;
fill it when the adapter is built.
