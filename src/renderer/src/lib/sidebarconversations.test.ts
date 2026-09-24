import { afterEach, describe, expect, it } from 'vitest'
import type { Task, TaskStatus } from '@shared/tasks'
import {
  openConversations,
  projectSidebarActive,
  readCollapsedConversations,
  writeCollapsedConversations
} from './sidebarconversations'

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

describe('openConversations — what a project lists under itself in the sidebar', () => {
  it('⛔ lists a conversation waiting on you, which is where one rests between every turn', () => {
    expect(openConversations([row('a', 'awaiting_human')], 'p1').map((t) => t.id)).toEqual(['a'])
  })

  it('lists every unfinished status: paused, queued, held and running alike', () => {
    const statuses: TaskStatus[] = ['ready', 'blocked', 'scheduled', 'assigned', 'running', 'paused_quota', 'paused_user', 'landing_queued', 'cancelling']
    const listed = openConversations(statuses.map((s, i) => row(`t${i}`, s)), 'p1')
    expect(listed).toHaveLength(statuses.length)
  })

  it('drops what is finished, cancelled, still a draft or deleted', () => {
    const rows = [
      row('done', 'completed'),
      row('gone', 'cancelled'),
      row('draft', 'draft'),
      row('deleted', 'awaiting_human', { deletedAt: 5 })
    ]
    expect(openConversations(rows, 'p1')).toEqual([])
  })

  it('lists only conversations, and only this project’s', () => {
    const rows = [
      row('work', 'awaiting_human', { kind: 'work' }),
      row('plan', 'awaiting_human', { kind: 'plan' }),
      row('debate', 'awaiting_human', { kind: 'debate' }),
      row('elsewhere', 'awaiting_human', { projectId: 'p2' }),
      row('orphan', 'awaiting_human', { projectId: null }),
      row('mine', 'awaiting_human')
    ]
    expect(openConversations(rows, 'p1').map((t) => t.id)).toEqual(['mine'])
  })

  it('puts the one you were just talking to at the top', () => {
    const rows = [row('old', 'awaiting_human', { updatedAt: 1 }), row('new', 'running', { updatedAt: 9 }), row('mid', 'ready', { updatedAt: 5 })]
    expect(openConversations(rows, 'p1').map((t) => t.id)).toEqual(['new', 'mid', 'old'])
  })
})

describe('which projects have folded their conversations away', () => {
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
    expect(readCollapsedConversations().size).toBe(0)
  })

  it('comes back as it was left', () => {
    const store: Record<string, string> = {}
    stub(store)
    writeCollapsedConversations(new Set(['p1', 'p3']))
    expect([...readCollapsedConversations()].sort()).toEqual(['p1', 'p3'])
  })

  it('reads a value it cannot trust as nothing folded, and survives storage that throws', () => {
    stub({ 'warmstart.sidebarConversationsCollapsed': '{"p1":true}' })
    expect(readCollapsedConversations().size).toBe(0)
    stub({ 'warmstart.sidebarConversationsCollapsed': '[1, "p2", null]' })
    expect([...readCollapsedConversations()]).toEqual(['p2'])
    stub({}, true)
    expect(readCollapsedConversations().size).toBe(0)
    expect(() => writeCollapsedConversations(new Set(['p1']))).not.toThrow()
  })
})

describe('sidebar selection for an open conversation', () => {
  const listed = [{ id: 'conversation-1' }]

  it('⛔ lets the conversation, not its project, own the active highlight', () => {
    expect(projectSidebarActive({ kind: 'project', id: 'p1', tab: 'thread', taskId: 'conversation-1' }, 'p1', listed)).toBe(false)
  })

  it('keeps the project active for its other tabs and threads', () => {
    expect(projectSidebarActive({ kind: 'project', id: 'p1', tab: 'tasks' }, 'p1', listed)).toBe(true)
    expect(projectSidebarActive({ kind: 'project', id: 'p1', tab: 'thread', taskId: 'not-listed' }, 'p1', listed)).toBe(true)
  })
})
