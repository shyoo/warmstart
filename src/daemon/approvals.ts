import { randomUUID } from 'node:crypto'
import type {
  Approval,
  ApprovalDecision,
  ApprovalOrigin,
  ApprovalPolicyResult,
  ApprovalRule
} from '@shared/tasks.js'
import { db, row, rows } from './db.js'
import { emit } from './events.js'
import { log } from './log.js'
import { getSession } from './sessions.js'
import { costModel } from './costmodel.js'
import { adapter } from './adapters/index.js'
import { getProject, policyFor } from './projects.js'
import { canonicalPath } from './fspath.js'
import { addMessage, getTask, runForSession, setStatus } from './tasks.js'

/**
 * Approvals.
 *
 * ⛔ **An approval is not a task.** It blocks one live session right now; only that session can
 * consume the answer; its answer set is closed and finite; and it is void the moment the session
 * dies. A Task is none of those things. Filing approvals as tasks would bury the task list in rows
 * nobody re-reads and hand the scheduler work it cannot schedule.
 *
 * Three ways one is resolved, in order of preference:
 *
 *  1. **It never happens** - the agent's own mode absorbs it (Claude Code's `auto` classifier, an
 *     Antigravity `allow` rule). That is D5, and it does most of the work.
 *  2. **Policy answers it** - the project's rules, evaluated here, without a human.
 *  3. **A human answers it in one click**, from the Approvals bar. Never by opening a task.
 *
 * And the deadline is real money, which is why this is not a notification: a blocked session is idle,
 * and idle burns the cache clock. An approval only becomes task work - `awaiting_human` - once it has
 * gone unanswered long enough that holding the session open has stopped paying for itself.
 */

/**
 * After this, the approval stops being an interrupt and becomes a decision someone has to schedule.
 *
 * ⛔ **It must be shorter than `WAIT_TIMEOUT_MS`, and it was not.** At 30 minutes against a
 * 10-minute wait, the waiter always fired first and wrote `answered_at` - which is the exact column
 * `escalateStale` filters on - so no approval that actually waited could ever reach `awaiting_human`.
 * The escalation path had been unreachable since it was written, and had no test. Found 2026-08-30
 * while building the Question object, which has the same clock and must not repeat the mistake.
 *
 * ⚠️ Five minutes is not a guess at operator patience; it is the only interval that leaves the
 * escalation useful. An approval that escalates at 5 has five more minutes in which somebody can
 * still answer it from the bar and unblock the live session - after which it denies, because an
 * unanswered permission is not consent.
 */
export const DEFAULT_ESCALATE_AFTER_MS = 5 * 60 * 1000

/** How long a blocked caller waits before we answer for it. Must be under the caller's own timeout. */
const WAIT_TIMEOUT_MS = 10 * 60 * 1000

interface ApprovalRow {
  id: string
  session_id: string
  run_id: string | null
  task_id: string | null
  project_id: string | null
  origin: string
  tool: string
  target: string | null
  summary: string
  policy_result: string
  matched_rule: string | null
  asked_at: number
  deadline_at: number | null
  escalate_after_ms: number
  answered_at: number | null
  answer: string | null
  answered_by: string | null
  escalated_at: number | null
}

function toApproval(r: ApprovalRow): Approval {
  return {
    id: r.id,
    sessionId: r.session_id,
    runId: r.run_id,
    taskId: r.task_id,
    projectId: r.project_id,
    origin: r.origin as ApprovalOrigin,
    tool: r.tool,
    target: r.target,
    summary: r.summary,
    policyResult: r.policy_result as ApprovalPolicyResult,
    matchedRule: r.matched_rule,
    askedAt: r.asked_at,
    deadlineAt: r.deadline_at,
    escalateAfterMs: r.escalate_after_ms,
    answeredAt: r.answered_at,
    answer: r.answer as ApprovalDecision | null,
    answeredBy: r.answered_by as Approval['answeredBy'],
    escalatedAt: r.escalated_at
  }
}

// ---------------------------------------------------------------------------- rules

/** `Bash(git *)`, `Read(src/**)`, or a bare `Edit` meaning every use of the tool. */
export function parseRule(text: string): { tool: string; pattern: string } | null {
  const match = /^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*(?:\((.*)\))?\s*$/.exec(text)
  if (!match?.[1]) return null
  return { tool: match[1], pattern: match[2]?.trim() || '*' }
}

/**
 * Glob match over the target. Deliberately not a regex from user input: a rule is a safety boundary,
 * and a mistyped regex that happens to match everything is exactly the failure this must not have.
 */
export function matchesPattern(pattern: string, target: string): boolean {
  if (pattern === '*') return true
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`).test(target)
}

/** What a pooled worktree is called inside a remembered rule. Never a real directory. */
export const WORKSPACE_TOKEN = '<workspace>'

/**
 * Rewrite the pooled worktree a command happens to be running in as `<workspace>`.
 *
 * ⛔ **This is what makes "Always" mean always.** The rule an "Always" answer wrote was the literal
 * target, worktree path and all — `Bash(cd "C:\…\ws1" && npm run typecheck 2>&1 | head -50)`. The
 * pool has four members and a task lands in whichever is free, so that rule could not match the next
 * run of the same command and never did: this install had `npm run typecheck`, `npm test`, `npm run
 * lint` and `npm run build` each remembered **twice** by 2026-09-06, from ws1 alone, and the
 * operator was asked all four again. The queue was supposed to empty itself and was instead
 * accumulating rules that could never fire.
 *
 * ⛔ **A token, deliberately, and not a `*`.** Widening the path to a wildcard would have been one
 * character and would have let `cd "x" && rm -rf y && cd "z" && npm test` match a rule about `npm
 * test` — `matchesPattern` globs over the whole string and a `*` in the middle of a shell command
 * spans the `&&`. Substituting a fixed token on **both** sides instead leaves the rule an exact
 * match; all that changes is which directory the two sides agree not to mention.
 *
 * ⚠️ Only the pool members under this project's `workspaceRoot`, and only a whole path segment of
 * one: `withinPath`'s reason applies here too — `ws1` must not swallow `ws10`. A command naming a
 * path outside the pool is left exactly as it was, because a rule about *that* path is a rule the
 * operator meant to be about that path.
 */
export function normalizeTarget(projectId: string | null, target: string): string {
  const project = projectId ? getProject(projectId) : null
  if (!project || !target) return target
  const root = canonicalPath(policyFor(project).workspaceRoot)
  // Either separator on either side: these strings arrive from a shell, a config file and this app's
  // own path handling, and this install has the same root recorded as both `C:/Dev/…` and `C:\Dev\…`.
  const rootPattern = root
    .split(/[\\/]/)
    .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\\\/]')
  return target.replace(new RegExp(`${rootPattern}[\\\\/][^\\\\/"'\\s]+`, 'gi'), WORKSPACE_TOKEN)
}

export function listRules(projectId: string | null): ApprovalRule[] {
  return rows<{
    id: string
    project_id: string | null
    tool: string
    pattern: string
    effect: string
    created_by: string
    created_at: number
  }>(
    db()
      .prepare('select * from approval_rules where project_id is ? or project_id is null order by created_at')
      .all(projectId)
  ).map((r) => ({
    id: r.id,
    projectId: r.project_id,
    tool: r.tool,
    pattern: r.pattern,
    effect: r.effect as 'allow' | 'deny',
    createdBy: r.created_by as ApprovalRule['createdBy'],
    createdAt: r.created_at
  }))
}

export function addRule(input: {
  projectId: string | null
  text: string
  effect: 'allow' | 'deny'
  createdBy?: ApprovalRule['createdBy']
}): ApprovalRule {
  const raw = parseRule(input.text)
  if (!raw) throw new Error(`'${input.text}' is not a rule — expected e.g. Bash(npm test)`)
  // ⛔ Here rather than at the one call site that prompted it, because this is the only door a
  // learned rule comes through — the Approvals bar's "Always", the MCP `approve` tool and the
  // project settings pane all arrive at this line, and a rule that pins a pooled worktree is dead on
  // arrival whichever of them wrote it.
  const parsed = { ...raw, pattern: normalizeTarget(input.projectId, raw.pattern) }
  const id = randomUUID()
  db()
    .prepare(
      `insert into approval_rules (id, project_id, tool, pattern, effect, created_by, created_at)
       values (?,?,?,?,?,?,?)`
    )
    .run(
      id,
      input.projectId,
      parsed.tool,
      parsed.pattern,
      input.effect,
      input.createdBy ?? 'human',
      Date.now()
    )
  const rule = listRules(input.projectId).find((r) => r.id === id)
  if (!rule) throw new Error('rule vanished after insert')
  log.info(`remembered rule: ${input.effect} ${parsed.tool}(${parsed.pattern})`)
  return rule
}

export function removeRule(id: string): void {
  db().prepare('delete from approval_rules where id = ?').run(id)
}

/**
 * Evaluate a request against the rules.
 *
 * ⛔ Deny wins, always, and is checked first. A project that has said "never push" must not have that
 * overridden by a broader allow someone added later.
 */
export function evaluate(
  projectId: string | null,
  tool: string,
  target: string
): { result: ApprovalPolicyResult; rule: string | null } {
  const project = projectId ? getProject(projectId) : null
  const policy = project ? policyFor(project) : null

  const committed = (list: string[], effect: 'allow' | 'deny') =>
    list
      .map(parseRule)
      .filter((p): p is { tool: string; pattern: string } => p !== null)
      .map((p) => ({ ...p, effect, source: `${effect} ${p.tool}(${p.pattern}) [project.json]` }))

  const learned = listRules(projectId).map((r) => ({
    tool: r.tool,
    pattern: r.pattern,
    effect: r.effect,
    source: `${r.effect} ${r.tool}(${r.pattern})`
  }))

  const all = [
    ...committed(policy?.denyRules ?? [], 'deny'),
    ...learned.filter((r) => r.effect === 'deny'),
    ...committed(policy?.allowRules ?? [], 'allow'),
    ...learned.filter((r) => r.effect === 'allow')
  ]

  // ⚠️ Both spellings are offered, and a rule matching either wins. `normalizeTarget` is what lets a
  // remembered rule survive the pool; the raw target is still tried so that a hand-written
  // `project.json` rule naming a real path goes on meaning what its author wrote.
  const normalized = normalizeTarget(projectId, target)

  for (const rule of all) {
    if (rule.tool !== tool) continue
    if (!matchesPattern(rule.pattern, target) && !matchesPattern(rule.pattern, normalized)) continue
    return { result: rule.effect === 'deny' ? 'auto_deny' : 'auto_allow', rule: rule.source }
  }
  return { result: 'escalate', rule: null }
}

// ---------------------------------------------------------------------------- lifecycle

const waiters = new Map<string, (decision: ApprovalDecision) => void>()

export interface ApprovalRequest {
  sessionId: string
  origin: ApprovalOrigin
  tool: string
  target?: string
  /** A one-line rendering of what is about to happen. Supplied by the caller, never inferred here. */
  summary: string
  escalateAfterMs?: number
}

/**
 * Ask. Returns as soon as policy can answer, or waits for a person.
 *
 * The deadline is the blocked session's own cache expiry, because that is what waiting actually
 * costs: past it, resuming this session is a full cold rebuild rather than a `0.1·C` read.
 */
export async function requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
  const session = getSession(request.sessionId)
  const run = runForSession(request.sessionId)
  const task = run?.taskId ? getTask(run.taskId) : null
  const projectId = task?.projectId ?? null
  const target = request.target ?? ''

  const { result, rule } = evaluate(projectId, request.tool, target)

  const deadlineAt = session
    ? costModel(adapter(session.adapterId).info.policy.costModelId).cacheExpiryFor(session)
    : null

  const id = randomUUID()
  const now = Date.now()
  db()
    .prepare(
      `insert into approvals (id, session_id, run_id, task_id, project_id, origin, tool, target,
                              summary, policy_result, matched_rule, asked_at, deadline_at,
                              escalate_after_ms, answered_at, answer, answered_by)
       values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      id,
      request.sessionId,
      run?.id ?? null,
      task?.id ?? null,
      projectId,
      request.origin,
      request.tool,
      target || null,
      request.summary,
      result,
      rule,
      now,
      deadlineAt,
      request.escalateAfterMs ?? DEFAULT_ESCALATE_AFTER_MS,
      result === 'escalate' ? null : now,
      result === 'auto_allow' ? 'allow' : result === 'auto_deny' ? 'deny' : null,
      result === 'escalate' ? null : 'policy'
    )

  const approval = requireApproval(id)
  emit({ type: 'approval.opened', approval })

  if (result !== 'escalate') {
    const decision: ApprovalDecision = result === 'auto_allow' ? 'allow' : 'deny'
    emit({ type: 'approval.answered', approval })
    return decision
  }

  log.info(`approval ${id.slice(0, 8)}: ${request.summary} — waiting for a human`)
  return await waitFor(id)
}

function waitFor(id: string): Promise<ApprovalDecision> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiters.delete(id)
      // ⛔ Timing out denies rather than allows. An unanswered question is not consent, and the agent
      // is told why so it can try something else instead of retrying the same call.
      recordAnswer(id, 'deny', 'timeout')
      resolve('deny')
    }, WAIT_TIMEOUT_MS)

    waiters.set(id, (decision) => {
      clearTimeout(timer)
      waiters.delete(id)
      resolve(decision)
    })
  })
}

export function answerApproval(
  id: string,
  decision: ApprovalDecision,
  by: 'human' | 'policy' = 'human'
): Approval {
  const approval = requireApproval(id)
  if (approval.answeredAt) return approval

  if (decision === 'allow_always') {
    // The remember offer is the important half: it turns a recurring interruption into a rule, which
    // is how this queue empties itself over time rather than growing.
    // ⚠️ The literal target, pooled worktree and all — `addRule` is what turns it into a rule that
    // can fire from another member of the pool. See `normalizeTarget`.
    addRule({
      projectId: approval.projectId,
      text: `${approval.tool}(${approval.target ?? '*'})`,
      effect: 'allow',
      createdBy: 'human'
    })
  }

  const answered = recordAnswer(id, decision, by)
  waiters.get(id)?.(decision === 'allow_always' ? 'allow' : decision)
  return answered
}

function recordAnswer(
  id: string,
  decision: ApprovalDecision,
  by: 'human' | 'policy' | 'timeout'
): Approval {
  db()
    .prepare('update approvals set answered_at = ?, answer = ?, answered_by = ? where id = ?')
    .run(Date.now(), decision, by, id)
  const approval = requireApproval(id)
  emit({ type: 'approval.answered', approval })
  return approval
}

export function requireApproval(id: string): Approval {
  const r = row<ApprovalRow>(db().prepare('select * from approvals where id = ?').get(id))
  if (!r) throw new Error(`no approval '${id}'`)
  return toApproval(r)
}

export function openApprovals(): Approval[] {
  return rows<ApprovalRow>(
    db().prepare(`
      select a.* from approvals a
      left join tasks t on a.task_id = t.id
      where a.answered_at is null
        and (a.task_id is null or t.deleted_at is null)
      order by a.asked_at
    `).all()
  ).map(toApproval)
}

export function recentApprovals(limit = 50): Approval[] {
  return rows<ApprovalRow>(
    db().prepare('select * from approvals order by asked_at desc limit ?').all(limit)
  ).map(toApproval)
}

/**
 * The one place the two objects meet.
 *
 * An approval becomes task work exactly when it stops being an interrupt and starts being a decision
 * someone has to schedule - which is also the moment holding a session open for it stops paying for
 * itself. Run on the scheduler tick.
 */
export function escalateStale(now = Date.now()): number {
  let escalated = 0
  for (const approval of openApprovals()) {
    if (approval.escalatedAt) continue
    if (now - approval.askedAt < approval.escalateAfterMs) continue

    db().prepare('update approvals set escalated_at = ? where id = ?').run(now, approval.id)
    escalated++

    if (approval.taskId) {
      addMessage(
        approval.taskId,
        'system',
        `Approval still needs your decision`,
        null,
        [],
        { detail: `${approval.summary}\nUnanswered for ${Math.round((now - approval.askedAt) / 60000)} minutes.` }
      )
      setStatus(approval.taskId, 'awaiting_human', {
        assignee: 'human',
        holdReason: `an approval went unanswered: ${approval.summary}`
      })
    }
    log.warn(`approval ${approval.id.slice(0, 8)} escalated to awaiting_human: ${approval.summary}`)
    emit({ type: 'approval.opened', approval: requireApproval(approval.id) })
  }
  return escalated
}

/** A session that has gone means its approvals are void - nothing can consume the answer any more. */
export function voidApprovalsForSession(sessionId: string): void {
  for (const approval of openApprovals()) {
    if (approval.sessionId !== sessionId) continue
    recordAnswer(approval.id, 'deny', 'timeout')
    waiters.get(approval.id)?.('deny')
  }
}

/** A task that was deleted means its open approvals are void. */
export function voidApprovalsForTask(taskId: string): void {
  for (const approval of openApprovals()) {
    if (approval.taskId !== taskId) continue
    recordAnswer(approval.id, 'deny', 'timeout')
    waiters.get(approval.id)?.('deny')
  }
}
