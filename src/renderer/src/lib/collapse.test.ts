import { describe, expect, it } from 'vitest'
import { COLLAPSE_AFTER_LINES, COLLAPSE_HEAD_LINES, foldAt } from './collapse'

const lines = (n: number, prefix = 'line'): string[] => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`)

describe('folding a long agent reply', () => {
  it('never folds an answer the size of t731’s, which is the case this exists for', () => {
    expect(foldAt(lines(COLLAPSE_AFTER_LINES).join('\n'))).toBeNull()
    expect(foldAt('one line')).toBeNull()
  })

  it('folds past the threshold, keeping the head and counting what it hid', () => {
    const text = lines(60).join('\n')
    const folded = foldAt(text)
    expect(folded?.head).toBe(lines(COLLAPSE_HEAD_LINES).join('\n'))
    expect(folded?.restLines).toBe(60 - COLLAPSE_HEAD_LINES)
    expect(`${folded?.head}\n${folded?.rest}`).toBe(text)
  })

  it('moves the fold back to before a fenced block it would otherwise cut in two', () => {
    // ⛔ A command split across the fold is the one thing a whole reply must not do.
    const text = [...lines(25), '```sh', ...lines(10, 'code'), '```', ...lines(20, 'after')].join('\n')
    const folded = foldAt(text)
    expect(folded?.head).toBe(lines(25).join('\n'))
    expect(folded?.rest.startsWith('```sh\ncode 1')).toBe(true)
  })

  it('moves the fold past a fence that opens at the very top', () => {
    const text = ['```', ...lines(45, 'code'), '```', ...lines(10, 'after')].join('\n')
    const folded = foldAt(text)
    expect(folded?.head.endsWith('code 45\n```')).toBe(true)
    expect(folded?.rest).toBe(lines(10, 'after').join('\n'))
  })

  it('does not fold when that would hide only a handful of lines', () => {
    const text = ['```', ...lines(40, 'code'), '```', 'after 1', 'after 2'].join('\n')
    expect(foldAt(text)).toBeNull()
  })

  it('treats an unclosed fence as running to the end, as the markdown reader does', () => {
    const text = [...lines(28), '```', ...lines(30, 'code')].join('\n')
    const folded = foldAt(text)
    expect(folded?.head).toBe(lines(28).join('\n'))
  })

  it('never cuts through a table (t908)', () => {
    const rows = Array.from({ length: 12 }, (_, i) => `| r${i} | v${i} |`)
    const text = [...lines(25), '| k | v |', '|---|---|', ...rows, ...lines(20, 'after')].join('\n')
    const folded = foldAt(text)
    expect(folded?.head).toBe(lines(25).join('\n'))
    expect(folded?.rest.startsWith('| k | v |\n|---|---|')).toBe(true)
  })
})
