import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AdapterDetection, AdapterInfo, QuotaSnapshot } from '@shared/protocol.js'
import type { AgentAdapter, IdentityProbe, SpawnPlan, SpawnRequest } from './types.js'
import { log } from '../log.js'
import { launchable, which } from '../which.js'

const run = promisify(execFile)

const info: AdapterInfo = {
  id: 'claude-code',
  label: 'Claude Code',
  command: 'claude',
  isolationEnvVar: 'CLAUDE_CONFIG_DIR',
  capabilities: {
    transports: ['pty', 'stream'],
    permissionModes: ['default', 'manual', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'],
    classifierBackedAuto: true,
    approvalChannel: 'permission_prompt_tool',
    manualCompact: true,
    resumeSession: true,
    forkSession: true,
    nativeWorktree: true,
    multimodalInput: true,
    mcp: true,
    quotaProbe: 'cli'
  },
  policy: {
    // Plan §9.1. ⚠️ `auto` is the built-in start mode only for a terminal session on Pro/Max/Team.
    // `-p` and the SDK start in `default`, and an "auto" defaultMode in a project settings file is
    // ignored outright - so it has to be passed on every spawn or scheduled runs silently run Manual
    // and stall on their first shell command with nobody watching.
    defaultPermissionMode: 'auto',
    // ESC is the CLI's own interrupt. ⛔ Not a process kill: a killed agent leaves its work
    // uncommitted and its claims held, which is the expensive half of a cancel.
    interruptSequence: '\x1b',
    costModelId: 'anthropic.subscription.2026-08',
    wrapUpProtocol: 'compact',
    // Opus 4.7+ receives no injected token budget, so a wrap-up instruction must state it. §2.
    needsExplicitBudget: true
  }
}

/** Claude Code's on-disk name for a working directory: every non-alphanumeric becomes a dash. */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/**
 * Where this root's `.claude.json` lives.
 *
 * With `CLAUDE_CONFIG_DIR` set, the CLI writes it *inside* the config directory - verified 2026-08-25
 * by pointing a fresh root at an empty directory and watching the file appear. But a default install
 * keeps its config directory at `~/.claude` while writing `~/.claude.json` **beside** it, so adopting
 * that root has to look one level up as well. An adapter is allowed to know its own CLI's quirks;
 * the scheduler is not.
 */
function usageFileFor(isolationRoot: string): string | null {
  const candidates = [
    join(isolationRoot, '.claude.json'),
    `${isolationRoot.replace(/[\\/]+$/, '')}.json`
  ]
  // Pick the file that actually carries usage, not merely the first that exists: pointing a worker
  // at an existing root makes the CLI write a *stub* .claude.json inside it, and preferring that
  // stub would report "no data" for an account whose real cache sits one level up.
  for (const file of candidates) {
    if (existsSync(file) && readFileSafe(file).includes('cachedUsageUtilization')) return file
  }
  return candidates.find((f) => existsSync(f)) ?? null
}

function readFileSafe(file: string): string {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

function envFor(isolationRoot: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  env.CLAUDE_CONFIG_DIR = isolationRoot
  // ⛔ An API key in the environment outranks the subscription login this worker was commissioned
  // with, silently billing a different account. The isolation root is the only credential we honour.
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  delete env.CLAUDE_CODE_OAUTH_TOKEN
  return env
}

export const claudeCode: AgentAdapter = {
  info,

  async detect(): Promise<AdapterDetection> {
    const resolved = which(info.command)
    if (!resolved) {
      return {
        adapterId: info.id,
        found: false,
        path: null,
        version: null,
        error: `'${info.command}' is not on PATH`
      }
    }
    try {
      const { stdout } = await run(resolved, ['--version'], { timeout: 15_000 })
      const version = stdout.trim().split(/\s+/)[0] ?? stdout.trim()
      return { adapterId: info.id, found: true, path: resolved, version }
    } catch (err) {
      return {
        adapterId: info.id,
        found: false,
        path: null,
        version: null,
        error: err instanceof Error ? err.message : String(err)
      }
    }
  },

  /**
   * `claude auth status --json` answers locally in about a third of a second and spends nothing.
   * Measured 2026-08-25 on 2.1.223: {loggedIn, authMethod, apiProvider, email, orgId, orgName,
   * subscriptionType}.
   */
  async probeIdentity(isolationRoot: string): Promise<IdentityProbe> {
    // ⚠️ `auth status` exits 1 when nobody is logged in but still prints valid JSON on stdout.
    // Measured 2026-08-25. Treating the exit code as the answer would report every un-commissioned
    // worker as "probe failed" instead of the true and far more useful "not logged in".
    let stdout = ''
    try {
      stdout = (
        await run(info.command, ['auth', 'status', '--json'], {
          timeout: 20_000,
          shell: true,
          env: envFor(isolationRoot)
        })
      ).stdout
    } catch (err) {
      stdout = (err as { stdout?: string }).stdout ?? ''
      if (!stdout.trim()) {
        return { loggedIn: null, raw: err instanceof Error ? err.message : String(err) }
      }
    }
    try {
      const parsed = JSON.parse(stdout) as {
        loggedIn?: boolean
        email?: string | null
        orgName?: string | null
        subscriptionType?: string | null
      }
      return {
        loggedIn: parsed.loggedIn ?? null,
        ...(parsed.email ? { account: parsed.email } : {}),
        ...(parsed.orgName ? { organization: parsed.orgName } : {}),
        raw: stdout.trim()
      }
    } catch {
      return { loggedIn: null, raw: stdout.slice(0, 400) }
    }
  },

  /**
   * ⚠️ There is no free live quota probe on Claude Code 2.1.223.
   *
   * Measured 2026-08-25, correcting the plan: `claude -p /usage` does **not** run the slash command.
   * It is taken as a prompt, spends a real assistant turn, and answers in prose. A poller built on it
   * would bill every account on every interval.
   *
   * What is left is `<isolationRoot>/.claude.json` → `cachedUsageUtilization`, which is a cache the
   * CLI refreshes on its own schedule - the reading on this machine was 19 days old. So the snapshot
   * carries `sampledAt = fetchedAtMs`, and the caller decides whether that is fresh enough. It is
   * never presented as current. See quota.ts.
   */
  async probeQuota(isolationRoot: string): Promise<Omit<QuotaSnapshot, 'workerId'>> {
    const file = usageFileFor(isolationRoot)
    if (!file) {
      return { windows: [], sampledAt: Date.now(), source: 'unknown', error: 'no .claude.json yet' }
    }
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
        cachedUsageUtilization?: {
          fetchedAtMs?: number
          utilization?: {
            limits?: Array<{
              kind: string
              group?: string
              percent: number
              resets_at?: string | null
              is_active?: boolean
            }>
          }
        }
      }
      const cached = parsed.cachedUsageUtilization
      const limits = cached?.utilization?.limits ?? []
      if (!cached?.fetchedAtMs || limits.length === 0) {
        return {
          windows: [],
          sampledAt: Date.now(),
          source: 'unknown',
          error: 'no cachedUsageUtilization in .claude.json'
        }
      }
      return {
        windows: limits.map((l) => ({
          id: l.kind,
          label: l.group ?? l.kind,
          percent: l.percent,
          resetsAt: l.resets_at ? Date.parse(l.resets_at) : null
        })),
        // The vendor's fetch time, not ours. Staleness is the caller's problem to see, not to guess.
        sampledAt: cached.fetchedAtMs,
        source: 'config-cache'
      }
    } catch (err) {
      log.warn('claude-code probeQuota failed:', err)
      return {
        windows: [],
        sampledAt: Date.now(),
        source: 'unknown',
        error: err instanceof Error ? err.message : String(err)
      }
    }
  },

  /**
   * `claude auth login` rather than `/login` inside a session: it is the vendor's own flow, it exits
   * when it is done, and agentyard never sees a credential - the CLI writes into its own isolation
   * root and we only watch the process finish.
   */
  loginArgv(): string[] {
    return ['auth', 'login']
  },

  plan(req: SpawnRequest): SpawnPlan {
    const env = envFor(req.isolationRoot)
    const resolved = which(info.command)
    if (!resolved) throw new Error(`'${info.command}' is not on PATH`)
    const { command, prefixArgs } = launchable(resolved)

    if (req.argv) return { command, args: [...prefixArgs, ...req.argv], env }

    const args = [
      // Minted before the process starts, so the transcript path is known before there is a file.
      '--session-id',
      req.sessionId,
      '--permission-mode',
      info.policy.defaultPermissionMode
    ]
    if (req.model) args.push('--model', req.model)
    if (req.mcpConfig) {
      args.push('--mcp-config', req.mcpConfig)
      if (req.transport === 'stream') {
        // ⚠️ Non-interactive only. A PTY session has no such channel, which is why §9.2 has two
        // transports rather than one and a screen parser.
        args.push('--permission-prompt-tool', 'mcp__agentyard__approve')
      }
    }
    if (req.transport === 'stream') {
      args.push('-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose')
    }
    return { command, args: [...prefixArgs, ...args], env }
  },

  transcriptPath(isolationRoot: string, cwd: string, sessionId: string): string {
    return join(isolationRoot, 'projects', encodeProjectDir(cwd), `${sessionId}.jsonl`)
  }
}
