import { describe, expect, it } from 'vitest'
import { plannerMcpNotice } from './plannernotice'

/**
 * What the composer says under the Plan rows about the planner's tools.
 *
 * ⛔ **The notice is advisory and must stay advisory.** These assertions are about wording and
 * about what is never omitted — the capability (not the adapter name), the consequence, and
 * the way out — never about refusing to file.
 */

describe('the planner MCP notice', () => {
  // ⛔ Capability language, never adapter names: which CLIs have MCP tools changes.
  it('says nothing for a pinned MCP-capable worker', () => {
    expect(plannerMcpNotice({ label: 'ClaudeFirst', hasMcp: true }, true)).toBeNull()
  })

  it('says nothing while the capability is still unknown', () => {
    expect(plannerMcpNotice({ label: 'ClaudeFirst', hasMcp: null }, true)).toBeNull()
  })

  it('cautions a pinned non-MCP worker and names the way out', () => {
    const notice = plannerMcpNotice({ label: 'AgyFirst', hasMcp: false }, true)
    expect(notice?.tone).toBe('caution')
    expect(notice?.text).toContain('AgyFirst')
    expect(notice?.text).toContain('task_split')
    expect(notice?.text).toContain('Workers table')
    expect(notice?.text).not.toContain('Claude Code')
    expect(notice?.text).not.toContain('Codex')
  })

  it('says nothing on Auto while some worker has MCP tools', () => {
    expect(plannerMcpNotice(null, true)).toBeNull()
  })

  it('cautions on Auto when no worker in the fleet has MCP tools', () => {
    const notice = plannerMcpNotice(null, false)
    expect(notice?.tone).toBe('caution')
    expect(notice?.text).toContain('No worker in this fleet')
    expect(notice?.text).toContain('task_split')
  })
})
