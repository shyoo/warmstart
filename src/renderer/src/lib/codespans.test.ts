import { describe, expect, it } from 'vitest'
import { codeSpans } from './codespans'

/**
 * The one piece of markdown a thread message carries.
 *
 * ⛔ **The messages were always written this way; only the rendering was missing.** `landing.ts`,
 * `finish.ts` and `scheduler.ts` have named branches, refs, shas and files in backticks since they
 * were written, and `{m.text}` printed the backticks. The interesting failures are all at the edges
 * — an unmatched backtick an operator typed, a fence spanning a line — because a greedy match there
 * turns a paragraph into an identifier.
 */
describe('splitting message text into plain and fenced runs', () => {
  it('leaves text with no backtick as a single run, allocating nothing', () => {
    expect(codeSpans('nothing to fence here')).toEqual([
      { text: 'nothing to fence here', code: false }
    ])
  })

  it('pulls out the identifiers a landing names', () => {
    expect(codeSpans('Landed as `98f200ab` onto `main`.')).toEqual([
      { text: 'Landed as ', code: false },
      { text: '98f200ab', code: true },
      { text: ' onto ', code: false },
      { text: 'main', code: true },
      { text: '.', code: false }
    ])
  })

  it('is total — the runs put the message back together, minus the fences', () => {
    // ⛔ The property that matters more than any single shape: nothing may be dropped. A message is
    //    the only record of what happened to a task, and a renderer that silently eats a clause is
    //    worse than one that prints punctuation.
    const text = 'a `b` c `d` e'
    expect(codeSpans(text).map((s) => s.text).join('')).toBe('a b c d e')
  })

  it('prints a lone backtick rather than swallowing the rest of the message', () => {
    // ⚠️ An operator typing an apostrophe-adjacent key, or prose about a shell. The worst an
    //    unmatched fence may do is show itself.
    expect(codeSpans('what does ` mean')).toEqual([{ text: 'what does ` mean', code: false }])
  })

  it('never fences across a newline, however the backticks fall', () => {
    // ⛔ The greedy failure: one stray backtick early in a multi-line system message and every line
    //    down to the next one renders as one identifier.
    const spans = codeSpans('first line has a ` in it\nsecond line `main` here')
    expect(spans.filter((s) => s.code).map((s) => s.text)).toEqual(['main'])
    expect(spans.map((s) => s.text).join('')).toBe('first line has a ` in it\nsecond line main here')
  })

  it('does not fence an empty pair, which is two characters of punctuation and no name', () => {
    expect(codeSpans('an empty `` pair')).toEqual([{ text: 'an empty `` pair', code: false }])
  })

  it('returns nothing for an empty message', () => {
    expect(codeSpans('')).toEqual([])
  })
})
