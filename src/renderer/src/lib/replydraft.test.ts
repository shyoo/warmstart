import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import {
  clearReplyDraft,
  draftCommand,
  draftImages,
  EMPTY_REPLY_DRAFT,
  isEmptyReplyDraft,
  normalizeReplyDraft,
  readReplyDraft,
  writeReplyDraft,
  type ReplyDraft
} from './replydraft.js'

const KEY = 'warmstart.threadReplyDrafts'

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

const typed = (over: Partial<ReplyDraft> = {}): ReplyDraft => ({ ...EMPTY_REPLY_DRAFT, text: 'and the tests?', ...over })

describe('what a thread reply box was left holding', () => {
  it('comes back when the box is mounted again, after another task was opened', () => {
    stub({})
    writeReplyDraft('t1', typed())
    expect(readReplyDraft('t1')).toEqual(typed())
  })

  it('keeps each task to itself — a reply is a message to one agent', () => {
    stub({})
    writeReplyDraft('t1', typed({ text: 'for one' }))
    writeReplyDraft('t2', typed({ text: 'for two' }))
    expect(readReplyDraft('t1').text).toBe('for one')
    expect(readReplyDraft('t2').text).toBe('for two')
    expect(readReplyDraft('t3')).toEqual(EMPTY_REPLY_DRAFT)
  })

  it('keeps the slash chip and the attachments, as ids without bytes', () => {
    stub({})
    const attachments = [{ id: 'a1', name: 'shot.png', width: 10, height: 20, bytes: 30 }]
    writeReplyDraft('t1', { text: '', commandId: 'delegate', attachments })
    const back = readReplyDraft('t1')
    expect(draftCommand(back)?.id).toBe('delegate')
    expect(draftImages(back)).toEqual([
      { id: 'a1', preview: null, name: 'shot.png', width: 10, height: 20, bytes: 30 }
    ])
  })

  it('is removed when emptied or sent, leaving nothing behind', () => {
    const store: Record<string, string> = {}
    stub(store)
    writeReplyDraft('t1', typed())
    writeReplyDraft('t2', typed())
    clearReplyDraft('t1')
    expect(Object.keys(JSON.parse(store[KEY]!) as object)).toEqual(['t2'])
    writeReplyDraft('t2', typed({ text: '   ' }))
    expect(JSON.parse(store[KEY]!) as object).toEqual({})
  })

  it('does not count blanks as content', () => {
    expect(isEmptyReplyDraft(typed({ text: ' \n ' }))).toBe(true)
    expect(isEmptyReplyDraft(typed({ text: '', commandId: 'delegate' }))).toBe(false)
  })

  it('reads an older or damaged value field by field', () => {
    expect(normalizeReplyDraft({ text: 'kept', commandId: 'gone', attachments: 'x' })).toEqual({
      text: 'kept',
      commandId: null,
      attachments: []
    })
    expect(normalizeReplyDraft(7)).toEqual(EMPTY_REPLY_DRAFT)
  })

  it('never throws when storage is missing, throws, or holds garbage', () => {
    stub(null)
    expect(readReplyDraft('t1')).toEqual(EMPTY_REPLY_DRAFT)
    expect(() => writeReplyDraft('t1', typed())).not.toThrow()
    stub({}, true)
    expect(readReplyDraft('t1')).toEqual(EMPTY_REPLY_DRAFT)
    expect(() => writeReplyDraft('t1', typed())).not.toThrow()
    stub({ [KEY]: '{not json' })
    expect(readReplyDraft('t1')).toEqual(EMPTY_REPLY_DRAFT)
    expect(() => writeReplyDraft('t1', typed())).not.toThrow()
  })
})

// No DOM host at L1, so the binding is pinned at source level (as threaddetail.test.ts does).
describe('the reply box is wired to the draft', () => {
  const source = readFileSync(new URL('../components/TaskThread.tsx', import.meta.url), 'utf8')
  it('seeds from the draft, writes on every change, and clears on a send', () => {
    expect(source).toMatch(/readReplyDraft\(task\.id\)/)
    expect(source).toMatch(/writeReplyDraft\(task\.id, \{ text, commandId/)
    expect(source).toMatch(/clearReplyDraft\(task\.id\)/)
    expect(source).toMatch(/useState\(restored\.text\)/)
  })
})
