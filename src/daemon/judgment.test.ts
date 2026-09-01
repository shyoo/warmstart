import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Consult } from '@shared/tasks.js'
import { closeDb, openDb } from './db.js'
import {
  applyConsult,
  fallbackFor,
  MAX_TITLE_SUMMARY,
  TITLE_SUMMARY_THRESHOLD,
  titleQuestion,
  validateTitleSummary
} from './judgment.js'
import { createTask, getTask, listTasks, messagesFor, updateTask } from './tasks.js'

/**
 * What actually happens to the board when the controller answers — and when it does not.
 *
 * ⛔ Against a real database, because this is where the two claims M4 rests on either hold or do not:
 * a decomposition lands in the one status that cannot dispatch, and *every* fallback leaves the fleet
 * somewhere safe and visible. Both are properties of the rows that come out, not of the prompt that
 * went in, so they are checked by reading the rows.
 *
 * ⛔ Spends nothing and starts no process: this exercises applying an answer, never obtaining one.
 */

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-judgment-'))
  openDb(join(dir, 'test.db'))
})

afterAll(() => {
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})

function consultFor(kind: Consult['kind'], subjectId: string): Consult {
  return {
    id: `consult-${kind}-${subjectId.slice(0, 8)}`,
    kind,
    subjectId,
    status: 'pending',
    question: '(not used here — this exercises applying an answer, not obtaining one)',
    detail: null,
    workerId: null,
    sessionId: null,
    answer: null,
    outcome: null,
    fallbackReason: null,
    spentTokens: 0,
    createdAt: Date.now(),
    startedAt: null,
    endedAt: null
  }
}

describe('decomposition lands on the board', () => {
  it('creates drafts in dependency order and completes the plan task', () => {
    const plan = createTask({ title: 'Ship the thing end to end', kind: 'plan' })
    const result = applyConsult(consultFor('decompose', plan.id), {
      children: [
        { title: 'Fleet substrate', acceptance: 'a worker can be commissioned' },
        { title: 'Tasks and approvals', dependsOn: [0] },
        { title: 'Cost intelligence', dependsOn: [1], estTokens: 400_000 }
      ],
      note: 'Three, because the middle one is genuinely wide.'
    })

    expect(result.ok, result.reason).toBe(true)
    const children = listTasks().filter((t) => t.parentTaskId === plan.id)
    expect(children).toHaveLength(3)

    // ⛔ The load-bearing one. The most open-ended thing the controller produces lands in the status
    // that dispatches nothing, is assigned to nobody and holds no worker.
    expect(children.every((c) => c.status === 'draft')).toBe(true)
    expect(children.every((c) => c.assignee === null)).toBe(true)

    const [first, second, third] = children
    expect(first?.dependsOn).toEqual([])
    expect(second?.dependsOn).toEqual([first?.id])
    expect(third?.dependsOn).toEqual([second?.id])
    expect(third?.estTokens).toBe(400_000)

    // The children are authored by the controller, not attributed to the operator.
    expect(children.every((c) => c.createdBy.kind === 'controller')).toBe(true)

    expect(getTask(plan.id)?.status).toBe('completed')
    const said = messagesFor(plan.id)
      .map((m) => m.text)
      .join('\n')
    expect(said).toContain('draft')
    // An acceptance criterion is recorded; a prompt deliberately is not.
    expect(messagesFor(first?.id ?? '').map((m) => m.text)).toContain(
      'Done when: a worker can be commissioned'
    )
  })

  it('creates nothing at all when one child is invalid', () => {
    const plan = createTask({ title: 'A plan with a bad edge', kind: 'plan' })
    const result = applyConsult(consultFor('decompose', plan.id), {
      children: [{ title: 'A', dependsOn: [1] }, { title: 'B' }]
    })
    expect(result.ok).toBe(false)
    // ⛔ All or nothing. A half-applied decomposition leaves a board that is neither the old plan nor
    // the new one, which is worse than either.
    expect(listTasks().filter((t) => t.parentTaskId === plan.id)).toHaveLength(0)
    expect(getTask(plan.id)?.status).not.toBe('completed')
  })
})

describe('the gate moves an agent-filed task somewhere definite', () => {
  const filed = () =>
    createTask({ title: `agent idea ${Math.random().toString(36).slice(2, 8)}`, status: 'draft' })

  it('accepting admits it', () => {
    const task = filed()
    expect(applyConsult(consultFor('gate', task.id), { verdict: 'accept', why: 'small' }).ok).toBe(true)
    expect(getTask(task.id)?.status).toBe('ready')
  })

  it('rescoping renames it and admits it', () => {
    const task = filed()
    applyConsult(consultFor('gate', task.id), { verdict: 'rescope', title: 'narrower idea' })
    expect(getTask(task.id)?.title).toBe('narrower idea')
    expect(getTask(task.id)?.status).toBe('ready')
  })

  it('rejecting cancels rather than deletes', () => {
    // ⛔ Plan §7.4. A rejected idea is evidence about how the fleet behaves, and the only tier that
    // can delete anything is a person.
    const task = filed()
    applyConsult(consultFor('gate', task.id), { verdict: 'reject', why: 'duplicate' })
    const after = getTask(task.id)
    expect(after?.status).toBe('cancelled')
    expect(after?.deletedAt).toBeNull()
    expect(messagesFor(task.id).some((m) => m.text.includes('duplicate'))).toBe(true)
  })

  it('a malformed verdict changes nothing', () => {
    const task = filed()
    expect(applyConsult(consultFor('gate', task.id), { verdict: 'maybe' }).ok).toBe(false)
    expect(getTask(task.id)?.status).toBe('draft')
  })
})

describe('triage', () => {
  it('a rewrite becomes the instruction the next run receives', () => {
    const task = createTask({ title: 'keeps failing', prompt: 'do the thing' })
    const result = applyConsult(consultFor('triage', task.id), {
      action: 'rewrite',
      prompt: 'do the thing, but install the dependencies first',
      why: 'it failed on a missing module twice'
    })
    expect(result.ok).toBe(true)
    expect(getTask(task.id)?.status).toBe('ready')

    const ctrl = messagesFor(task.id).filter((m) => m.role === 'controller')
    expect(ctrl.at(-1)?.text).toContain('install the dependencies first')
    // Where it came from is on the record, so nobody later reads it as something the operator typed.
    expect(messagesFor(task.id).some((m) => m.text.startsWith('Controller rewrote'))).toBe(true)
  })

  it('refuses to escalate to a model the cost model cannot price, and changes nothing', () => {
    const task = createTask({ title: 'also keeps failing' })
    const result = applyConsult(consultFor('triage', task.id), {
      action: 'escalate',
      model: 'claude-omega-9'
    })
    expect(result.ok).toBe(false)
    expect(getTask(task.id)?.constraints.model).toBeUndefined()
  })
})

describe('the fallbacks, which are what happens most of the time', () => {
  it('never invents a decomposition — it asks a person', () => {
    // ⛔ A made-up plan looks exactly like a real one on a board, which is why this is the one
    // fallback that must refuse to guess.
    const plan = createTask({ title: 'undecomposable for now', kind: 'plan' })
    const outcome = fallbackFor(consultFor('decompose', plan.id))
    expect(listTasks().filter((t) => t.parentTaskId === plan.id)).toHaveLength(0)
    expect(getTask(plan.id)?.status).toBe('awaiting_human')
    expect(outcome).toContain('person')
  })

  it('leaves an ungated agent-filed task as a draft, holding nothing', () => {
    const task = createTask({ title: 'ungated idea', status: 'draft' })
    fallbackFor(consultFor('gate', task.id))
    expect(getTask(task.id)?.status).toBe('draft')
  })

  it('parks a repeatedly failing task for a person and says so on the task', () => {
    const task = createTask({ title: 'untriaged' })
    fallbackFor(consultFor('triage', task.id))
    expect(getTask(task.id)?.status).toBe('awaiting_human')
    expect(messagesFor(task.id).some((m) => /no controller was available/.test(m.text))).toBe(true)
  })

  it('has a deterministic answer for routing that needed no controller at all', () => {
    const task = createTask({ title: 'routable' })
    expect(fallbackFor(consultFor('route', task.id))).toContain('highest-scoring')
    // ⚠️ And it does not touch the task: the arithmetic already had the answer.
    expect(getTask(task.id)?.status).toBe('ready')
  })

  it('does not fall over when the task is already gone', () => {
    expect(fallbackFor(consultFor('triage', 'a-task-that-never-existed'))).toContain('gone')
  })
})

describe('initial task prompt message recording', () => {
  it('records initial title as a human message when created by a human without prompt', () => {
    const task = createTask({ title: 'Fix something', createdBy: { kind: 'human' } })
    const msgs = messagesFor(task.id)
    expect(msgs).toHaveLength(1)
    expect(msgs[0]?.role).toBe('human')
    expect(msgs[0]?.text).toBe('Fix something')
  })

  it('records explicit prompt as a human message when prompt is provided', () => {
    const task = createTask({ title: 'Short title', prompt: 'Detailed instruction', createdBy: { kind: 'human' } })
    const msgs = messagesFor(task.id)
    expect(msgs).toHaveLength(1)
    expect(msgs[0]?.role).toBe('human')
    expect(msgs[0]?.text).toBe('Detailed instruction')
  })

  it('records controller role when created by controller', () => {
    const task = createTask({ title: 'Controller task', createdBy: { kind: 'controller' } })
    const msgs = messagesFor(task.id)
    expect(msgs).toHaveLength(1)
    expect(msgs[0]?.role).toBe('controller')
    expect(msgs[0]?.text).toBe('Controller task')
  })

  it('records agent role when created by an agent', () => {
    const task = createTask({
      title: 'Agent subtask',
      createdBy: { kind: 'agent', workerId: 'w1', sessionId: 's1', runId: 'r1' }
    })
    const msgs = messagesFor(task.id)
    expect(msgs).toHaveLength(1)
    expect(msgs[0]?.role).toBe('agent')
    expect(msgs[0]?.text).toBe('Agent subtask')
  })
})

/**
 * The one-line label, and the thing it must never do.
 *
 * ⛔ **`title` is the prompt.** `promptFor()` sends it to the agent verbatim and the task form files
 * an entire textarea into it, so the whole design rests on the summary living somewhere else and the
 * prompt surviving untouched. Every assertion here that looks redundant is checking exactly that: a
 * label was written, *and* the instruction is still the instruction.
 */
describe('the summarised title', () => {
  /** A prompt of the shape that made this feature necessary: an instruction, not a name. */
  const LONG =
    'I wonder if we can use an AI-summarized title for each task, because each task description ' +
    'is lengthy and the board is unreadable. One way is to use the judgment call to produce it in ' +
    'JSON, not just the routing decision.'

  const AGENT = { kind: 'agent', workerId: 'w1', sessionId: 's1', runId: 'r1' } as const

  it('takes a one-line answer and leaves the prompt exactly as it was', () => {
    const task = createTask({ title: LONG })
    const result = applyConsult(consultFor('title', task.id), {
      summary: 'Use AI-summarised titles on the task board'
    })

    expect(result.ok).toBe(true)
    const after = getTask(task.id)
    expect(after?.titleSummary).toBe('Use AI-summarised titles on the task board')
    // ⛔ The point of the whole exercise. A summary that shortened this would have shortened what
    // the agent is told to do.
    expect(after?.title).toBe(LONG)
  })

  it('refuses a summary longer than a summary, rather than cutting it off', () => {
    // ⛔ Rejected, not truncated: a label cut mid-word is indistinguishable from a bug in the table,
    // where falling back to the prompt is at least honest about what it is showing.
    expect(validateTitleSummary({ summary: 'x'.repeat(MAX_TITLE_SUMMARY + 1) })).toBeNull()
    expect(validateTitleSummary({ summary: 'x'.repeat(MAX_TITLE_SUMMARY) })).toHaveLength(
      MAX_TITLE_SUMMARY
    )
  })

  it('refuses a paragraph, because keeping its first line would keep half an answer', () => {
    expect(validateTitleSummary({ summary: 'A label\n\nand some reasoning about it' })).toBeNull()
  })

  it('refuses an empty, blank, or non-string one', () => {
    expect(validateTitleSummary({})).toBeNull()
    expect(validateTitleSummary({ summary: '   ' })).toBeNull()
    expect(validateTitleSummary({ summary: 42 })).toBeNull()
  })

  it('fails the dedicated consult when nothing usable came back, since it has no other content', () => {
    const task = createTask({ title: LONG })
    const result = applyConsult(consultFor('title', task.id), { summary: '' })
    expect(result.ok).toBe(false)
    expect(getTask(task.id)?.titleSummary).toBeNull()
  })

  it('changes nothing and says nothing when no controller answers', () => {
    const task = createTask({ title: LONG })
    const before = messagesFor(task.id).length
    const outcome = fallbackFor(consultFor('title', task.id))

    expect(outcome).toContain('prompt')
    expect(getTask(task.id)?.titleSummary).toBeNull()
    // ⛔ Silent on purpose, and the only fallback in this file that is. Every other one has something
    // a person needs to know; this would put a note on every long task about a question the operator
    // never saw the point of having asked.
    expect(messagesFor(task.id)).toHaveLength(before)
  })

  /**
   * The label riding along on the four questions that were being asked anyway.
   *
   * ⛔ **It must never be able to fail one of them.** Those four decide where work goes; a controller
   * that writes a forty-word "summary" beside a valid verdict has to lose the summary, not the
   * verdict.
   */
  it('is stored beside a gate verdict', () => {
    const task = createTask({
      title: 'Investigate whether the quota poller can read a 7-day window without spending a turn',
      createdBy: AGENT
    })
    const result = applyConsult(consultFor('gate', task.id), {
      verdict: 'accept',
      why: 'cheap and read-only',
      summary: 'Read the 7-day quota window for free'
    })

    expect(result.ok).toBe(true)
    expect(getTask(task.id)?.titleSummary).toBe('Read the 7-day quota window for free')
    expect(getTask(task.id)?.status).toBe('ready')
  })

  it('goes with the new title on a rescope rather than being dropped by it', () => {
    // ⛔ `updateTask` clears a summary whenever the title changes under it. A rescope changes the
    // title *and* supplies the label for it, so the two have to land in one write or the label is
    // lost the instant it is stored.
    const task = createTask({
      title: 'Rewrite the entire scheduler so that it never has to make a routing decision at all',
      createdBy: AGENT
    })
    const result = applyConsult(consultFor('gate', task.id), {
      verdict: 'rescope',
      title: 'Add a tie-break term to the router',
      why: 'the filed version is a rewrite',
      summary: 'Add a router tie-break'
    })

    expect(result.ok).toBe(true)
    const after = getTask(task.id)
    expect(after?.title).toBe('Add a tie-break term to the router')
    expect(after?.titleSummary).toBe('Add a router tie-break')
  })

  it('is discarded without taking the decision down with it', () => {
    const task = createTask({
      title: 'Work out why the estimator reads every Antigravity run as a runaway at four times',
      createdBy: AGENT
    })
    const result = applyConsult(consultFor('gate', task.id), {
      verdict: 'accept',
      why: 'worth doing',
      summary: 'x'.repeat(MAX_TITLE_SUMMARY + 1)
    })

    // ⛔ The verdict landed; only the label was lost.
    expect(result.ok).toBe(true)
    expect(getTask(task.id)?.status).toBe('ready')
    expect(getTask(task.id)?.titleSummary).toBeNull()
  })
})

describe('a label and the text it describes', () => {
  it('is dropped when the prompt is rewritten under it', () => {
    // ⛔ A label is a claim about a particular piece of text. Once an operator edits that text, the
    // old one-line description describes work nobody asked for any more — and the board would go on
    // presenting it as though somebody had.
    const task = createTask({ title: 'Something long enough to be worth labelling at all, honestly' })
    updateTask(task.id, { titleSummary: 'The old label' })
    expect(getTask(task.id)?.titleSummary).toBe('The old label')

    updateTask(task.id, { title: 'Something else entirely' })
    expect(getTask(task.id)?.titleSummary).toBeNull()
  })

  it('survives an edit that does not touch the title', () => {
    const task = createTask({ title: 'Something long enough to be worth labelling at all, honestly' })
    updateTask(task.id, { titleSummary: 'The label' })
    updateTask(task.id, { priority: 'P1' })
    expect(getTask(task.id)?.titleSummary).toBe('The label')
  })
})

describe('the dedicated question', () => {
  it('carries the prompt, and says that nothing it returns can change the work', () => {
    const task = createTask({ title: 'A'.repeat(TITLE_SUMMARY_THRESHOLD + 10) })
    const question = titleQuestion(task)

    expect(question).toContain('A'.repeat(TITLE_SUMMARY_THRESHOLD + 10))
    expect(question).toContain(String(MAX_TITLE_SUMMARY))
    // ⚠️ Asserted because it is true of the code as well as the prose: `applyTitle` writes
    // `titleSummary` and touches nothing else. A controller that believed otherwise would set about
    // improving the task instead of naming it.
    expect(question).toContain('changes a label and nothing else')
  })
})
