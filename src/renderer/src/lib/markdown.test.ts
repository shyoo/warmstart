import { describe, expect, it } from 'vitest'
import { hasMarkdown, inlineSpans, markdownBlocks } from './markdown'

describe('inline runs', () => {
  it('leaves prose with no markup as a single text run', () => {
    expect(inlineSpans('nothing to set here')).toEqual([
      { kind: 'text', text: 'nothing to set here' }
    ])
  })

  it('sets the constructs an agent actually writes', () => {
    expect(inlineSpans('**So the order is:** run `npm test` first')).toEqual([
      { kind: 'strong', text: 'So the order is:' },
      { kind: 'text', text: ' run ' },
      { kind: 'code', text: 'npm test' },
      { kind: 'text', text: ' first' }
    ])
  })

  it('lets a code span win over emphasis inside it', () => {
    // ⛔ `**` inside backticks is two asterisks. The alternation order is what guarantees this.
    expect(inlineSpans('try `a ** b` now')).toEqual([
      { kind: 'text', text: 'try ' },
      { kind: 'code', text: 'a ** b' },
      { kind: 'text', text: ' now' }
    ])
  })

  it('is total: the text survives whatever it does to it', () => {
    // ⛔ Concatenating every run back, minus the fences, is the input. The spaces belong to the
    //    plain runs, so this is a join with nothing between them.
    const source = 'a **b** c `d` e *f* g ~~h~~'
    expect(inlineSpans(source).map((s) => s.text).join('')).toBe('a b c d e f g h')
  })

  it('never swallows a line: an unmatched marker prints itself', () => {
    const spans = inlineSpans('2 * 3 is not emphasis\nand nor is this')
    expect(spans).toEqual([{ kind: 'text', text: '2 * 3 is not emphasis\nand nor is this' }])
  })

  it('takes an http link and refuses every other scheme', () => {
    expect(inlineSpans('see [the docs](https://example.com/x)')).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'link', text: 'the docs', href: 'https://example.com/x' }
    ])
    // ⛔ The whole point of whitelisting at the parse: this is text, and has no `href` to forget
    //    to check downstream.
    const unsafe = inlineSpans('[click](javascript:alert(1))')
    expect(unsafe.every((s) => s.kind === 'text')).toBe(true)
    expect(unsafe.map((s) => s.text).join('')).toBe('[click](javascript:alert(1))')
    expect(inlineSpans('[x](file:///C:/secret)')[0]?.kind).toBe('text')
  })

  it('makes a bare URL a link, without the punctuation that ends its sentence (t401)', () => {
    const url = 'https://github.com/shyoo/awardtracker/pull/141'
    expect(inlineSpans(`Pull request opened for \`abc12345\` into \`main\`: ${url}`)).toEqual([
      { kind: 'text', text: 'Pull request opened for ' },
      { kind: 'code', text: 'abc12345' },
      { kind: 'text', text: ' into ' },
      { kind: 'code', text: 'main' },
      { kind: 'text', text: ': ' },
      { kind: 'link', text: url, href: url }
    ])
    expect(inlineSpans(`See ${url}.`)).toEqual([
      { kind: 'text', text: 'See ' },
      { kind: 'link', text: url, href: url },
      { kind: 'text', text: '.' }
    ])
    expect(inlineSpans(`(see ${url})`)[1]).toEqual({ kind: 'link', text: url, href: url })
    expect(inlineSpans('https://en.wikipedia.org/wiki/Foo_(bar)')[0]?.href).toBe('https://en.wikipedia.org/wiki/Foo_(bar)')
    // ⛔ Only http(s) is ever bare-linked; nothing else becomes an href this way.
    expect(inlineSpans('javascript:alert(1) and file:///C:/x').every((s) => s.kind === 'text')).toBe(true)
    // A URL inside a code span stays code.
    expect(inlineSpans(`\`${url}\``)).toEqual([{ kind: 'code', text: url }])
  })
})

describe('blocks', () => {
  it('reads the shape of a real agent reply', () => {
    const blocks = markdownBlocks(
      ['## Yes — macOS', '', 'Two things changed:', '', '- a red check', '- a green one', ''].join('\n')
    )
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'paragraph', 'list'])
    expect(blocks[0]).toMatchObject({ kind: 'heading', level: 2 })
    expect(blocks[2]).toMatchObject({ kind: 'list', ordered: false })
    expect(blocks[2]?.kind === 'list' && blocks[2].items).toHaveLength(2)
  })

  it('keeps line breaks inside a paragraph, because a chat message meant them', () => {
    const blocks = markdownBlocks('one line\nand another')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({
      kind: 'paragraph',
      spans: [{ kind: 'text', text: 'one line\nand another' }]
    })
  })

  it('parses nothing inside a fence and keeps its newlines', () => {
    const blocks = markdownBlocks(['before', '', '```ts', 'const a = `**x**`', '', 'b', '```'].join('\n'))
    expect(blocks[1]).toEqual({ kind: 'code', lang: 'ts', text: 'const a = `**x**`\n\nb' })
  })

  it('runs an unterminated fence to the end rather than failing', () => {
    // ⚠️ An agent's reply can be cut off mid-block; half a code block is the honest rendering.
    const blocks = markdownBlocks('```\nhalf a thing')
    expect(blocks).toEqual([{ kind: 'code', lang: null, text: 'half a thing' }])
  })

  it('numbers an ordered list from where the author started it', () => {
    const blocks = markdownBlocks(['3. third', '4. fourth'].join('\n'))
    expect(blocks[0]).toMatchObject({ kind: 'list', ordered: true, start: 3 })
  })

  it('starts a second list when the kind changes rather than renumbering one', () => {
    const blocks = markdownBlocks(['- a', '1. b'].join('\n'))
    expect(blocks.map((b) => b.kind)).toEqual(['list', 'list'])
  })

  it('records how far a nested item was indented without inventing a nested list', () => {
    const blocks = markdownBlocks(['- top', '  - under', '      - deep'].join('\n'))
    const list = blocks[0]
    expect(list?.kind === 'list' && list.items.map((i) => i.depth)).toEqual([0, 1, 3])
  })

  it('reads a rule as a rule and not as a one-item list', () => {
    expect(markdownBlocks('---')).toEqual([{ kind: 'rule' }])
    expect(markdownBlocks('***')).toEqual([{ kind: 'rule' }])
  })

  it('joins the lines of a quote and drops the markers', () => {
    const blocks = markdownBlocks(['> one', '> two'].join('\n'))
    expect(blocks[0]).toMatchObject({ kind: 'quote', spans: [{ kind: 'text', text: 'one\ntwo' }] })
  })

  it('renders the daemon’s own system lines as what they were written as', () => {
    const blocks = markdownBlocks('Landed as `5ebb3b42` onto `main` — local only, **not pushed**')
    expect(blocks).toHaveLength(1)
    const spans = blocks[0]?.kind === 'paragraph' ? blocks[0].spans : []
    expect(spans.filter((s) => s.kind === 'code').map((s) => s.text)).toEqual(['5ebb3b42', 'main'])
    expect(spans.some((s) => s.kind === 'strong' && s.text === 'not pushed')).toBe(true)
  })

  it('says when a message would read identically either way', () => {
    expect(hasMarkdown('just some words')).toBe(false)
    expect(hasMarkdown('words with a `ref`')).toBe(true)
    expect(hasMarkdown('# a heading')).toBe(true)
  })

  it('survives an empty message', () => {
    expect(markdownBlocks('')).toEqual([])
    expect(inlineSpans('')).toEqual([])
  })
})
