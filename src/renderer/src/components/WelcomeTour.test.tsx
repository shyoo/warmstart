import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { WelcomeTour } from './WelcomeTour.js'

describe('WelcomeTour', () => {
  it('renders step 1 with the real screenshot, description, progress steps, and next button', () => {
    const html = renderToStaticMarkup(<WelcomeTour onClose={() => {}} />)
    expect(html).toContain('Add a project')
    expect(html).toContain('Choose a repository')
    expect(html).toContain('welcome-shot-frame')
    expect(html).toContain('welcome-shot')
    expect(html).toContain('<img')
    expect(html).not.toContain('<svg')
    expect(html).toContain('Skip tour')
    expect(html).toContain('Next')
    expect(html).toContain('Tour progress')
  })
})
