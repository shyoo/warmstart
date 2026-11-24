import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Markdown } from './Markdown'

describe('Markdown tables (t908)', () => {
  const source = '| Time | What |\n|---|--:|\n| 18:03 | **Proposal** <b>x</b> |'

  it('draws a table with a header row, a body row and the column alignment', () => {
    const html = renderToStaticMarkup(<Markdown text={source} />)
    expect(html).toContain('<table class="md-table">')
    expect(html).toContain('<th>Time</th>')
    expect(html).toContain('<th class="md-cell-right">What</th>')
    expect(html).toContain('<strong>Proposal</strong>')
  })

  it('draws a cell’s markup characters as text, never as elements', () => {
    const html = renderToStaticMarkup(<Markdown text={source} />)
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;')
    expect(html).not.toContain('<b>')
  })
})

describe('Markdown links (t1330)', () => {
  it('renders file links with formatted code symbols inside anchor tags', () => {
    const text = '[`repoCandidatePrompt`](file:///C:/project/file.ts#L90-L115)'
    const html = renderToStaticMarkup(<Markdown text={text} />)
    expect(html).toContain('<a class="md-link"')
    expect(html).toContain('href="file:///C:/project/file.ts#L90-L115"')
    expect(html).toContain('title="file:///C:/project/file.ts#L90-L115"')
    expect(html).toContain('<code class="msg-code">repoCandidatePrompt</code>')
    expect(html).not.toContain('`repoCandidatePrompt`')
  })

  it('renders standard plain text file links', () => {
    const text = '[InterviewService.runDemo()](file:///C:/project/interviews.ts#L10)'
    const html = renderToStaticMarkup(<Markdown text={text} />)
    expect(html).toContain('<a class="md-link"')
    expect(html).toContain('href="file:///C:/project/interviews.ts#L10"')
    expect(html).toContain('InterviewService.runDemo()')
  })

  it('renders clickable links nested inside bold bullet headings', () => {
    const text =
      '- **Clickable Options ([Warmup.tsx](file:///C:/repo/Warmup.tsx#L160-L224), [warmup.css](file:///C:/repo/warmup.css#L1-L5)):**'
    const html = renderToStaticMarkup(<Markdown text={text} />)
    expect(html).toContain('<strong>Clickable Options (')
    expect(html).toContain('<a class="md-link" href="file:///C:/repo/Warmup.tsx#L160-L224"')
    expect(html).toContain('>Warmup.tsx</a>')
    expect(html).toContain('<a class="md-link" href="file:///C:/repo/warmup.css#L1-L5"')
    expect(html).toContain('>warmup.css</a>')
    expect(html).not.toContain('[Warmup.tsx](')
  })
})
