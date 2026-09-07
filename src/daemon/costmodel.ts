import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { paths } from './paths.js'
import { log } from './log.js'
import type { CostModelSummary, SpendMeter } from '@shared/protocol.js'
import builtinAnthropic from '../../costmodels/anthropic.subscription.2026-08.json' with { type: 'json' }
import builtinGoogle from '../../costmodels/google.antigravity.2026-08.json' with { type: 'json' }
import builtinOpenai from '../../costmodels/openai.codex.2026-08.json' with { type: 'json' }
import builtinLocal from '../../costmodels/local.llm.2026-09.json' with { type: 'json' }
import builtinMuse from '../../costmodels/meta.muse.2026-09.json' with { type: 'json' }

/**
 * Cost models are data, never code.
 *
 * ⛔ No pricing arithmetic is written anywhere else. Anthropic prices a multiplier on a TTL; Google
 * Vertex prices context caching partly as storage over time. Those are different formulas, not
 * different constants, and all of them move. Everything downstream asks this object questions.
 *
 * Built early on purpose: building it late is how inline arithmetic gets written. docs/cost-model.md §8.
 */

export interface CostModelFile {
  id: string
  provider: string
  channel?: string
  schema_version: number
  effective_from: string
  cache: {
    /** ⛔ `unpriced` is a real state, not a missing value. See CostModel.canPriceCache(). */
    kind: string
    read_multiplier: number | null
    read_refreshes_ttl: boolean
    ttl_measured_from: 'request_start' | 'response_end'
    /**
     * ⚠️ `write_multiplier` is nullable, and null is a different statement from a small number: the
     * prefix has a **lifetime** here, but nobody has published what rebuilding it costs. A provider
     * can have one without the other — OpenAI caches server-side and prices nothing a client can
     * steer — and `costOfColdStart` returns null rather than inventing the multiplier.
     */
    ttls: Array<{ id: string; seconds: number; write_multiplier: number | null }>
    default_ttl: string | null
    max_breakpoints?: number
    scope?: string
    min_cacheable_tokens?: Record<string, number>
  }
  compaction: {
    /** Absent means true, so the Anthropic file did not have to be rewritten to add this. */
    available?: boolean
    summary_output_tokens: number
    post_context_tokens: number
    duration_ms: number
    breakeven_context_tokens: number
    min_tokens_since_compact: number
  }
  models?: Array<{
    id: string
    /**
     * ⚠️ Nullable, like the two price fields beside it. A model whose window nobody has read is a
     * missing denominator, not a broken model — `contextWindowFor` already returns `null` for it and
     * the UI shows no percentage. Copying a plausible number from a sibling model would be a guess
     * wearing a measurement's clothes, which is the one thing this file may not contain.
     */
    context_window: number | null
    input_per_mtok: number | null
    output_per_mtok: number | null
    tokenizer: string
    context_awareness: boolean
    effort_levels: string[]
    /**
     * Which separately metered quota pool this model draws on.
     *
     * ⭐ Only where the vendor meters more than one. Antigravity bills Gemini apart from Claude/GPT,
     * so an account can be empty for one and untouched for the other.
     *
     * ⚠️ Matched against a window's `group` by **containment, not equality**: the group id is derived
     * from the `/usage` panel's own heading, and `CLAUDE & GPT`, `CLAUDE AND GPT` and `CLAUDE/GPT`
     * slugify to three different strings. `claude` and `gpt` are substrings of all three; `gemini` is
     * a substring of none of them.
     */
    pool?: string
  }>
  quota?: unknown
  /**
   * What a subscription costs, and which of its windows the money is divided over.
   *
   * ⛔ **Absent is a real state.** A cost model with no `plans` block prices no run in money at all,
   * and every run on it renders `n/a`. That is different from `priced: false`, which says the plan
   * is known and has no price to divide (free, self-hosted) — both render `n/a`, but only the second
   * one can name the plan while doing it.
   */
  plans?: PlansBlock
}

/** The subscription catalogue for one provider. See docs/cost-model.md §13. */
export interface PlansBlock {
  /** Whole-provider off switch — `local.llm` has no subscription of any kind. */
  priced?: boolean
  /**
   * The window the subscription's money is divided over, and how to find it.
   *
   * ⛔ `match` is matched against the window ids the **adapter emits**, never against this file's
   * own `quota.windows`. Measured 2026-09-02: claude-code emits `session`/`weekly_all` while its
   * `quota.windows` declares `5h`/`7d`. Equality first, then containment, in the order written.
   */
  billing_window: { days: number; match: string[]; pooled?: boolean } | null
  /**
   * How one subscription is charged across separately metered pools, keyed by the pool a *model*
   * declares. ⚠️ Shares sum to 1, which is what stops a week that fills every pool from reporting
   * more than one week of subscription.
   */
  pool_shares?: Record<string, number>
  /** Where a run with no other evidence lands. ⚠️ Never a free plan — see the codex file. */
  default_plan: string
  catalog: PlanEntry[]
}

export interface PlanEntry {
  id: string
  label: string
  monthly_usd: number
  /** Absent means true. `false` is the n/a state, and is not `monthly_usd: 0`. */
  priced?: boolean
  /** Matched, case-folded, against the vendor's own `WorkerIdentity.subscriptionType`. */
  match: string[]
  /**
   * Matched against the window ids a run actually carried.
   *
   * ⭐ Beats `match` wherever a run has its own reading: the shape is evidence from the run, and the
   * identity string is a belief about *now*. This is what splits Codex's free era from its paid one.
   */
  detect?: { windows_all_of?: string[]; windows_none_of?: string[] }
}

/** A plan, resolved, carrying how it was resolved. AGENTS.md: every cost belief carries its basis. */
export interface PlanRef {
  id: string
  label: string
  monthlyUsd: number
  priced: boolean
  source: PlanSource
}

export type PlanSource = 'window_shape' | 'identity' | 'neighbour' | 'default' | 'stored'

/** One billing window selected for a run, and the share of the subscription it carries. */
export interface BillingWindowRef {
  id: string
  days: number
  pool: string | null
  /** 1 on a single-pool provider; the pool's slice of the subscription on a pooled one. */
  share: number
}

/** What a caller has to know about a session to have it priced. */
export interface PriceableSession {
  contextTokens: number | null
  model?: string | null
  lastRequestStartedAt?: number | null
}

/** Output is billed at 5x input; costs below are in input-token-equivalents. cost-model.md §3. */
const OUTPUT_MULTIPLE = 5

/**
 * Standing in for a multiplier nobody has published, on the providers that publish none.
 *
 * ⛔ Not a measurement, and `priceRun` says so on every result it uses them for. They are Anthropic's
 * numbers (§1) reused, chosen because they are the only cache multipliers this repo has ever
 * verified. Replace them with a provider's own the day it publishes them — cost-model.md §12 Owed.
 */
const ASSUMED_CACHE_READ = 0.1
const ASSUMED_CACHE_WRITE = 1.25

/**
 * Days in an average month: 365.25 / 12.
 *
 * ⛔ Not 30, and not 4 weeks. The ask said "$20 a month is $5 a week, or slightly less if we have
 * 29+ days per month" — this is that "slightly less", made exact. $20/month over a 7-day window is
 * $4.5996 per full window, so 5% of a week is $0.230.
 */
const DAYS_PER_MONTH = 365.25 / 12

/** The four counters a run (or a turn) records. */
export interface RunUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export class CostModel {
  readonly id: string
  readonly provider: string
  readonly effectiveFrom: string
  readonly source: CostModelSummary['source']
  readonly path: string | null

  constructor(
    private readonly data: CostModelFile,
    source: CostModelSummary['source'],
    path: string | null
  ) {
    this.id = data.id
    this.provider = data.provider
    this.effectiveFrom = data.effective_from
    this.source = source
    this.path = path
  }

  /**
   * Can this provider's cache be *priced and steered* at all?
   *
   * ⛔ The single most important question this class answers, and the reason `unpriced` exists as a
   * state rather than as a missing field. Anthropic sells a write multiplier against a TTL that a
   * read extends, which is a lever: paying `0.1·C` to avoid `2.0·C` later is arithmetic. Google bills
   * cache storage per token-hour, and OpenAI caches server-side with no client-controlled TTL — on
   * neither is there a lever of that shape.
   *
   * When this is false the cache clock declines to spend on keepalive or compaction rather than
   * acting on an invented number. ⚠️ Work still runs, preemption still fires, handoffs still happen.
   * The provider simply does not get an optimisation nobody has measured.
   */
  canPriceCache(): boolean {
    return this.data.cache.kind !== 'unpriced' && typeof this.data.cache.read_multiplier === 'number'
  }

  /** Is compaction a thing this provider can be asked to do? Adapters answer too, via manualCompact. */
  canCompact(): boolean {
    return this.data.compaction.available !== false
  }

  /**
   * One trivial turn that refreshes the TTL. A read refreshes it for free, so this is just the read.
   * ⛔ Returns null where the cache cannot be priced — a caller that treats that as zero would
   * conclude a keepalive is free and do it forever.
   */
  costOfKeepalive(session: PriceableSession): number | null {
    const multiplier = this.data.cache.read_multiplier
    if (multiplier === null || !this.canPriceCache()) return null
    return multiplier * (session.contextTokens ?? 0)
  }

  /** Read the context back, then pay for the summary the model writes. ~= 0.1·C + 28k. */
  costOfCompact(session: PriceableSession): number | null {
    const multiplier = this.data.cache.read_multiplier
    if (multiplier === null || !this.canPriceCache() || !this.canCompact()) return null
    return (
      multiplier * (session.contextTokens ?? 0) +
      OUTPUT_MULTIPLE * this.data.compaction.summary_output_tokens
    )
  }

  /**
   * What a whole run cost, in input-token-equivalents.
   *
   * ⛔ The unit every cross-agent comparison is made in, and the reason it lives here rather than in
   * the estimator: raw metered totals are 92-98% cache reads (cost-model.md §10), billed at a
   * fraction, so summing the four counters compares run *length*, not spend.
   *
   * ⚠️ `assumed` is the honest half. Anthropic sells a read multiplier and this prices against it.
   * Google and OpenAI are `unpriced` here — Google bills cache storage per token-hour, OpenAI caches
   * server-side with no published client multiplier — so their cache columns are priced at
   * `ASSUMED_CACHE_READ`, which is Anthropic's number standing in for one nobody has measured.
   * ⛔ Every consumer must carry `assumed` through to whatever it shows a person. A ratio between an
   * exactly-priced provider and an assumed one moves with that assumption, and a reader who cannot
   * see it has no way to know that.
   */
  priceRun(usage: RunUsage): { tokens: number; assumed: boolean; basis: string } {
    const assumed = !this.canPriceCache()
    const read = assumed ? ASSUMED_CACHE_READ : (this.data.cache.read_multiplier as number)
    const write = assumed ? ASSUMED_CACHE_WRITE : (this.defaultTtl()?.write_multiplier ?? ASSUMED_CACHE_WRITE)
    const tokens =
      usage.inputTokens +
      OUTPUT_MULTIPLE * usage.outputTokens +
      read * usage.cacheReadTokens +
      write * usage.cacheWriteTokens
    return {
      tokens: Math.round(tokens),
      assumed,
      basis:
        `input + ${OUTPUT_MULTIPLE}·output + ${read}·cache_read + ${write}·cache_write` +
        (assumed ? ` (${this.provider} cache pricing is unpublished; multipliers assumed)` : '')
    }
  }

  /** Rebuilding a lapsed prefix from nothing: a full cache write at the default TTL's multiplier. */
  costOfColdStart(tokens: number): number | null {
    const ttl = this.defaultTtl()
    // ⛔ A declared TTL is not a declared price. See the note on `ttls`.
    return ttl && ttl.write_multiplier !== null ? ttl.write_multiplier * tokens : null
  }

  /**
   * When this session's cached prefix lapses, in epoch ms, or null if it has never made a request.
   * ⚠️ Measured from the request START. A four-minute response has already spent four minutes.
   */
  cacheExpiryFor(session: PriceableSession): number | null {
    if (!session.lastRequestStartedAt) return null
    const ttl = this.defaultTtl()
    // ⛔ No declared TTL means no expiry to reason about - not an expiry of zero, which would read as
    // "already lapsed" and have the clock act on it.
    if (!ttl) return null
    return session.lastRequestStartedAt + ttl.seconds * 1000
  }

  /**
   * How long a cached prefix lives, in ms, or null where the provider declares no TTL.
   *
   * ⛔ **The denominator every "how warm is this?" question needs, and the one several callers used
   * to hardcode as an hour.** Anthropic's default TTL is 3600s and OpenAI's is 1800s, so a divisor
   * of one hour reports a *completely fresh* codex prefix as 50% warm and can never score it above
   * that — which quietly ranks every codex conversation below every Claude one no matter how
   * recently it was used. Two callers arrived at this independently and for different reasons: the
   * cache clock, whose decision windows are a fraction of the TTL rather than a fixed fifteen
   * minutes (`decideBeforeExpiryMs`), and the routing score's `warm` term, which divided by a
   * hard-coded 60m and so penalised the shorter-TTL provider for being fresh.
   *
   * ⚠️ The renderer does **not** ask: it holds both stored timestamps and derives the span from
   * `expiry - started`, which is right for every provider without a round trip.

   */
  cacheTtlMs(): number | null {
    const ttl = this.defaultTtl()
    return ttl ? ttl.seconds * 1000 : null
  }

  /** Below this, the provider caches nothing and reports no error - so nothing is saved. */
  minCacheableTokens(model: string | null | undefined): number {
    const table = this.data.cache.min_cacheable_tokens
    if (!table || !model) return 0
    return table[model] ?? Math.max(...Object.values(table))
  }

  get compaction() {
    return this.data.compaction
  }

  get readRefreshesTtl(): boolean {
    return this.data.cache.read_refreshes_ttl
  }

  get ttlMeasuredFrom(): 'request_start' | 'response_end' {
    return this.data.cache.ttl_measured_from
  }

  modelSpec(id: string) {
    return this.data.models?.find((m) => m.id === id) ?? null
  }

  /**
   * Every model this file can price. ⛔ The only list agentyard will accept a model name from - a
   * model it cannot price is one it cannot gate, estimate for, or reason about the context of.
   */
  modelIds(): string[] {
    return this.data.models?.map((m) => m.id) ?? []
  }

  /**
   * Separately metered quota pools declared by this cost model and its models, or empty if single-pool.
   */
  pools(): Array<{ id: string; label: string; models: string[] }> {
    const quotaWindows =
      (this.data.quota as { windows?: Array<{ id: string; label: string; pool?: string }> } | undefined)
        ?.windows ?? []
    const poolMap = new Map<string, { label: string; models: string[] }>()
    for (const w of quotaWindows) {
      if (w.pool && !poolMap.has(w.pool)) {
        const cleanLabel = w.label.replace(/\s+(?:5h|7d|session)$/i, '')
        poolMap.set(w.pool, { label: cleanLabel, models: [] })
      }
    }

    if (this.data.models) {
      for (const m of this.data.models) {
        if (m.pool) {
          const targetPool =
            m.pool === 'gpt' && poolMap.has('claude')
              ? 'claude'
              : m.pool
          if (!poolMap.has(targetPool)) {
            poolMap.set(targetPool, { label: targetPool.charAt(0).toUpperCase() + targetPool.slice(1), models: [] })
          }
          poolMap.get(targetPool)!.models.push(m.id)
        }
      }
    }

    if (poolMap.size <= 1) return []

    return Array.from(poolMap.entries()).map(([id, info]) => ({
      id,
      label: info.label,
      models: info.models
    }))
  }

  // -------------------------------------------------------------------------- money

  /**
   * Does this provider have a subscription price to divide at all?
   *
   * ⛔ False is the honest answer for a local server: electricity is a real cost this tool cannot
   * meter, and $0.00 would claim otherwise. Callers render `n/a`, never a zero.
   */
  canPriceMoney(): boolean {
    const plans = this.data.plans
    return !!plans && plans.priced !== false && !!plans.billing_window
  }

  /** A plan by its catalogue id, or null. `source` is `stored` — the caller already decided. */
  planById(id: string | null | undefined): PlanRef | null {
    const entry = this.data.plans?.catalog.find((p) => p.id === id)
    return entry ? this.toPlanRef(entry, 'stored') : null
  }

  /** Every plan this provider sells, in catalogue order. */
  planIds(): string[] {
    return this.data.plans?.catalog.map((p) => p.id) ?? []
  }

  /**
   * Which subscription a run was on.
   *
   * Priority, and the order is the whole point:
   *
   * 1. **`detect`, the shape of the reading the run itself carried.** Evidence from the run.
   * 2. **`match` against the vendor's own `subscriptionType` string.** A belief about *now*, which
   *    is right for a live run and wrong for one that predates a plan change.
   * 3. **`default_plan`.** ⚠️ Always a paid plan — see the codex file's note on why free is never
   *    the default.
   *
   * Returns null only where the provider declares no plans at all.
   */
  resolvePlan(input: { subscriptionType?: string | null; windowIds?: string[] }): PlanRef | null {
    const plans = this.data.plans
    if (!plans) return null

    const ids = input.windowIds ?? []
    if (ids.length > 0) {
      for (const entry of plans.catalog) {
        if (entry.detect && matchesShape(entry.detect, ids)) return this.toPlanRef(entry, 'window_shape')
      }
    }

    const raw = (input.subscriptionType ?? '').trim().toLowerCase()
    if (raw) {
      for (const entry of plans.catalog) {
        if (entry.match.some((m) => matchesToken(m, raw))) return this.toPlanRef(entry, 'identity')
      }
    }

    const fallback = plans.catalog.find((p) => p.id === plans.default_plan)
    return fallback ? this.toPlanRef(fallback, 'default') : null
  }

  /**
   * Which of the windows a run actually saw the subscription is divided over, and at what share.
   *
   * ⚠️ Returns a **list**, because a pooled provider with an unknown model has to be charged across
   * every pool it might have drawn on. 26 antigravity runs on this install recorded no model at all
   * (the CLI names its model on the transcript's first usage record, and those never got one), and
   * charging them to whichever pool happened to be listed first would be a coin toss wearing a
   * measurement's clothes.
   *
   * ⛔ Each window appears **once**, at the largest share that names it: `claude` and `gpt` are two
   * pool keys over one window, and counting it twice would bill 40% of the subscription for a pool
   * that is worth 20% of it.
   */
  billingWindowsFor(windowIds: string[], pool?: string | null): BillingWindowRef[] {
    const plans = this.data.plans
    const bw = plans?.billing_window
    if (!plans || plans.priced === false || !bw) return []

    if (!bw.pooled) {
      const id = pickWindow(bw.match, windowIds)
      return id ? [{ id, days: bw.days, pool: null, share: 1 }] : []
    }

    const shares = plans.pool_shares ?? {}
    const keys = pool && pool in shares ? [pool] : Object.keys(shares)
    const best = new Map<string, { pool: string; share: number }>()
    for (const key of keys) {
      const scoped = windowIds.filter((w) => w.toLowerCase().includes(key.toLowerCase()))
      const id = pickWindow(bw.match, scoped)
      if (!id) continue
      const share = shares[key] ?? 0
      const seen = best.get(id)
      if (!seen || share > seen.share) best.set(id, { pool: key, share })
    }
    return [...best.entries()].map(([id, v]) => ({ id, days: bw.days, pool: v.pool, share: v.share }))
  }

  /**
   * What a slice of one billing window is worth, in dollars.
   *
   * ⛔ **The whole formula, in one place**, per AGENTS.md's "no pricing arithmetic inline":
   *
   *     usd = monthly_usd x pool_share x (window_days / 30.4375) x (percent / 100)
   *
   * Returns null — never 0 — where the plan has no price to divide. A free plan reading 5% of its
   * window spent 5% of nothing, and `$0.00` would say it spent nothing at all.
   */
  priceOfWindowPercent(
    planId: string,
    percent: number,
    pool?: string | null
  ): { usd: number; basis: string } | null {
    const bw = this.data.plans?.billing_window
    if (!bw) return null
    const share = pool ? (this.data.plans?.pool_shares?.[pool] ?? 1) : 1
    return this.priceOfWindowUsage(planId, [
      { window: { id: bw.match[0] ?? 'weekly', days: bw.days, pool: pool ?? null, share }, percent }
    ])
  }

  /**
   * The same sum over several windows at once — the pooled case, where each window carries its own
   * slice of the one subscription. ⚠️ Summed here rather than by the caller so that no consumer ever
   * has to know a share is a multiplier rather than an addend.
   */
  priceOfWindowUsage(
    planId: string,
    usage: Array<{ window: BillingWindowRef; percent: number }>
  ): { usd: number; basis: string } | null {
    const entry = this.data.plans?.catalog.find((p) => p.id === planId)
    if (!entry || entry.priced === false || !this.canPriceMoney() || usage.length === 0) return null
    let usd = 0
    const parts: string[] = []
    for (const u of usage) {
      const perWindow = entry.monthly_usd * (u.window.days / DAYS_PER_MONTH)
      usd += perWindow * u.window.share * (u.percent / 100)
      parts.push(
        `${u.percent.toFixed(2)}% of ${u.window.id}` +
          (u.window.share === 1 ? '' : ` (${Math.round(u.window.share * 100)}% of the subscription)`)
      )
    }
    const days = usage[0]!.window.days
    return {
      usd,
      basis:
        `${entry.label}, $${entry.monthly_usd}/month over a ${days}-day window ` +
        `($${(entry.monthly_usd * (days / DAYS_PER_MONTH)).toFixed(3)} per full window): ` +
        parts.join(' + ')
    }
  }

  /**
   * What a movement on a **spend meter** is worth, in dollars.
   *
   * ⛔ **The other half of the money formula, and here for the same reason as the first half**
   * (AGENTS.md: *"No pricing arithmetic inline. Ask the cost-model object."*). `price.ts` decides
   * only *whose* share of a movement is whose; turning `amount` into dollars — including deciding
   * that it cannot be turned into dollars — is this object's job, and inlining the multiply at the
   * one call site is how the second call site gets a different answer.
   *
   * A `usd` meter is already dollars and needs no conversion. A `credits` meter needs
   * `usdPerUnit`, and ⛔ **without it the answer is `null`, never `0`** — a vendor that publishes
   * credits with no conversion has given a meter that is real and unpriceable, and `$0.00` would
   * claim the movement cost nothing.
   *
   * ⚠️ Unlike `priceOfWindowUsage` this is subscription-independent: it is money that was billed,
   * not a share of money already paid. It asks the plan catalogue nothing.
   */
  priceOfMeterUsage(
    meter: Pick<SpendMeter, 'id' | 'label' | 'unit' | 'usdPerUnit'>,
    amount: number
  ): { usd: number; basis: string } | null {
    if (!Number.isFinite(amount)) return null
    if (meter.unit === 'usd') {
      return { usd: amount, basis: `$${amount.toFixed(4)} billed directly on ${meter.label}` }
    }
    const rate = meter.usdPerUnit
    if (rate === null || rate === undefined || !Number.isFinite(rate)) return null
    return {
      usd: amount * rate,
      basis: `${amount.toFixed(2)} credits on ${meter.label} at $${rate}/credit`
    }
  }

  private toPlanRef(entry: PlanEntry, source: PlanSource): PlanRef {
    return {
      id: entry.id,
      label: entry.label,
      monthlyUsd: entry.monthly_usd,
      priced: entry.priced !== false && this.canPriceMoney(),
      source
    }
  }

  summary(): CostModelSummary {
    return {
      id: this.id,
      provider: this.provider,
      effectiveFrom: this.effectiveFrom,
      source: this.source,
      path: this.path
    }
  }

  /** ⛔ Null rather than a throw: a provider with no client-controlled TTL is valid, not broken. */
  private defaultTtl() {
    const wanted = this.data.cache.default_ttl
    return this.data.cache.ttls.find((t) => t.id === wanted) ?? this.data.cache.ttls[0] ?? null
  }
}

/**
 * Equality first, then containment — and never the other way round.
 *
 * ⚠️ Containment alone would let `weekly` claim `weekly_all` before `weekly_all` itself was tried,
 * which is harmless here and would not be on a provider that emits both. Equality across the whole
 * candidate list is attempted before any containment is.
 */
function pickWindow(match: string[], windowIds: string[]): string | null {
  const lower = windowIds.map((w) => w.toLowerCase())
  for (const want of match) {
    const exact = lower.indexOf(want.toLowerCase())
    if (exact >= 0) return windowIds[exact]!
  }
  for (const want of match) {
    const w = want.toLowerCase()
    const partial = lower.findIndex((id) => id.includes(w))
    if (partial >= 0) return windowIds[partial]!
  }
  return null
}

/** `match` entries hit a vendor string by equality or containment, case-folded. */
function matchesToken(token: string, haystack: string): boolean {
  const t = token.trim().toLowerCase()
  return t.length > 0 && (haystack === t || haystack.includes(t))
}

/** Does the shape of the windows a run carried satisfy this plan's `detect` clause? */
function matchesShape(
  detect: { windows_all_of?: string[]; windows_none_of?: string[] },
  windowIds: string[]
): boolean {
  const has = (want: string): boolean =>
    windowIds.some((id) => id.toLowerCase() === want.toLowerCase())
  const all = detect.windows_all_of ?? []
  if (all.length === 0) return false
  if (!all.every(has)) return false
  return !(detect.windows_none_of ?? []).some(has)
}

let registry: Map<string, CostModel> | null = null

/**
 * Search order, most specific first: the user's own directory, then the copy shipped with the app,
 * then a compiled-in fallback so a broken install still prices correctly. A user can drop a new
 * pricing file into their data directory without waiting for a release.
 */
export function loadCostModels(extraDirs: string[] = []): Map<string, CostModel> {
  const found = new Map<string, CostModel>()

  const consider = (dir: string, source: CostModelSummary['source']) => {
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      const full = join(dir, name)
      try {
        const data = JSON.parse(readFileSync(full, 'utf8')) as CostModelFile
        if (!data.id || !data.cache || !data.compaction) {
          log.warn(`cost model ${full} is missing id/cache/compaction - ignored`)
          continue
        }
        if (!found.has(data.id)) found.set(data.id, new CostModel(data, source, full))
      } catch (err) {
        log.warn(`cost model ${full} failed to parse - ignored:`, err)
      }
    }
  }

  consider(paths.costModels, 'user')
  for (const dir of extraDirs) consider(dir, 'bundled')

  // ⛔ Compiled in, not read from disk. A cost model that fails to load is a scheduler that cannot
  // price anything, and "the file was not copied at packaging time" is not a failure worth having.
  // A user file of the same id still wins, because `consider` ran first.
  for (const file of [builtinAnthropic, builtinGoogle, builtinOpenai, builtinLocal, builtinMuse]) {
    const builtin = file as unknown as CostModelFile
    if (!found.has(builtin.id)) found.set(builtin.id, new CostModel(builtin, 'builtin', null))
  }

  registry = found
  log.info(`loaded ${found.size} cost model(s): ${[...found.keys()].join(', ')}`)
  return found
}

export function costModel(id: string): CostModel {
  if (!registry) loadCostModels()
  const found = registry?.get(id)
  if (!found) throw new Error(`no cost model '${id}' is loaded`)
  return found
}

export function costModels(): CostModel[] {
  if (!registry) loadCostModels()
  return [...(registry?.values() ?? [])]
}
