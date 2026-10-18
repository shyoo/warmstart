import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import type { RpcMethod } from '@shared/protocol.js'
import { appEnvName } from '@shared/env.js'
import { ensureDir, paths } from './paths.js'
import { mcpServerScript } from './mcpconfig.js'
import { pathKey } from './which.js'
import { lastRunForSession, runForSession } from './tasks.js'
import { log } from './log.js'

/**
 * `warmstart-agent`: the worker tier for an agent whose CLI cannot speak MCP.
 *
 * ⛔ **The hole it fills.** Antigravity registers MCP servers globally, so one registration cannot
 * carry a per-session identity, and its agents were given text contracts instead — end with
 * `TASK COMPLETE:` or `NEEDS DECISION:` and stop. That left them with no `task_read`, no
 * `project_settings`, no `handoff`, no `task_split`, and an `ask_human` that existed only as the last
 * line of a reply. What such an agent *can* do is run a shell command, and a shell command inherits
 * the environment the daemon spawned its CLI with. So the identity travels there instead.
 *
 * ⛔ **A per-session token, never the daemon's.** The bearer token in `orchestratord.json` opens every
 * RPC the desktop app has. The helper is handed a token minted for one session, which opens only
 * `/agent`, only the worker tier (`AGENT_METHODS`), only while that session has an open run, and
 * whose `sessionId` the daemon writes itself — so an agent cannot speak for another session by
 * changing an argument, and cannot promote itself by exporting a variable.
 *
 * ⚠️ **A shell cannot wait on a person.** A vendor's shell tool kills a command long before an
 * operator's hour is up, so every call that would block on a person is *deferred* instead: the card
 * is filed, the run ends `blocked`, and the answer arrives as the next run, which is how every parked
 * answer already travels. `isHelperCall` is how `askQuestion` knows. Waits on the project's checks
 * (`task_complete`, `land_work`) still block: the daemon finishes them whether or not the shell is
 * still listening.
 */

/** The command an agent types. Also the name of both shims. */
export const AGENT_CLI_COMMAND = 'warmstart-agent'

/**
 * The worker tier, as RPC methods. ⛔ Nothing else is reachable with an agent token.
 *
 * `question.ask` is the one non-`agent.*` method, and `AGENT_ASK_ORIGINS` narrows it further.
 */
export const AGENT_METHODS: ReadonlySet<RpcMethod> = new Set<RpcMethod>([
  'agent.taskRead',
  'agent.projectSettings',
  'agent.complete',
  'agent.awaitHuman',
  'agent.createTask',
  'agent.split',
  'agent.depend',
  'agent.handoff',
  'agent.land',
  'agent.debateRound',
  'agent.requestDirectory',
  'question.ask'
])

/**
 * ⛔ The origins an agent may put on a `question.ask`. A card raised as `request_directory` or
 * `task_split` is worded by the daemon, and its answer *does* something; one an agent could raise
 * itself under that origin would be a grant card with the agent's own words on it.
 */
export const AGENT_ASK_ORIGINS: ReadonlySet<string> = new Set(['ask_human', 'checkpoint'])

/**
 * How many helper calls one session may make in a minute.
 *
 * ⚠️ Chosen, not measured: a whole worker-tier task is a handful of calls — read the task, read the
 * settings, perhaps a handoff, then one terminal call — and an agent stuck re-running a command in a
 * loop passes thirty in well under a minute. The refusal names the limit, so a loop learns it.
 */
export const AGENT_CALLS_PER_MINUTE = 30

const tokens = new Map<string, string>()
const tokenOf = new Map<string, string>()
const recentCalls = new Map<string, number[]>()
const callsPerRun = new Map<string, number>()
/** The run a helper call ended, by session. See `helperEndedLastRun`. */
const endedByHelper = new Map<string, string>()
const helperContext = new AsyncLocalStorage<{ sessionId: string }>()

let endpointPort: number | null = null

/** Recorded once the server is listening; the helper is told where to call. */
export function setAgentCliPort(port: number | null): void {
  endpointPort = port
}

/** Mint the token one session's helper presents. Idempotent per session. */
export function mintAgentToken(sessionId: string): string {
  const existing = tokenOf.get(sessionId)
  if (existing) return existing
  const token = randomBytes(32).toString('base64url')
  tokens.set(token, sessionId)
  tokenOf.set(sessionId, token)
  return token
}

/** The session is gone, and so is everything its helper could do. */
export function revokeAgentToken(sessionId: string): void {
  const token = tokenOf.get(sessionId)
  if (token) tokens.delete(token)
  tokenOf.delete(sessionId)
  recentCalls.delete(sessionId)
  endedByHelper.delete(sessionId)
}

/**
 * The session a presented token was minted for, or null.
 *
 * ⚠️ Compared in constant time against the one candidate the map names, so the lookup itself is the
 * only thing that depends on the token's bytes.
 */
export function sessionForAgentToken(presented: string): string | null {
  if (!presented) return null
  const sessionId = tokens.get(presented)
  if (!sessionId) return null
  const expected = tokenOf.get(sessionId)
  if (!expected) return null
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b) ? sessionId : null
}

/** Is the code running now serving a `warmstart-agent` call? Read by `askQuestion`. */
export function isHelperCall(): boolean {
  return helperContext.getStore() !== undefined
}

/**
 * Note one call against the session's minute, and say whether it is allowed.
 *
 * Returns the refusal sentence, or null when the call may proceed.
 */
export function rateLimitRefusal(sessionId: string, now = Date.now()): string | null {
  const recent = (recentCalls.get(sessionId) ?? []).filter((at) => now - at < 60_000)
  if (recent.length >= AGENT_CALLS_PER_MINUTE) {
    recentCalls.set(sessionId, recent)
    return (
      `Refused: this session has made ${recent.length} ${AGENT_CLI_COMMAND} calls in the last minute, ` +
      `and the limit is ${AGENT_CALLS_PER_MINUTE}. Do not retry in a loop — read what the last call ` +
      'said and act on it.'
    )
  }
  recent.push(now)
  recentCalls.set(sessionId, recent)
  return null
}

/**
 * Run one helper call as the session it was authorised for.
 *
 * ⛔ **And remember whether it ended that session's run.** On an MCP-less adapter, `onStreamResult`
 * reads the end of a turn as the end of the work unless the agent wrote a contract line — the right
 * reading when a line is the only channel there is, and the wrong one after the helper has already
 * completed the task, parked it on a question, or handed it to a person. See `helperEndedLastRun`.
 */
export async function runAsHelper<T>(sessionId: string, call: () => Promise<T> | T): Promise<T> {
  const before = runForSession(sessionId)
  if (before) {
    const n = (callsPerRun.get(before.id) ?? 0) + 1
    callsPerRun.set(before.id, n)
    if (n === 1 || n % 10 === 0) log.info(`run ${before.id.slice(0, 8)}: ${n} ${AGENT_CLI_COMMAND} call(s)`)
  }
  try {
    return await helperContext.run({ sessionId }, async () => await call())
  } finally {
    if (before && runForSession(sessionId)?.id !== before.id) {
      endedByHelper.set(sessionId, before.id)
      callsPerRun.delete(before.id)
    }
  }
}

/**
 * Did a helper call end the run this session last had?
 *
 * ⚠️ Keyed by run, so a mark left by one run can never silence the turn end of the next.
 */
export function helperEndedLastRun(sessionId: string): boolean {
  const ended = endedByHelper.get(sessionId)
  if (!ended) return false
  return lastRunForSession(sessionId)?.id === ended && !runForSession(sessionId)
}

/** The bundle the shims run. Beside the MCP server's, which is how a packaged build finds both. */
export function agentCliScript(): string {
  return join(dirname(mcpServerScript()), 'warmstart-agent.js')
}

/** Where the shims live. */
export function agentCliBinDir(): string {
  return join(paths.root, 'agent-bin')
}

/**
 * ⛔ **Fixed text: no path, no token, nothing about this machine.** Everything that varies arrives in
 * the environment, so the shim is identical on every install and is rewritten whenever it is not —
 * an agent that edited it changes nothing for the next session.
 *
 * ⚠️ `ELECTRON_RUN_AS_NODE` is set inside the shim, never in the agent's environment: this project's
 * own UI suites launch Electron from an agent's shell, and an inherited `ELECTRON_RUN_AS_NODE=1` turns
 * every one of those launches into a bare Node process.
 */
const CMD_SHIM =
  '@echo off\r\n' +
  'setlocal\r\n' +
  'set ELECTRON_RUN_AS_NODE=1\r\n' +
  `"%${appEnvName('AGENT_NODE')}%" "%${appEnvName('AGENT_SCRIPT')}%" %*\r\n`

const SH_SHIM =
  '#!/bin/sh\n' +
  `ELECTRON_RUN_AS_NODE=1 exec "$${appEnvName('AGENT_NODE')}" "$${appEnvName('AGENT_SCRIPT')}" "$@"\n`

function writeIfChanged(path: string, content: string, mode?: number): void {
  let current: string | null
  try {
    current = readFileSync(path, 'utf8')
  } catch {
    current = null
  }
  if (current !== content) writeFileSync(path, content)
  if (mode !== undefined) {
    try {
      chmodSync(path, mode)
    } catch {
      // Windows has no execute bit; Git Bash runs a `#!/bin/sh` file regardless.
    }
  }
}

/**
 * The environment one session's agent needs to reach the helper, merged over `env`.
 *
 * Returns null — and the agent keeps its text contracts — when the helper bundle is not there, as in
 * a checkout that has never been built. ⛔ PATH is extended under the key `env` already spells it
 * with; see `pathKey`.
 */
export function agentCliEnv(
  sessionId: string,
  env: Record<string, string>,
  script = agentCliScript()
): Record<string, string> | null {
  if (!existsSync(script)) {
    log.warn(`${AGENT_CLI_COMMAND} bundle missing at ${script}; this session keeps its text contracts only`)
    return null
  }
  if (endpointPort === null) {
    log.warn(`${AGENT_CLI_COMMAND}: the daemon has no port yet; this session keeps its text contracts only`)
    return null
  }
  const bin = ensureDir(agentCliBinDir())
  writeIfChanged(join(bin, `${AGENT_CLI_COMMAND}.cmd`), CMD_SHIM)
  writeIfChanged(join(bin, AGENT_CLI_COMMAND), SH_SHIM, 0o755)

  const key = pathKey(env)
  const current = env[key]
  return {
    ...env,
    [key]: current ? `${bin}${delimiter}${current}` : bin,
    [appEnvName('AGENT_TOKEN')]: mintAgentToken(sessionId),
    [appEnvName('AGENT_URL')]: `http://127.0.0.1:${endpointPort}/agent`,
    [appEnvName('AGENT_NODE')]: process.execPath,
    [appEnvName('AGENT_SCRIPT')]: script
  }
}
