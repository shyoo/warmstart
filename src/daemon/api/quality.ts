/** Reviews, cost, routing, statistics and the controller chat. */
import type { CostReport } from '@shared/protocol.js'
import { createManualReview, deleteManualReview, deleteReview, updateManualReview } from '../review.js'
import { cancelReview, requestReview, reviewEligibility } from '../reviewer.js'
import { getWorker, listWorkers } from '../workers.js'
import { routingDecisions } from '../routingdecisions.js'
import { qualityReport, reviewQueue, ungradedTasks } from '../quality.js'
import { cancelBatch, currentBatch, startBatch } from '../gradebatch.js'
import { statisticsReport } from '../statistics.js'
import { listSessions } from '../sessions.js'
import { createTask, requireTask } from '../tasks.js'
import {
  agentPositionsFor,
  citationReport,
  openDebate,
  organizerLinesFor,
  seatsOf,
  statedConfidence,
  validateDebate
} from '../debate.js'
import { getProject } from '../projects.js'
import { debatePreview } from '../debatecost.js'
import { tick } from '../scheduler.js'
import { controllerReport, drainConsults } from '../controller.js'
import { chatHistory, clearChat, sendChat } from '../chat.js'
import { costFactors, estimateTask } from '../estimator.js'
import { recentClockEvents, remainingTokens, reserveState } from '../reserve.js'
import { decide, medianHumanLatencyMs } from '../cacheclock.js'
import { lastRateLimit, windowResetsAt } from '../quota.js'
import { DEFAULT_OBJECTIVE } from '../objective.js'
import { settings } from '../settings.js'
import { lastSpend } from '../spend.js'
import type { Api, ApiContext } from './support.js'
import { checkConstraints, checkedChildAccounts, modelReport, velocityReport } from './support.js'

type QualityMethod =
  | 'review.eligibility' | 'review.request' | 'review.cancel' | 'review.delete' | 'review.manual.create' | 'review.manual.update' | 'review.manual.delete' | 'cost.report'
  | 'routing.decisions' | 'routing.velocity' | 'routing.models' | 'quality.report' | 'statistics.report'
  | 'quality.ungraded' | 'quality.queue' | 'quality.batch.start' | 'quality.batch' | 'quality.batch.cancel'
  | 'scheduler.tick' | 'controller.report' | 'controller.drain' | 'task.plan' | 'task.estimate'
  | 'task.debate' | 'task.debateState' | 'task.estimatePreview'
  | 'chat.history' | 'chat.send' | 'chat.clear'

export function apiQuality(_ctx: ApiContext): Pick<Api, QualityMethod> {
  return {
    // ⛔ Two calls, and the split is the point. `review.eligibility` is free and answers *before*
    // anybody presses anything — no peer, or no recoverable diff, are both states the button has to
    // state rather than discover. `review.request` spends a turn.
    'review.eligibility': (p) => reviewEligibility(p.taskId),
    'review.request': (p) => requestReview(p.taskId, p.workerId),
    'review.cancel': (p) => {
      const target = p.reviewId ?? p.taskId
      if (!target) return { ok: false, reason: 'missing reviewId or taskId' }
      return cancelReview(target)
    },
    'review.delete': (p) => {
      if (!p.reviewId) return { ok: false, reason: 'missing reviewId' }
      return deleteReview(p.reviewId)
    },
    'review.manual.create': (p) => createManualReview(p.taskId, p.score, p.explanation),
    'review.manual.update': (p) => updateManualReview(p.reviewId, p.score, p.explanation),
    'review.manual.delete': (p) => deleteManualReview(p.reviewId),
    'cost.report': () => {
      const objective = settings().objective ?? DEFAULT_OBJECTIVE
      const live = listSessions()
      return {
        generatedAt: Date.now(),
        objective,
        reserves: listWorkers().map((w) => reserveState(w.id)),
        // Evaluated, not executed: this is the panel that answers "why is that session still open?"
        decisions: live.map((session) => decide(session, { objective })),
        recent: recentClockEvents(30) as CostReport['recent'],
        medianHumanLatencyMs: medianHumanLatencyMs(),
        // ⚠️ Published whole, `learnedFrom` and all. The money fields are measured now, and
        // `null` still means "nothing on this rung could be priced" rather than $0.00. `usdSamples`
        // is its own count on every rung: a key's priced runs are a subset of its runs, so it is
        // routinely far below `samples`. ⛔ Never re-mapped field by field on the way out — a rung
        // that gains a basis the estimator publishes would silently lose it here.
        costFactors: costFactors(),
        // ⚠️ One entry per worker that has ever been probed, and none for the rest — an account
        // nobody has asked is absent here rather than present with a meter at zero. `sampledAt` is
        // the **vendor's** timestamp where the vendor supplied one, which is what makes the age on
        // screen an honest age; `error` carries the last failed probe verbatim.
        spend: listWorkers().flatMap((w) => {
          const reading = lastSpend(w.id)
          return reading
            ? [
                {
                  workerId: w.id,
                  label: w.label,
                  meters: reading.meters,
                  sampledAt: reading.sampledAt,
                  error: reading.error ?? null
                }
              ]
            : []
        }),
        settings: settings(),
        workers: listWorkers().map((w) => {
          const remaining = remainingTokens(w.id)
          const reset = windowResetsAt(w.id)
          const rate = lastRateLimit(w.id)
          return {
            workerId: w.id,
            label: w.label,
            remainingTokens: remaining.tokens,
            remainingBasis: remaining.basis,
            windowResetsAt: reset?.at ?? null,
            windowResetSource: reset?.source ?? null,
            liveRateLimitStatus: rate?.status ?? null
          }
        })
      }
    },
    // ⛔ Reads, all of them, with one exception: `quality.batch.start` spends turns and is only ever
    // reached by somebody pressing a button. Nothing in a scheduler tick calls it.
    'routing.decisions': (p) => routingDecisions(p?.limit ?? 5, p?.offset ?? 0),
    'routing.velocity': () => velocityReport(),
    'routing.models': () => modelReport(),
    'quality.report': () => qualityReport(),
    // ⚠️ Anything but the literal `all` reads the default window: a stale or mistyped preference
    //    must not turn into an unbounded read.
    'statistics.report': (p) => statisticsReport(Date.now(), p?.window === 'all' ? 'all' : 'recent'),
    'quality.ungraded': (p) => ungradedTasks(p?.limit ?? 25),
    'quality.queue': (p) =>
      reviewQueue(p?.filter ?? 'none', p?.limit ?? 25, p?.offset ?? 0, p?.gradableOnly ?? false),
    // ⛔ Starts a queue and answers; it does not wait for the grades. See `quality.batch.start`.
    'quality.batch.start': (p) => startBatch(p.count, p.threshold),
    'quality.batch': () => currentBatch(),
    'quality.batch.cancel': () => cancelBatch(),
    'scheduler.tick': () => tick(),
    'controller.report': (p) => controllerReport(p?.limit ?? 40, p?.offset ?? 0),
    // ⚠️ The one RPC that can spend tokens by being called. Nothing in a scheduler tick calls it.
    'controller.drain': () => drainConsults(),
    'task.plan': (p) =>
      createTask({
        title: p.title,
        kind: 'plan',
        projectId: p.projectId ?? null,
        ...(p.prompt ? { prompt: p.prompt } : {}),
        // ⛔ The planner's own settings. Until t182 a plan task took none of these, because it was
        // never dispatched and nothing would have read them; it is a real run now.
        ...(p.priority ? { priority: p.priority } : {}),
        ...(p.finishPolicy ? { finishPolicy: p.finishPolicy } : {}),
        ...(p.sessionSharing ? { sessionSharing: p.sessionSharing } : {}),
        ...(p.status ? { status: p.status } : {}),
        ...(p.notBefore ? { notBefore: p.notBefore } : {}),
        ...(p.constraints ? { constraints: checkConstraints(p.constraints) } : {}),
        ...(p.dependsOn?.length ? { dependsOn: p.dependsOn } : {}),
        ...(p.attachmentIds?.length ? { attachmentIds: p.attachmentIds } : {}),
        // ⛔ **The fan-out the operator picked is written into the mandate**, which is what
        // `createTask` actually enforces. There is never a second, invisible cap: the old shape had
        // `ROOT_MANDATE.maxChildren = 5` against a decomposition cap of 8, so a split of six was
        // refused with a message about a limit nobody had set.
        ...(p.maxChildren ? { mandate: { maxChildren: p.maxChildren } } : {}),
        // ⛔ Checked at the door, like every other constraint. The accounts and models named for the
        // pieces are stored here and read by `applySplit` months later, with no operator in the
        // room; an id that names nothing would produce children no candidate loop can ever match and
        // a model the cost model cannot price. `checkConstraints` refuses both, here, once.
        ...(p.childDefaults
          ? { childDefaults: { ...p.childDefaults, ...checkedChildAccounts(p.childDefaults) } }
          : {})
      }),
    'task.estimate': (p) => {
      // ⚠️ The worker is optional and the answer changes enormously with it. A caller that wants
      // "what will this cost" without saying where has asked a fleet-neutral question and gets a
      // fleet-neutral answer; the basis string says which it got.
      const worker = p.workerId ? getWorker(p.workerId) : null
      const estimate = estimateTask(
        requireTask(p.id),
        worker ? { adapterId: worker.adapterId } : undefined
      )
      return {
        tokens: estimate.tokens,
        pricedTokens: estimate.pricedTokens,
        // ⚠️ `null` where the runs behind the answer could not be priced, which is a different
        // statement from "it is free"; `usdConfidence` is `none` in exactly that case.
        usd: estimate.usd,
        usdConfidence: estimate.usdConfidence,
        confidence: estimate.confidence,
        basis: estimate.basis,
        factor: estimate.factor,
        assumed: estimate.assumed
      }
    },
    /**
     * File a Debate task and seat it in one call.
     *
     * ⛔ **Validated before anything is written.** `openDebate` is all-or-nothing, but a roster
     * that was never going to pass would still have left a parent task with no seats sitting in
     * the queue — a debate that dispatches an organizer with nothing to arbitrate.
     *
     * ⛔ **The operator's seat count is written into the mandate**, which is what `createTask`
     * actually enforces. There is never a second, invisible cap — the Plan & Split lesson, where a
     * split of six was refused with a message about a limit nobody had set.
     */
    'task.debate': (p) => {
      const precheck = validateDebate({ seats: p.seats, rounds: p.rounds, exchange: p.exchange })
      if (!precheck.ok) return { ok: false, reason: precheck.reason }
      const task = createTask({
        title: p.title,
        kind: 'debate',
        projectId: p.projectId ?? null,
        ...(p.prompt ? { prompt: p.prompt } : {}),
        ...(p.priority ? { priority: p.priority } : {}),
        ...(p.finishPolicy ? { finishPolicy: p.finishPolicy } : {}),
        ...(p.status ? { status: p.status } : {}),
        ...(p.notBefore ? { notBefore: p.notBefore } : {}),
        ...(p.constraints ? { constraints: checkConstraints(p.constraints) } : {}),
        ...(p.dependsOn?.length ? { dependsOn: p.dependsOn } : {}),
        ...(p.attachmentIds?.length ? { attachmentIds: p.attachmentIds } : {}),
        mandate: { maxChildren: p.seats.length },
        debate: { seats: p.seats, rounds: p.rounds, exchange: p.exchange, round: 1, verdict: null }
      })
      // ⚠️ A draft seats nothing. It dispatches nothing and holds nothing, so the seats are filed
      // when the operator promotes it — `promoteDraft` is where that happens.
      if (task.status === 'draft') return { ok: true, task }
      const opened = openDebate(task.id, { kind: 'human' })
      if (!opened.ok) return { ok: false, task, reason: opened.reason }
      return { ok: true, task: requireTask(task.id), seatSeqs: opened.seats.map((s) => s.seq) }
    },
    /**
     * The board.
     *
     * ⚠️ Every cell is agent output, so it travels as **text**. The renderer parses it with
     * `lib/markdown.ts`'s closed subset and draws elements this codebase writes — no raw HTML.
     */
    'task.debateState': (p) => {
      const task = requireTask(p.id)
      if (!task.debate) return null
      const project = task.projectId ? getProject(task.projectId) : null
      const seats = seatsOf(task.id).map((seat) => {
        const positions = agentPositionsFor(seat.id)
        return {
          taskId: seat.id,
          seq: seat.seq,
          status: seat.status,
          workerId: seat.constraints.workerId ?? seat.assignee ?? null,
          adapterId: (seat.constraints.workerId ? getWorker(seat.constraints.workerId) : null)?.adapterId ?? null,
          model: seat.ranModel ?? seat.constraints.model ?? null,
          rounds: positions.map((text, i) => ({
            round: i + 1,
            text,
            confidence: statedConfidence(text),
            citations: citationReport(text, project?.root ?? null)
          }))
        }
      })
      return { debate: task.debate, seats, organizer: organizerLinesFor(task.id) }
    },
    /**
     * ⛔ The renderer does not compute money. Every figure comes back with its basis, and `null`
     * rather than `$0.00` where nothing could be priced.
     */
    'task.estimatePreview': (p) => debatePreview(p),
    'chat.history': (p) => chatHistory(p?.threadId),
    'chat.send': (p) => sendChat(p.text, p.threadId),
    'chat.clear': (p) => {
      clearChat(p?.threadId)
      return { ok: true as const }
    }
  }
}
