import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import type { Project, Task, TaskMessage } from '@shared/tasks.js'
import {
  composite,
  RUBRIC_DIMENSIONS,
  RUBRIC_VERSION,
  rubricFor,
  type DimensionScore,
  type QualityReview,
  type ReviewAuthor,
  type RubricDimension
} from '@shared/review.js'
import { db, row, rows } from './db.js'
import { requireTask } from './tasks.js'
import { emit } from './events.js'
import { log } from './log.js'

/**
 * Peer quality review — the rubric, the diff, and the grade.
 *
 * ⛔ **A second agent grades the first agent's diff, and it is never the agent that did the work.**
 * Each task on this fleet is run once for cost reasons, so one run produces no comparison: it says
 * the task finished, not whether it finished well. `RunOutcome` is a statement about a process
 * exiting and `activeMs` one about speed. Both are measured. Quality was not.
 *
 * ⛔ **Nothing gates on the score.** No task changes status, no routing decision reads it, the
 * estimator never sees a review run. It is an instrument, and wiring it into a gate before it has
 * been shown to measure anything is the mistake this project has already made once.
 *
 * The design, the sources behind the rubric and the four decisions taken with the operator are in
 * `transient_docs/quality_review_2026-09-03.md`. The weights and dimension list live in
 * `@shared/review.js` because the thread renders them beside each score.
 */

const run = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 })
  return stdout.replace(/\s+$/, '')
}

// ---------------------------------------------------------------------------- blinding

/**
 * Names of the things that identify an agent in structured text, built from what is actually
 * installed rather than from a list written here.
 *
 * ⚠️ The adapter and model vocabulary is passed in by the caller: `review.ts` must not import the
 * adapter registry to do string surgery, and a hard-coded list of vendor names would go stale the
 * first time a model id changed.
 */
export interface BlindVocabulary {
  /** Adapter ids, adapter labels, worker labels and model ids — anything that names who ran. */
  names: string[]
}

/** Every commit trailer that names the agent that wrote the commit. */
const TRAILER = /^[ \t]*(?:co-authored-by|assisted-by|signed-off-by)\b.*$/gim

/**
 * The tool footer, which is not a trailer and does not start at the margin.
 *
 * ⚠️ Its real form in this repository is `🤖 Generated with [Claude Code](https://claude.com/…)` —
 * an emoji, then the phrase, then a URL naming the vendor twice more. A rule anchored to the start
 * of the line, which is the right shape for a trailer, missed every one of them.
 */
const TOOL_FOOTER = /^.*\bgenerated with\b.*$/gim

/**
 * ⚠️ Measured on this repository 2026-09-03, over the last 60 commits: **37** carry a
 * `Co-Authored-By:` trailer naming the model and **20** name an agent (*"codex"*, *"Claude"*,
 * *"antigravity"*) in the message **body**, outside any trailer.
 */
const PROSE_AGENT = /\b(claude|codex|antigravity|gemini|opus|sonnet|haiku|gpt-\d|qwen)\b/i

/**
 * Strip what identifies the author, and say honestly what could not be stripped.
 *
 * ⛔ **Exact on structured fields, best-effort on prose, and the difference is recorded rather than
 * papered over.** Trailers, model ids, worker labels and vendor dotfile directories come out
 * mechanically and completely. A commit body that explains a codex-specific sandbox bug does not:
 * replacing *"codex"* with *"AGENT-A"* throughout produces a paragraph that no longer means
 * anything, and a reviewer reading it would score the redaction rather than the work.
 *
 * So `leaked` is stored on the review, and a comparison across agents that has not excluded leaked
 * reviews is not a clean comparison. ⚠️ The field exists so that can be *checked* rather than
 * assumed — which is the whole difference between this and claiming a guarantee it cannot keep.
 *
 * ⭐ A pure function over strings, which is what makes it cheap to keep honest: `blinding.test.ts`
 * uses real trailers and real leak cases from this repository's own history as fixtures.
 */
export function blind(text: string, vocabulary: BlindVocabulary = { names: [] }): {
  text: string
  leaked: boolean
} {
  let out = text.replace(TRAILER, '').replace(TOOL_FOOTER, '')

  // ⛔ Longest first. `claude-opus-5` must not be half-replaced by a rule for `claude`, which would
  // leave `AGENT-opus-5` on the page — a redaction that names the thing it removed.
  const names = [...vocabulary.names]
    .filter((n) => n.trim().length >= 3)
    .sort((a, b) => b.length - a.length)
  for (const name of names) {
    out = out.replace(new RegExp(escapeRegExp(name), 'gi'), 'AGENT')
  }

  // ⚠️ The path is kept and the vendor directory generalised: *which* dotfile directory a task
  // touched names the agent as surely as a trailer does, while the fact that it touched agent
  // configuration at all is part of the change being judged.
  out = out.replace(/\.(claude|gemini|codex|agy)\//gi, '.agent-config/')

  out = out.replace(/\n{3,}/g, '\n\n')
  return { text: out, leaked: PROSE_AGENT.test(out) }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ---------------------------------------------------------------------------- the diff

export interface ReviewDiff {
  base: string
  head: string
  files: number
  insertions: number
  deletions: number
  truncated: boolean
  /** `--stat`, then the hunks that fit. Already blinded by the caller of `buildReviewPrompt`. */
  text: string
}

/**
 * ~120k characters of diff text, which is roughly 30k tokens.
 *
 * ⚠️ A judge that does not know it is looking at part of a change scores the part as if it were the
 * whole, so truncation is stated in the prompt and stored on the review rather than being silent.
 */
export const DIFF_BUDGET_CHARS = 120_000

/** Listed with their line counts, never inlined: nothing here is a judgment about the work. */
const GENERATED = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|dist|out|release|node_modules)(\/|$)/

export type RangeResolution =
  | { ok: true; base: string; head: string; trunkSha: string; cwd: string; from: 'landed' | 'branch' }
  | { ok: false; reason: string }

/**
 * Find the commits to review — and refuse rather than guess.
 *
 * The ladder, in order:
 *  1. `landedBaseSha`/`landedHeadSha`, when both still resolve in the trunk. After a fast-forward
 *     merge both are reachable from the trunk forever, so this answers long after the branch is gone.
 *  2. The task's branch, when it still exists: `merge-base(target, branch)..branch`.
 *  3. Neither → refuse, in one sentence that says why.
 *
 * ⛔ **Rung 3 is the honest answer for every task that landed before the range was recorded**, and
 * there is no fourth rung. A review of the wrong commits is worse than no review, because it
 * produces a number that looks exactly like a real one and is indistinguishable from one later.
 */
export async function resolveRange(
  task: Pick<Task, 'landedBaseSha' | 'landedHeadSha' | 'branch'>,
  project: Project,
  target: string
): Promise<RangeResolution> {
  const cwd = project.root
  const trunkSha = await resolves(cwd, target)
  if (!trunkSha) return { ok: false, reason: `the landing target '${target}' does not resolve` }
  if (task.landedBaseSha && task.landedHeadSha) {
    const base = await resolves(cwd, task.landedBaseSha)
    const head = await resolves(cwd, task.landedHeadSha)
    const baseBeforeHead = base && head ? await isAncestor(cwd, base, head) : false
    const headOnTrunk = head ? await isAncestor(cwd, head, trunkSha) : false
    if (base && head && baseBeforeHead && headOnTrunk) {
      return { ok: true, base, head, trunkSha, cwd, from: 'landed' }
    }
  }
  if (task.branch) {
    const branch = await resolves(cwd, task.branch)
    if (branch) {
      const base = await tryGit(cwd, ['merge-base', target, task.branch])
      if (base) return { ok: true, base, head: branch, trunkSha, cwd, from: 'branch' }
    }
  }
  return {
    ok: false,
    reason:
      task.landedBaseSha || task.landedHeadSha
        ? 'this task recorded a commit range that no longer resolves in the trunk, so there is no ' +
          'diff to review'
        : 'this task landed before its commit range was recorded and its branch has been retired, ' +
          'so there is no diff to review'
  }
}

async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await git(cwd, ['merge-base', '--is-ancestor', ancestor, descendant])
    return true
  } catch {
    return false
  }
}

async function resolves(cwd: string, ref: string): Promise<string | null> {
  return tryGit(cwd, ['rev-parse', `${ref}^{commit}`])
}

async function tryGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    return await git(cwd, args)
  } catch {
    return null
  }
}

/**
 * Assemble the diff, biggest change first, and stop at the budget.
 *
 * ⚠️ Descending change density rather than alphabetical: a truncated review should have seen the
 * files where the work happened, not the first ones in the tree.
 */
export async function collectDiff(cwd: string, base: string, head: string): Promise<ReviewDiff> {
  const range = `${base}..${head}`
  const numstat = await git(cwd, ['diff', '--numstat', range])
  const entries = numstat
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [added, removed, ...rest] = line.split('\t')
      const path = rest.join('\t')
      return {
        path,
        // `-` is git's way of saying binary. Counted as changed, never inlined.
        added: added === '-' ? 0 : Number.parseInt(added ?? '0', 10) || 0,
        removed: removed === '-' ? 0 : Number.parseInt(removed ?? '0', 10) || 0,
        binary: added === '-'
      }
    })

  const insertions = entries.reduce((n, e) => n + e.added, 0)
  const deletions = entries.reduce((n, e) => n + e.removed, 0)
  const stat = await git(cwd, ['diff', '--stat', range])

  const ordered = [...entries].sort((a, b) => b.added + b.removed - (a.added + a.removed))
  const parts: string[] = [stat]
  const omitted: string[] = []
  let used = stat.length

  for (const entry of ordered) {
    if (entry.binary || GENERATED.test(entry.path)) {
      omitted.push(`${entry.path} | +${entry.added}/-${entry.removed} (generated or binary, not shown)`)
      continue
    }
    if (used >= DIFF_BUDGET_CHARS) {
      omitted.push(`${entry.path} | +${entry.added}/-${entry.removed} (not shown)`)
      continue
    }
    const hunks = (await tryGit(cwd, ['diff', range, '--', entry.path])) ?? ''
    if (used + hunks.length > DIFF_BUDGET_CHARS && parts.length > 1) {
      omitted.push(`${entry.path} | +${entry.added}/-${entry.removed} (not shown)`)
      continue
    }
    parts.push(hunks)
    used += hunks.length
  }

  if (omitted.length > 0) {
    parts.push(`\n--- files not shown in full ---\n${omitted.join('\n')}`)
  }

  return {
    base,
    head,
    files: entries.length,
    insertions,
    deletions,
    truncated: omitted.length > 0,
    text: parts.join('\n\n')
  }
}

// ---------------------------------------------------------------------------- the prompt

/**
 * The anchors, verbatim.
 *
 * ⛔ **What makes a 7 mean the same thing on Tuesday as on Friday**, and a 7 from one agent
 * comparable with a 7 from another. The reported human/LLM alignment peak is a 0–5 scale and longer
 * scales drift; the operator asked for 10-point, so the documented mitigation ships with it — five
 * described states to interpolate between rather than a bare line to pick a number off.
 */
const ANCHORS_1_0: Record<RubricDimension, string> = {
  requirement_fidelity: [
    '10 — Every stated requirement is met. Ambiguities were resolved the way a careful colleague',
    '     would, and where a judgment call was made it is stated.',
    '8  — All requirements met; one ambiguity resolved silently in a defensible direction.',
    '6  — The main requirement is met; a secondary one is partially done or quietly dropped.',
    '4  — A stated requirement is missing or was reinterpreted into something easier.',
    '2  — The change addresses a related problem rather than the one asked about.',
    '0  — Does not address the request.'
  ].join('\n'),
  correctness: [
    '10 — Correct on the happy path and on the error, empty, concurrent and boundary paths. Failure',
    '     modes are handled deliberately; nothing swallows an error into a wrong-but-quiet state.',
    '8  — Correct; one unhandled edge case that is unlikely and would fail loudly.',
    '6  — Correct for the intended use; a plausible input or ordering produces wrong behaviour.',
    '4  — A defect a careful reviewer would catch on one read — an off-by-one, an unawaited promise,',
    '     a resource never released, a null path.',
    '2  — Works only on the exact case demonstrated.',
    '0  — Does not work, or breaks existing behaviour.'
  ].join('\n'),
  tests: [
    '10 — New behaviour has tests that would fail without the change. They assert observable',
    '     behaviour, cover at least one failure path, and sit where this repository puts tests.',
    '8  — Good coverage of the happy path, thin on failure paths.',
    '6  — Tests exist and pass but largely restate the implementation.',
    '4  — A token test, or tests for the easy part while the risky part is untested.',
    '2  — No tests where the change plainly needed them.',
    '0  — No tests, and existing tests were weakened, skipped or deleted to make the change pass.',
    'NOT EVERY CHANGE NEEDS A TEST. A pure-CSS change, a doc edit or a rename has no behaviour to',
    'assert: score null rather than 0, and the composite renormalises over what was scored.'
  ].join('\n'),
  codebase_fit: [
    '10 — Indistinguishable in style from the code around it: naming, structure, error handling,',
    '     comment density and level of abstraction all match. Existing helpers are reused.',
    '8  — Fits well; one small divergence.',
    '6  — Recognisably a different hand — works, reads as bolted on.',
    '4  — Introduces a pattern the project does not use, or a dependency it did not need.',
    '2  — Ignores the surrounding conventions.',
    '0  — Fights them: parallel abstractions, duplicated state, a second way to do an existing thing.'
  ].join('\n'),
  scope_discipline: [
    '10 — Every hunk is necessary. No drive-by reformatting, no speculative generality, no dead',
    '     scaffolding, no unrelated file touched.',
    '8  — Essentially minimal; one small unrelated tidy-up.',
    '6  — Noticeable extra surface — an abstraction with one caller, an option nothing sets.',
    '4  — A refactor was carried along with the fix, mixing two reviews into one diff.',
    '2  — The change is several times the size the job needed.',
    '0  — Sweeping unrequested rewrite.',
    'SMALL IS NOT AUTOMATICALLY GOOD. A one-line change that skips work the task asked for scores',
    'low on requirement fidelity and must not be rewarded here for being short.'
  ].join('\n'),
  maintainability: [
    '10 — A stranger can change this in six months. Names say what things are, non-obvious decisions',
    '     carry their reason, and the docs the change made wrong were fixed in the same diff.',
    '8  — Clear; one place where the reason for a choice is not recorded.',
    '6  — Readable but requires re-deriving the author’s intent in a couple of places.',
    '4  — Hidden coupling, a magic value with no name, or an interface that invites misuse.',
    '2  — Would need rewriting before it could safely be extended.',
    '0  — Actively misleading — comments contradict code, names lie about behaviour.'
  ].join('\n'),
  self_sufficiency: [
    '10 — One run, checks passed first time, no human input needed beyond the original prompt.',
    '8  — One or two runs; a question was asked and it was a genuinely necessary one.',
    '6  — Several runs, or checks failed once and were fixed without help.',
    '4  — Repeated check failures, or a question the original prompt already answered.',
    '2  — Needed a person to unstick it, or left uncommitted work behind.',
    '0  — Did not converge without substantial human rework.',
    'RETRIES ARE NOT AUTOMATICALLY THE AGENT’S FAULT. A run preempted at a quota window boundary, or',
    'one stopped because a workspace was contended, is the scheduler’s doing. The run history below',
    'states each run’s outcome precisely so you can tell those apart; score the agent’s contribution.'
  ].join('\n')
}

/** Append-only beside `RUBRICS`: anchors are part of a rubric, not mutable prompt prose. */
const RUBRIC_ANCHORS: Readonly<Record<string, Record<RubricDimension, string>>> = Object.freeze({
  '1.0': Object.freeze(ANCHORS_1_0)
})

/** The rubric section of the prompt: seven dimensions, their weights, and all their anchors. */
export function rubricText(version = RUBRIC_VERSION): string {
  const anchors = RUBRIC_ANCHORS[version]
  const rubric = rubricFor(version)
  if (!anchors || !rubric) throw new Error(`no complete definition for rubric ${version}`)
  return RUBRIC_DIMENSIONS.map((dimension, i) => {
    const { label, asks } = rubric.labels[dimension]
    return (
      `${i + 1}. ${label}  (key: "${dimension}", weight ${rubric.weights[dimension].toFixed(2)})\n` +
      `   ${asks}\n${indent(anchors[dimension])}`
    )
  }).join('\n\n')
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `   ${line}`)
    .join('\n')
}

export interface PromptInputs {
  task: Pick<Task, 'title'>
  /** Follow-up instructions a person sent, already blinded. */
  followUps: string[]
  /** The anonymised run history — `runHistoryText`. */
  history: string
  diff: ReviewDiff
  /** Where the reviewer is standing, and what the trunk is at, so it can trust the diff over it. */
  trunkSha: string | null
}

/**
 * ⛔ The effort instruction goes **second, before the rubric**, because it is the one most likely to
 * be ignored and the whole economics of this feature rest on it. A review is well under 1% of the
 * task it grades only while it stays a one-pass, tool-less job; the moment it earns a second turn it
 * stops being free and starts being a thing to budget for.
 */
export function buildReviewPrompt(input: PromptInputs): string {
  const { diff } = input
  return [
    'You are grading a code change against a fixed rubric. Do not fix anything, do not edit any',
    'file, and do not run any command that writes. You may read files to understand the code around',
    'the change.',
    '',
    'KEEP THIS TO A SINGLE PASS. Read the diff, open at most a handful of files you actually need in',
    'order to judge whether the change fits the code around it, and answer. Do not explore the',
    'repository, do not run the test suite, do not attempt to reproduce anything. A thorough review',
    'is not what is wanted here; a calibrated one is.',
    '',
    '=== RUBRIC ===',
    'Score each dimension 0-10 against the anchors below, or null when the dimension does not apply.',
    'Interpolate between the described states; do not pick a number off a bare line.',
    '',
    rubricText(),
    '',
    '=== THE ORIGINAL REQUEST ===',
    input.task.title,
    ...(input.followUps.length
      ? ['', '=== FOLLOW-UP INSTRUCTIONS FROM THE REQUESTER ===', ...input.followUps]
      : []),
    '',
    '=== OBSERVED RUN HISTORY ===',
    input.history,
    '',
    '=== THE CHANGE ===',
    `Commit range: ${diff.base.slice(0, 12)}..${diff.head.slice(0, 12)} · ${diff.files} file(s), ` +
      `+${diff.insertions}/-${diff.deletions}.`,
    input.trunkSha
      ? `The working tree you are standing in is at ${input.trunkSha.slice(0, 12)} and may have ` +
        'moved past these commits. Trust the diff below over the files on disk where they disagree.'
      : '',
    diff.truncated
      ? 'Some of the changed files are shown in full and the rest are listed with their line counts ' +
        'only. Score what you can see, and say in your rationale that the diff was truncated.'
      : '',
    '',
    diff.text,
    '',
    '=== THIS PROJECT’S CONVENTIONS ===',
    'This project documents its rules in `AGENTS.md` and its current state in `HANDOFF.md`. Read',
    '`AGENTS.md` if you need to judge whether the change follows this project’s conventions — the',
    'codebase-fit dimension is about *this* repository, not about universal taste.',
    '',
    '=== OUTPUT ===',
    'Reply with this JSON object and nothing else:',
    '{',
    '  "rubric_version": "' + RUBRIC_VERSION + '",',
    '  "scores": {',
    RUBRIC_DIMENSIONS.map(
      (d) => `    "${d}": { "score": 0-10 or null, "rationale": "one or two sentences citing file:line" }`
    ).join(',\n'),
    '  },',
    '  "summary": "one or two sentences",',
    '  "notable": ["at most three specific observations, each citing file:line"]',
    '}',
    'Do not include an overall score: it is computed from the dimensions above.'
  ]
    .filter((line) => line !== '')
    .join('\n')
}

// ---------------------------------------------------------------------------- the reply

export type ParsedReview =
  | { ok: true; scores: Record<RubricDimension, DimensionScore>; summary: string; notable: string[] }
  | { ok: false; reason: string }

const MAX_RATIONALE = 600

/**
 * Validate the reply against a closed set, exactly as a consult's answer is.
 *
 * ⛔ **No repair pass and no re-ask.** A second turn to fix a malformed answer doubles the cost of
 * the cheapest thing in the system, and a model that cannot emit seven keys is a finding about that
 * model worth keeping. A failure is stored as `status: 'failed'` with its reason — ⚠️ never as a
 * score of 0, which is a real grade and would be a lie about the work.
 */
export function parseReviewReply(reply: Record<string, unknown>): ParsedReview {
  if (reply.rubric_version !== RUBRIC_VERSION) {
    return {
      ok: false,
      reason: `the reply used rubric ${JSON.stringify(reply.rubric_version)}, expected ${RUBRIC_VERSION}`
    }
  }
  const raw = reply.scores
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'the reply carried no `scores` object' }
  const source = raw as Record<string, unknown>

  const scores = {} as Record<RubricDimension, DimensionScore>
  for (const dimension of RUBRIC_DIMENSIONS) {
    const entry = source[dimension]
    if (!entry || typeof entry !== 'object') {
      return { ok: false, reason: `the reply had no score for \`${dimension}\`` }
    }
    const { score, rationale } = entry as { score?: unknown; rationale?: unknown }
    if (score !== null && (typeof score !== 'number' || !Number.isInteger(score) || score < 0 || score > 10)) {
      return { ok: false, reason: `\`${dimension}\` scored ${JSON.stringify(score)}, which is not 0-10 or null` }
    }
    if (typeof rationale !== 'string' || rationale.trim().length === 0) {
      return { ok: false, reason: `\`${dimension}\` carried no rationale` }
    }
    scores[dimension] = { score, rationale: rationale.trim().slice(0, MAX_RATIONALE) }
  }

  const summary = typeof reply.summary === 'string' ? reply.summary.trim() : ''
  if (!summary) return { ok: false, reason: 'the reply carried no summary' }

  const notable = Array.isArray(reply.notable)
    ? reply.notable.filter((n): n is string => typeof n === 'string' && n.trim().length > 0).slice(0, 3)
    : []

  return { ok: true, scores, summary, notable }
}

// ---------------------------------------------------------------------------- authorship

/**
 * Who is being graded.
 *
 * ⭐ **Credit goes to the adapter of the last non-failed work run** — the operator's rule, and the
 * only one that matches how a task actually ends. ⚠️ When more than one adapter contributed,
 * `mixed` is set and the whole list is kept: any aggregate that compares agents must exclude those
 * rows and say so, because a score attributed to one agent for a task another did most of is not
 * evidence about either. ⛔ No apportioning — nothing here can measure who wrote which hunk, and
 * inventing a split would be exactly the confident unsourced number `AGENTS.md` forbids.
 */
export function authorshipOf(taskId: string): {
  authors: ReviewAuthor[]
  subjectAdapter: string | null
  subjectModel: string | null
  mixed: boolean
} {
  const found = rows<{ adapter_id: string | null; model: string | null; n: number; last_at: number }>(
    db()
      .prepare(
        `select adapter_id, model, count(*) as n, max(started_at) as last_at
           from runs
          where task_id = ? and kind = 'work' and coalesce(outcome, '') <> 'failed'
          group by adapter_id
          order by last_at asc`
      )
      .all(taskId)
  )
  const authors: ReviewAuthor[] = found
    .filter((r) => r.adapter_id)
    .map((r) => ({
      adapterId: r.adapter_id as string,
      model: r.model,
      runs: r.n,
      lastAt: r.last_at
    }))
  const last = authors.length ? authors[authors.length - 1] : undefined
  return {
    authors,
    subjectAdapter: last?.adapterId ?? null,
    subjectModel: last?.model ?? null,
    mixed: authors.length > 1
  }
}

/**
 * The run history, anonymised, as prose the judge can score dimension 7 from.
 *
 * ⛔ **The daemon supplies the facts; the reviewer supplies the judgment.** It states what happened
 * — how many runs, what each one's outcome was, how many questions were asked — and never how much
 * of that was avoidable, which is the thing being graded. ⚠️ Every adapter, model and worker label
 * is gone; a run is *"run 1"*, and a change of hands is *"a different agent took over"*.
 */
export function runHistoryText(taskId: string): string {
  const found = rows<{ adapter_id: string | null; outcome: string | null }>(
    db()
      .prepare(
        `select adapter_id, outcome from runs
          where task_id = ? and kind = 'work' order by started_at asc`
      )
      .all(taskId)
  )
  if (found.length === 0) return 'No runs were recorded for this task.'

  const lines: string[] = [`${found.length} run(s).`]
  let previous: string | null = null
  found.forEach((r, i) => {
    const handover = i > 0 && r.adapter_id && previous && r.adapter_id !== previous
    lines.push(
      `Run ${i + 1}: ${outcomeSentence(r.outcome)}${handover ? ' (a different agent took over here)' : ''}`
    )
    if (r.adapter_id) previous = r.adapter_id
  })

  const questions = (
    db()
      .prepare('select count(*) as n from questions where task_id = ?')
      .get(taskId) as { n: number } | undefined
  )?.n ?? 0
  lines.push(
    questions === 0
      ? 'The agent asked no questions.'
      : `The agent asked ${questions} question(s) of a person.`
  )
  return lines.join('\n')
}

/**
 * ⚠️ `preempted` and `cancelled` say *the scheduler stopped this*, in the prompt, in words. Without
 * that the judge reads a three-run task as three failures and scores incompetence that never
 * happened — the single most likely way this rubric produces a wrong number.
 */
function outcomeSentence(outcome: string | null): string {
  switch (outcome) {
    case 'completed':
      return 'completed.'
    case 'preempted':
      return 'was stopped by the scheduler at a quota window boundary. Not a failure of the work.'
    case 'cancelled':
      return 'was cancelled by a person. Not a failure of the work.'
    case 'terminated':
      return 'was stopped externally.'
    case 'blocked':
      return 'stopped to ask something and did not finish.'
    case 'failed':
      return 'failed.'
    default:
      return 'is still running or recorded no outcome.'
  }
}

// ---------------------------------------------------------------------------- storage

interface ReviewRow {
  id: string
  task_id: string
  run_id: string
  reviewer_worker_id: string
  reviewer_adapter: string
  reviewer_model: string | null
  subject_adapter: string
  subject_model: string | null
  mixed_authorship: number
  authorship_json: string
  base_sha: string | null
  head_sha: string | null
  diff_files: number | null
  diff_insertions: number | null
  diff_deletions: number | null
  diff_truncated: number
  scores_json: string | null
  composite: number | null
  summary: string | null
  notable_json: string
  status: string
  failure_reason: string | null
  rubric_version: string
  blinded: number
  blinding_leak: number
  created_at: number
  completed_at: number | null
}

function toReview(r: ReviewRow): QualityReview {
  return {
    id: r.id,
    taskId: r.task_id,
    runId: r.run_id,
    reviewerWorkerId: r.reviewer_worker_id,
    reviewerAdapter: r.reviewer_adapter,
    reviewerModel: r.reviewer_model,
    subjectAdapter: r.subject_adapter,
    subjectModel: r.subject_model,
    mixedAuthorship: r.mixed_authorship === 1,
    authorship: JSON.parse(r.authorship_json) as ReviewAuthor[],
    baseSha: r.base_sha,
    headSha: r.head_sha,
    diffFiles: r.diff_files,
    diffInsertions: r.diff_insertions,
    diffDeletions: r.diff_deletions,
    diffTruncated: r.diff_truncated === 1,
    scores: r.scores_json
      ? (JSON.parse(r.scores_json) as Partial<Record<RubricDimension, DimensionScore>>)
      : null,
    composite: r.composite,
    summary: r.summary,
    notable: JSON.parse(r.notable_json) as string[],
    status: r.status as QualityReview['status'],
    failureReason: r.failure_reason,
    rubricVersion: r.rubric_version,
    blinded: r.blinded === 1,
    blindingLeak: r.blinding_leak === 1,
    createdAt: r.created_at,
    completedAt: r.completed_at
  }
}

export interface PendingReviewInput {
  taskId: string
  runId: string
  reviewerWorkerId: string
  reviewerAdapter: string
  reviewerModel: string | null
  subjectAdapter: string
  subjectModel: string | null
  authorship: ReviewAuthor[]
  mixed: boolean
  diff: ReviewDiff | null
  blindingLeak: boolean
}

/** Insert the review as `pending` before the agent is asked, so the thread shows it immediately. */
export function createPendingReview(input: PendingReviewInput): QualityReview {
  const id = randomUUID()
  db()
    .prepare(
      `insert into quality_reviews
         (id, task_id, run_id, reviewer_worker_id, reviewer_adapter, reviewer_model,
          subject_adapter, subject_model, mixed_authorship, authorship_json,
          base_sha, head_sha, diff_files, diff_insertions, diff_deletions, diff_truncated,
          notable_json, status, rubric_version, blinded, blinding_leak, created_at)
       values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'[]','pending',?,1,?,?)`
    )
    .run(
      id,
      input.taskId,
      input.runId,
      input.reviewerWorkerId,
      input.reviewerAdapter,
      input.reviewerModel,
      input.subjectAdapter,
      input.subjectModel,
      input.mixed ? 1 : 0,
      JSON.stringify(input.authorship),
      input.diff?.base ?? null,
      input.diff?.head ?? null,
      input.diff?.files ?? null,
      input.diff?.insertions ?? null,
      input.diff?.deletions ?? null,
      input.diff?.truncated ? 1 : 0,
      RUBRIC_VERSION,
      input.blindingLeak ? 1 : 0,
      Date.now()
    )
  const review = requireReview(id)
  emit({ type: 'task.changed', task: requireTaskRow(input.taskId) })
  return review
}

/**
 * Settle a review, and denormalise the headline onto its task.
 *
 * ⛔ **The composite is computed here from the stored dimension scores**, never read from the
 * model's reply. The stored rubric version selects the immutable weights, so a later version never
 * rewrites history, and a judge is never asked for the holistic number it is least reliable at.
 *
 * ⚠️ The five `tasks.quality_review_*` columns are written by this function and by nothing else.
 */
export function completeReview(
  id: string,
  parsed: ParsedReview
): QualityReview {
  const existing = requireReview(id)
  if (!parsed.ok) {
    db()
      .prepare(
        "update quality_reviews set status = 'failed', failure_reason = ?, completed_at = ? where id = ?"
      )
      .run(parsed.reason, Date.now(), id)
    log.info(`quality review ${id.slice(0, 8)} failed: ${parsed.reason}`)
    emit({ type: 'task.changed', task: requireTaskRow(existing.taskId) })
    return requireReview(id)
  }

  const score = composite(parsed.scores, existing.rubricVersion)
  const now = Date.now()
  db()
    .prepare(
      `update quality_reviews
          set status = 'complete', scores_json = ?, composite = ?, summary = ?, notable_json = ?,
              completed_at = ?
        where id = ?`
    )
    .run(JSON.stringify(parsed.scores), score, parsed.summary, JSON.stringify(parsed.notable), now, id)

  db()
    .prepare(
      `update tasks
          set quality_review_id = ?, quality_review_score = ?, quality_review_at = ?,
              quality_reviewer = ?
        where id = ?`
    )
    .run(id, score, now, existing.reviewerAdapter, existing.taskId)

  const aggregate = db()
    .prepare(
      `select avg(composite) as score, count(composite) as count
         from quality_reviews
        where task_id = ? and status = 'complete' and composite is not null`
    )
    .get(existing.taskId) as { score: number | null; count: number }
  db()
    .prepare('update tasks set quality_review_score = ?, quality_review_count = ? where id = ?')
    .run(aggregate.score === null ? null : Math.round(aggregate.score * 10) / 10, aggregate.count, existing.taskId)

  log.info(
    `quality review ${id.slice(0, 8)} scored ${score ?? 'nothing'} on ${existing.subjectAdapter}'s work`
  )
  emit({ type: 'task.changed', task: requireTaskRow(existing.taskId) })
  return requireReview(id)
}

/** ⛔ `refused` is not `failed`: nothing was asked and nothing was spent. See the resolution ladder. */
export function refuseReview(id: string, reason: string): QualityReview {
  db()
    .prepare(
      "update quality_reviews set status = 'refused', failure_reason = ?, completed_at = ? where id = ?"
    )
    .run(reason, Date.now(), id)
  return requireReview(id)
}

export function requireReview(id: string): QualityReview {
  const r = row<ReviewRow>(db().prepare('select * from quality_reviews where id = ?').get(id))
  if (!r) throw new Error(`no quality review '${id}'`)
  return toReview(r)
}

/** Every review of a task, newest first. ⛔ Kept, never replaced — see re-reviewing. */
export function reviewsForTask(taskId: string): QualityReview[] {
  return rows<ReviewRow>(
    db()
      .prepare('select * from quality_reviews where task_id = ? order by created_at desc')
      .all(taskId)
  ).map(toReview)
}

/**
 * The task row, re-broadcast after a write so the thread and the table update without a poll.
 *
 * ⛔ A direct import: `tasks.ts` does not import this module, so there is no cycle to route around.
 */
function requireTaskRow(taskId: string): Task {
  return requireTask(taskId)
}

/** ⚠️ Follow-ups a person sent, which are part of what the work was asked to do. */
export function humanFollowUps(messages: TaskMessage[]): string[] {
  return messages
    .filter((m) => m.role === 'human' && m.text.trim().length > 0)
    .map((m) => m.text.trim())
}
