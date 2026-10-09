import { describe, expect, it } from 'vitest'
import {
  conversationTargets,
  insertAfter,
  mergeWithNext,
  moveItem,
  openCount,
  parseScratch,
  promptOf,
  removeItem,
  scratchRows,
  serializeScratch,
  setBody,
  setTag,
  splitAt,
  tagOf,
  taskForRef,
  titleOf,
  withTag
} from './scratchpad'

/** A history shaped like the one the page was built for: a heading, hundreds of prompts, a few New. */
function historyText(count: number): string {
  const parts = ['# Prompt History\n\n## Initial prompt\n\nBuild the thing.\n\n# History\n']
  for (let i = 1; i <= count; i++) {
    const marker = i % 97 === 0 ? '* New\n\n' : ''
    const fence = i % 50 === 0 ? '\n```\n---\nnot a separator\n```\n' : ''
    parts.push(`\n${marker}Prompt ${i}: do the work.\n\n- a bullet\n${fence}\n`)
  }
  return parts.join('---') + '\n\n# Future\n\n\n'
}

describe('parse and serialize', () => {
  it('round-trips a 600-prompt history byte for byte, splitting on --- and never inside a fence', () => {
    const text = historyText(600)
    const doc = parseScratch(text)
    expect(doc.items).toHaveLength(601)
    expect(serializeScratch(doc)).toBe(text)
    expect(doc.items[50]?.body).toContain('```\n---\nnot a separator\n```')
    expect(doc.items.filter((item) => tagOf(item.body)?.kind === 'new')).toHaveLength(6)
  })

  it.each([
    ['empty', ''],
    ['whitespace only', '\n\n  \n'],
    ['no separator', 'one prompt\n'],
    ['no trailing newline', 'a\n---\nb'],
    ['separator on the first line', '---\nx\n'],
    ['separator on the last line', 'x\n---'],
    ['two separators in a row', 'a\n---\n---\nb\n'],
    ['a blank line between separators', 'a\n---\n\n---\nb\n'],
    ['longer separators and trailing spaces', 'a\n\n----  \n\nb\n\n\n'],
    ['indented first line', '\n\n    code-ish\n---\n\n  b\n'],
    ['setext-looking text', 'Title\n---\nbody\n'],
    ['an unclosed fence', 'a\n```\n---\nstill code\n']
  ])('round-trips %s', (_, text) => {
    expect(serializeScratch(parseScratch(text))).toBe(text.trim() === '' ? '' : text)
  })

  it('keeps every other card byte for byte when one is edited', () => {
    const text = historyText(40)
    const doc = parseScratch(text)
    const edited = serializeScratch(setBody(doc, 7, 'Prompt 7, rewritten.'))
    expect(edited).toBe(text.replace('Prompt 7: do the work.\n\n- a bullet', 'Prompt 7, rewritten.'))
  })
})

describe('card operations', () => {
  const three = 'one\n\n---\n\ntwo\n\n---\n\nthree\n'

  it('moves bodies and leaves the blank lines where they were', () => {
    const doc = parseScratch(three)
    expect(serializeScratch(moveItem(doc, 2, 0))).toBe('three\n\n---\n\none\n\n---\n\ntwo\n')
    expect(serializeScratch(moveItem(doc, 0, 2))).toBe('two\n\n---\n\nthree\n\n---\n\none\n')
    expect(moveItem(doc, 0, 3)).toBe(doc)
  })

  it('keeps keys through a move, so an open editor follows its card', () => {
    const doc = parseScratch(three)
    const moved = moveItem(doc, 0, 2)
    expect(moved.items[2]?.key).toBe(doc.items[0]?.key)
  })

  it('merges a card with the next, dropping the separator between them', () => {
    const doc = parseScratch(three)
    expect(serializeScratch(mergeWithNext(doc, 0))).toBe('one\n\ntwo\n\n---\n\nthree\n')
    expect(serializeScratch(mergeWithNext(doc, 1))).toBe('one\n\n---\n\ntwo\n\nthree\n')
    expect(mergeWithNext(doc, 2)).toBe(doc)
  })

  it('splits at a caret, and does nothing at either end of the card', () => {
    const doc = parseScratch('first half second half\n')
    const split = splitAt(doc, 0, 'first half'.length)
    expect(serializeScratch(split)).toBe('first half\n\n---\n\nsecond half\n')
    expect(split.items[0]?.key).toBe(doc.items[0]?.key)
    expect(splitAt(doc, 0, 0)).toBe(doc)
    expect(splitAt(doc, 0, doc.items[0]?.body.length ?? 0)).toBe(doc)
  })

  it('splits a card whose edited text now holds a --- line, only when asked', () => {
    const doc = parseScratch(three)
    const typed = 'two\n\n---\n\ntwo and a half'
    expect(setBody(doc, 1, typed).items).toHaveLength(3)
    const split = setBody(doc, 1, typed, true)
    expect(split.items.map((item) => item.body)).toEqual(['one', 'two', 'two and a half', 'three'])
    expect(serializeScratch(split)).toBe('one\n\n---\n\ntwo\n\n---\n\ntwo and a half\n\n---\n\nthree\n')
  })

  it('inserts at the end, keeping how the file ended', () => {
    expect(serializeScratch(insertAfter(parseScratch('x\n'), '* New').doc)).toBe('x\n\n---\n\n* New\n')
    expect(serializeScratch(insertAfter(parseScratch('x'), 'y').doc)).toBe('x\n\n---\n\ny')
    expect(serializeScratch(insertAfter(parseScratch(''), '* New').doc)).toBe('* New\n')
    expect(serializeScratch(insertAfter(parseScratch(three), 'mid', 0).doc)).toBe(
      'one\n\n---\n\nmid\n\n---\n\ntwo\n\n---\n\nthree\n'
    )
  })

  it('removes a card with one separator, keeping the file opening and ending', () => {
    const doc = parseScratch(three)
    expect(serializeScratch(removeItem(doc, 0))).toBe('two\n\n---\n\nthree\n')
    expect(serializeScratch(removeItem(doc, 1))).toBe('one\n\n---\n\nthree\n')
    expect(serializeScratch(removeItem(doc, 2))).toBe('one\n\n---\n\ntwo\n')
    expect(serializeScratch(removeItem(parseScratch('only\n'), 0))).toBe('')
  })
})

describe('tags', () => {
  it('reads the markers the operator writes and the ones this page writes', () => {
    expect(tagOf('* New\n\nprompt')).toEqual({ kind: 'new' })
    expect(tagOf('* new  ')).toEqual({ kind: 'new' })
    expect(tagOf('* Filed t994\n\nprompt')).toEqual({ kind: 'filed', ref: 't994' })
    expect(tagOf('* Sent t907.2')).toEqual({ kind: 'sent', ref: 't907.2' })
    // A bullet that happens to start a prompt is the prompt's own text.
    expect(tagOf('* New feature: dark mode')).toBeNull()
    expect(tagOf('* Filed the bug yesterday')).toBeNull()
    expect(tagOf('* Next\n\nprompt')).toBeNull()
  })

  it('replaces, adds and removes the marker line without touching the prompt', () => {
    expect(withTag('* New\n\nDo it.', { kind: 'filed', ref: 't12' })).toBe('* Filed t12\n\nDo it.')
    expect(withTag('Do it.', { kind: 'new' })).toBe('* New\n\nDo it.')
    expect(withTag('* Sent t3\n\n\nDo it.', null)).toBe('Do it.')
    expect(withTag('', { kind: 'new' })).toBe('* New')
    const doc = parseScratch('a\n\n---\n\n* New\n\nb\n')
    expect(serializeScratch(setTag(doc, 1, { kind: 'filed', ref: 't5' }))).toBe('a\n\n---\n\n* Filed t5\n\nb\n')
  })

  it('files the prompt without its marker, and names it by its first line of text', () => {
    expect(promptOf('* New\n\n## Add a scratchpad\n\nDetails.')).toBe('## Add a scratchpad\n\nDetails.')
    expect(titleOf('* New\n\n## Add a scratchpad\n\nDetails.')).toBe('Add a scratchpad')
    expect(titleOf('* New')).toBe('Empty prompt')
    expect(titleOf('- '.padEnd(200, 'x'), 20)).toHaveLength(20)
  })
})

describe('what is drawn', () => {
  const text = 'old one\n---\nold two\n---\n* New\n\nfresh\n---\n* Filed t9\n\nfiled\n---\nold three\n'
  const shape = (rows: ReturnType<typeof scratchRows>) =>
    rows.map((row) => (row.kind === 'item' ? `item ${row.index}` : `fold ${row.from}+${row.keys.length}`))

  it('shows only New cards, folding each consecutive run of the rest in place', () => {
    const doc = parseScratch(text)
    expect(shape(scratchRows(doc, false, new Set()))).toEqual(['fold 0+2', 'item 2', 'fold 3+2'])
  })

  it('shows everything with showAll, and a run or a card opened by key', () => {
    const doc = parseScratch(text)
    expect(shape(scratchRows(doc, true, new Set()))).toEqual(['item 0', 'item 1', 'item 2', 'item 3', 'item 4'])
    const [fold] = scratchRows(doc, false, new Set())
    if (fold?.kind !== 'fold') throw new Error('expected a fold')
    expect(shape(scratchRows(doc, false, new Set(fold.keys)))).toEqual(['item 0', 'item 1', 'item 2', 'fold 3+2'])
    // A card filed a moment ago stays where it was while its key is held.
    const fresh = doc.items[2]
    if (!fresh) throw new Error('expected a third card')
    const filed = setTag(doc, 2, { kind: 'filed', ref: 't10' })
    expect(shape(scratchRows(filed, false, new Set()))).toEqual(['fold 0+5'])
    expect(shape(scratchRows(filed, false, new Set([fresh.key])))).toEqual(['fold 0+2', 'item 2', 'fold 3+2'])
  })

  it('counts the cards marked New, which is exactly the cards drawn by default', () => {
    const doc = parseScratch(text)
    expect(openCount(doc)).toBe(1)
    expect(openCount(setTag(doc, 0, { kind: 'new' }))).toBe(2)
    expect(openCount(setTag(doc, 2, { kind: 'filed', ref: 't10' }))).toBe(0)
    expect(openCount(parseScratch(''))).toBe(0)
    // The operator's real history shape: one New in every 97 prompts.
    expect(openCount(parseScratch(historyText(400)))).toBe(4)
  })
})

describe('task links', () => {
  const task = (seq: number, kind: 'work' | 'conversation', status: string, updatedAt = seq, deletedAt: number | null = null) =>
    ({ id: `id${seq}`, seq, kind, status, updatedAt, deletedAt }) as Parameters<typeof conversationTargets>[0][number]

  it('offers open conversations only, newest first', () => {
    const tasks = [
      task(1, 'conversation', 'awaiting_human', 10),
      task(2, 'work', 'running', 50),
      task(3, 'conversation', 'completed', 60),
      task(4, 'conversation', 'running', 30),
      task(5, 'conversation', 'failed', 20),
      task(6, 'conversation', 'draft', 70),
      task(7, 'conversation', 'running', 80, 1)
    ]
    expect(conversationTargets(tasks).map((t) => t.seq)).toEqual([4, 5, 1])
  })

  it('finds the task a marker names', () => {
    const tasks = [task(12, 'work', 'completed'), task(994, 'work', 'running')]
    expect(taskForRef(tasks, 't994')?.id).toBe('id994')
    expect(taskForRef(tasks, 't13')).toBeUndefined()
    expect(taskForRef(tasks, 't907.2')).toBeUndefined()
  })
})
