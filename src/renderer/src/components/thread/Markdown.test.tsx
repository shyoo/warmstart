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
