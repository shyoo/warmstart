import type { AgentAdapter } from './types.js'
import { claudeCode } from './claude-code.js'
import { antigravityCli } from './antigravity-cli.js'
import { openaiCompatible } from './openai-compatible.js'

/**
 * The adapter registry.
 *
 * ⛔ Adding one must not require touching the scheduler. M5 is where that claim was tested, and it
 * held: three CLIs that differ in compaction, in whether anything reviews an action, in whether a
 * session id can be chosen, and in whether the machine can hold more than one account of them — and
 * not one line of scheduling code asks which adapter it is looking at. Every difference is a
 * capability the scheduler reads.
 *
 * ⚠️ They do **not** all carry the same confidence. `claude-code` was measured; the other two are
 * written from documentation and say so in `info.verification`, which Doctor and the Workers panel
 * both surface. A capability table is easy to write and expensive to be wrong about.
 */
const ADAPTERS: AgentAdapter[] = [claudeCode, antigravityCli, openaiCompatible]

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
