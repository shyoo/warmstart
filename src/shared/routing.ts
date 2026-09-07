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
