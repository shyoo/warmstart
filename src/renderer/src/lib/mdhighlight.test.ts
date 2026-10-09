import { describe, expect, it } from 'vitest'
import { highlightLines, type MdTokenKind } from './mdhighlight'

function kinds(text: string): MdTokenKind[][] {
  return highlightLines(text).map((line) => line.map((token) => token.kind))
}

describe('highlightLines', () => {
  it('gives back every character of every line, in order — the overlay depends on it', () => {
    const text = [
      '# Title',
      '* New',
      '',
      'Some **bold**, *em*, _em_, `code` and [a link](https://x.y) and a_snake_case word.',
      '  - nested bullet with `a`',
      '12. numbered',
      '> quoted *text*',
      '---',
      '```ts',
      'const x = `y` // **not bold**',
      '---',
      '```',
      '* unclosed *em and ``` mid-line',
      '\ttabbed'
    ].join('\n')
    const lines = highlightLines(text)
    expect(lines.map((line) => line.map((t) => t.text).join('')).join('\n')).toBe(text)
  })

  it('names headings, rules, markers, bullets and quotes', () => {
    expect(kinds('# Title\n---\n* New\n* Filed t994\n- item\n> q')).toEqual([
      ['heading'],
      ['rule'],
      ['marker'],
      ['marker'],
      ['bullet', 'text', 'text'],
      ['quote', 'text']
    ])
  })

  it('names inline code, bold, italics and links, and leaves snake_case alone', () => {
    expect(kinds('a `b` **c** *d* [e](f)')[0]).toEqual(['text', 'code', 'text', 'strong', 'text', 'em', 'text', 'link'])
    expect(kinds('a_snake_case word')[0]).toEqual(['text'])
  })

  it('treats everything inside a fence as code, a --- included', () => {
    expect(kinds('```\n# not a heading\n---\n```\n# heading')).toEqual([['fence'], ['code'], ['code'], ['fence'], ['heading']])
  })
})
