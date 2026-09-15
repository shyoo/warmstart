import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { WelcomeTour } from './WelcomeTour.js'

describe('WelcomeTour', () => {
  it('renders step 1 with the project SVG mockup, description, progress steps, and next button', () => {
    const html = renderToStaticMarkup(<WelcomeTour onClose={() => {}} />)
    expect(html).toContain('Add a project')
    expect(html).toContain('Choose a repository')
    expect(html).toContain('welcome-mockup-frame')
    expect(html).toContain('welcome-mockup-svg')
    expect(html).toContain('WHAT IS THERE')
    expect(html).toContain('Skip tour')
    expect(html).toContain('Next')
    expect(html).toContain('Tour progress')
  })
})
