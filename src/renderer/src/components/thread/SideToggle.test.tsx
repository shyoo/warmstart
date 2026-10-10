import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SideToggle } from './SideToggle'

const noop = (): void => undefined
const button = (markup: string, pane: string): string =>
  markup.match(new RegExp(`<button[^>]*data-pane="${pane}"[^>]*>`))?.[0] ?? ''

describe('the thread title bar buttons (t1011)', () => {
  it('press exactly the pane that is showing', () => {
    const status = renderToStaticMarkup(<SideToggle side="status" hasScratchpad onToggle={noop} />)
    expect(button(status, 'status')).toContain('aria-pressed="true"')
    expect(button(status, 'scratchpad')).toContain('aria-pressed="false"')

    const scratch = renderToStaticMarkup(<SideToggle side="scratchpad" hasScratchpad onToggle={noop} />)
    expect(button(scratch, 'status')).toContain('aria-pressed="false"')
    expect(button(scratch, 'scratchpad')).toContain('aria-pressed="true"')
  })

  it('press neither when the column is closed, and say what a click will do', () => {
    const none = renderToStaticMarkup(<SideToggle side="none" hasScratchpad onToggle={noop} />)
    expect(button(none, 'status')).toContain('aria-pressed="false"')
    expect(button(none, 'scratchpad')).toContain('aria-pressed="false"')
    expect(button(none, 'status')).toContain('title="Show the status pane"')
    const open = renderToStaticMarkup(<SideToggle side="status" hasScratchpad onToggle={noop} />)
    expect(button(open, 'status')).toContain('title="Hide the status pane"')
  })

  it('offers no scratchpad button on a thread that has no project behind it', () => {
    const markup = renderToStaticMarkup(<SideToggle side="status" hasScratchpad={false} onToggle={noop} />)
    expect(markup).toContain('data-pane="status"')
    expect(markup).not.toContain('data-pane="scratchpad"')
  })

  it('draws pictograms in currentColor, never a colour of their own', () => {
    const markup = renderToStaticMarkup(<SideToggle side="none" hasScratchpad onToggle={noop} />)
    expect(markup).toContain('stroke="currentColor"')
    expect(markup).not.toMatch(/#[0-9a-f]{3,6}|rgb\(/i)
  })
})

describe('the thread wiring (source level: no DOM host at L1)', () => {
  const thread = readFileSync(new URL('../TaskThread.tsx', import.meta.url), 'utf8')
  const project = readFileSync(new URL('../Project.tsx', import.meta.url), 'utf8')

  it('keeps the ledger mounted but hidden, and draws the scratchpad only when it is the pane', () => {
    expect(thread).toContain('<aside className="detail-side" hidden={side !== \'status\'}>')
    expect(thread).toContain("side === 'scratchpad' && hasScratchpad")
  })

  it('has the project page hand its compact scratchpad to the thread', () => {
    expect(project).toMatch(/scratchpad=\{[\s\S]*<Scratchpad[\s\S]*compact[\s\S]*\/>/)
  })
})

describe('the scratchpad save indicator', () => {
  const css = readFileSync(new URL('../../styles/app.css', import.meta.url), 'utf8')

  it('reads green once saved, where grey did not stand out', () => {
    expect(css).toMatch(/\.scratchpad-save--saved \{\s*color: var\(--state-ok\);/)
  })
})
