import type { AgentAdapter } from './types.js'
import { claudeCode } from './claude-code.js'

/**
 * The adapter registry.
 *
 * M1 ships `claude-code`. `antigravity-cli` (the Google adapter - `gemini-cli` was retired on
 * 2026-06-18) and `openai-compatible` arrive at M5. Adding one must not require touching the
 * scheduler: if it does, something has been branched on that should have been a capability.
 */
const ADAPTERS: AgentAdapter[] = [claudeCode]

export function adapters(): AgentAdapter[] {
  return ADAPTERS
}

export function adapter(id: string): AgentAdapter {
  const found = ADAPTERS.find((a) => a.info.id === id)
  if (!found) throw new Error(`unknown adapter '${id}'`)
  return found
}

export function hasAdapter(id: string): boolean {
  return ADAPTERS.some((a) => a.info.id === id)
}

export type { AgentAdapter } from './types.js'
