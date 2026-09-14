/** Types for `link-agent-skills.mjs`, so the guard test can import it without widening to `any`. */
export interface SkillLinkResult {
  ok: boolean
  action: 'linked' | 'already-linked' | 'left-directory' | 'skipped' | 'failed'
  why?: string
}

/** Point `<root>/.codex` at `<root>/.claude` as a link this filesystem understands. Idempotent. */
export function linkAgentSkills(root?: string): SkillLinkResult
