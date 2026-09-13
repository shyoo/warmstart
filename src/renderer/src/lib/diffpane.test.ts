import { describe, expect, it } from 'vitest'
import {
  EXPAND_MAX_FILES,
  EXPAND_MAX_LINES,
  initialExpansion,
  paneFollows,
  sameSource,
  type DiffPaneRequest
} from './diffpane'

const file = (path: string, lines = 10, extra: { binary?: boolean; generated?: boolean } = {}) => ({
  path,
  added: lines,
  removed: 0,
  binary: extra.binary ?? false,
  generated: extra.generated ?? false
})

describe('the pane follows the route', () => {
  const request: DiffPaneRequest = { taskId: 't-1', source: { kind: 'commit', sha: 'abc' } }

  it('stays open while the route names the task it was opened for', () => {
    expect(paneFollows(request, 't-1')).toBe(true)
  })

  it('closes when the route names another task, or none', () => {
    expect(paneFollows(request, 't-2')).toBe(false)
    // ⚠️ Overview and Settings carry no task, and there is nothing there for a diff to be of.
    expect(paneFollows(request, null)).toBe(false)
  })

  it('has nothing to follow when nothing is open', () => {
    expect(paneFollows(null, 't-1')).toBe(false)
  })
})

describe('naming the same change', () => {
  it('matches a branch to a branch and a commit to its own sha', () => {
    expect(sameSource({ kind: 'branch' }, { kind: 'branch' })).toBe(true)
    expect(sameSource({ kind: 'commit', sha: 'a' }, { kind: 'commit', sha: 'a' })).toBe(true)
    expect(sameSource({ kind: 'commit', sha: 'a' }, { kind: 'commit', sha: 'b' })).toBe(false)
    expect(sameSource({ kind: 'branch' }, { kind: 'commit', sha: 'a' })).toBe(false)
  })
})

describe('which files open expanded', () => {
  it('opens a small change in full', () => {
    const open = initialExpansion([file('a.ts'), file('b.ts'), file('c.ts')], undefined)
    expect([...open]).toEqual(['a.ts', 'b.ts', 'c.ts'])
  })

  it('stops at the file count ceiling, contiguously from the top', () => {
    const files = Array.from({ length: EXPAND_MAX_FILES + 3 }, (_, i) => file(`f${i}.ts`, 1))
    const open = initialExpansion(files, undefined)
    expect(open.size).toBe(EXPAND_MAX_FILES)
    expect(open.has('f0.ts')).toBe(true)
    expect(open.has(`f${EXPAND_MAX_FILES}.ts`)).toBe(false)
  })

  it('stops at the line ceiling and does not skip ahead to a smaller file', () => {
    // ⚠️ The third file would fit on its own; opening it past a closed one would draw a scatter of
    // open and closed rows rather than a run, so the budget is spent the moment one does not fit.
    const open = initialExpansion(
      [file('big.ts', EXPAND_MAX_LINES - 10), file('next.ts', 20), file('tiny.ts', 1)],
      undefined
    )
    expect([...open]).toEqual(['big.ts'])
  })

  it('never opens a binary or generated file, and they cost nothing', () => {
    const open = initialExpansion(
      [file('logo.png', 0, { binary: true }), file('package-lock.json', 4_000, { generated: true }), file('a.ts')],
      undefined
    )
    expect([...open]).toEqual(['a.ts'])
  })

  it('always opens the file somebody pressed, wherever it sits', () => {
    const files = Array.from({ length: EXPAND_MAX_FILES + 5 }, (_, i) => file(`f${i}.ts`, 1))
    const open = initialExpansion(files, 'f15.ts')
    expect(open.has('f15.ts')).toBe(true)
    // ⚠️ And it does not spend the budget — the twelve from the top still open.
    expect(open.has(`f${EXPAND_MAX_FILES - 1}.ts`)).toBe(true)
  })
})
