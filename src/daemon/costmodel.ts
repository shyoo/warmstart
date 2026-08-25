import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { paths } from './paths.js'
import { log } from './log.js'
import type { CostModelSummary } from '@shared/protocol.js'
import builtinAnthropic from '../../costmodels/anthropic.subscription.2026-08.json' with { type: 'json' }

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
    kind: string
    read_multiplier: number
    read_refreshes_ttl: boolean
    ttl_measured_from: 'request_start' | 'response_end'
    ttls: Array<{ id: string; seconds: number; write_multiplier: number }>
    default_ttl: string
    max_breakpoints?: number
    scope?: string
    min_cacheable_tokens?: Record<string, number>
  }
  compaction: {
    summary_output_tokens: number
    post_context_tokens: number
    duration_ms: number
    breakeven_context_tokens: number
    min_tokens_since_compact: number
  }
  models?: Array<{
    id: string
    context_window: number
    input_per_mtok: number | null
    output_per_mtok: number | null
    tokenizer: string
    context_awareness: boolean
    effort_levels: string[]
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

  /** One trivial turn that refreshes the TTL. A read refreshes it for free, so this is just the read. */
  costOfKeepalive(session: PriceableSession): number {
    return this.data.cache.read_multiplier * (session.contextTokens ?? 0)
  }

  /** Read the context back, then pay for the summary the model writes. ~= 0.1·C + 28k. */
  costOfCompact(session: PriceableSession): number {
    return (
      this.data.cache.read_multiplier * (session.contextTokens ?? 0) +
      OUTPUT_MULTIPLE * this.data.compaction.summary_output_tokens
    )
  }

  /** Rebuilding a lapsed prefix from nothing: a full cache write at the default TTL's multiplier. */
  costOfColdStart(tokens: number): number {
    return this.defaultTtl().write_multiplier * tokens
  }

  /**
   * When this session's cached prefix lapses, in epoch ms, or null if it has never made a request.
   * ⚠️ Measured from the request START. A four-minute response has already spent four minutes.
   */
  cacheExpiryFor(session: PriceableSession): number | null {
    if (!session.lastRequestStartedAt) return null
    return session.lastRequestStartedAt + this.defaultTtl().seconds * 1000
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

  summary(): CostModelSummary {
    return {
      id: this.id,
      provider: this.provider,
      effectiveFrom: this.effectiveFrom,
      source: this.source,
      path: this.path
    }
  }

  private defaultTtl() {
    const wanted = this.data.cache.default_ttl
    const found = this.data.cache.ttls.find((t) => t.id === wanted) ?? this.data.cache.ttls[0]
    if (!found) throw new Error(`cost model ${this.id} declares no TTLs`)
    return found
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

  const builtin = builtinAnthropic as unknown as CostModelFile
  if (!found.has(builtin.id)) found.set(builtin.id, new CostModel(builtin, 'builtin', null))

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
