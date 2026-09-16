import type { Objective } from './tasks.js'

/**
 * A routing decision, kept.
 *
 * ⛔ **Stored at dispatch, never recomputed at read time.** The score that ordered the candidates was
 * computed against windows, caches and context sizes that existed for one tick and are gone by the
 * time anybody asks. Re-deriving it later would produce a number that looks exactly like the real one
 * and answers a different question — which is the failure mode this whole file exists to avoid, and
 * the same argument `quality_reviews` makes for storing its rubric version.
 *
 * ⚠️ Shared rather than daemon-only because the Analytics UI renders each term beside the weight it
 * carried and the basis it rested on; a second copy of these shapes in the renderer is a second thing
 * to keep in step with the scheduler that produced them.
 */

/**
 * The routing model this build runs. Printed on the Routing Model page and nowhere else yet.
 *
 * ⚠️ A version of the *model* — the terms, their signs and the weight formulas below — not of the
 * app. It moves when a term is added, removed or re-derived, so a reader comparing two decisions
 * a month apart can tell whether the arithmetic between them changed.
 */
export const ROUTING_MODEL_VERSION = '1.0'

/** The names of the ten objective-derived weights, in the order the scheduler publishes them. */
export type WeightName =
  | 'cacheWarmth'
  | 'contextHeld'
  | 'contextRot'
  | 'projectSwitch'
  | 'quotaRisk'
  | 'cold'
  | 'capabilityFit'
  | 'pace'
  | 'fitness'
  | 'price'

/**
 * Each weight's derivation, as the arithmetic it actually is.
 *
 * ⛔ **Published so a score can be checked rather than believed.** A rendered `1.249` tells an
 * operator nothing — not where it came from, not whether it is large, not what would move it. These
 * strings are printed beside the number they produce, stamped on every stored decision, and
 * `cost.test.ts` evaluates every one of them against `weights()` in `objective.ts` so the published
 * derivation cannot drift from the code that computes it.
 *
 * ⚠️ Shared, not daemon-only, because the Routing Model page typesets exactly these strings. A
 * second table of the same formulas in the renderer is the drift the test above exists to prevent.
 * Written with `×` and `−` because they are read by people, and parsed back by that test.
 */
export const WEIGHT_FORMULAS: Record<WeightName, string> = {
  cacheWarmth: '1.0 + 2.2×cost − 0.6×velocity',
  contextHeld: '0.8 + 1.0×cost + 0.4×quality',
  contextRot: '0.6 + 1.6×quality',
  projectSwitch: '0.3 + 0.6×cost',
  quotaRisk: '0.5 + 1.2×cost',
  cold: '0.8 + 2.0×cost − 0.7×velocity',
  capabilityFit: '0.7 + 1.3×quality',
  pace: '0.3 + 1.7×velocity',
  fitness: '0.4 + 1.6×quality',
  price: '0.5 + 2.0×cost'
}

/**
 * The direction each weight pushes. ⛔ `scoreCandidate` in `scoring.ts` reads this same table, so
 * the sign the page prints is the sign the sum used.
 *
 * ⚠️ `pace` is `+1` with a **signed** value, which is why it is not listed as a penalty: the term is
 * positive for an agent measured faster than the fleet's centre and negative for one measured slower,
 * so a single direction here would be a lie about half of its range.
 */
export const WEIGHT_SIGNS: Record<WeightName, 1 | -1> = {
  cacheWarmth: 1,
  contextHeld: 1,
  contextRot: -1,
  projectSwitch: -1,
  quotaRisk: -1,
  cold: -1,
  capabilityFit: 1,
  pace: 1,
  fitness: 1,
  price: -1
}

/**
 * A published formula, evaluated at one objective vector.
 *
 * ⛔ **Parsed, never evaluated.** `Function(…)` on a string is implied eval, and a page that reaches
 * for it to typeset a constant has traded a real guarantee for a convenient one. The grammar is
 * deliberately tiny — signed terms of `number` or `number×name` — and a term outside it throws, so a
 * formula this cannot read is a build error rather than a silently wrong number.
 */
export function evaluateWeightFormula(formula: string, objective: Objective): number {
  const vars: Record<string, number> = {
    cost: objective.cost,
    velocity: objective.velocity,
    quality: objective.quality
  }
  let total = 0
  for (const [, sign, body] of formula.matchAll(/([+−-]?)\s*([\d.]+(?:×[a-z]+)?)/g)) {
    const factor = sign === '−' || sign === '-' ? -1 : 1
    const [num, name] = (body as string).split('×')
    const scalar = Number(num)
    if (Number.isNaN(scalar)) throw new Error(`unparsed term: ${body} in ${formula}`)
    if (name === undefined) {
      total += factor * scalar
    } else {
      const v = vars[name]
      if (v === undefined) throw new Error(`unknown variable ${name} in ${formula}`)
      total += factor * scalar * v
    }
  }
  return total
}

/** One term of one candidate's score, exactly as `scheduler.ts` computed it. */
export interface RoutingTerm {
  name: string
  /** The objective weight — identical across candidates, since it derives from the vector alone. */
  weight: number
  /** That weight's own arithmetic, e.g. `0.8 + 2.0×cost − 0.7×velocity`. */
  weightFormula: string
  /** What this candidate measured for the term. Normally 0..1; `pace` alone is signed. */
  value: number
  /** Where that value came from, in words — the reading, the count, or the absence behind it. */
  basis: string
  sign: 1 | -1
  /** `sign × weight × value`. Summing this over every term gives the candidate's score. */
  contribution: number
}

export interface RoutingCandidate {
  workerId: string
  label: string
  adapterId: string
  /** The model this candidate would have run, where it was knowable before the spawn. */
  model: string | null
  /** A conversation already holds this task on this account — live, or closed and reopenable. */
  warm: boolean
  quotaUnverified: boolean
  score: number
  /** ⛔ Exactly one candidate per decision carries this. */
  chosen: boolean
  terms: RoutingTerm[]
}

/**
 * How the winner was picked.
 *
 * `score` — the arithmetic separated them. `controller` — it did not, by more than ε, and a
 * controller consult named the winner. ⚠️ `pinned` is a decision with one candidate because the task
 * named its worker; it is recorded so a table of decisions does not silently omit them.
 */
/**
 * How a dispatch chose its account.
 *
 * ⚠️ `sticky` is not a kind of score. It says the task already had a conversation on that account and
 * keeping it was worth more than any comparison — see `stickyWorkerFor`. A decision recorded as
 * `sticky` still carries the whole ranked field, so the arithmetic it declined to use is auditable.
 *
 * ⚠️ `reuse` is the tie-break, not a term: the scores came within ε of each other and only some of
 * the tied candidates already held this task's conversation, so the cheaper of two equals was taken
 * and no controller turn was spent. A `reuse` decision is one a `controller` consult would have
 * decided before this existed.
 */
export type RoutingBasis = 'score' | 'controller' | 'pinned' | 'sticky' | 'explore' | 'reuse'

export interface RoutingDecision {
  id: string
  taskId: string | null
  taskSeq: number | null
  taskTitle: string
  projectId: string | null
  chosenWorkerId: string | null
  chosenLabel: string | null
  /** The vector in force for this task — fleet default, project override or task override. */
  objective: Objective
  /** Every weight the vector produced, by name. Identical across this decision's candidates. */
  weights: Record<string, number>
  weightFormulas: Record<string, string>
  /** Gaps at or below this count as no difference at all, and are what triggers a consult. */
  epsilon: number
  basis: RoutingBasis
  /** Whether the winner was reusing a live or reopenable conversation. */
  warm: boolean
  candidates: RoutingCandidate[]
  decidedAt: number
}

export interface RoutingDecisionPage {
  decisions: RoutingDecision[]
  total: number
  limit: number
  offset: number
}

/**
 * One (worker, model) pair the fleet could route to, with everything that fed its `fitness` and
 * `price` terms.
 *
 * ⛔ **Every priced model on every commissioned worker, not only the ones on its allowlist.** The
 * point of the page this feeds is to answer "should I add this model", which needs the candidates
 * an operator has *not* opted into as much as the ones they have — `routable` is what tells the two
 * apart. `routableModelsFor` (`workers.ts`) is the same ladder `chooseTarget` climbs: an explicit
 * allowlist entry, or — when a worker has set none — the one model it already defaults to.
 */
export interface ModelReportRow {
  workerId: string
  label: string
  adapterId: string
  model: string
  /** On this worker's allowlist, or the one model it already defaults to with an empty allowlist. */
  routable: boolean
  /** 0..1 from `benchmarkPrior`. `null` is unknown, never a guessed 0. */
  prior: number | null
  priorBasis: string
  priorSource: string | null
  /** The clean composite, on the rubric's own 0..10 scale — never the 0..1 `fitness` blend. */
  cleanComposite: number | null
  /** ⚠️ The **clean** review count, never the raw sample count — see `fitness.ts`. */
  cleanSamples: number
  /** The blended `fitness` term's value. `null` only when neither a prior nor a clean review exists. */
  fitness: number | null
  fitnessBasis: string
  /** What a task is estimated to cost on this pair. `null` renders `n/a`, never `$0.00`. */
  costUsd: number | null
  costConfidence: 'none' | 'low' | 'medium' | 'high'
  /** Above 1 is slower than the fleet's centre; below 1 is faster. `null` when nothing is measured. */
  paceFactor: number | null
  paceSamples: number
  /** The quota pool this model draws on, or `null` where the provider has only one. */
  pool: string | null
  /** That pool's current reading, or `null` where nothing trustworthy has been read. */
  poolPercent: number | null
  /** How many dispatches actually chose this pair, from `routing_decisions`. */
  dispatches: number
  /** Of those, how many were `basis: 'explore'` rather than the arithmetic's own winner. */
  explorations: number
}

/**
 * One leaderboard a benchmark prior was taken from, so the table can say where its numbers came
 * from rather than asking the reader to trust them.
 *
 * ⛔ **Carried, not re-derived in the renderer.** The names on a row's `priorSource` are keys into
 * the benchmark file's own `sources` list; only the daemon can read that file, so the URL and the
 * retrieval date travel with the report. A name that resolves to nothing here is shown as a bare
 * name, never as a dead link.
 */
export interface BenchmarkSourceRef {
  /** The benchmark file this source belongs to, e.g. `coding-agents.2026-09`. */
  fileId: string
  /** The date that file's numbers are stated as of. */
  effectiveFrom: string
  /** The key a model entry's `source` holds. */
  name: string
  url: string
  /** When the number was read off the leaderboard. */
  retrieved: string
}

export interface ModelReport {
  generatedAt: number
  objective: Objective
  /**
   * Whether the `fitness` and `price` terms are scoring anything at all right now.
   *
   * ⛔ **False means every number below is shown but unused.** Both terms sit at 0 fleet-wide
   * until some worker has a non-empty allowlist (`modelRoutingActive`), so a page that printed a
   * fitness of 0.85 without saying so would be describing a belief nothing acts on — which is the
   * distinction the Quality tab already has to make and the reason it makes it loudly.
   */
  active: boolean
  fitnessWeight: number
  fitnessFormula: string
  priceWeight: number
  priceFormula: string
  rows: ModelReportRow[]
  /** Where the `prior` column's numbers were read from. Empty only if no benchmark file loaded. */
  benchmarkSources: BenchmarkSourceRef[]
}

/**
 * The velocity picture: who is actually available right now, and how fast each has been measured.
 *
 * ⛔ Availability and pace are two different questions and are kept apart here. *Can this account
 * take work at this instant* is a gate — capacity, a quota window, a sign-in — and answering it wrong
 * holds a task. *How long does this account take* is a learned preference that only ever breaks a
 * tie. Merging them into one "velocity score" would let a slow-but-free worker look ineligible and an
 * unavailable-but-fast one look ready.
 */
export interface VelocityWorker {
  workerId: string
  label: string
  adapterId: string
  /** Null where nothing has been measured. */
  medianActiveMs: number | null
  /** How many finished tasks that median rests on. */
  samples: number
  /** Above 1 is slower than the fleet's centre; below 1 is faster. Shrunk towards 1 by `samples`. */
  factor: number
  /** The signed routing value the `pace` term contributes at value ×1. See the daemon's `paceValue`. */
  value: number
  basis: string
  /** Live work sessions against `maxConcurrent`. */
  running: number
  maxConcurrent: number
  /** Why this account could not be handed a turn right now, or null when it could. */
  unavailable: string | null
  /** The tightest applicable quota window, as a percentage, or null where nothing is trustworthy. */
  windowPercent: number | null
  windowLabel: string | null
}

export interface VelocityReport {
  generatedAt: number
  objective: Objective
  /** `pace` alone — every other weight belongs to a different tab. */
  paceWeight: number
  paceFormula: string
  /** The fleet's centre: the geometric mean of its finished tasks' active time. */
  neutralActiveMs: number
  /** How many finished tasks carried a usable duration and a credited agent. */
  samples: number
  workers: VelocityWorker[]
}
