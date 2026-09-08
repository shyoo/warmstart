import { afterEach, describe, expect, it } from 'vitest'
import {
  clearComposerScratch,
  EMPTY_SCRATCH,
  hasComposerScratch,
  isEmptyScratch,
  normalizeScratch,
  readComposerScratch,
  scratchAttachments,
  scratchImages,
  writeComposerScratch,
  type ComposerScratch
} from './composerscratch.js'

const KEY = 'multi_agent_controller.composerScratch'

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

function typed(over: Partial<ComposerScratch> = {}): ComposerScratch {
  return { ...EMPTY_SCRATCH, prompt: 'Fix the pager', ...over }
}

describe('what the composer was left half-writing', () => {
  it('comes back after the form has been unmounted and mounted again', () => {
    const store: Record<string, string> = {}
    stub(store)
    writeComposerScratch('', typed({ dependsOn: ['t1'] }))
    // A different render of the same form, reading it cold.
    expect(readComposerScratch('')).toEqual({
      ...EMPTY_SCRATCH,
      prompt: 'Fix the pager',
      dependsOn: ['t1']
    })
  })

  /**
   * ⛔ The project composer and the fleet-wide one file into different places. Text typed into one
   * appearing in the other would be a task filed against a project nobody chose.
   */
  it('keeps each composer to itself', () => {
    const store: Record<string, string> = {}
    stub(store)
    writeComposerScratch('p1', typed({ prompt: 'in the project' }))
    writeComposerScratch('', typed({ prompt: 'fleet wide' }))
    expect(readComposerScratch('p1').prompt).toBe('in the project')
    expect(readComposerScratch('').prompt).toBe('fleet wide')
    expect(readComposerScratch('p2')).toEqual(EMPTY_SCRATCH)
  })

  it('forgets a scope that has been emptied, rather than storing blanks', () => {
    const store: Record<string, string> = {}
    stub(store)
    writeComposerScratch('p1', typed())
    writeComposerScratch('', typed())
    clearComposerScratch('p1')
    expect(readComposerScratch('p1')).toEqual(EMPTY_SCRATCH)
    expect(JSON.parse(store[KEY] ?? '{}')).not.toHaveProperty('p1')
    // ⚠️ And only that one. Clearing one form must not clear the other.
    expect(readComposerScratch('').prompt).toBe('Fix the pager')
  })

  /** ⛔ What the list uses to decide whether to open the composer at all. */
  it('reports a scratch only when there is something to come back to', () => {
    const store: Record<string, string> = {}
    stub(store)
    expect(hasComposerScratch('')).toBe(false)
    writeComposerScratch('', { ...EMPTY_SCRATCH, schedule: 'now' })
    expect(hasComposerScratch('')).toBe(false)
    writeComposerScratch('', typed({ prompt: '   ' }))
    expect(hasComposerScratch('')).toBe(false)
    writeComposerScratch('', typed({ prompt: '   ', attachments: [{ id: 'a1', width: 0, height: 0, bytes: 3 }] }))
    expect(hasComposerScratch('')).toBe(true)
    writeComposerScratch('', typed())
    expect(hasComposerScratch('')).toBe(true)
  })

  it('counts an armed schedule as content, so a scheduled send is not silently disarmed', () => {
    expect(isEmptyScratch({ ...EMPTY_SCRATCH, schedule: '4h' })).toBe(false)
    expect(isEmptyScratch(EMPTY_SCRATCH)).toBe(true)
  })

  // ⚠️ `localStorage` throws rather than returning null in real configurations. A scratch is never
  // worth a blank screen, so both directions swallow it.
  it('survives a localStorage that throws, in both directions', () => {
    stub({}, true)
    expect(readComposerScratch('')).toEqual(EMPTY_SCRATCH)
    expect(hasComposerScratch('')).toBe(false)
    expect(() => writeComposerScratch('', typed())).not.toThrow()
  })

  it('survives a window with no storage at all', () => {
    stub(null)
    expect(readComposerScratch('')).toEqual(EMPTY_SCRATCH)
    expect(() => writeComposerScratch('', typed())).not.toThrow()
  })

  it('reads rubbish in the slot as nothing typed', () => {
    stub({ [KEY]: 'not json' })
    expect(readComposerScratch('')).toEqual(EMPTY_SCRATCH)
    stub({ [KEY]: '"a string"' })
    expect(readComposerScratch('')).toEqual(EMPTY_SCRATCH)
  })
})

/**
 * ⛔ Field by field. What is in storage was written by whichever build of the composer ran last, and
 * throwing a whole paragraph away because one field is missing or has aged out is exactly the
 * failure this module exists to prevent.
 */
describe('normalizeScratch', () => {
  it('keeps the prompt even when everything around it is wrong', () => {
    expect(normalizeScratch({ prompt: 'still here', dependsOn: 'nope', attachments: 7 })).toEqual({
      ...EMPTY_SCRATCH,
      prompt: 'still here'
    })
  })

  it('drops a schedule it does not recognise, rather than arming an unknown clock', () => {
    expect(normalizeScratch({ schedule: '9h' }).schedule).toBe('now')
    expect(normalizeScratch({ schedule: '4h' }).schedule).toBe('4h')
  })

  it('drops a custom time unless the clock is actually on custom', () => {
    expect(normalizeScratch({ schedule: '1h', customTime: '2020-01-01T00:00' }).customTime).toBe('')
    expect(normalizeScratch({ schedule: 'custom', customTime: '2026-09-08T09:30' }).customTime).toBe(
      '2026-09-08T09:30'
    )
  })

  it('drops attachment entries with no id, and keeps the ones that have one', () => {
    const got = normalizeScratch({
      attachments: [{ width: 10 }, null, 'x', { id: '', bytes: 1 }, { id: 'a1', bytes: 44 }]
    })
    expect(got.attachments).toEqual([{ id: 'a1', width: 0, height: 0, bytes: 44 }])
  })

  it('reads anything that is not an object as nothing typed', () => {
    expect(normalizeScratch(undefined)).toEqual(EMPTY_SCRATCH)
    expect(normalizeScratch(12)).toEqual(EMPTY_SCRATCH)
  })
})

describe('attachments across the boundary', () => {
  /**
   * ⛔ The bytes must not be stored — one downscaled screenshot is over a megabyte of base64 against
   * a five-megabyte budget, and evicting the prompt to keep a thumbnail gets the trade backwards.
   */
  it('stores the id and never the preview', () => {
    const stored = scratchAttachments([
      { id: 'a1', preview: 'data:image/png;base64,AAAA', width: 1568, height: 880, bytes: 900 },
      { id: 'a2', preview: null, name: 'notes.pdf', width: 0, height: 0, bytes: 12 }
    ])
    expect(stored).toEqual([
      { id: 'a1', width: 1568, height: 880, bytes: 900 },
      { id: 'a2', name: 'notes.pdf', width: 0, height: 0, bytes: 12 }
    ])
    expect(JSON.stringify(stored)).not.toContain('base64')
  })

  /** ⚠️ The chip names what it can no longer draw, so a restored image is not a blank square. */
  it('brings each upload back as a named chip with no thumbnail', () => {
    const images = scratchImages(
      normalizeScratch({
        attachments: [
          { id: 'a1', width: 1568, height: 880, bytes: 900 },
          { id: 'a2', name: 'notes.pdf' },
          { id: 'a3' }
        ]
      })
    )
    expect(images.map((i) => i.preview)).toEqual([null, null, null])
    expect(images.map((i) => i.name)).toEqual(['1568×880 image', 'notes.pdf', 'attachment'])
    // ⛔ The ids are the whole point: they are what `task.create` is handed.
    expect(images.map((i) => i.id)).toEqual(['a1', 'a2', 'a3'])
  })

  it('round-trips what the composer holds', () => {
    const store: Record<string, string> = {}
    stub(store)
    const images = [
      { id: 'a1', preview: 'data:image/png;base64,AAAA', width: 4, height: 5, bytes: 6 }
    ]
    writeComposerScratch('', { ...EMPTY_SCRATCH, prompt: 'x', attachments: scratchAttachments(images) })
    expect(scratchImages(readComposerScratch('')).map((i) => i.id)).toEqual(['a1'])
  })
})
