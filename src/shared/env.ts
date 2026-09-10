/**
 * The app's own environment variables, under the current name and every name it used to have.
 *
 * ⛔ **Why a fallback exists at all.** Two of these variables are not set by the person running the
 * app — they are **written into the vendor CLIs' own MCP configuration files** by `mcpconfig.ts` and
 * read back by `src/mcp/index.ts` in a process the CLI spawns. A config written before a rename is
 * still on disk after it, so an MCP server that understood only the new name would answer *"no
 * session"* for every tool call in a session that was already running, and the failure would look
 * like the MCP server being broken rather than like a rename.
 *
 * ⚠️ **The others are a courtesy, not a requirement**: `WARMSTART_DATA_DIR` in particular is the one
 * an operator may have put in a shell profile or a shortcut to keep the fleet on another volume, and
 * breaking that silently moves someone's whole install to a directory they did not choose.
 *
 * ⛔ **Deprecated, and dated.** The legacy prefix is read, never written — `mcpconfig.ts` emits only
 * the current name, so configs converge on their own as sessions are recreated. Remove
 * `LEGACY_PREFIXES` once no supported install predates the rename (added 2026-09-09).
 */

const PREFIX = 'WARMSTART_'

/** Newest first. `MULTI_AGENT_CONTROLLER_` was the first public name; `AGENTYARD_` never shipped. */
const LEGACY_PREFIXES = ['MULTI_AGENT_CONTROLLER_'] as const

/**
 * Read `WARMSTART_<name>`, falling back to the same suffix under any previous prefix.
 *
 * ⚠️ An empty string counts as unset, matching how every caller already treated these: a variable
 * exported as `""` by a shell wrapper meant "not configured" before this function existed and must
 * keep meaning it, or an empty `WARMSTART_DATA_DIR` would start shadowing a working legacy one.
 */
export function appEnv(name: string): string | undefined {
  const current = process.env[PREFIX + name]
  if (current !== undefined && current !== '') return current
  for (const legacy of LEGACY_PREFIXES) {
    const value = process.env[legacy + name]
    if (value !== undefined && value !== '') return value
  }
  return undefined
}

/** The current, canonical name for one of these variables. Use when *writing* an environment. */
export function appEnvName(name: string): string {
  return PREFIX + name
}
