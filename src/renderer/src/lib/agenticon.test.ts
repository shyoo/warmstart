import type { ReactElement, SVGProps } from 'react'
import { describe, expect, it } from 'vitest'
import { AgentIcon } from '../components/AgentIcon.js'

type SvgEl = ReactElement<SVGProps<SVGSVGElement>>

describe('AgentIcon component', () => {
  it('renders Claude icon for claude-code adapter', () => {
    const el = AgentIcon({ adapterId: 'claude-code' }) as SvgEl
    expect(el.props.viewBox).toBe('0 0 24 24')
    expect(el.props.fill).toBe('#D97757')
  })

  it('renders Claude icon case-insensitively', () => {
    const el = AgentIcon({ adapterId: 'Claude-Code' }) as SvgEl
    expect(el.props.viewBox).toBe('0 0 24 24')
    expect(el.props.fill).toBe('#D97757')
  })

  it('renders Antigravity icon for antigravity-cli adapter', () => {
    const el = AgentIcon({ adapterId: 'antigravity-cli' }) as SvgEl
    expect(el.props.viewBox).toBe('0 0 112 112')
    expect(el.props.fill).toBe('none')
  })

  it('renders OpenAI/Codex icon for openai-compatible adapter', () => {
    const el = AgentIcon({ adapterId: 'openai-compatible' }) as SvgEl
    expect(el.props.viewBox).toBe('0 0 24 24')
    expect(el.props.fill).toBe('currentColor')
  })

  it('renders OpenAI/Codex icon for codex', () => {
    const el = AgentIcon({ adapterId: 'codex' }) as SvgEl
    expect(el.props.viewBox).toBe('0 0 24 24')
    expect(el.props.fill).toBe('currentColor')
  })

  it('renders the Meta mark for muse-code: two wings that cross through a shared stem (t564)', () => {
    const el = AgentIcon({ adapterId: 'muse-code' }) as SvgEl
    expect(el.props.viewBox).toBe('0 0 64 64')
    expect(el.props.stroke).toBe('#0064E0')
    expect(el.props.fill).toBe('none')
    // ⛔ Two strokes, each running from one wing's foot through the stem into the other wing's
    // crown. The earlier single open loop read as an earring, not a butterfly (t564).
    const paths = (el.props.children as ReactElement[]).filter((c) => c && c.type === 'path')
    expect(paths).toHaveLength(2)
    for (const path of paths) {
      const d = String((path.props as { d: string }).d)
      // Reaches both edges of the box, so the mark is two wings and not one loop.
      expect(d).toContain('4 30')
      expect(d).toContain('60 30')
    }
  })

  it('renders fallback icon for unknown adapter', () => {
    const el = AgentIcon({ adapterId: 'custom-adapter' }) as SvgEl
    expect(el.props.viewBox).toBe('0 0 16 16')
    expect(el.props.stroke).toBe('currentColor')
  })

  it('handles undefined or null adapterId gracefully with fallback', () => {
    const elNull = AgentIcon({ adapterId: null }) as SvgEl
    expect(elNull.props.viewBox).toBe('0 0 16 16')

    const elUndef = AgentIcon({}) as SvgEl
    expect(elUndef.props.viewBox).toBe('0 0 16 16')
  })
})