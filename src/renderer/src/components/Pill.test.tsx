import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { PillOptions } from './Pill'

describe('PillOptions', () => {
  const options = [
    { value: '', label: 'Auto (scheduler decides)' },
    { value: 'w1', label: 'Worker 1' },
    { value: 'w2', label: 'Worker 2' }
  ]

  it('renders checkmark and aria-selected only on the active option', () => {
    const html = renderToStaticMarkup(
      <PillOptions options={options} value="w1" ariaLabel="Test select" onPick={() => {}} />
    )
    // w1 has aria-selected="true" and checkmark
    expect(html).toMatch(/data-value="w1"[^>]*aria-selected="true"/)
    expect(html).toMatch(/data-value="w1"[^>]*pill-option--on/)
    expect(html).toContain('✓')

    // empty value (Auto) and w2 are not selected
    expect(html).toMatch(/data-value=""[^>]*aria-selected="false"/)
    expect(html).not.toMatch(/data-value=""[^>]*pill-option--on/)
    expect(html).toMatch(/data-value="w2"[^>]*aria-selected="false"/)
    expect(html).not.toMatch(/data-value="w2"[^>]*pill-option--on/)
  })

  it('correctly marks empty string as active when value is empty string', () => {
    const html = renderToStaticMarkup(
      <PillOptions options={options} value="" ariaLabel="Test select" onPick={() => {}} />
    )
    expect(html).toMatch(/data-value=""[^>]*aria-selected="true"/)
    expect(html).toMatch(/data-value=""[^>]*pill-option--on/)
    expect(html).toMatch(/data-value="w1"[^>]*aria-selected="false"/)
  })
})
