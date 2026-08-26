import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Consult } from '@shared/tasks.js'
import { closeDb, openDb } from './db.js'
import { applyConsult, fallbackFor } from './judgment.js'
import { createTask, getTask, listTasks, messagesFor } from './tasks.js'

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

    const human = messagesFor(task.id).filter((m) => m.role === 'human')
    expect(human.at(-1)?.text).toContain('install the dependencies first')
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
