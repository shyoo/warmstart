import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ActivityChip, ActivityDisclosure, PromptChip, PromptDisclosure } from './Disclosure'
import { DelegationMenu } from './DelegatePill'

describe('AI agent UI kit components (t1426)', () => {
  it('renders monochrome SVG icons in PromptChip, PromptDisclosure, ActivityChip, and ActivityDisclosure instead of raw emoji', () => {
    const promptChip = renderToStaticMarkup(<PromptChip prompt="hello world" />)
    expect(promptChip).toContain('<svg')
    expect(promptChip).not.toContain('📋')
    expect(promptChip).toContain('11')

    const promptDisc = renderToStaticMarkup(<PromptDisclosure prompt="hello world" />)
    expect(promptDisc).toContain('disclosure-chevron')
    expect(promptDisc).not.toContain('📋')

    const actChip = renderToStaticMarkup(<ActivityChip activity={[{ text: 'Read file', ts: 1000 }]} />)
    expect(actChip).toContain('<svg')
    expect(actChip).not.toContain('⚡')

    const actDisc = renderToStaticMarkup(
      <ActivityDisclosure activity={[{ text: 'Read file', ts: 1000 }, { text: 'Edit file', ts: 2000 }]} />
    )
    expect(actDisc).toContain('activity-disclosure-sparkle')
    expect(actDisc).toContain('2 steps')
    expect(actDisc).not.toContain('⚡')
  })

  it('renders accessible pill toggle switches inside DelegationMenu', () => {
    const html = renderToStaticMarkup(
      <DelegationMenu
        on={true}
        allowedTiers={['Low']}
        allowedModels={['gemini-4-hydrogen']}
        availableTiers={['High', 'Med', 'Low']}
        availableModels={['gemini-4-hydrogen']}
        modelTiers={{ 'gemini-4-hydrogen': ['Low'] }}
        onChange={() => {}}
      />
    )
    expect(html).toContain('class="ui-switch"')
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('Low')
  })
})
