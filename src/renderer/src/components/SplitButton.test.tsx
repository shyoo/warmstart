import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { SplitButton } from './SplitButton'
import { ChevronDownIcon, SendArrowIcon } from './UiIcons'

describe('SplitButton & composer Send/Queue dropdown', () => {
  it('renders a primary split button with custom ReactNode label and SVG chevron caret', () => {
    const html = renderToStaticMarkup(
      <SplitButton
        className="compose-send-split"
        tone="primary"
        align="right"
        caret={<ChevronDownIcon size={12} />}
        label={
          <span className="compose-send-label">
            <span>Send</span>
            <SendArrowIcon size={13} />
          </span>
        }
        value="send"
        ariaLabel="Send"
        menuAriaLabel="Send options"
        options={[
          { value: 'send', label: 'Send', hint: 'Deliver immediately' },
          { value: 'queue', label: 'Queue', hint: 'Wait until active turn finishes' }
        ]}
        onAct={vi.fn()}
      />
    )

    expect(html).toContain('split-btn split-btn--primary compose-send-split')
    expect(html).toContain('btn btn--primary split-btn-main')
    expect(html).toContain('compose-send-label')
    expect(html).toContain('Send')
    expect(html).toContain('aria-label="Send options"')
    expect(html).toContain('split-btn-more')
    expect(html).toContain('<svg')
  })

  it('propagates disabled state to both halves of the split button', () => {
    const html = renderToStaticMarkup(
      <SplitButton
        className="compose-send-split"
        tone="primary"
        align="right"
        label="Send"
        value="send"
        disabled={true}
        ariaLabel="Send"
        menuAriaLabel="Send options"
        options={[
          { value: 'send', label: 'Send' },
          { value: 'queue', label: 'Queue' }
        ]}
        onAct={() => {}}
      />
    )

    const disabledMatches = html.match(/disabled=""/g) ?? []
    expect(disabledMatches.length).toBeGreaterThanOrEqual(2)
  })

  it('wires Compose Send/Queue split button, Queued hint/badge, and pill split CSS in TaskThread and app.css', () => {
    const threadSrc = readFileSync(resolve(process.cwd(), 'src/renderer/src/components/TaskThread.tsx'), 'utf8')
    expect(threadSrc).toContain('className="compose-send-split"')
    expect(threadSrc).toContain("menuAriaLabel=\"Send options\"")
    expect(threadSrc).toContain("value: 'queue'")
    expect(threadSrc).toContain("label: 'Queue'")
    expect(threadSrc).toContain("delivery === 'queue' ? { delivery: 'queue' } : {}")
    expect(threadSrc).toContain('Queued — waits until the current turn finishes.')
    expect(threadSrc).toContain('className="msg-queued"')

    const css = readFileSync(resolve(process.cwd(), 'src/renderer/src/styles/app.css'), 'utf8')
    expect(css).toContain('.compose-send-split')
    expect(css).toContain('.compose-send-split .split-btn-main')
    expect(css).toContain('.compose-send-split .pill')
    expect(css).toContain('.msg-queued')
  })
})
