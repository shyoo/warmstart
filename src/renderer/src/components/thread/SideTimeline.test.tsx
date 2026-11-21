import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SideTimeline } from './SideTimeline'

describe('SideTimeline', () => {
  it('renders collapsed by default (no open attribute) with caret, label, count, and body', () => {
    const html = renderToStaticMarkup(
      <SideTimeline count={3}>
        <div className="side-run">#1 Run</div>
      </SideTimeline>
    )

    expect(html).toContain('<details class="detail-side-box side-timeline-disclosure">')
    expect(html).not.toMatch(/<details[^>]*\bopen\b/)
    expect(html).toContain(
      '<summary class="side-label side-timeline-summary" title="Chronological timeline of task attempts and context compactions.">'
    )
    expect(html).toContain('<span class="side-timeline-caret" aria-hidden="true">▶</span>')
    expect(html).toContain('timeline · runs, compactions &amp; reviews')
    expect(html).toContain('<span class="side-timeline-count">(3)</span>')
    expect(html).toContain('<div class="side-timeline-body"><div class="side-run">#1 Run</div></div>')
  })

  it('uses native <details> + <summary> disclosure semantics with CSS caret rotation and hidden marker', () => {
    const css = readFileSync(new URL('../../styles/app.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.side-timeline-summary\s*\{[\s\S]*list-style:\s*none;/)
    expect(css).toMatch(/\.side-timeline-summary::-webkit-details-marker\s*\{\s*display:\s*none;\s*\}/)
    expect(css).toMatch(
      /\.side-timeline-disclosure\[open\]\s*>\s*\.side-timeline-summary\s+\.side-timeline-caret\s*\{\s*transform:\s*rotate\(90deg\);\s*\}/
    )
  })
})

describe('TaskThread SideTimeline wiring (source level: no DOM host at L1)', () => {
  const thread = readFileSync(new URL('../TaskThread.tsx', import.meta.url), 'utf8')

  it('wraps timeline entries in SideTimeline inside the status aside and opens on jump-to-run', () => {
    const sideStart = thread.indexOf("<aside className=\"detail-side\" hidden={side !== 'status'}>")
    const sideEnd = thread.indexOf('</aside>', sideStart)
    const timelinePos = thread.indexOf('<SideTimeline count={timeline.length} detailsRef={setTimelineRef}>')
    expect(sideStart).toBeGreaterThan(-1)
    expect(sideEnd).toBeGreaterThan(sideStart)
    expect(timelinePos).toBeGreaterThan(sideStart)
    expect(timelinePos).toBeLessThan(sideEnd)
    expect(thread).toMatch(
      /onJumpToRun=\{\(\)\s*=>\s*\{\s*if\s*\(timelineDetailsRef\.current\)\s*timelineDetailsRef\.current\.open\s*=\s*true[\s\S]*?jumpTo\(timelineBox\)/
    )
  })
})
