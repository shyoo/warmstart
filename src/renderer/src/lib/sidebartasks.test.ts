import { afterEach, describe, expect, it } from 'vitest'
import type { Task, TaskStatus } from '@shared/tasks'
import {
  openTasks,
  projectSidebarActive,
  readCollapsedProjects,
  readProjectFilter,
  SIDEBAR_TASK_CAP,
  sidebarProjects,
  writeCollapsedProjects,
  writeProjectFilter
} from './sidebartasks'

type Row = Pick<Task, 'id' | 'kind' | 'status' | 'projectId' | 'deletedAt' | 'updatedAt'>

const row = (id: string, status: TaskStatus, over: Partial<Row> = {}): Row => ({
  id,
  kind: 'conversation',
  status,
  projectId: 'p1',
  deletedAt: null,
  updatedAt: 1000,
  ...over
})

describe('openTasks — what a project lists under itself in the sidebar', () => {
  it('⛔ lists a conversation waiting on you, which is where one rests between every turn', () => {
    expect(openTasks([row('a', 'awaiting_human')], 'p1').shown.map((t) => t.id)).toEqual(['a'])
  })

  it('lists every unfinished status: paused, queued, held and running alike', () => {
    const statuses: TaskStatus[] = ['ready', 'blocked', 'scheduled', 'assigned', 'running', 'paused_quota', 'paused_user', 'landing_queued', 'cancelling']
    const listed = openTasks(statuses.map((s, i) => row(`t${i}`, s)), 'p1', 100)
    expect(listed.shown).toHaveLength(statuses.length)
  })

  it('drops what is finished, cancelled, still a draft or deleted', () => {
    const rows = [
      row('done', 'completed'),
      row('gone', 'cancelled'),
      row('draft', 'draft'),
      row('deleted', 'awaiting_human', { deletedAt: 5 })
    ]
    expect(openTasks(rows, 'p1')).toEqual({ shown: [], hidden: 0 })
  })

  it('⛔ lists every kind, and only this project’s (t901)', () => {
    const rows = [
      row('work', 'awaiting_human', { kind: 'work' }),
      row('plan', 'ready', { kind: 'plan' }),
      row('debate', 'running', { kind: 'debate' }),
      row('elsewhere', 'awaiting_human', { projectId: 'p2' }),
      row('orphan', 'awaiting_human', { projectId: null }),
      row('mine', 'awaiting_human')
    ]
    expect(openTasks(rows, 'p1').shown.map((t) => t.id)).toEqual(['work', 'plan', 'debate', 'mine'])
  })

  it('shows the newest few and counts the rest', () => {
    const rows = Array.from({ length: SIDEBAR_TASK_CAP + 3 }, (_, i) => row(`t${i}`, 'ready', { updatedAt: i }))
    const { shown, hidden } = openTasks(rows, 'p1')
    expect(shown).toHaveLength(SIDEBAR_TASK_CAP)
    expect(shown[0]?.id).toBe(`t${SIDEBAR_TASK_CAP + 2}`)
    expect(hidden).toBe(3)
    expect(openTasks(rows.slice(0, SIDEBAR_TASK_CAP), 'p1').hidden).toBe(0)
  })

  it('puts the one you were just talking to at the top', () => {
    const rows = [row('old', 'awaiting_human', { updatedAt: 1 }), row('new', 'running', { updatedAt: 9 }), row('mid', 'ready', { updatedAt: 5 })]
    expect(openTasks(rows, 'p1').shown.map((t) => t.id)).toEqual(['new', 'mid', 'old'])
  })
})

describe('which projects have folded their tasks away', () => {
  const stub = (store: Record<string, string> | null, throws = false): void => {
    const storage = {
      getItem: (k: string) => {
        if (throws) throw new Error('site data disabled')
        return store?.[k] ?? null
      },
      setItem: (k: string, v: string) => {
        if (throws) throw new Error('site data disabled')
        if (store) store[k] = v
      },
      key: () => null,
      length: 0
    }
    ;(globalThis as { window?: unknown }).window = { localStorage: store === null ? null : storage }
  }

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window
  })

  it('defaults to open: a project seen for the first time shows what it has', () => {
    stub({})
    expect(readCollapsedProjects().size).toBe(0)
  })

  it('comes back as it was left', () => {
    const store: Record<string, string> = {}
    stub(store)
    writeCollapsedProjects(new Set(['p1', 'p3']))
    expect([...readCollapsedProjects()].sort()).toEqual(['p1', 'p3'])
  })

  it('reads a value it cannot trust as nothing folded, and survives storage that throws', () => {
    stub({ 'warmstart.sidebarConversationsCollapsed': '{"p1":true}' })
    expect(readCollapsedProjects().size).toBe(0)
    stub({ 'warmstart.sidebarConversationsCollapsed': '[1, "p2", null]' })
    expect([...readCollapsedProjects()]).toEqual(['p2'])
    stub({}, true)
    expect(readCollapsedProjects().size).toBe(0)
    expect(() => writeCollapsedProjects(new Set(['p1']))).not.toThrow()
  })
})

describe('which projects the sidebar lists (t901)', () => {
  const stub = (store: Record<string, string>): void => {
    ;(globalThis as { window?: unknown }).window = {
      localStorage: { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v } }
    }
  }
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window
  })

  it('defaults to Active, remembers a choice, and reads anything else as Active', () => {
    const store: Record<string, string> = {}
    stub(store)
    expect(readProjectFilter()).toBe('active')
    writeProjectFilter('archived')
    expect(readProjectFilter()).toBe('archived')
    store['warmstart.sidebarProjectFilter'] = 'everything'
    expect(readProjectFilter()).toBe('active')
  })

  it('lists active, archived, or active then archived', () => {
    const active: Array<{ id: string; archivedAt: number | null }> = [{ id: 'a', archivedAt: null }]
    const archived = [{ id: 'z', archivedAt: 5 }]
    expect(sidebarProjects(active, archived, 'active').map((p) => p.id)).toEqual(['a'])
    expect(sidebarProjects(active, archived, 'archived').map((p) => p.id)).toEqual(['z'])
    expect(sidebarProjects(active, archived, 'all').map((p) => p.id)).toEqual(['a', 'z'])
  })
})

describe('sidebar selection for an open task', () => {
  const listed = [{ id: 'conversation-1' }]

  it('⛔ lets the conversation, not its project, own the active highlight', () => {
    expect(projectSidebarActive({ kind: 'project', id: 'p1', tab: 'thread', taskId: 'conversation-1' }, 'p1', listed)).toBe(false)
  })

  it('keeps the project active for its other tabs and threads', () => {
    expect(projectSidebarActive({ kind: 'project', id: 'p1', tab: 'tasks' }, 'p1', listed)).toBe(true)
    expect(projectSidebarActive({ kind: 'project', id: 'p1', tab: 'thread', taskId: 'not-listed' }, 'p1', listed)).toBe(true)
  })
})
