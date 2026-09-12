import { existsSync } from 'node:fs'
import { isAbsolute, join, normalize } from 'node:path'
import {
  MAX_DEBATE_ROUNDS,
  MAX_DEBATE_SEATS,
  MIN_DEBATE_ROUNDS,
  MIN_DEBATE_SEATS,
  type DebateExchange,
  type DebateSeat,
  type DebateState,
  type DebateVerdict,
  type Principal,
  type Task
} from '@shared/tasks.js'
import { errorMessage } from '@shared/errors.js'
import { db } from './db.js'
import { emit } from './events.js'
import { log } from './log.js'
import { getProject, policyFor } from './projects.js'
import {
  addDependency,
  addMessage,
  admit,
  createTask,
  getTask,
  requireTask,
  setStatus
} from './tasks.js'

/**
 * Debate mode: several agents answer one question independently, then read each other under an
 * organizer that arbitrates and reports an agreement **with its dissent**.
 *
 * ⛔ **Its product is a decision, not a commit**, and that single sentence is what most of this file
 * pays for. Every path in this codebase that finishes a task assumes the work left commits behind,
 * so a seat is filed `report-only` (`finish.ts`) and `nonGradable` (`review.ts` has nothing to
 * grade), and the parent's own grade — if it ever lands commits — measures the organizer's
 * *execution* turn and is never a grade of the agreement.
 *
 * ⛔ **There is no transport here, and that is the design rather than an omission.** A seat never
 * talks to another seat: the daemon carries text between threads with `addMessage` + `continueTask`,
 * which is what makes every exchange visible in the UI, replayable from the database, and impossible
 * to do off the record. A direct agent-to-agent channel would be the one shape where the operator
 * cannot see what was said.
 *
 * ⛔ **The safety boundary lives here rather than in the MCP tool**, for the reason `split.ts` gives:
 * it is the expensive thing to get wrong and the cheap thing to test, against a temp database with
 * no agent, no prompt and no UI in the way. See `debate.test.ts` and
 * `transient_docs/debate_mode_2026-09-12.md`.
 */

// ---------------------------------------------------------------------------- the roster

export interface DebateInput {
  seats: DebateSeat[]
  rounds: number
  exchange: DebateExchange
}

export type DebateCheck = { ok: true } | { ok: false; reason: string }

/**
 * Everything that can be said about a proposed debate without writing to the database.
 *
 * ⛔ **One cap, not two.** The seat ceiling is `MAX_DEBATE_SEATS`, which is also
 * `ROOT_MANDATE.maxChildren` — the number `createTask` will actually enforce — so the number the
 * composer offers is the number that will be allowed. This is §3.7 of the Plan & Split plan
 * restated: a split of six was once refused with a message about a cap nobody had set.
 *
 * ⚠️ A duplicate (worker, model, effort) triple is **allowed**. That is a homogeneous debate, which
 * an operator on a one-account fleet may well want; it is what the composer's heterogeneity notice
 * counts, and a notice is not a gate.
 */
export function validateDebate(input: DebateInput, cap = MAX_DEBATE_SEATS): DebateCheck {
  const seats = input.seats ?? []
  if (!Array.isArray(seats) || seats.length < MIN_DEBATE_SEATS) {
    return {
      ok: false,
      reason:
        `a debate needs at least ${MIN_DEBATE_SEATS} seats; got ${seats?.length ?? 0}. ` +
        'One agent answering a question on its own is an ordinary task, and cheaper.'
    }
  }
  if (seats.length > Math.min(cap, MAX_DEBATE_SEATS)) {
    return {
      ok: false,
      reason:
        `${seats.length} seats exceeds this task's fan-out cap of ${Math.min(cap, MAX_DEBATE_SEATS)}. ` +
        'Published work finds the gain flattens past about five agents.'
    }
  }
  for (const [i, seat] of seats.entries()) {
    if (!seat?.workerId?.trim()) {
      return { ok: false, reason: `seat ${i + 1} names no account, so nothing could be dispatched to it` }
    }
  }
  const rounds = input.rounds
  if (!Number.isInteger(rounds) || rounds < MIN_DEBATE_ROUNDS || rounds > MAX_DEBATE_ROUNDS) {
    return {
      ok: false,
      reason: `rounds must be a whole number from ${MIN_DEBATE_ROUNDS} to ${MAX_DEBATE_ROUNDS}; got ${String(rounds)}`
    }
  }
  if (input.exchange !== 'full' && input.exchange !== 'digest') {
    return { ok: false, reason: `'${String(input.exchange)}' is not an exchange rule; use 'full' or 'digest'` }
  }
  return { ok: true }
}

/** The seats of one debate, in the order they were filed. */
export function seatsOf(parentTaskId: string): Task[] {
  const parent = getTask(parentTaskId)
  if (!parent) return []
  return parent.dependsOn
    .map((id) => getTask(id))
    .filter((t): t is Task => !!t && t.parentTaskId === parentTaskId)
    .sort((a, b) => a.seq - b.seq)
}

// ---------------------------------------------------------------------------- opening

export type DebateResult = { ok: true; seats: Task[] } | { ok: false; reason: string }

/**
 * File every seat, or none of them, and block the organizer on all of them.
 *
 * ⛔ **The all-or-nothing shape is `applySplit`'s, deliberately reused rather than reinvented.** An
 * organizer blocked on seats that do not exist is a task nothing can ever release, because the thing
 * it waits for was never filed.
 *
 * ⛔ **`sessionSharing: 'off'`, unconditionally, and it is not an operator setting.** Two seats of a
 * homogeneous debate satisfy every gate in `sharing.ts` — same project, same account, same model,
 * same effort, clean, room to grow — so with sharing on, seat 2 would be dispatched into the
 * conversation seat 1 had just finished, read everything seat 1 argued, and the blind first round
 * would silently not be blind. With a cheaper bill that looks like a win. ⚠️ Sharing is `off` at
 * every tier today, so this is inert on this install and would become a correctness bug the first
 * time anybody turned it on. A seat's *own* session across rounds is a different mechanism
 * (`warmSessionFor` tries own runs first) and is exactly what we want.
 *
 * ⛔ **The edges are `settled`, not `completed`**, for the reason a split's are: the organizer has to
 * be woken by the seat that failed as well as by the ones that answered. Reading what came back,
 * including what did not, is the arbitration turn's whole job.
 */
export function openDebate(parentTaskId: string, createdBy: Principal): DebateResult {
  const parent = requireTask(parentTaskId)
  if (parent.kind !== 'debate') {
    return { ok: false, reason: `t${parent.seq} is not a Debate task` }
  }
  if (!parent.debate) {
    return { ok: false, reason: `t${parent.seq} carries no roster, so there is nothing to seat` }
  }
  if (seatsOf(parent.id).length > 0) {
    return { ok: false, reason: `t${parent.seq} already has its seats` }
  }
  const check = validateDebate(parent.debate, parent.mandate.maxChildren)
  if (!check.ok) return check

  const project = parent.projectId ? getProject(parent.projectId) : null
  // ⚠️ The project's own trunk, named explicitly. A seat leaves nothing on its branch, so the thing
  // its (empty) branch is measured against has to be a ref that exists — not the organizer's branch,
  // which is created when the organizer is first dispatched and so does not exist yet.
  const landingTarget = project ? policyFor(project).landingTarget : null

  const roster = parent.debate.seats
  const created: Task[] = []
  try {
    for (const [i, seat] of roster.entries()) {
      created.push(
        createTask({
          title: seatPromptFor(parent, i, roster.length),
          projectId: parent.projectId,
          parentTaskId: parent.id,
          createdBy,
          kind: 'work',
          status: 'ready',
          priority: parent.priority,
          assigneeHint: seat.workerId,
          // ⛔ The deliverable is the thread. Without this every seat trips `decideFinish`'s
          // empty-branch guard and parks at `awaiting_human`, which is not a settled status — so
          // the organizer's edges never release and the debate stalls on round 1, N times, each
          // seat holding a worker slot through `awaitingHumanReservations`.
          finishPolicy: 'report-only',
          sessionSharing: 'off',
          // ⛔ `resolveRange` needs commits and a seat has none, so every seat would enter the
          // grading queue and fail out of it. Migration 51's column, used for exactly this.
          nonGradable: true,
          ...(landingTarget ? { landingTarget } : {}),
          budgetShare: 1 / roster.length,
          mergeDuplicates: false,
          // ⛔ **Seats read and argue; they do not write.** A seat that can edit the workspace is N
          // agents writing to N branches nobody asked for. Turning an agreement into edits is the
          // verdict *Split the work*, which is supported and visible.
          mandate: { allowed: ['read'] },
          // ⛔ **A pin, exactly one (account, model, effort) — not a candidate set.** This is the
          // whole reason `DebateSeat` exists rather than `ChildDefaults.workerIds`: the latter is a
          // list the scheduler may pick *from*, which would let three seats land on one account and
          // still be called a debate.
          constraints: {
            workerId: seat.workerId,
            workerIds: [seat.workerId],
            ...(seat.model ? { model: seat.model } : {}),
            ...(seat.effort ? { effort: seat.effort } : {})
          }
        })
      )
    }
    for (const seat of created) admit(seat.id)
    for (const seat of created) addDependency(parent.id, seat.id, 'settled')
  } catch (err) {
    for (const seat of created) {
      try {
        setStatus(seat.id, 'cancelled', { holdReason: 'the debate it belonged to could not be opened' })
      } catch {
        // Best effort: the message below is what the operator acts on.
      }
    }
    const reason = errorMessage(err)
    log.warn(`t${parent.seq} debate could not be opened: ${reason}`)
    return { ok: false, reason }
  }

  const listed = created.map((c) => `t${c.seq}`).join(', ')
  addMessage(parent.id, 'system', `Round 1 — ${created.length} seats, answering blind`, null, [], {
    detail:
      `${listed}. Each reads the repository and answers independently; none of them can see another's ` +
      'answer. This task waits for all of them to settle, then arbitrates.'
  })
  setStatus(parent.id, 'blocked', {
    holdReason: `waiting on ${created.length} debate seats answering round 1 (${listed})`
  })
  // ⚠️ Re-derive rather than trust the write above — `applySplit`'s own note: a seat that somehow
  // settled between being created and being depended on would leave the organizer blocked on nothing.
  admit(parent.id)
  log.info(`t${parent.seq} opened a debate with ${created.length} seats: ${listed}`)
  return { ok: true, seats: created }
}

// ---------------------------------------------------------------------------- the round loop

/**
 * ⚠️ `SETTLED_STATUSES` is private to `tasks.ts` and deliberately stays that way — this is a read
 * of the same three for one warning, not a second authority on what settled means. `admit()` is
 * still the only thing that decides whether an edge is met.
 */
const SETTLED = ['completed', 'failed', 'cancelled']

export interface DebateBrief {
  /** 1-based seat number, as the organizer sees it in its prompt. */
  seat: number
  text: string
}

/**
 * Send each seat its brief, and put the organizer back to sleep.
 *
 * ⛔ **Re-queue, then block, then admit — in that order, and the order is the whole of §4.5.**
 * `setStatus` re-admits dependents on the transition *into* a settled status; nothing re-blocks a
 * parent when a dependency goes back *out* of `completed`. So the seats have to leave their settled
 * status first. In the other order the organizer is admitted against seats that have not yet moved
 * and is dispatched into a round that has not happened.
 *
 * ⛔ **The organizer may stop early and may never extend.** The round count is the budget the
 * operator authorised, and *preference never widens authority*. Converging early only ever saves
 * money and needs no permission; a request for one more round is refused with the reason.
 */
export function nextRound(
  parentTaskId: string,
  briefs: DebateBrief[],
  /**
   * ⛔ **Passed in rather than imported.** `continueTask` lives in `scheduler.ts`, which imports
   * `prompt.ts`, which imports this file for `debatePhaseOf` — importing it back would close a
   * cycle for one call. It is also what makes the ordering testable: `debate.test.ts` hands this a
   * recorder and asserts the parent is `blocked` and undispatchable at every point between rounds.
   *
   * ⚠️ Synchronous, and it has to be: `continueTask` is, and an `await` here would let the block
   * below run against seats that had not yet moved — which is the very ordering this function
   * exists to get right.
   */
  continueSeat: (taskId: string) => void
): DebateCheck {
  const parent = requireTask(parentTaskId)
  if (parent.kind !== 'debate' || !parent.debate) {
    return { ok: false, reason: `t${parent.seq} is not a Debate task` }
  }
  const state = parent.debate
  const seats = seatsOf(parent.id)
  if (seats.length === 0) {
    return { ok: false, reason: `t${parent.seq} has no seats to send a brief to` }
  }
  if (state.round >= state.rounds) {
    return {
      ok: false,
      reason:
        `this debate was authorised for ${state.rounds} round(s) and is on round ${state.round}, so ` +
        'there is no further round to open. Converge instead: report the agreement, the dissent, ' +
        'your confidence, and what the debate did not settle. Only the operator can buy more rounds.'
    }
  }
  if (briefs.length !== seats.length) {
    return {
      ok: false,
      reason: `there are ${seats.length} seats and you wrote ${briefs.length} brief(s). Write one per seat.`
    }
  }
  const bySeat = new Map<number, string>()
  for (const brief of briefs) {
    const text = brief?.text?.trim() ?? ''
    if (!Number.isInteger(brief?.seat) || brief.seat < 1 || brief.seat > seats.length) {
      return { ok: false, reason: `'${String(brief?.seat)}' is not a seat number; they run 1 to ${seats.length}` }
    }
    if (!text) return { ok: false, reason: `seat ${brief.seat}'s brief is empty` }
    if (bySeat.has(brief.seat)) return { ok: false, reason: `seat ${brief.seat} was given two briefs` }
    bySeat.set(brief.seat, text)
  }

  const round = state.round + 1
  for (const [i, seat] of seats.entries()) {
    const brief = bySeat.get(i + 1) ?? ''
    addMessage(seat.id, 'human', roundBriefFor(parent, seats, i, brief, round))
  }
  // ⛔ Every seat leaves its settled status *before* the organizer is re-blocked. See above.
  for (const seat of seats) continueSeat(seat.id)

  // ⚠️ **Said out loud rather than assumed.** `admit()` below recomputes from the world, which is
  // the honest reading — so a seat that did *not* leave its settled status leaves the organizer
  // legitimately dispatchable into a round nobody is answering. That is a bug in the caller, not
  // in the arithmetic, and it is invisible unless something names it: the debate would simply
  // arbitrate the previous round's positions again and look like it had worked.
  const stuck = seats.filter((seat) => SETTLED.includes(requireTask(seat.id).status))
  if (stuck.length > 0) {
    log.warn(
      `t${parent.seq} round ${round}: ${stuck.map((s) => `t${s.seq}`).join(', ')} did not leave a ` +
        'settled status, so this task may be dispatched before they answer'
    )
  }

  writeDebateState(parent.id, { ...state, round })
  const listed = seats.map((s) => `t${s.seq}`).join(', ')
  addMessage(parent.id, 'system', `Round ${round} — briefs sent to ${seats.length} seats`, null, [], {
    detail: `${listed}. This task waits for all of them again, then arbitrates.`
  })
  setStatus(parent.id, 'blocked', {
    holdReason: `waiting on ${seats.length} debate seats answering round ${round} (${listed})`
  })
  // ⚠️ Recomputed from the world, never trusted from the write above — `applySplit`'s rule.
  admit(parent.id)
  log.info(`t${parent.seq} opened debate round ${round} across ${seats.length} seats`)
  return { ok: true }
}

// ---------------------------------------------------------------------------- the phases

/**
 * Which turn of a debate this is.
 *
 * ⛔ Derived from the seats and the stored verdict, not from a phase column — `planPhaseOf`'s own
 * reasoning: a phase column is a second copy of a fact the edges already carry, and the two would
 * disagree the first time a round half-failed.
 *
 * ⚠️ Selecting a prompt on this is **not** a violation of *never branch on a mode name*. That rule
 * is about adapters and objectives, which are data. What kind of thing a task is is a domain fact,
 * and `planPhaseOf` sits beside this doing the same thing.
 */
export function debatePhaseOf(task: Task): 'seating' | 'arbitrating' | 'executing' | null {
  if (task.kind !== 'debate') return null
  if (task.debate?.verdict) return 'executing'
  return seatsOf(task.id).length === 0 ? 'seating' : 'arbitrating'
}

// ---------------------------------------------------------------------------- the citation check

export interface Citation {
  path: string
  exists: boolean
}

/**
 * ⚠️ Deliberately conservative. It wants `a/b.ts`-shaped things — at least one directory separator
 * and a short extension — because a rule loose enough to catch `README` also catches every prose
 * noun with a full stop after it, and a report full of false positives is a report nobody reads.
 */
const PATH_LIKE = /(?:[A-Za-z0-9_.@-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,6}/g

/**
 * ⭐ **The one thing about an argument this tool can establish rather than believe.**
 *
 * A debater naming a file is making a claim about where something lives, and in a repository that
 * claim is checkable: the path either resolves or it does not. Published work on debate *hacking* —
 * fabricated evidence, overconfident claims, redundancy dressed as verification — recommends
 * evidence verification by quote matching; a file path is strictly better than a quote match,
 * because it has a ground truth.
 *
 * ⛔ **A report, never a penalty.** It does not score the seat, does not exclude it and does not
 * edit its words. It is listed beside the seat's name in the organizer's prompt and on the board,
 * and what to make of it is the organizer's judgement.
 *
 * ⚠️ There is precedent in this repository: `docs.test.ts` extracts `src/…` paths from backticks
 * and tests `existsSync`, because *"a doc naming a file is making a claim about where something
 * lives"*.
 *
 * ⚠️ **`workspaceRoot` is the project's own root, not the seat's worktree**, and that is deliberate:
 * a seat's workspace is released when its run ends, so by the time the organizer reads its position
 * the directory the claim was made against may not exist. The project root is the one checkout that
 * is always there. ⛔ The cost is real and worth naming: a path a seat *created* on its own branch
 * reads as unresolved, which is why this reports rather than penalises. A seat is told not to change
 * anything, so a path it cites should be one that was already there.
 */
export function citationReport(text: string, workspaceRoot: string | null): Citation[] {
  const seen = new Map<string, boolean>()
  for (const match of text.matchAll(PATH_LIKE)) {
    const raw = match[0]
    if (seen.has(raw)) continue
    // ⚠️ A URL is not a claim about this repository. `https://x/y.html` matches the shape and means
    // something else entirely, so the hostname form is dropped rather than reported as missing.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text.slice(Math.max(0, (match.index ?? 0) - 8), match.index ?? 0) + raw)) {
      continue
    }
    let exists = false
    if (workspaceRoot) {
      const candidate = isAbsolute(raw) ? raw : join(workspaceRoot, raw)
      // ⚠️ `normalize` rather than `resolve`, and the containment test is on the normalised string:
      // a citation of `../../etc/passwd` is not a claim about this repository either.
      const inside = isAbsolute(raw) ? candidate.startsWith(workspaceRoot) : !normalize(raw).startsWith('..')
      exists = inside && existsSync(candidate)
    }
    seen.set(raw, exists)
  }
  return [...seen.entries()].map(([path, exists]) => ({ path, exists }))
}

/** The unresolved half of a citation report, as the line that goes next to a seat's name. */
export function citationLine(citations: Citation[]): string | null {
  const missing = citations.filter((c) => !c.exists).map((c) => c.path)
  if (missing.length === 0) return null
  return `does not resolve in this repository: ${missing.join(', ')}`
}

// ---------------------------------------------------------------------------- the flip report

export interface FlipReport {
  /** Paths this round cites that no earlier round of the same seat cited. */
  newPaths: Citation[]
  /** How many of this round's citations an earlier round had already made. */
  repeated: number
}

/**
 * ⭐ **The evidence side of a change of position — the half of a flip this tool can establish.**
 *
 * Published work on sycophancy in multi-agent debate finds the damage at the *flip*: a seat that
 * adopts a peer's answer because the peer sounded confident, or because *"they argued it better"*,
 * rather than because evidence arrived — and finds expressed disagreement decaying round by round
 * for exactly that reason. Whether a seat changed its mind is not something a deterministic check
 * can read out of prose. Whether it cited anything it had not cited before **is**: a position
 * that moved while citing no new path moved on words alone. That is reported here, per seat, per
 * round, beside the citation report — and like the citation report it is ⛔ **a report, never a
 * penalty**. A seat may have changed its mind for a reason it did not footnote; what to make of
 * it is the organizer's judgement, and the change ledger `roundBriefFor` asks for is where the
 * seat gets to say.
 *
 * ⚠️ Null on round 1, where there is nothing to have flipped from.
 */
export function flipReport(positions: string[], workspaceRoot: string | null): FlipReport | null {
  if (positions.length < 2) return null
  const before = new Set(
    positions.slice(0, -1).flatMap((p) => citationReport(p, workspaceRoot).map((c) => c.path))
  )
  const now = citationReport(positions[positions.length - 1] ?? '', workspaceRoot)
  const newPaths = now.filter((c) => !before.has(c.path))
  return { newPaths, repeated: now.length - newPaths.length }
}

/** The flip report as the line that goes next to a seat's name, or null where there is none. */
export function flipLine(report: FlipReport | null): string | null {
  if (!report) return null
  if (report.newPaths.length === 0) {
    return (
      'this round cites no path it had not cited in an earlier round' +
      (report.repeated > 0 ? ` (${report.repeated} repeated)` : ' (and no path at all)') +
      ' — a change of position here rests on words alone'
    )
  }
  const listed = report.newPaths.map((c) => (c.exists ? c.path : `${c.path} (does not resolve)`)).join(', ')
  return `newly cites ${report.newPaths.length} path(s) no earlier round cited: ${listed}`
}

/**
 * The confidence a seat stated, as it stated it.
 *
 * ⚠️ Text, never a number: seats write `0.85/0.8/0.75`, `~0.8`, `78%` and `high`, and turning any
 * of those into a figure would be this tool believing something it cannot establish. The prompt
 * asks for a `Confidence: …` line and that line is preferred; failing one, the first sentence that
 * mentions confidence is taken, capped so it stays a label.
 */
export function statedConfidence(text: string): string | null {
  const line = /^[ \t>*_`#-]*confidence[*_`]*\s*[:：]\s*(\S[^\n]*)$/im.exec(text)?.[1]
  const said = line ?? /confiden(?:ce|t)[^\n]*/i.exec(text)?.[0]
  if (!said) return null
  const trimmed = said.trim()
  return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed
}

// ---------------------------------------------------------------------------- the agreement

export interface Agreement {
  agreed: string
  dissent: string
  confidence: string
  unresolved: string
}

/**
 * ⚠️ Shorter than "there was none; the seats never contested X" can be written. It is not a
 * quality bar — nothing here scores an argument — it is the length below which the field is an
 * emptiness with letters in it.
 */
export const MIN_DISSENT_CHARS = 40

/**
 * ⛔ **Four parts, and a reply missing any of them is refused with the reason.**
 *
 * The dissent field is the load-bearing one. Published work finds consensus-seeking debaters
 * *neglect critical disagreements in order to agree*, so `converged` may never be allowed to mean
 * *they agreed*: an agreement with an empty dissent section is refused, and if there genuinely was
 * none the organizer has to say that and say what was never contested.
 *
 * ⚠️ **This is the closed-set rule, and the rule that comes before it still applies**: a turn that
 * ended in `isError` carries the vendor's JSON where the answer goes and validates as badly as a bad
 * answer. Establish there is a reply before judging its shape — see `judgment.ts`.
 */
export function validateAgreement(input: Partial<Agreement>): { ok: true; agreement: Agreement } | { ok: false; reason: string } {
  const agreed = input.agreed?.trim() ?? ''
  const dissent = input.dissent?.trim() ?? ''
  const confidence = input.confidence?.trim() ?? ''
  const unresolved = input.unresolved?.trim() ?? ''
  if (!agreed) {
    return { ok: false, reason: 'the agreement is empty. Say what to do, concretely enough to execute.' }
  }
  if (!dissent) {
    return {
      ok: false,
      reason:
        'the dissent section is empty, and it may never be. Say who disagreed, with what, and on ' +
        'what grounds. If there genuinely was no disagreement, say that here and say what was ' +
        'never contested — an agreement nobody examined is not evidence.'
    }
  }
  // ⛔ A dissent that fits in a breath is the empty one wearing a word. "None", "N/A" and "all
  //    agreed" are what the refusal above exists to refuse, and they are how it was being passed.
  //    Whether the dissent *names its evidence* cannot be checked here; that it says something can.
  if (dissent.length < MIN_DISSENT_CHARS) {
    return {
      ok: false,
      reason:
        `the dissent section is ${dissent.length} characters, which is not a dissent. Name each seat ` +
        'that disagreed, what it held, and on what grounds; for every dissent that was withdrawn ' +
        'during the debate, name the evidence that withdrew it — a seat conceding is not evidence. ' +
        'If nothing was ever contested, say what was never contested and why that is not agreement.'
    }
  }
  if (!confidence) {
    return { ok: false, reason: 'say how confident you are in this agreement, and why.' }
  }
  if (!unresolved) {
    return {
      ok: false,
      reason: 'say what the debate did not settle and what would settle it. "Nothing" is an answer; silence is not.'
    }
  }
  return { ok: true, agreement: { agreed, dissent, confidence, unresolved } }
}

/** How an agreement reads on the thread and in the verdict card. */
export function renderAgreement(a: Agreement): string {
  return [
    `Agreed: ${a.agreed}`,
    '',
    `Dissent: ${a.dissent}`,
    '',
    `Confidence: ${a.confidence}`,
    '',
    `Unresolved: ${a.unresolved}`
  ].join('\n')
}

// ---------------------------------------------------------------------------- writes

/**
 * The only writer of `tasks.debate_json`.
 *
 * ⚠️ Narrow on purpose: `updateTask` names every column it writes and this is not among them, so a
 * roster is not something a UI patch can reach.
 */
export function writeDebateState(taskId: string, state: DebateState): Task {
  db()
    .prepare('update tasks set debate_json = ?, updated_at = ? where id = ?')
    .run(JSON.stringify(state), Date.now(), taskId)
  const task = requireTask(taskId)
  emit({ type: 'task.changed', task })
  return task
}

export function recordVerdict(taskId: string, verdict: DebateVerdict): Task {
  const task = requireTask(taskId)
  if (!task.debate) throw new Error(`t${task.seq} carries no debate state`)
  return writeDebateState(taskId, { ...task.debate, verdict })
}

/**
 * `debate` → `conversation`, and nothing else, ever.
 *
 * ⛔ **One way, one moment, one caller.** *"Ask follow-up questions"* is literally a request to
 * become a conversation, whose contract is `isOpenConversation(task)` — read by the prompt's closing
 * instruction, by `resolveFinishPolicy`, by `endConversationTurn`, by `land_work` and by the
 * thread's buttons. Converting keeps the organizer's warm session, which holds the whole debate;
 * filing a new task would pay a cold rebuild of exactly the context this tool exists to preserve.
 *
 * ⛔ **`updateTask` is deliberately not the writer.** A mutation reachable from `task.update` would
 * be a kind anybody could change on any row, which is precisely the property that makes `kind` safe
 * to branch on in `promptFor` today. So: the current kind is asserted first, the reverse direction
 * is impossible by construction, and a second application is refused.
 *
 * ⚠️ The transition writes a thread line, so what looks afterwards like an ordinary conversation can
 * still be traced back to the debate that produced it.
 */
export function becomeConversation(taskId: string): DebateCheck {
  const task = requireTask(taskId)
  if (task.kind !== 'debate') {
    return {
      ok: false,
      reason: `t${task.seq} is a '${task.kind}' task; only a debate may become a conversation, and only once`
    }
  }
  db()
    .prepare("update tasks set kind = 'conversation', finish_policy = 'inherit', updated_at = ? where id = ? and kind = 'debate'")
    .run(Date.now(), taskId)
  addMessage(taskId, 'system', 'This debate is now a conversation', null, [], {
    detail:
      'The operator chose to keep asking questions. The organizer keeps its session — and with it ' +
      'every position and every round — and this task now ends each turn back with you.'
  })
  emit({ type: 'task.changed', task: requireTask(taskId) })
  log.info(`t${task.seq} became a conversation from its debate verdict`)
  return { ok: true }
}

/**
 * Every position one seat has argued, oldest first — one per round it answered.
 *
 * ⚠️ `agent` rows only. A seat's opening prompt is written with role `human` (its debate was filed
 * by a person), so nothing here can mistake the instruction for an argument.
 */
export function agentPositionsFor(seatTaskId: string): string[] {
  return (
    db()
      .prepare(
        `select text from task_messages where task_id = ? and role = 'agent' order by ts, id`
      )
      .all(seatTaskId) as Array<{ text: string }>
  )
    .map((r) => r.text.trim())
    .filter((t) => t.length > 0)
}

/**
 * What the organizer itself has said on the debate's own thread, oldest first.
 *
 * ⚠️ The `round` here is the **position** of the organizer's turn, not a stored round number: the
 * organizer speaks once per round, so the *n*th thing it said belongs beside the *n*th row of the
 * board. A debate whose organizer failed a round has one fewer line and the board simply has a gap.
 */
export function organizerLinesFor(parentTaskId: string): Array<{ round: number; text: string }> {
  return (
    db()
      .prepare(
        `select text from task_messages where task_id = ? and role = 'agent' order by ts, id`
      )
      .all(parentTaskId) as Array<{ text: string }>
  )
    .map((r, i) => ({ round: i + 1, text: r.text.trim() }))
    .filter((r) => r.text.length > 0)
}

// ---------------------------------------------------------------------------- seat prompts

/**
 * The seat's lens, when the roster gave it one.
 *
 * ⛔ **An evidence base, never a stance.** Published work finds an *assigned* position — a devil's
 * advocate, a seat told to disagree — degrades accuracy, and that moderate disagreement beats
 * maximal; what it does not find harmful is seats that examined different evidence. So a lens says
 * what to read first and most carefully, and says in the same breath that the seat may reach the
 * answer every other seat reaches. ⚠️ The composer offers lenses only when every seat is one model
 * family (`adapterSpread === 1`), where prompt-level diversity is the only diversity available;
 * with two families in the room the roster already bought it. The daemon does not refuse a lens on
 * a mixed roster — a notice is not a gate — it simply never offers one.
 */
function lensParagraph(lens: string | null | undefined): string[] {
  const text = lens?.trim()
  if (!text) return []
  return [
    `Your lens: ${text}`,
    '',
    'That is the evidence you are asked to examine first and most carefully — it is NOT a position ' +
      'to hold. Reach whatever answer that evidence supports, including the answer you would guess ' +
      'the other seats reach.',
    ''
  ]
}

/**
 * How a seat is asked to close its turn.
 *
 * ⛔ **The summary IS the position, and the prompt says so against the tool's own hint.**
 * `task_complete` describes its summary as *"One line: what was done"*, and on t382 (2026-09-12)
 * two of three seats obeyed the tool over the prompt in both rounds, so the organizer received
 * three paid runs and one arbitrable position. The peephole net in `landCompletion` recovers what
 * it can after the fact; the sentence below is what stops the loss at the source.
 */
const SEAT_CLOSING =
  '⛔ Then call the MCP tool `task_complete` with your WHOLE position as the summary — every ' +
  'paragraph of it, not a one-line report. The tool’s "one line" hint does not apply to a debate ' +
  'seat: the summary is the only part of what you write that the organizer and the other seats ' +
  'are guaranteed to read. Do not commit, and do not change anything: this task exists to produce ' +
  'an argument, not a diff.'

/**
 * What a seat is told on round 1.
 *
 * ⛔ **The prompt must never ask an agent to win.** Published work measures *competitive* framing
 * degrading results by up to 15 percentage points, while collaborative truth-seeking framing with
 * evidence verification beat single-agent self-consistency at a matched token budget. "Debate" is
 * the operator's word for the feature; what the seat is asked for is the most defensible answer.
 *
 * ⛔ **And it must never ask an agent to disagree.** Sycophancy is real — strict conformity to a
 * peer's answer, vacuous peer reasoning adopted as evidence, disagreement that decays round by
 * round — but the published lever is at the moment a seat *changes* its position, not the stance
 * it opens with: a forced-dissent rule degrades accuracy the same way a forced win does, and it
 * would hollow out the `dissent` field `validateAgreement` rests on. So this prompt asks for a
 * position, a falsification condition and a confidence, and `roundBriefFor` asks what became of
 * each. t382 (2026-09-12) is where that was decided.
 */
export function seatPromptFor(parent: Task, index: number, total: number): string {
  const lens = parent.debate?.seats[index]?.lens
  return [
    `You are one of ${total} agents answering this question independently (you are seat ${index + 1}).`,
    '',
    parent.title,
    '',
    'The others cannot see your answer and you cannot see theirs. That is deliberate, and an answer ' +
      'that hedges towards what you imagine they will say is worth nothing.',
    '',
    ...lensParagraph(lens),
    'Read enough of the repository to be concrete — real paths, real functions. State: the answer ' +
      'you would defend, the reasoning behind it, what would have to be true for you to be wrong ' +
      '(a specific, checkable condition — a path, a line, a command and its output — not a mood), ' +
      'and how confident you are, on its own line as `Confidence: …`. That condition is quoted ' +
      'back to you in every later round and you are asked whether it was met.',
    '',
    '⛔ Cite real paths. Every `path/to/file.ts` you name is checked against this repository before ' +
      'anybody reads your position, and a citation that does not resolve is reported next to your ' +
      'name. It is a report, not a penalty — but a fabricated path is the cheapest lie to catch.',
    '',
    SEAT_CLOSING
  ].join('\n')
}

/**
 * What a seat is told on round 2 and after.
 *
 * ⛔ **Colleagues, not opponents**, for the reason above. And ⚠️ **do not converge for the sake of
 * converging**: consensus-seeking debaters neglect critical disagreements in order to agree, so an
 * unresolved disagreement recorded honestly is worth more than an agreement nobody believes.
 *
 * ⭐ **The seat's own prior position is quoted back, and the seat is asked what became of it.**
 * Round 1 elicits *what would have to be true for you to be wrong*; until t382 nothing ever asked
 * whether it happened, so the check only looked like it was happening. Published work on sycophancy
 * finds the damage at the *flip* — a position changed because a peer sounded confident, not because
 * evidence arrived — and the deterministic half of the answer is `flipReport`; this is the half the
 * seat is asked to write: a ledger, per peer, of what it accepted, what it rejected and what it
 * could not refute but does not believe, each with the evidence. *"They argued it better"* is named
 * as a non-reason, because it is the one every flip gives.
 *
 * ⚠️ Under `exchange: 'full'` every other seat's position travels verbatim; under `'digest'` the
 * organizer's brief travels alone. That is **data** in `debate_json`, never a branch on seat count.
 */
export function roundBriefFor(
  parent: Task,
  seats: Task[],
  index: number,
  brief: string,
  round: number
): string {
  const parts: string[] = [`Round ${round} of this debate. The organizer's brief for you:`, '', brief]
  const self = seats[index]
  const own = self ? lastPositionOf(self) : null
  parts.push(
    '',
    'Your own position from the previous round, verbatim — the one you are revising:',
    '',
    own ?? '(no position recorded — this round starts from the question itself)'
  )
  const lens = lensParagraph(parent.debate?.seats[index]?.lens)
  if (lens.length > 0) parts.push('', ...lens.slice(0, -1))
  if (parent.debate?.exchange === 'full') {
    const others = seats
      .map((seat, i) => ({ seat, i }))
      .filter(({ i }) => i !== index)
      .map(({ seat, i }) => `--- Seat ${i + 1} (t${seat.seq}) said:\n${lastPositionOf(seat) ?? '(no position recorded)'}`)
    if (others.length > 0) {
      parts.push('', 'What the others argued, verbatim and unedited:', '', others.join('\n\n'))
    }
  }
  parts.push(
    '',
    'These are colleagues working on the same problem, not opponents. Where you were wrong, say so ' +
      'and say why — changing your mind on evidence is the most valuable thing you can do here. ' +
      'Where you were right and they disagree, say what evidence would settle it.',
    '',
    '⛔ Before your revised position, write a change ledger, and keep it short:',
    '  • Your falsification condition — the thing you said would have to be true for you to be ' +
      'wrong. Has it happened? Quote the path, line or command output that met it or failed it.',
    '  • For each other seat, one of: AGREE / DISAGREE / NOT REFUTED BUT UNCONVINCED — and for ' +
      'every position you change, the specific new evidence that changed it. "Seat N argued it ' +
      'better", "Seat N seemed confident" and "the organizer leaned that way" are not evidence; ' +
      'a path, a line, a test, a measurement or a document is.',
    '  • What you retract, if anything, and what you now hold that you did not before.',
    '',
    '⚠️ Do not converge for the sake of converging: an unresolved disagreement recorded honestly is ' +
      'worth more than an agreement nobody believes. And do not dig in for the sake of digging in: ' +
      'a position kept against evidence is worth exactly as little.',
    '',
    'Answer with the ledger and your revised position, with your confidence on its own line as ' +
      '`Confidence: …`. ' +
      SEAT_CLOSING
  )
  return parts.join('\n')
}

/**
 * A seat's most recent position: the last thing its agent said on its own thread.
 *
 * ⚠️ **`agent` rows only, which is what makes it safe.** A task's own prompt is written onto its
 * thread as a `human` message (`updateTask`), and so is every brief this file sends, so nothing here
 * can hand a seat its own instruction back as "what seat 2 argued".
 */
export function lastPositionOf(seat: Task): string | null {
  const found = db()
    .prepare(
      `select text from task_messages
        where task_id = ? and role = 'agent'
        order by ts desc, id desc limit 1`
    )
    .get(seat.id) as { text: string } | undefined
  const text = found?.text?.trim()
  return text ? text : null
}

