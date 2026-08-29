import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { paths } from './paths.js'
import { log } from './log.js'
import type { CostModelSummary } from '@shared/protocol.js'
import builtinAnthropic from '../../costmodels/anthropic.subscription.2026-08.json' with { type: 'json' }
import builtinGoogle from '../../costmodels/google.antigravity.2026-08.json' with { type: 'json' }
import builtinOpenai from '../../costmodels/openai.codex.2026-08.json' with { type: 'json' }

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
    ttls: Array<{ id: string; seconds: number; write_multiplier: number }>
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
}

/** What a caller has to know about a session to have it priced. */
export interface PriceableSession {
  contextTokens: number | null
  model?: string | null
  lastRequestStartedAt?: number | null
}

/** Output is billed at 5x input; costs below are in input-token-equivalents. cost-model.md §3. */
const OUTPUT_MULTIPLE = 5

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

  /** Rebuilding a lapsed prefix from nothing: a full cache write at the default TTL's multiplier. */
  costOfColdStart(tokens: number): number | null {
    const ttl = this.defaultTtl()
    return ttl ? ttl.write_multiplier * tokens : null
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
  for (const file of [builtinAnthropic, builtinGoogle, builtinOpenai]) {
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
