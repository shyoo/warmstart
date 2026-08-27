import type { Consult, RiskGate, Task } from '@shared/tasks.js'
import type { Worker } from '@shared/protocol.js'
import {
  addDependency,
  addMessage,
  createTask,
  getTask,
  listTasks,
  messagesFor,
  requireTask,
  runsFor,
  setStatus,
  updateTask
} from './tasks.js'
import { getProject } from './projects.js'
import { listWorkers } from './workers.js'
import { costModel } from './costmodel.js'
import { adapter } from './adapters/index.js'
import { estimateTask } from './estimator.js'
import { DEFAULT_OBJECTIVE } from './objective.js'
import { log } from './log.js'

/**
 * The four judgment events: what is asked, what a valid answer looks like, and what happens when
 * there is no answer.
 *
 * ⛔ **Every answer is validated against a closed set before it takes effect.** A worker id has to be
 * one of the candidates offered; a triage action has to be one of four; a model has to be one the
 * cost model knows about; a dependency edge has to point backwards. Anything else is discarded and
 * the deterministic answer is used. The controller is a *source of preference over an answer that
 * already exists*, never a source of instructions.
 *
 * ⚠️ Read the fallbacks first. They are what the fleet actually does most of the time - on a fresh
 * install, on an account out of quota, at three in the morning when the controller's own window has
 * closed - and if a fallback is wrong, the feature is wrong.
 */

/** A decomposition cannot exceed this however much the goal seems to want. Plan §7.2. */
export const MAX_DECOMPOSE_CHILDREN = 8

export interface ApplyResult {
  ok: boolean
  outcome: string
  reason: string
}

const bad = (reason: string): ApplyResult => ({ ok: false, outcome: '', reason })
const good = (outcome: string): ApplyResult => ({ ok: true, outcome, reason: '' })

// ---------------------------------------------------------------------------- the closed sets
//
// ⛔ Pure, and separated from applying on purpose. These are the safety boundary between a language
// model's output and a scheduler that spends money, so they are testable without a database, a
// worker, or a network — and they are tested that way.

export interface DecomposedChild {
  title: string
  acceptance: string
  dependsOn: number[]
  estTokens: number | null
}

export type Validated<T> = { ok: true; value: T } | { ok: false; reason: string }

/**
 * ⛔ The dependency rule is the interesting one: an index must point **backwards**. That is not a
 * stylistic preference — it makes a cycle impossible by construction rather than detectable after the
 * fact, and an agent-authored DAG is exactly where cycles come from (plan §7.2).
 */
export function validateDecomposition(answer: Record<string, unknown>): Validated<DecomposedChild[]> {
  const raw = answer.children
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, reason: 'no children in the answer' }
  if (raw.length > MAX_DECOMPOSE_CHILDREN) {
    return { ok: false, reason: `${raw.length} children exceeds the cap of ${MAX_DECOMPOSE_CHILDREN}` }
  }

  const children: DecomposedChild[] = []
  for (const [i, entry] of raw.entries()) {
    if (!entry || typeof entry !== 'object') return { ok: false, reason: `child ${i} is not an object` }
    const child = entry as Record<string, unknown>
    const title = typeof child.title === 'string' ? child.title.trim() : ''
    if (!title) return { ok: false, reason: `child ${i} has no title` }

    const deps = child.dependsOn
    const dependsOn: number[] = []
    if (deps !== undefined) {
      if (!Array.isArray(deps)) return { ok: false, reason: `child ${i} has a non-list dependsOn` }
      for (const dep of deps) {
        if (!Number.isInteger(dep) || (dep as number) < 0 || (dep as number) >= i) {
          return { ok: false, reason: `child ${i} depends on ${String(dep)}, which is not an earlier child` }
        }
        dependsOn.push(dep as number)
      }
    }

    children.push({
      title,
      acceptance: typeof child.acceptance === 'string' ? child.acceptance.trim() : '',
      dependsOn,
      estTokens:
        typeof child.estTokens === 'number' && child.estTokens > 0 ? Math.round(child.estTokens) : null
    })
  }
  return { ok: true, value: children }
}

export type TriageAction =
  | { action: 'retry'; why: string }
  | { action: 'human'; why: string }
  | { action: 'rewrite'; prompt: string; why: string }
  | { action: 'escalate'; model: string; why: string }

/**
 * ⛔ `escalate` is checked against the models the **cost model file** knows about. A model agentyard
 * cannot price is one it cannot gate, estimate for, or reason about the context window of — so an
 * invented id is rejected here rather than passed to a CLI to fail at spawn time on somebody's
 * account.
 */
export function validateTriage(
  answer: Record<string, unknown>,
  knownModelIds: string[]
): Validated<TriageAction> {
  const action = typeof answer.action === 'string' ? answer.action.trim() : ''
  const why = typeof answer.why === 'string' ? answer.why.trim() : ''

  if (action === 'retry' || action === 'human') return { ok: true, value: { action, why } }

  if (action === 'rewrite') {
    const prompt = typeof answer.prompt === 'string' ? answer.prompt.trim() : ''
    if (!prompt) return { ok: false, reason: 'rewrite chosen with no replacement prompt' }
    return { ok: true, value: { action, prompt, why } }
  }

  if (action === 'escalate') {
    const model = typeof answer.model === 'string' ? answer.model.trim() : ''
    if (!model) return { ok: false, reason: 'escalate chosen with no model' }
    if (!knownModelIds.includes(model)) {
      return { ok: false, reason: `'${model}' is not a model this cost model can price` }
    }
    return { ok: true, value: { action, model, why } }
  }

  return { ok: false, reason: `'${action}' is not one of retry, rewrite, escalate, human` }
}

export type GateVerdict =
  | { verdict: 'accept' | 'reject' | 'human'; why: string }
  | { verdict: 'rescope'; title: string; why: string }

export function validateGate(answer: Record<string, unknown>): Validated<GateVerdict> {
  const verdict = typeof answer.verdict === 'string' ? answer.verdict.trim() : ''
  const why = typeof answer.why === 'string' ? answer.why.trim() : ''

  if (verdict === 'accept' || verdict === 'reject' || verdict === 'human') {
    return { ok: true, value: { verdict, why } }
  }
  if (verdict === 'rescope') {
    const title = typeof answer.title === 'string' ? answer.title.trim() : ''
    if (!title) return { ok: false, reason: 'rescope chosen with no replacement title' }
    return { ok: true, value: { verdict, title, why } }
  }
  return { ok: false, reason: `'${verdict}' is not one of accept, rescope, reject, human` }
}

/** ⛔ Checked against the candidates that were offered. A worker id from anywhere else is a fiction. */
export function validateRoute(
  answer: Record<string, unknown>,
  candidateIds: string[]
): Validated<{ workerId: string; why: string }> {
  const workerId = typeof answer.workerId === 'string' ? answer.workerId.trim() : ''
  if (!workerId) return { ok: false, reason: 'no workerId in the answer' }
  if (!candidateIds.includes(workerId)) {
    return { ok: false, reason: `'${workerId.slice(0, 12)}' was not one of the candidates` }
  }
  return { ok: true, value: { workerId, why: typeof answer.why === 'string' ? answer.why.trim() : '' } }
}

// ---------------------------------------------------------------------------- is it still worth asking

/**
 * A question nobody is asking any more.
 *
 * Between enqueue and drain, a person may have cancelled the task, deleted it, or dealt with it. The
 * cheapest consult is the one that is never run.
 */
export function questionStillStands(consult: Consult): { ok: boolean; reason: string } {
  if (!consult.subjectId) return { ok: true, reason: '' }
  const task = getTask(consult.subjectId)
  if (!task) return { ok: false, reason: 'the task is gone' }
  if (task.deletedAt) return { ok: false, reason: 'the task was deleted' }

  if (consult.kind === 'decompose') {
    return task.status === 'assigned' || task.status === 'ready'
      ? { ok: true, reason: '' }
      : { ok: false, reason: `the plan task is ${task.status}` }
  }
  if (consult.kind === 'route') {
    return task.status === 'ready'
      ? { ok: true, reason: '' }
      : { ok: false, reason: `the task is ${task.status}` }
  }
  if (consult.kind === 'gate') {
    return task.status === 'draft'
      ? { ok: true, reason: '' }
      : { ok: false, reason: `the task is already ${task.status}` }
  }
  // triage
  return task.status === 'awaiting_human' || task.status === 'failed'
    ? { ok: true, reason: '' }
    : { ok: false, reason: `the task moved on to ${task.status}` }
}

// ---------------------------------------------------------------------------- 1. decompose

/**
 * ⛔ **Titles and acceptance criteria, never prompts.**
 *
 * A milestone plan is a roadmap, not a task DAG (plan §18.1). The evidence is this repository: an M2
 * ticket written the day the plan was drafted would have said *"host sessions in a PTY"*, which M1
 * then measured to be impossible; an M3 ticket would have said *"poll `claude -p /usage`"*, which
 * spends a real turn per poll. Five of six prompts would have been rewritten - and a stale prompt is
 * worse than no prompt, because somebody follows it.
 *
 * So decomposition writes the *shape* of the work, the children land as `draft`, and the prompt is
 * written at promotion, when what the previous milestone learned is known.
 */
export function decomposeQuestion(task: Task): string {
  const project = task.projectId ? getProject(task.projectId) : null
  const goal = [task.title, ...messagesFor(task.id).filter((m) => m.role === 'human').map((m) => m.text)]
  const open = listTasks({ ...(task.projectId ? { projectId: task.projectId } : {}) })
    .filter((t) => t.id !== task.id && !['completed', 'cancelled', 'failed'].includes(t.status))
    .slice(0, 40)
    .map((t) => `- t${t.seq} (${t.status}): ${t.title}`)

  return [
    'You are the planning controller for Multi Agent Controller, a scheduler that routes coding-agent work.',
    'Break the goal below into a small number of sequenced pieces of work.',
    '',
    '# Goal',
    goal.join('\n\n'),
    '',
    project ? `# Project\n${project.name} (${project.root})` : '# Project\nnone',
    '',
    open.length ? `# Work already on the board — do not duplicate any of it\n${open.join('\n')}` : '',
    '',
    '# How to answer',
    'Reply with a single JSON object and nothing else that matters:',
    '',
    '```json',
    '{"children":[{"title":"...","acceptance":"...","dependsOn":[0],"estTokens":250000}],"note":"..."}',
    '```',
    '',
    'Rules, all of which are enforced — an answer that breaks one is discarded entirely:',
    `- At most ${MAX_DECOMPOSE_CHILDREN} children. Prefer whole pieces of work; split only where the`,
    '  work is genuinely wide. Four large children beat twelve small ones.',
    '- List them in dependency order. Every index in `dependsOn` must be SMALLER than the child\'s own',
    '  position in the array. Cycles are impossible if you follow this, and rejected if you do not.',
    '- `title` is one line, as you would say it to a colleague. `acceptance` is how someone would know',
    '  it is done.',
    '- `estTokens` is a rough total token cost, or omit it.',
    '',
    '⛔ Do NOT write prompts, instructions, or implementation notes for these children.',
    'They are created as drafts and the prompt for each is written later, at the moment it is promoted,',
    'from what the preceding work actually learned. A prompt written now would be a guess, and a stale',
    'prompt is worse than no prompt because somebody follows it.'
  ]
    .filter((line) => line !== '')
    .join('\n')
}

function applyDecompose(task: Task, answer: Record<string, unknown>): ApplyResult {
  // ⛔ The whole answer is validated before anything is created. A half-applied decomposition leaves
  // a task list that is neither the old plan nor the new one, which is worse than either.
  const checked = validateDecomposition(answer)
  if (!checked.ok) return bad(checked.reason)

  const created: Task[] = []
  for (const child of checked.value) {
    const made = createTask({
      title: child.title,
      projectId: task.projectId,
      parentTaskId: task.id,
      createdBy: { kind: 'controller' },
      priority: task.priority,
      // ⛔ Draft. The most open-ended thing the controller produces lands in the one status that
      // cannot dispatch, is not assigned and holds no worker.
      status: 'draft',
      ...(child.estTokens ? { estTokens: child.estTokens } : {})
    })
    if (child.acceptance) addMessage(made.id, 'system', `Done when: ${child.acceptance}`)
    created.push(made)
    for (const dep of child.dependsOn) {
      const target = created[dep]
      if (target) addDependency(made.id, target.id)
    }
  }

  const note = typeof answer.note === 'string' ? answer.note.trim() : ''
  const named = created.map((c) => `t${c.seq}`).join(', ')
  addMessage(
    task.id,
    'system',
    [
      `Decomposed into ${created.length} draft task(s): ${named}.`,
      'Each is a draft on purpose - its prompt is written when it is promoted, not now.',
      ...(note ? ['', note] : [])
    ].join('\n')
  )
  setStatus(task.id, 'completed')
  return good(`${created.length} drafts: ${named}`)
}

// ---------------------------------------------------------------------------- 2. triage

export function triageQuestion(task: Task): string {
  const attempts = runsFor(task.id)
    .slice(0, 5)
    .map(
      (r) =>
        `- ${new Date(r.startedAt).toISOString()} on run ${r.id.slice(0, 8)}: ${r.outcome ?? 'open'}` +
        `${r.note ? ` — ${r.note}` : ''}`
    )
  const thread = messagesFor(task.id)
    .slice(-12)
    .map((m) => `${m.role}: ${m.text.slice(0, 600)}`)
  const models = knownModels(task)

  return [
    'You are the controller for Multi Agent Controller. A task has failed more than once and is parked for a',
    'person. Decide whether it is worth another attempt, and if so, what should change.',
    '',
    `# Task t${task.seq}`,
    task.title,
    '',
    `# Attempts\n${attempts.join('\n') || 'none recorded'}`,
    '',
    `# Thread\n${thread.join('\n') || 'empty'}`,
    '',
    '# How to answer',
    'Reply with a single JSON object:',
    '',
    '```json',
    '{"action":"retry"|"rewrite"|"escalate"|"human","prompt":"...","model":"...","why":"..."}',
    '```',
    '',
    '- `retry` — nothing was wrong with the instruction; the failure looks transient.',
    '- `rewrite` — the instruction was the problem. Supply `prompt`: the replacement, written from',
    '  what the attempts show. This is the one that usually pays.',
    '- `escalate` — the work needs a more capable model. Supply `model`, one of:',
    `  ${models.length ? models.join(', ') : '(none known — do not choose this)'}`,
    '- `human` — a person has to decide something. Choose this freely; it is the safe answer and it',
    '  is what happens anyway if you do not reply.',
    '',
    '`why` is one line, for the person reading the task later.'
  ].join('\n')
}

/**
 * The models this task could legitimately be escalated to.
 *
 * ⛔ Read from the cost model file, not from a list in code. A model agentyard cannot price is one it
 * cannot gate, estimate for, or reason about the context window of - so an id outside this set is
 * rejected rather than passed through to a CLI to fail at spawn time on somebody's account.
 */
function knownModels(task: Task): string[] {
  const adapterId = task.constraints.adapterId ?? 'claude-code'
  try {
    return costModel(adapter(adapterId).info.policy.costModelId).modelIds()
  } catch (err) {
    log.warn('could not read the model list for a triage question:', err)
    return []
  }
}

function applyTriage(task: Task, answer: Record<string, unknown>): ApplyResult {
  const checked = validateTriage(answer, knownModels(task))
  if (!checked.ok) return bad(checked.reason)
  const decision = checked.value
  const why = decision.why ? ` ${decision.why}` : ''

  switch (decision.action) {
    case 'human':
      addMessage(task.id, 'system', `Controller: this needs a person.${why}`)
      setStatus(task.id, 'awaiting_human', {
        assignee: 'human',
        holdReason: `the controller decided this needs a person.${why}`
      })
      return good('handed to a person')

    case 'retry':
      addMessage(task.id, 'system', `Controller: retrying unchanged.${why}`)
      setStatus(task.id, 'ready')
      return good('queued for another attempt')

    case 'rewrite':
      // The replacement is filed as a human-role message so the next run's prompt carries it. The
      // system note above it records where it came from, so nobody later reads it as something the
      // operator typed.
      addMessage(task.id, 'system', `Controller rewrote the instruction.${why}`)
      addMessage(task.id, 'human', decision.prompt)
      setStatus(task.id, 'ready')
      return good('instruction rewritten and requeued')

    case 'escalate':
      updateTask(task.id, { constraints: { ...task.constraints, model: decision.model } })
      addMessage(task.id, 'system', `Controller escalated this to ${decision.model}.${why}`)
      setStatus(task.id, 'ready')
      return good(`escalated to ${decision.model}`)
  }
}

// ---------------------------------------------------------------------------- 3. gate

/**
 * Should this agent-filed task be admitted, reviewed, or handed to a person?
 *
 * ⛔ Rule-based and cheap, because it runs on **every** agent-filed task and the point of the gate is
 * to contain task explosion, not to add a turn to it. Only what this returns as `controller` costs
 * anything. Plan §7.2.
 */
export function riskOf(task: Task): { gate: RiskGate; why: string } {
  const cost = DEFAULT_OBJECTIVE.cost
  // A cost-weighted operator gates one generation sooner: the cheapest agent-authored task is the
  // one that was never admitted.
  const gateAboveDepth = cost > 0.5 ? 1 : 2

  if (task.lineageDepth > 2) {
    return { gate: 'human', why: `three agent generations from anything a person asked for` }
  }
  const parent = task.parentTaskId ? getTask(task.parentTaskId) : null
  const remaining = parent ? Math.max(0, parent.budget.grantedTokens - parent.budget.spentTokens) : 0
  const estimate = estimateTask(task).tokens

  if (parent && parent.budget.grantedTokens > 0 && estimate > remaining) {
    return {
      gate: 'controller',
      why: `estimated ${estimate} tokens against ${remaining} left in its parent's budget`
    }
  }
  if (task.mandate.allowed.includes('push') && task.lineageDepth > gateAboveDepth) {
    return { gate: 'controller', why: 'can push, and is more than one generation from a person' }
  }
  if (task.mandate.allowed.includes('commit') || task.mandate.allowed.includes('push')) {
    return { gate: 'controller', why: 'writes to a repository' }
  }
  return { gate: 'auto', why: 'read-only or small, within its parent’s budget' }
}

export function gateQuestion(task: Task, why: string): string {
  const parent = task.parentTaskId ? getTask(task.parentTaskId) : null
  const siblings = listTasks({ ...(task.projectId ? { projectId: task.projectId } : {}) })
    .filter((t) => t.id !== task.id && !['completed', 'cancelled', 'failed'].includes(t.status))
    .slice(0, 30)
    .map((t) => `- t${t.seq} (${t.status}): ${t.title}`)

  return [
    'You are the controller for Multi Agent Controller. An agent filed this task while working on something else.',
    'Decide whether it should exist, and in what form. Cheap to reject; expensive to let a fleet',
    'generate its own work unchecked.',
    '',
    `# Filed task t${task.seq}`,
    task.title,
    messagesFor(task.id)
      .filter((m) => m.role !== 'system')
      .slice(0, 4)
      .map((m) => m.text.slice(0, 800))
      .join('\n'),
    '',
    `# Why it reached you\n${why}`,
    `# Provenance\nlineage depth ${task.lineageDepth}, filed by an agent working on ` +
      (parent ? `t${parent.seq} "${parent.title}"` : 'an unknown task'),
    `# Authority it would run under\n${task.mandate.allowed.join(', ')}`,
    `# Estimated cost\n${estimateTask(task).tokens} tokens (${estimateTask(task).basis})`,
    '',
    siblings.length ? `# Other open work in this project\n${siblings.join('\n')}` : '',
    '',
    '# How to answer',
    '```json',
    '{"verdict":"accept"|"rescope"|"reject"|"human","title":"...","why":"..."}',
    '```',
    '',
    '- `accept` — worth doing as filed. It joins the queue.',
    '- `rescope` — worth doing, but not like this. Supply a narrower `title`.',
    '- `reject` — duplicate, out of scope, or not worth the tokens. The task is cancelled, not',
    '  deleted: it stays on the board with your reason on it.',
    '- `human` — the call is not yours to make.',
    '',
    '`why` is one line and will be shown on the task.'
  ]
    .filter((line) => line !== '')
    .join('\n')
}

function applyGate(task: Task, answer: Record<string, unknown>): ApplyResult {
  const checked = validateGate(answer)
  if (!checked.ok) return bad(checked.reason)
  const decision = checked.value
  const why = decision.why ? ` ${decision.why}` : ''

  switch (decision.verdict) {
    case 'accept':
      addMessage(task.id, 'system', `Controller admitted this.${why}`)
      setStatus(task.id, 'ready')
      return good(`t${task.seq} admitted`)

    case 'rescope':
      updateTask(task.id, { title: decision.title })
      addMessage(task.id, 'system', `Controller rescoped this.${why}`)
      setStatus(task.id, 'ready')
      return good(`t${task.seq} rescoped and admitted`)

    case 'reject':
      // ⛔ Cancelled, never deleted. Plan §7.4 - an agent's rejected idea is evidence about how the
      // fleet behaves, and the only tier that can delete anything is a person.
      addMessage(task.id, 'system', `Controller rejected this.${why}`)
      setStatus(task.id, 'cancelled')
      return good(`t${task.seq} rejected`)

    case 'human':
      addMessage(task.id, 'system', `Controller passed this to you.${why}`)
      setStatus(task.id, 'awaiting_human', {
        assignee: 'human',
        holdReason: `the controller passed this to you.${why}`
      })
      return good(`t${task.seq} handed to a person`)
  }
}

// ---------------------------------------------------------------------------- 4. route

export interface RouteCandidate {
  worker: Worker
  score: number
  warm: boolean
  note: string
}

/**
 * ⚠️ **The weakest of the four, and gated hardest.**
 *
 * A tie means the alternatives are by definition close, so the most this can win back is ε — while
 * costing a real turn. It fires only on a task expensive enough that ε is worth more than the turn,
 * and only when the deterministic scorer genuinely cannot separate two candidates. Everywhere else,
 * the arithmetic decides and nothing is spent.
 */
export function routeQuestion(task: Task, candidates: RouteCandidate[]): string {
  return [
    'You are the controller for Multi Agent Controller. Two accounts score within a hair of each other for a large',
    'task, so the arithmetic cannot separate them. Pick one.',
    '',
    `# Task t${task.seq}`,
    task.title,
    `estimated ${estimateTask(task).tokens} tokens (${estimateTask(task).basis})`,
    '',
    '# Candidates',
    ...candidates.map(
      (c) =>
        `- ${c.worker.id} — ${c.worker.label}: score ${c.score.toFixed(3)}, ` +
        `${c.warm ? 'already holds this task’s context' : 'cold start'}${c.note ? `, ${c.note}` : ''}`
    ),
    '',
    '# How to answer',
    '```json',
    '{"workerId":"<one of the ids above, verbatim>","why":"..."}',
    '```',
    '',
    'Any id not in that list is discarded and the highest-scoring candidate is used instead.'
  ].join('\n')
}

function applyRoute(task: Task, answer: Record<string, unknown>): ApplyResult {
  // Checked twice, against two different sets, because they answer two different questions. Here:
  // is this a worker at all? In the scheduler, when the answer is read: is it still a *candidate* -
  // an account can be disabled, fill its window, or lose its sign-in between this and the next tick.
  const checked = validateRoute(answer, listWorkers().map((w) => w.id))
  if (!checked.ok) return bad(checked.reason)
  const { workerId, why } = checked.value
  const label = listWorkers().find((w) => w.id === workerId)?.label ?? workerId.slice(0, 8)
  addMessage(task.id, 'system', `Controller routed this to ${label}.${why ? ` ${why}` : ''}`)
  return good(`t${task.seq} routed to ${label}`)
}

// ---------------------------------------------------------------------------- apply and fall back

export function applyConsult(consult: Consult, answer: Record<string, unknown>): ApplyResult {
  const task = consult.subjectId ? getTask(consult.subjectId) : null
  if (!task) return bad('the task this was about is gone')
  try {
    switch (consult.kind) {
      case 'decompose':
        return applyDecompose(task, answer)
      case 'triage':
        return applyTriage(task, answer)
      case 'gate':
        return applyGate(task, answer)
      case 'route':
        return applyRoute(task, answer)
    }
  } catch (err) {
    return bad(`applying the answer failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * What happens when there is no answer — and what happens most of the time.
 *
 * ⛔ Every one of these is *safe*, not merely defined. Nothing here dispatches work, spends a budget,
 * or invents a plan: the fallback for a question about judgment is to stop and ask a person, except
 * where a perfectly good deterministic answer already exists (route), or where the safe state is
 * simply to leave the work where it is (gate).
 */
export function fallbackFor(consult: Consult): string {
  const task = consult.subjectId ? getTask(consult.subjectId) : null
  if (!task) return 'nothing to do; the task is gone'

  try {
    switch (consult.kind) {
      case 'decompose':
        // ⛔ Never guess a decomposition. A made-up plan looks exactly like a real one on a board.
        addMessage(
          task.id,
          'system',
          'This needs decomposing and no controller was available to do it. Break it into drafts by ' +
            'hand, or designate a controller account and requeue it.'
        )
        setStatus(task.id, 'awaiting_human', {
          assignee: 'human',
          holdReason: 'this needs breaking into drafts and no controller was available to do it'
        })
        return 'left for a person to decompose'

      case 'triage':
        // Already where the deterministic path put it. Saying so is the point: silence would read as
        // a controller decision.
        addMessage(
          task.id,
          'system',
          'This has failed more than once and no controller was available to diagnose it.'
        )
        setStatus(task.id, 'awaiting_human', {
          assignee: 'human',
          holdReason: 'this has failed more than once and no controller was available to diagnose it'
        })
        return 'left for a person to triage'

      case 'gate':
        // A draft holds nothing and dispatches nothing, so waiting costs only time.
        addMessage(
          task.id,
          'system',
          'Filed by an agent and held for review; no controller was available. It stays a draft until ' +
            'you queue it or delete it.'
        )
        return 'held as a draft'

      case 'route':
        // The arithmetic already had an answer; that is the whole reason this consult is optional.
        return 'the highest-scoring worker is used'
    }
  } catch (err) {
    log.warn('a consult fallback failed:', err)
    return 'the fallback could not be applied'
  }
}

/** Build the question for a queued consult. Kept here so every kind's wording lives in one file. */
export function questionFor(kind: Consult['kind'], taskId: string, extra?: string): string {
  const task = requireTask(taskId)
  switch (kind) {
    case 'decompose':
      return decomposeQuestion(task)
    case 'triage':
      return triageQuestion(task)
    case 'gate':
      return gateQuestion(task, extra ?? 'project policy')
    case 'route':
      return extra ?? routeQuestion(task, [])
  }
}
