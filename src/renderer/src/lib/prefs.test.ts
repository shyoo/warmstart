import { afterEach, describe, expect, it } from 'vitest'
import type { TaskView } from '@shared/tasks'
import {
  readStatisticsExcludeApiMixed,
  writeStatisticsExcludeApiMixed,
  readStatisticsIncludeConversations,
  writeStatisticsIncludeConversations,
  readStatisticsWindow,
  writeStatisticsWindow,
  readFleetDensity,
  readTaskColumns,
  writeFleetDensity,
  writeTaskColumns,
  readQualityGradableOnly,
  writeQualityGradableOnly,
  readTaskPage,
  readTaskSort,
  taskListSignature,
  writeTaskPage,
  writeTaskSort
} from './prefs.js'

/**
 * ⛔ t353: sort by price, open a task, press `← Tasks`, and the table was back on *updated*. The
 * order lived only in the table's state, which opening a task unmounts.
 */
describe('which column the task table is ordered by', () => {
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

  it('starts on most recently updated, newest first', () => {
    stub({})
    expect(readTaskSort()).toEqual({ sort: 'updated', asc: false })
  })

  it('comes back as it was left, column and direction together', () => {
    const store: Record<string, string> = {}
    stub(store)
    writeTaskSort('price', true)
    // A fresh mount of the table, reading it cold.
    expect(readTaskSort()).toEqual({ sort: 'price', asc: true })
    writeTaskSort('price', false)
    expect(readTaskSort()).toEqual({ sort: 'price', asc: false })
  })

  it('falls back whole rather than half-applying a value it cannot trust', () => {
    for (const held of ['{', '"price"', '{"sort":"owner","asc":true}', '{"sort":"price"}', '{"sort":"price","asc":"yes"}']) {
      stub({ 'warmstart.taskSort': held })
      expect(readTaskSort(), held).toEqual({ sort: 'updated', asc: false })
    }
  })

  it('survives a localStorage that throws, or is not there', () => {
    stub({}, true)
    expect(readTaskSort()).toEqual({ sort: 'updated', asc: false })
    expect(() => writeTaskSort('title', true)).not.toThrow()
    stub(null)
    expect(readTaskSort()).toEqual({ sort: 'updated', asc: false })
  })
})

describe('which task columns are visible', () => {
  const stub = (store: Record<string, string>): void => {
    ;(globalThis as { window?: unknown }).window = {
      localStorage: { getItem: (key: string) => store[key] ?? null, setItem: (key: string, value: string) => { store[key] = value } }
    }
  }

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window
  })

  it('shows every optional column by default and remembers a chosen subset', () => {
    const store: Record<string, string> = {}
    stub(store)
    expect(readTaskColumns()).toContain('title')
    expect(readTaskColumns()).toContain('kind')
    writeTaskColumns(['title', 'status'])
    expect(readTaskColumns()).toEqual(['title', 'status'])
  })

  it('adds Type to a saved pre-Type layout while preserving its other choices', () => {
    stub({ 'warmstart.taskColumns': '["title","status"]' })
    expect(readTaskColumns()).toEqual(['title', 'kind', 'status'])
    stub({ 'warmstart.taskColumns': '[]' })
    expect(readTaskColumns()).toEqual([])
  })

  it('uses the full table when a saved value is malformed or obsolete', () => {
    stub({ 'warmstart.taskColumns': '{' })
    expect(readTaskColumns()).toContain('action')
    stub({ 'warmstart.taskColumns': '["owner"]' })
    expect(readTaskColumns()).toContain('action')
  })
})

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
    expect(store['warmstart.fleetDensity']).toBe('narrow')
    expect(readFleetDensity()).toBe('narrow')
    writeFleetDensity('wide')
    expect(readFleetDensity()).toBe('wide')
  })

  it('reads anything it does not recognise as wide', () => {
    stub({ 'warmstart.fleetDensity': 'condensed' })
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
    expect(store['warmstart.qualityGradableOnly']).toBe('true')
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
      stub({ 'warmstart.taskPage': held })
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

/** t361: how far back Analytics › Statistics reads is the reader’s choice, and it has to survive a restart. */
describe('the statistics window', () => {
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

  it('reads the bounded window by default, and after any value that is not the literal all', () => {
    stub({})
    expect(readStatisticsWindow()).toBe('recent')
    const store: Record<string, string> = {}
    stub(store)
    writeStatisticsWindow('all')
    expect(readStatisticsWindow()).toBe('all')
    store[Object.keys(store)[0] as string] = 'everything'
    expect(readStatisticsWindow()).toBe('recent')
  })

  it('is never worth a blank screen', () => {
    stub({}, true)
    expect(readStatisticsWindow()).toBe('recent')
    expect(() => writeStatisticsWindow('all')).not.toThrow()
  })
})

/** The trade-off scatters' "Exclude API rate & mixed" checkbox has to survive a restart too. */
describe('the statistics exclude-API-mixed filter', () => {
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

  it('defaults to off, and remembers a checked value across a restart', () => {
    stub({})
    expect(readStatisticsExcludeApiMixed()).toBe(false)
    const store: Record<string, string> = {}
    stub(store)
    writeStatisticsExcludeApiMixed(true)
    expect(readStatisticsExcludeApiMixed()).toBe(true)
  })

  it('is never worth a blank screen', () => {
    stub({}, true)
    expect(readStatisticsExcludeApiMixed()).toBe(false)
    expect(() => writeStatisticsExcludeApiMixed(true)).not.toThrow()
  })
})

/** t695: whether Analytics › Statistics folds conversation-kind tasks in has to survive a restart. */
describe('the statistics include-conversations filter', () => {
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

  it('defaults to in — anything but an explicit false reads true', () => {
    stub({})
    expect(readStatisticsIncludeConversations()).toBe(true)
    const store: Record<string, string> = {}
    stub(store)
    writeStatisticsIncludeConversations(false)
    expect(readStatisticsIncludeConversations()).toBe(false)
    store[Object.keys(store)[0] as string] = 'perhaps'
    expect(readStatisticsIncludeConversations()).toBe(true)
  })

  it('is never worth a blank screen', () => {
    stub({}, true)
    expect(readStatisticsIncludeConversations()).toBe(true)
    expect(() => writeStatisticsIncludeConversations(false)).not.toThrow()
  })
})
