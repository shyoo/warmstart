import type { AgentAdapter } from './types.js'
import { claudeCode } from './claude-code.js'
import { antigravityCli } from './antigravity-cli.js'
import { openaiCompatible } from './openai-compatible.js'
import { localLlm } from './local-llm.js'
import { museCode } from './muse-code.js'
import { loadExternalAdapters } from './external.js'

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
const BUILT_IN: AgentAdapter[] = [claudeCode, antigravityCli, openaiCompatible, localLlm, museCode]

let ADAPTERS: AgentAdapter[] = [...BUILT_IN]
let externalProblems: string[] = []

/**
 * Pick up declarative adapters from the data directory.
 *
 * ⛔ Called once at startup, deliberately - not on every lookup. An adapter appearing or vanishing
 * under a running scheduler would mean a worker's capabilities changing between the gate that
 * admitted its task and the dispatch that acted on it.
 *
 * ⚠️ A built-in always wins. An operator cannot shadow `claude-code` with a declaration and quietly
 * lose the measured capability table, the transcript metering or the approval callback.
 */
export function loadAdapters(): { loaded: number; problems: string[] } {
  const external = loadExternalAdapters()
  const extra = external.adapters.filter((a) => !BUILT_IN.some((b) => b.info.id === a.info.id))
  const shadowed = external.adapters.length - extra.length
  if (shadowed > 0) {
    external.problems.push(
      `${shadowed} declared adapter(s) ignored: a built-in of the same id already exists, and ` +
        'shadowing one would replace a measured capability table with an unverified declaration'
    )
  }
  ADAPTERS = [...BUILT_IN, ...extra]
  externalProblems = external.problems
  return { loaded: extra.length, problems: external.problems }
}

/** What did not load, and why. Surfaced by Doctor rather than only in a log nobody reads. */
export function adapterProblems(): string[] {
  return externalProblems
}

export function adapters(): AgentAdapter[] {
  return ADAPTERS
}

/**
 * Every loaded adapter's display name, for reports that render stored adapter ids.
 *
 * An adapter this build no longer loads is deliberately absent, so its stored id renders as itself.
 */
export function adapterLabels(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const item of ADAPTERS) out[item.info.id] = item.info.label
  return out
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
