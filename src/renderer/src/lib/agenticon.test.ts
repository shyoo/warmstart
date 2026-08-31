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