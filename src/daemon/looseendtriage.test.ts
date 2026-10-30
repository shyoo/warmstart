import { describe, expect, it } from 'vitest'
import type { LooseEnd, Task } from '@shared/tasks.js'
import { TRIAGE_TITLE_PREFIX, openTriageTask, triageGroups, triagePrompt, triageTitle } from './looseendtriage.js'

const end = (over: Partial<LooseEnd>): LooseEnd => ({
  id: 'e1',
  kind: 'unlanded',
  projectId: 'p1',
  projectName: 'alpha',
  workspacePath: 'C:/ws1',
  branch: 'warmstart/t12-fix',
  count: 3,
  taskSeq: 12,
  summary: '3 commit(s) not on main',
  ...over
})

const task = (over: Partial<Task>): Task =>
  ({ id: 'x', seq: 90, projectId: 'p1', status: 'running', title: triageTitle('alpha', 2), ...over }) as Task

describe('which rows reach a triage task', () => {
  it('groups the rows the operator was shown by project, from the fresh scan', () => {
    const fresh = [
      end({ id: 'a' }),
      end({ id: 'b', projectId: 'p2', projectName: 'beta' }),
      end({ id: 'c', kind: 'stash', branch: null, taskSeq: null })
    ]
    const groups = triageGroups(fresh, ['a', 'b', 'c'])
    expect(groups.map((g) => [g.projectName, g.ends.map((e) => e.id)])).toEqual([
      ['alpha', ['a', 'c']],
      ['beta', ['b']]
    ])
  })

  it('⛔ drops a row that resolved since the panel drew it, and one the operator never saw', () => {
    // `gone` is a row the operator was shown that the fresh scan no longer has; `unseen` appeared
    // after they looked. Neither is something they handed over.
    const groups = triageGroups([end({ id: 'kept' }), end({ id: 'unseen' })], ['kept', 'gone'])
    expect(groups.flatMap((g) => g.ends.map((e) => e.id))).toEqual(['kept'])
  })
})

describe('one triage task per project at a time', () => {
  it('finds an open triage task for the same project', () => {
    expect(openTriageTask([task({})], 'p1')?.seq).toBe(90)
  })

  it('ignores a settled one, another project’s, and a task that is not a triage', () => {
    expect(openTriageTask([task({ status: 'completed' })], 'p1')).toBeNull()
    expect(openTriageTask([task({ projectId: 'p2' })], 'p1')).toBeNull()
    expect(openTriageTask([task({ title: 'Fix the dialog' })], 'p1')).toBeNull()
  })

  it('titles carry the prefix the guard looks for', () => {
    expect(triageTitle('alpha', 1)).toBe(`${TRIAGE_TITLE_PREFIX}alpha (1 item)`)
    expect(triageTitle('alpha', 4)).toBe(`${TRIAGE_TITLE_PREFIX}alpha (4 items)`)
  })
})

describe('the instruction the agent works from', () => {
  const prompt = triagePrompt(
    {
      projectId: 'p1',
      projectName: 'alpha',
      ends: [end({}), end({ id: 'm', kind: 'merged', branch: 'warmstart/t7-x', taskSeq: 7, url: 'https://example.test/pr/7' })]
    },
    'main',
    new Date('2026-10-30T00:00:00Z')
  )

  it('lists every item with its kind, branch, task and workspace', () => {
    expect(prompt).toContain('1. [not landed] branch `warmstart/t12-fix` (t12) — 3 commit(s) not on main')
    expect(prompt).toContain('2. [merged, branch left] branch `warmstart/t7-x` (t7)')
    expect(prompt).toContain('pull request: https://example.test/pr/7')
    expect(prompt).toContain('workspace: C:/ws1')
  })

  it('offers land, delete and leave, and lands by merge so the original commits clear their rows', () => {
    expect(prompt).toContain('**Land it**')
    expect(prompt).toContain('git merge --no-ff <branch>')
    expect(prompt).toContain('do not squash')
    expect(prompt).toContain('**Delete it**')
    expect(prompt).toContain('**Leave it**')
  })

  it('⛔ makes every deletion restorable and forbids touching another workspace’s files', () => {
    expect(prompt).toContain('git rev-parse <branch>')
    expect(prompt).toContain('git branch <name> <sha>')
    expect(prompt).toContain('Never reset, clean, or delete another workspace’s files')
    expect(prompt).toContain('stash stack is shared')
  })

  it('measures against the project’s landing target', () => {
    expect(prompt).toContain('git log --oneline main..<branch>')
  })
})
