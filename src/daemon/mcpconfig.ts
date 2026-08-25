import { writeFileSync, existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureDir, paths } from './paths.js'
import { log } from './log.js'

/**
 * The MCP config handed to each agent session.
 *
 * ⚠️ **Tool definitions are the first thing in the cache prefix, and changing them invalidates
 * everything after** (`tools → system → messages`). So every session on this install gets the *same*
 * tool set, and the only thing that varies per session is an environment variable telling the server
 * which session it is speaking for. A per-session tool schema would silently cost a full cache
 * rebuild on every spawn.
 *
 * The server itself is a separate bundle because the agent CLI spawns it, not us.
 */

const here = dirname(fileURLToPath(import.meta.url))

export function mcpServerScript(): string {
  return join(here, 'agentyard-mcp.js')
}

export function mcpConfigDir(): string {
  return join(paths.root, 'mcp')
}

/** Written per session, identical apart from `AGENTYARD_SESSION_ID`. Cleaned up on session exit. */
export function writeMcpConfig(sessionId: string): string | null {
  const script = mcpServerScript()
  if (!existsSync(script)) {
    log.warn(`MCP server bundle missing at ${script}; sessions will run without agentyard tools`)
    return null
  }
  ensureDir(mcpConfigDir())
  const path = join(mcpConfigDir(), `${sessionId}.json`)
  const config = {
    mcpServers: {
      agentyard: {
        // ELECTRON_RUN_AS_NODE turns this binary into plain Node, so a packaged app needs no system
        // Node to run its own MCP server.
        command: process.execPath,
        args: [script],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          AGENTYARD_SESSION_ID: sessionId,
          ...(process.env.AGENTYARD_DATA_DIR ? { AGENTYARD_DATA_DIR: process.env.AGENTYARD_DATA_DIR } : {})
        }
      }
    }
  }
  writeFileSync(path, JSON.stringify(config, null, 2))
  return path
}

export function removeMcpConfig(sessionId: string): void {
  try {
    rmSync(join(mcpConfigDir(), `${sessionId}.json`), { force: true })
  } catch {
    // A stale config file is harmless; failing to remove one must not fail a session teardown.
  }
}
