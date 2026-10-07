import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { TaskDetailStore, viewFor, type DetailState } from './threaddetail'

interface Detail {
  task: { id: string }
  rev: number
}

/** A `task.get` whose every answer is held until the test releases it, in any order. */
function harness() {
  const pending: { id: string; resolve: (d: Detail | null) => void; reject: (e: Error) => void }[] = []
  const store = new TaskDetailStore<Detail>(
    (id) => new Promise((resolve, reject) => pending.push({ id, resolve, reject })),
    'a'
  )
  const answer = (index: number, detail: Detail | null) => pending[index]!.resolve(detail)
  const shown = (routeTaskId: string) => viewFor(store.getSnapshot(), routeTaskId)
  return { store, pending, answer, shown }
}

const detail = (id: string, rev = 1): Detail => ({ task: { id }, rev })
// Microtasks only: a timer here costs ~15ms a tick on Windows and the burst test takes thousands.
const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('TaskDetailStore — a thread only ever shows the task the route names', () => {
  it('shows nothing until the first read answers, then that task', async () => {
    const { store, answer, shown } = harness()
    const read = store.refresh()
    expect(shown('a')).toMatchObject({ detail: null, missing: false })
    answer(0, detail('a'))
    await read
    expect(shown('a').detail?.task.id).toBe('a')
  })

  it("t936 → t948: a slow read of the task you left cannot resurface under the new route", async () => {
    // The reported bug. The pane was on `a` (t948), a task.changed started a read, the operator
    // opened `b` (t936), and the read of `a` came back *after* the one for `b`.
    const { store, answer, shown, pending } = harness()
    const readA = store.refresh() // in flight for a
    store.open('b')
    const readB = store.refresh()
    expect(pending.map((p) => p.id)).toEqual(['a', 'b'])

    answer(1, detail('b'))
    await readB
    answer(0, detail('a')) // the stale one lands last
    await readA

    expect(shown('b').detail?.task.id).toBe('b')
    expect(store.getSnapshot().taskId).toBe('b')
  })

  it('a stale read of the previous task landing before the new one has answered shows nothing', async () => {
    const { store, answer, shown } = harness()
    const readA = store.refresh()
    store.open('b')
    const readB = store.refresh()

    answer(0, detail('a')) // before b has answered: the old pane must not come back
    await readA
    // ⛔ The store itself stays on b: its next refresh must ask for b, not for the task left behind.
    expect(store.getSnapshot()).toMatchObject({ taskId: 'b', detail: null })
    expect(shown('b')).toMatchObject({ detail: null, missing: false })

    answer(1, detail('b'))
    await readB
    expect(shown('b').detail?.task.id).toBe('b')
  })

  it.each([
    ['a before b', [0, 1]],
    ['b before a', [1, 0]]
  ])('whichever order two reads answer in (%s), the open task wins', async (_name, order) => {
    const { store, answer, shown } = harness()
    const reads = [store.refresh()]
    store.open('b')
    reads.push(store.refresh())
    for (const index of order) answer(index, detail(index === 0 ? 'a' : 'b'))
    await Promise.all(reads)
    expect(shown('b').detail?.task.id).toBe('b')
    expect(shown('a')).toMatchObject({ detail: null, missing: false })
  })

  it('a → b → a: a read of the first visit cannot be mistaken for the second', async () => {
    const { store, answer, shown } = harness()
    const first = store.refresh() // a, visit one
    store.open('b')
    store.open('a') // back again before anything answered
    const second = store.refresh() // a, visit two
    answer(1, detail('a', 2))
    await second
    answer(0, detail('a', 1)) // visit one's read arrives late, older than what is shown
    await first
    expect(shown('a').detail?.rev).toBe(2)
  })

  it('an older read of the same task never replaces a newer one', async () => {
    const { store, answer, shown } = harness()
    const older = store.refresh()
    const newer = store.refresh()
    answer(1, detail('a', 2))
    await newer
    answer(0, detail('a', 1))
    await older
    expect(shown('a').detail?.rev).toBe(2)
  })

  it('a body naming another task is refused even if it answers the right request', async () => {
    const { store, answer, shown } = harness()
    const read = store.refresh()
    answer(0, detail('zzz'))
    await read
    expect(store.getSnapshot().detail).toBeNull()
    expect(shown('a')).toMatchObject({ detail: null, missing: false })
  })

  it('a task that is gone reads as missing, and only for its own route', async () => {
    const { store, answer, shown } = harness()
    const read = store.refresh()
    answer(0, null)
    await read
    expect(shown('a').missing).toBe(true)
    expect(shown('b').missing).toBe(false)
  })

  it('a stale "missing" for the task you left does not mark the one you opened as gone', async () => {
    const { store, answer, shown } = harness()
    const readA = store.refresh()
    store.open('b')
    const readB = store.refresh()
    answer(1, detail('b'))
    await readB
    answer(0, null) // a was deleted, and the answer is late
    await readA
    expect(shown('b')).toMatchObject({ missing: false })
    expect(shown('b').detail?.task.id).toBe('b')
  })

  it('a refresh after an action keeps the open task and notifies subscribers', async () => {
    const { store, answer } = harness()
    let notified = 0
    const off = store.subscribe(() => notified++)
    const first = store.refresh()
    answer(0, detail('a', 1))
    await first
    const second = store.refresh()
    answer(1, detail('a', 2))
    await second
    expect(notified).toBe(2)
    expect(store.getSnapshot().detail?.rev).toBe(2)
    off()
    const third = store.refresh()
    answer(2, detail('a', 3))
    await third
    expect(notified).toBe(2)
  })

  it('opening the task already open changes nothing', async () => {
    const { store, answer } = harness()
    const read = store.refresh()
    answer(0, detail('a'))
    await read
    const before = store.getSnapshot()
    store.open('a')
    expect(store.getSnapshot()).toBe(before)
  })

  it('a failed read propagates to the caller and leaves what was shown alone', async () => {
    const { store, pending, answer } = harness()
    const ok = store.refresh()
    answer(0, detail('a'))
    await ok
    const failing = store.refresh()
    pending[1]!.reject(new Error('daemon unreachable'))
    await expect(failing).rejects.toThrow('daemon unreachable')
    expect(store.getSnapshot().detail?.task.id).toBe('a')
  })

  it('survives a burst of task.changed reads while the operator navigates back and forth', async () => {
    // Randomised but seeded: many reads for two tasks, answered in a shuffled order, with the route
    // flipping between them. Whatever happens, the pane never shows a task other than the route's.
    let seed = 948
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    for (let round = 0; round < 200; round++) {
      const { store, answer, pending } = harness()
      let route = 'a'
      const reads: Promise<void>[] = []
      for (let step = 0; step < 12; step++) {
        if (rand() < 0.4) {
          route = route === 'a' ? 'b' : 'a'
          store.open(route)
        }
        reads.push(store.refresh())
      }
      const order = pending.map((_, i) => i).sort(() => rand() - 0.5)
      for (const i of order) {
        answer(i, detail(pending[i]!.id, i))
        await settle()
        const view = viewFor(store.getSnapshot(), route)
        if (view.detail) expect(view.detail.task.id).toBe(route)
      }
      await Promise.all(reads)
      const finalView = viewFor(store.getSnapshot(), route)
      if (finalView.detail) expect(finalView.detail.task.id).toBe(route)
    }
  })
})

describe('viewFor — the render between a route change and the effect that re-opens the store', () => {
  const state = (taskId: string, held: Detail | null, missing = false): DetailState<Detail> => ({
    taskId,
    detail: held,
    missing
  })

  it('draws the held detail for its own task', () => {
    const held = detail('a')
    expect(viewFor(state('a', held), 'a').detail).toBe(held)
  })

  it('draws loading, not the old task, on the first render after the route changed', () => {
    expect(viewFor(state('a', detail('a')), 'b')).toEqual({ detail: null, missing: false })
  })

  it('does not carry a missing flag across tasks', () => {
    expect(viewFor(state('a', null, true), 'b').missing).toBe(false)
  })

  it('refuses a detail whose body names a different task than its state claims', () => {
    expect(viewFor(state('a', detail('b')), 'a').detail).toBeNull()
  })

  it('returns one shared loading object, so useSyncExternalStore consumers do not churn', () => {
    expect(viewFor(state('a', null), 'b')).toBe(viewFor(state('c', null), 'd'))
  })
})

describe('TaskThread wiring', () => {
  // The component is React-bound and there is no hook host at L1 (see useAction.test.ts), so the
  // contract is pinned at source level: the pane reads through the store and never from a bare
  // `useState` that any answer can write.
  const source = readFileSync(
    fileURLToPath(new URL('../components/TaskThread.tsx', import.meta.url)),
    'utf8'
  )

  it('holds its detail in the store and draws it through viewFor', () => {
    expect(source).toContain('new TaskDetailStore<TaskDetailData>')
    expect(source).toContain('viewFor(state, taskId)')
    expect(source).not.toContain('setDetail(')
  })

  it('re-opens the store when the route changes, before reading', () => {
    expect(source).toMatch(/store\.open\(taskId\)\s*\n\s*void store\.refresh\(\)/)
  })

  it("keys the open thread by its own task so a draft or a pending send cannot cross tasks", () => {
    expect(source).toMatch(/<TaskDetail\s*\n(?:\s*\/\/[^\n]*\n)*\s*key=\{detail\.task\.id\}/)
  })
})
