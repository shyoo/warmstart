import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { PROJECT_TABS, ProjectTabIcon } from './ProjectTabs'

describe('project tabs', () => {
  it('puts the project destinations in the requested order', () => {
    expect(PROJECT_TABS.map(({ label }) => label)).toEqual([
      'Flow', 'Scratchpad', 'Tasks', 'Thread', 'Conversations', 'Session TUI', 'Settings'
    ])
  })

  it('gives every destination a distinct pictogram that follows the text colour', () => {
    const icons = PROJECT_TABS.map(({ id }) => renderToStaticMarkup(<ProjectTabIcon tab={id} />))
    expect(new Set(icons).size).toBe(PROJECT_TABS.length)
    for (const icon of icons) {
      expect(icon).toContain('aria-hidden="true"')
      expect(icon).toContain('stroke="currentColor"')
      expect(icon).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i)
    }
  })
})
