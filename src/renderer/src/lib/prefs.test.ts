import { afterEach, describe, expect, it } from 'vitest'
import type { TaskView } from '@shared/tasks'
import {
  readFleetDensity,
  writeFleetDensity,
  readQualityGradableOnly,
  writeQualityGradableOnly,
  readTaskPage,
  taskListSignature,
  writeTaskPage
} from './prefs.js'

/**
 * ⛔ The default is the interesting case, not the round trip. `narrow` hides the name of every
 * gauge on every card, and it is a mode somebody opted into by pressing a button — so anything
 * this reader is unsure about has to come back `wide`. An unreadable stored value resolving to
 * `narrow` would silently condense the strip of an operator who never asked, with no clue in the
 * UI as to why the labels went.
 */
describe('how dense the fleet strip was left', () => {
  const stub = (store: Record<string, string> | null, throws = false): void => {
    const storage = {
      getItem: (k: string) => {
        if (throws) throw new Error('site data disabled')
        return store?.[k] ?? null
      },
      setItem: (k: string, v: string) => {
        if (throws) throw new Error('site data disabled')
        if (store) store[k] = v
      }
    }
    ;(globalThis as { window?: unknown }).window = { localStorage: store === null ? null : storage }
  }

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window
  })

  it('starts wide, because that is the mode that shows everything', () => {
    stub({})
    expect(readFleetDensity()).toBe('wide')
  })

  it('remembers the one mode you have to ask for', () => {
    const store: Record<string, string> = {}
    stub(store)
    writeFleetDensity('narrow')
    expect(store['multi_agent_controller.fleetDensity']).toBe('narrow')
    expect(readFleetDensity()).toBe('narrow')
    writeFleetDensity('wide')
    expect(readFleetDensity()).toBe('wide')
  })

  it('reads anything it does not recognise as wide', () => {
    stub({ 'multi_agent_controller.fleetDensity': 'condensed' })
    expect(readFleetDensity()).toBe('wide')
  })

  // ⚠️ `localStorage` throws rather than returning null in real configurations — a profile with
  // site data disabled, a private window on some platforms. A preference is never worth a blank
  // screen, so both directions swallow it.
  it('survives a localStorage that throws, in both directions', () => {
    stub({}, true)
    expect(readFleetDensity()).toBe('wide')
    expect(() => writeFleetDensity('narrow')).not.toThrow()
  })

  it('and a renderer with no window at all', () => {
    expect(readFleetDensity()).toBe('wide')
    expect(() => writeFleetDensity('narrow')).not.toThrow()
  })
})

describe('whether quality review filters out ungradable tasks', () => {
  const stub = (store: Record<string, string> | null, throws = false): void => {
    const storage = {
      getItem: (k: string) => {
        if (throws) throw new Error('site data disabled')
        return store?.[k] ?? null
      },
      setItem: (k: string, v: string) => {
        if (throws) throw new Error('site data disabled')
        if (store) store[k] = v
      }
    }
    ;(globalThis as { window?: unknown }).window = { localStorage: store === null ? null : storage }
  }

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window
  })

  it('defaults to false', () => {
    stub({})
    expect(readQualityGradableOnly()).toBe(false)
  })

  it('persists true when set', () => {
    const store: Record<string, string> = {}
    stub(store)
    writeQualityGradableOnly(true)
    expect(store['multi_agent_controller.qualityGradableOnly']).toBe('true')
    expect(readQualityGradableOnly()).toBe(true)
    writeQualityGradableOnly(false)
    expect(readQualityGradableOnly()).toBe(false)
  })

  it('survives throwing localStorage', () => {
    stub({}, true)
    expect(readQualityGradableOnly()).toBe(false)
    expect(() => writeQualityGradableOnly(true)).not.toThrow()
  })
})

/**
 * ⛔ The bug this exists for: opening a task unmounts the table, so `← Tasks` used to land on page 1
 * however deep into the list somebody had navigated. The offset survives — but only onto the same
 * list, because page 4 of a filter that now has one page is an empty table under a chip reading
 * `Done 3`, which reads as a broken screen rather than as a stale offset.
 */
describe('which page of the task list you were reading', () => {
  const stub = (store: Record<string, string> | null, throws = false): void => {
    const storage = {
      getItem: (k: string) => {
        if (throws) throw new Error('site data disabled')
        return store?.[k] ?? null
      },
      setItem: (k: string, v: string) => {
        if (throws) throw new Error('site data disabled')
        if (store) store[k] = v
      }
    }
    ;(globalThis as { window?: unknown }).window = { localStorage: store === null ? null : storage }
  }

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window
  })

  const list = {
    projectId: 'p1',
    views: ['needs_you'] as TaskView[],
    sort: 'updated',
    asc: false,
    pageSize: 25,
    search: ''
  }

  it('comes back on the list it was taken from', () => {
    const store: Record<string, string> = {}
    stub(store)
    const signature = taskListSignature(list)
    writeTaskPage(signature, 3)
    // A fresh mount of the same table, reading it cold.
    expect(readTaskPage(taskListSignature(list))).toBe(3)
  })

  it('is ignored the moment any part of what is listed differs', () => {
    const store: Record<string, string> = {}
    stub(store)
    writeTaskPage(taskListSignature(list), 3)
    expect(readTaskPage(taskListSignature({ ...list, projectId: 'p2' }))).toBe(0)
    expect(readTaskPage(taskListSignature({ ...list, views: [] }))).toBe(0)
    expect(readTaskPage(taskListSignature({ ...list, sort: 'title' }))).toBe(0)
    expect(readTaskPage(taskListSignature({ ...list, asc: true }))).toBe(0)
    expect(readTaskPage(taskListSignature({ ...list, pageSize: 50 }))).toBe(0)
    expect(readTaskPage(taskListSignature({ ...list, search: 'muse' }))).toBe(0)
  })

  // ⚠️ Picking two buckets in the other order is the same list. A signature that said otherwise
  // would throw the offset away for a reason nobody sitting here could see.
  it('does not care what order the buckets were picked in', () => {
    expect(taskListSignature({ ...list, views: ['needs_you', 'running'] as TaskView[] })).toBe(
      taskListSignature({ ...list, views: ['running', 'needs_you'] as TaskView[] })
    )
  })

  // ⚠️ Whitespace is not a search. The table trims before it queries, and the signature has to agree
  // or a trailing space would silently reset the page.
  it('trims the search the same way the query does', () => {
    expect(taskListSignature({ ...list, search: '  muse  ' })).toBe(
      taskListSignature({ ...list, search: 'muse' })
    )
  })

  it('reads a stored page that is not a page at all as the first one', () => {
    const signature = taskListSignature(list)
    for (const held of ['nonsense', '[]', JSON.stringify({ signature, page: -1 }), JSON.stringify({ signature, page: 2.5 }), JSON.stringify({ signature, page: 'four' })]) {
      stub({ 'multi_agent_controller.taskPage': held })
      expect(readTaskPage(signature)).toBe(0)
    }
  })

  it('survives a localStorage that throws, in both directions', () => {
    stub({}, true)
    expect(readTaskPage(taskListSignature(list))).toBe(0)
    expect(() => writeTaskPage(taskListSignature(list), 2)).not.toThrow()
    stub(null)
    expect(readTaskPage(taskListSignature(list))).toBe(0)
  })
})
