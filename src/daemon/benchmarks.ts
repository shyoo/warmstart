import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { paths } from './paths.js'
import { log } from './log.js'
import builtin from '../../benchmarks/coding-agents.2026-09.json' with { type: 'json' }

/**
 * Benchmark priors: what a published (or carefully inferred) leaderboard says about a model's
 * agentic coding ability, before this fleet has measured anything of its own.
 *
 * ⛔ **Data, never code** — the same rule `costmodel.ts` states at its own top, and for the same
 * reason: a leaderboard number moves on its own schedule, and a version of it embedded in a
 * conditional is a fact nobody can find to update. `benchmarks/*.json` is versioned the same way
 * `costmodels/*.json` is, and this file is nothing but the loader and the two-rung lookup ladder.
 *
 * ⛔ **`agentic: null` means unknown, and is never read as 0.** A model this fleet has never seen
 * benchmarked is a missing input, not a model that scored the floor — conflating the two would make
 * `fitness.ts` prefer a genuinely bad model over one nobody has measured yet.
 */

export interface BenchmarkModelEntry {
  id: string
  /** 0..1, higher is better. `null` means unknown — never coerced to 0. */
  agentic: number | null
  basis: 'published' | 'inferred' | 'unknown'
  source: string | null
  note: string
}

export interface BenchmarkFamilyEntry {
  /** A prefix matched against a model id that has no exact entry. Longest match wins. */
  match: string
  agentic: number | null
  basis: 'published' | 'inferred' | 'unknown'
  note: string
}

export interface BenchmarkFile {
  id: string
  schema_version: number
  effective_from: string
  scale: string
  sources: Array<{ name: string; url: string; retrieved: string }>
  models: BenchmarkModelEntry[]
  families?: BenchmarkFamilyEntry[]
}

/** What this file has to say about one model id, and how it got there. */
export interface BenchmarkPrior {
  agentic: number | null
  /** A sentence, not a token — `AGENTS.md`: "every belief carries its basis." */
  basis: string
  source: string | null
}

let cache: BenchmarkFile[] | null = null

/**
 * Search order, most specific first: the user's own directory, then the copy compiled into the
 * app. Mirrors `loadCostModels` exactly, including the reason — a broken install still prices (and
 * here, still ranks) correctly, and a user can drop an updated file into their data directory
 * without waiting for a release.
 */
export function loadBenchmarks(extraDirs: string[] = []): BenchmarkFile[] {
  const found: BenchmarkFile[] = []
  const seen = new Set<string>()

  const consider = (dir: string) => {
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      const full = join(dir, name)
      try {
        const data = JSON.parse(readFileSync(full, 'utf8')) as BenchmarkFile
        if (!data.id || !Array.isArray(data.models)) {
          log.warn(`benchmark file ${full} is missing id/models - ignored`)
          continue
        }
        if (seen.has(data.id)) continue
        seen.add(data.id)
        found.push(data)
      } catch (err) {
        log.warn(`benchmark file ${full} failed to parse - ignored:`, err)
      }
    }
  }

  consider(paths.benchmarks)
  for (const dir of extraDirs) consider(dir)

  // ⛔ Compiled in, not read from disk, for the same reason `loadCostModels` compiles its four
  // files in: a benchmark prior that vanishes because a packaging step forgot to copy a directory
  // is a failure worth never having, not one worth debugging in the field.
  const builtinFile = builtin as unknown as BenchmarkFile
  if (!seen.has(builtinFile.id)) found.push(builtinFile)

  cache = found
  log.info(`loaded ${found.length} benchmark file(s): ${found.map((f) => f.id).join(', ')}`)
  return found
}

function files(): BenchmarkFile[] {
  if (!cache) return loadBenchmarks()
  return cache
}

/** Test seam, matching `resetCostFactors`'s shape. */
export function resetBenchmarks(): void {
  cache = null
}

/**
 * What the leaderboards say about one model, exact id first, then the longest matching family
 * prefix, then unknown.
 *
 * ⭐ The same two-rung ladder `factorFor` (`estimator.ts`) and `paceFor` (`pace.ts`) already climb —
 * exact key, then a wider rung, then an honest "nothing measured" — so all three read the same way.
 */
export function benchmarkPrior(modelId: string | null | undefined): BenchmarkPrior {
  if (!modelId) {
    return { agentic: null, basis: 'no model id was given, so no prior applies', source: null }
  }

  for (const file of files()) {
    const exact = file.models.find((m) => m.id === modelId)
    if (exact) {
      return {
        agentic: exact.agentic,
        basis:
          exact.agentic === null
            ? `${file.id}: '${modelId}' has no published or inferred score — ${exact.note}`
            : `${file.id}: '${modelId}' is ${exact.basis} at ${exact.agentic.toFixed(2)} — ${exact.note}`,
        source: exact.source
      }
    }
  }

  let best: { entry: BenchmarkFamilyEntry; fileId: string } | null = null
  for (const file of files()) {
    for (const family of file.families ?? []) {
      if (!modelId.startsWith(family.match)) continue
      if (!best || family.match.length > best.entry.match.length) {
        best = { entry: family, fileId: file.id }
      }
    }
  }
  if (best) {
    const { entry, fileId } = best
    return {
      agentic: entry.agentic,
      basis:
        entry.agentic === null
          ? `${fileId}: no family prior for '${modelId}' (matched '${entry.match}') — ${entry.note}`
          : `${fileId}: '${modelId}' matched family '${entry.match}', ${entry.basis} at ` +
            `${entry.agentic.toFixed(2)} — ${entry.note}`,
      source: null
    }
  }

  return {
    agentic: null,
    basis: `no benchmark file names '${modelId}' or a family prefix of it — unknown, not a guess`,
    source: null
  }
}

/** Every model and family entry this fleet has loaded, for the operator surface. */
export function benchmarkTable(): BenchmarkFile[] {
  return files()
}
