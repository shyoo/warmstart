import { expect, it } from 'vitest'
import type { Task } from '@shared/tasks'
import type { DaemonEvent } from '@shared/protocol'
import { refreshGate, patchTask, rememberTaskProjects, taskPageChanged } from './refresh'
import { setCurrentTargetId } from './target'

it('collapses a burst into one active read and one follow-up', async () => {
  const gate = refreshGate()
  let release!: () => void
  const wait = new Promise<void>((resolve) => { release = resolve })
  let count = 0
  const first = gate.run(async () => { count++; await wait })
  const queued = Array.from({ length: 100 }, () => gate.run(async () => { count++ }))
  expect(count).toBe(1)
  release(); await Promise.all([first, ...queued])
  expect(count).toBe(2)
})

it('does not refetch another project, and remembers a move/deletion even off the visible page', () => {
  setCurrentTargetId('refresh-test')
  const task = { id: 't', projectId: 'old', deletedAt: null } as Task
  rememberTaskProjects([task], true)
  const run = { type: 'run.changed', run: { taskId: 't' } } as DaemonEvent
  expect(taskPageChanged(run, 'other', [])).toBe(false)
  rememberTaskProjects([{ ...task, projectId: 'new' }]) // App handles this before its child page.
  expect(taskPageChanged({ type: 'task.changed', task: { ...task, projectId: 'new' } }, 'old', [])).toBe(true)
  expect(taskPageChanged(run, 'old', [])).toBe(false)
  expect(patchTask([task], { ...task, deletedAt: 123 })).toEqual([])
  setCurrentTargetId('another-computer')
  rememberTaskProjects([task], true, 'refresh-test') // A late snapshot from the previous computer.
  expect(taskPageChanged(run, 'old', [])).toBe(true) // Missing metadata is unknown, not exclusion.
  setCurrentTargetId('local')
})
