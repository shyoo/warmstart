import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ApprovalBody } from './Questions.js'

const INSTRUCTION = [
  'Rework the retry loop in `src/daemon/scheduler.ts`.',
  '',
  '- Change `backoffFor` to cap at 30s',
  '- Leave everything else alone',
  '',
  'Done means the existing retry tests pass unchanged.'
].join('\n')

/** A Plan & Execute approval body the way `splitApprovalFor` builds one: framing, then bytes. */
const HANDOFF = [
  't5 has finished planning and wants to hand the whole job to one executor:',
  '',
  '1. Rework the retry loop in `src/daemon/scheduler.ts`.',
  '',
  'Approving files it and starts it as soon as an account is free. Refusing sends it back.',
  '',
  'The full instruction the executor will receive:',
  '',
  INSTRUCTION
].join('\n')

const SHORT_SPLIT = [
  't5 wants to split into 2 pieces and delegate them:',
  '',
  '1. first piece',
  '2. second piece',
  '',
  'Approving files all of them at once and starts them.'
].join('\n')

/**
 * t693: the approval card showed the executor's instruction as a one-line label. The card now
 * carries the whole instruction behind an expander — `renderToStaticMarkup`, because the suites
 * run with `environment: 'node'` and there is no DOM to click one open (Statistics.test.tsx).
 */
describe('ApprovalBody', () => {
  it('collapses a handoff past the framing and keeps the whole instruction in the card', () => {
    const html = renderToStaticMarkup(<ApprovalBody text={HANDOFF} />)
    // The framing stays visible: the operator sees what they are approving without opening.
    expect(html).toContain('The full instruction the executor will receive:')
    // Collapsed by default, and honest about what is behind the press.
    expect(html).toContain('Show full instruction (6 more lines)')
    expect(html).toContain('aria-expanded="false"')
    // ⛔ The bytes are in the card even collapsed — an expander that fetched on open would be a
    // second place the instruction could fail to arrive.
    expect(html).toContain('hidden')
    expect(html).toContain('Done means the existing retry tests pass unchanged.')
  })

  it('leaves a short split approval fully visible with no expander', () => {
    const html = renderToStaticMarkup(<ApprovalBody text={SHORT_SPLIT} />)
    expect(html).not.toContain('Show full instruction')
    // Rendered as a real list: the `1.` is list markup, not text.
    expect(html).toContain('<li class="md-item md-depth0">first piece</li>')
    expect(html).toContain('<li class="md-item md-depth0">second piece</li>')
  })
})
