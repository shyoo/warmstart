import type { Task } from '@shared/tasks.js'
import { attachmentCountFor } from './attachments.js'
import { dependentsOf } from './tasks.js'

/**
 * How hard a task's prompt looks, estimated with **zero tokens**.
 *
 * ⛔ `AGENTS.md`: "The scheduler costs zero tokens. A loop running every 10s for weeks must bill
 * nothing." Nothing here calls an LLM, consults the controller, or reaches the network — every
 * signal is either already on the `Task` row or one cheap indexed query away. Today, nothing on
 * this fleet has any opinion about task difficulty: `estimateTask` (`estimator.ts`) derives a size
 * purely from project and fleet medians over past *runs*, and never reads the prompt that produced
 * them. This is the first thing that does.
 *
 * ⚠️ **`task.title` is the prompt.** `promptFor()` sends it verbatim and the composer files the
 * whole textarea into it (`docs/glossary.md` › *Title, and title summary*) — so word count and
 * structure are measured against `title`, never `titleSummary`, which is a display label the
 * controller writes for the board and says nothing about what the agent was actually asked.
 */

export type ComplexityBand = 'low' | 'medium' | 'high'

export interface ComplexitySignal {
  name: string
  /** 0..1 for every signal except `kind`, whose value can be pushed past 1 by the plan floor. */
  value: number
  weight: number
  contribution: number
  basis: string
}

export interface Complexity {
  band: ComplexityBand
  /** 0..1. The sum of every signal's `contribution`, exactly — never recomputed separately. */
  score: number
  signals: ComplexitySignal[]
  /** One line naming the two or three signals that actually moved the score. */
  basis: string
}

/**
 * Verbs that raise or lower the read of a prompt's difficulty, case-folded and matched whole-word
 * only — "typography" must not read as "typo". Exported so the classification is auditable rather
 * than a private regex nobody can check.
 */
export const COMPLEXITY_VERBS_UP = [
  'refactor',
  'migrate',
  'redesign',
  'architect',
  'rewrite',
  'investigate'
]
export const COMPLEXITY_VERBS_DOWN = ['typo', 'rename', 'bump', 'comment', 'tweak', 'revert']

/** A plan task never scores below this. See `complexityOf`'s note on the `kind` signal. */
const PLAN_FLOOR = 0.34

/**
 * ⚠️ `kind` is deliberately the only signal with a small nominal weight: floor. Fixing the plan
 * floor by *reserving* weight for `kind` would cap every non-plan task's ceiling at `1 - reserved`,
 * which is the opposite of what a floor should do. Instead `kind` contributes its natural
 * `weight × value` like every other signal, and — only for a plan task whose raw score would land
 * below the floor — its own contribution absorbs the difference after the fact. The other six
 * signals' weights are untouched either way, so a `work` task can still reach `high` on prompt
 * signals alone.
 */
interface WeightTable {
  size: number
  structure: number
  verb: number
  needs: number
  attachments: number
  fanOut: number
  kind: number
}

const WEIGHTS: WeightTable = {
  size: 0.36,
  structure: 0.24,
  verb: 0.14,
  needs: 0.08,
  attachments: 0.05,
  fanOut: 0.08,
  kind: 0.05
}

/**
 * When `task.estTokens` is stated it outranks the prose signals, exactly as it does in
 * `estimateTask`: somebody who has already sized the work knows something the word count does not.
 * `size` is boosted to this share and the other five prose/metadata weights (everything but `kind`,
 * which is about `task.kind` and untouched by size) are scaled down to fit what remains.
 */
const ESTTOKENS_SIZE_WEIGHT = 0.7

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

function countWords(text: string): number {
  const trimmed = text.trim()
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length
}

/**
 * A smooth 0..1 read of prose length: `words = 5` (a one-line instruction) is 0, `words = 150`
 * (a few paragraphs with context and a criteria list — this fleet's composer files a whole
 * textarea as the prompt, so a real task description reaches this length routinely) is 1,
 * log-scaled because a prompt going from 10 to 20 words says more than one going from 200 to 210
 * does.
 */
function sizeFromWords(words: number): number {
  if (words <= 5) return 0
  const lo = Math.log10(5)
  const hi = Math.log10(150)
  return clamp01((Math.log10(words) - lo) / (hi - lo))
}

/**
 * The same shape as `sizeFromWords`, over a stated token estimate. `1,000` tokens (a one-line fix)
 * is 0, `500,000` (the fleet's own pessimistic cold-start fallback in `estimator.ts`, roughly twice
 * `ROUTE_CONSULT_FLOOR_TOKENS`) is 1.
 */
function sizeFromTokens(tokens: number): number {
  if (tokens <= 1_000) return 0
  const lo = Math.log10(1_000)
  const hi = Math.log10(500_000)
  return clamp01((Math.log10(tokens) - lo) / (hi - lo))
}

const CODE_FENCE = /```/
const FILE_PATH = /(?:^|[\s(])(?:[\w.-]+\/)+[\w.-]+\.[a-zA-Z0-9]+/
const LIST_ITEM = /^[ \t]*(?:[-*]|\d+[.)])\s+\S/gm
const ACCEPTANCE_WORDS = /\bacceptance criteria\b/i
/** Explicit checkbox-shaped criteria, e.g. `- [ ] does the thing`. */
const CHECKBOX_ITEM = /^[ \t]*[-*]\s+\[[ xX]\]/m

interface StructureFacts {
  codeFence: boolean
  filePath: boolean
  list: boolean
  acceptanceCriteria: boolean
}

function structureFacts(text: string): StructureFacts {
  const items = text.match(LIST_ITEM) ?? []
  return {
    codeFence: CODE_FENCE.test(text),
    filePath: FILE_PATH.test(text),
    list: items.length >= 1,
    // ⚠️ Three or more list items reads as an enumerated checklist even with no header naming it,
    // which is how most prompts on this fleet actually state acceptance criteria.
    acceptanceCriteria: items.length >= 3 || ACCEPTANCE_WORDS.test(text) || CHECKBOX_ITEM.test(text)
  }
}

function structureValue(facts: StructureFacts): number {
  const hits = [facts.codeFence, facts.filePath, facts.list, facts.acceptanceCriteria].filter(
    Boolean
  ).length
  return hits / 4
}

function wholeWord(word: string): RegExp {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\b${escaped}\\b`, 'i')
}

/** 1 for a verb that raises the read, 0 for one that lowers it, 0.5 for neither or both. */
function verbValue(text: string): { value: number; matched: string[] } {
  const up = COMPLEXITY_VERBS_UP.filter((w) => wholeWord(w).test(text))
  const down = COMPLEXITY_VERBS_DOWN.filter((w) => wholeWord(w).test(text))
  if (up.length > 0 && down.length === 0) return { value: 1, matched: up }
  if (down.length > 0 && up.length === 0) return { value: 0, matched: down }
  return { value: 0.5, matched: [...up, ...down] }
}

/** The weight table for one task: boosted toward `size` when `estTokens` is stated. */
function weightsFor(hasEstTokens: boolean): WeightTable {
  if (!hasEstTokens) return WEIGHTS
  const restNames = ['structure', 'verb', 'needs', 'attachments', 'fanOut'] as const
  const restSum = restNames.reduce((sum, name) => sum + WEIGHTS[name], 0)
  const restBudget = 1 - WEIGHTS.kind - ESTTOKENS_SIZE_WEIGHT
  const scale = restBudget / restSum
  const scaled = Object.fromEntries(restNames.map((name) => [name, WEIGHTS[name] * scale])) as Record<
    (typeof restNames)[number],
    number
  >
  return { ...scaled, size: ESTTOKENS_SIZE_WEIGHT, kind: WEIGHTS.kind }
}

/** What the fleet knows about a task's difficulty, from its prompt and metadata alone. */
export function complexityOf(task: Task, _now = Date.now()): Complexity {
  const text = task.title ?? ''
  const hasEstTokens = typeof task.estTokens === 'number' && task.estTokens > 0
  const weights = weightsFor(hasEstTokens)

  const words = countWords(text)
  const sizeValue = hasEstTokens ? sizeFromTokens(task.estTokens as number) : sizeFromWords(words)
  const facts = structureFacts(text)
  const structure = structureValue(facts)
  const verb = verbValue(text)
  const needsCount = task.constraints?.needs?.length ?? 0
  const attachments = attachmentCountFor(task.id)
  const fanOut = dependentsOf(task.id).length
  const isPlan = task.kind === 'plan'

  const needsValue = clamp01(needsCount / 3)
  const attachmentsValue = clamp01(attachments / 5)
  const fanOutValue = clamp01(fanOut / 3)
  const kindValue = isPlan ? 1 : 0

  const signals: ComplexitySignal[] = [
    {
      name: 'size',
      value: sizeValue,
      weight: weights.size,
      contribution: sizeValue * weights.size,
      basis: hasEstTokens
        ? `stated estTokens of ${task.estTokens} outranks the prose signals, as it already does in estimateTask`
        : `${words} word(s) in the prompt (title, not titleSummary)`
    },
    {
      name: 'structure',
      value: structure,
      weight: weights.structure,
      contribution: structure * weights.structure,
      basis:
        `${[
          facts.codeFence ? 'code fence' : null,
          facts.filePath ? 'file path' : null,
          facts.list ? 'list' : null,
          facts.acceptanceCriteria ? 'explicit acceptance criteria' : null
        ]
          .filter(Boolean)
          .join(', ') || 'no code fence, file path, list or acceptance criteria found'}`
    },
    {
      name: 'verb',
      value: verb.value,
      weight: weights.verb,
      contribution: verb.value * weights.verb,
      basis:
        verb.matched.length > 0
          ? `matched verb(s): ${verb.matched.join(', ')}`
          : 'no verb from either lexicon matched as a whole word'
    },
    {
      name: 'needs',
      value: needsValue,
      weight: weights.needs,
      contribution: needsValue * weights.needs,
      basis: `${needsCount} required capabilit${needsCount === 1 ? 'y' : 'ies'} in constraints.needs`
    },
    {
      name: 'attachments',
      value: attachmentsValue,
      weight: weights.attachments,
      contribution: attachmentsValue * weights.attachments,
      basis: `${attachments} attachment(s) bound to this task`
    },
    {
      name: 'fanOut',
      value: fanOutValue,
      weight: weights.fanOut,
      contribution: fanOutValue * weights.fanOut,
      basis: `${fanOut} other task(s) depend on this one`
    },
    {
      name: 'kind',
      value: kindValue,
      weight: weights.kind,
      contribution: kindValue * weights.kind,
      basis: isPlan
        ? 'a plan task is a reading-and-judgment job'
        : `task kind is '${task.kind}', not 'plan'`
    }
  ]

  let score = signals.reduce((sum, s) => sum + s.contribution, 0)

  // ⛔ The floor, applied once, to the `kind` signal's own contribution rather than to the total —
  // so `score` stays exactly the sum of `signals[].contribution` with no separate adjustment term.
  if (isPlan && score < PLAN_FLOOR) {
    const deficit = PLAN_FLOOR - score
    const kind = signals[signals.length - 1]!
    kind.contribution += deficit
    kind.value = kind.weight > 0 ? kind.contribution / kind.weight : kind.value
    kind.basis += `; floored to ${PLAN_FLOOR.toFixed(2)} because a plan task is never simple to route`
    score = PLAN_FLOOR
  }

  score = clamp01(score)
  const band: ComplexityBand = score < 0.34 ? 'low' : score < 0.67 ? 'medium' : 'high'

  const leaders = [...signals]
    .sort((a, b) => b.contribution - a.contribution)
    .filter((s) => s.contribution > 0)
    .slice(0, 3)
  const basis =
    leaders.length > 0
      ? `${band} (${score.toFixed(2)}): driven by ${leaders.map((s) => `${s.name} (+${s.contribution.toFixed(2)})`).join(', ')}`
      : `${band} (${score.toFixed(2)}): nothing about this task's prompt or metadata reads as complex`

  return { band, score, signals, basis }
}
