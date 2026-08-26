import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AdapterDetection, AdapterInfo, QuotaSnapshot } from '@shared/protocol.js'
import type {
  AgentAdapter,
  IdentityProbe,
  PermissionRules,
  SpawnPlan,
  SpawnRequest,
  WrittenPermissions
} from './types.js'
import { asRecord, num, textBlocks, type StreamEvent, type StreamUsage } from '../stream.js'
import { log } from '../log.js'
import { launchArgs, launchable, which } from '../which.js'

/**
 * Codex CLI — the OpenAI-compatible adapter.
 *
 * Measured against **codex-cli 0.149.1 on Windows, 2026-08-25**, and the corrections matter:
 *
 *  - ⛔ **`--ask-for-approval` does not exist on `codex exec`.** It is an *interactive* flag. Written
 *    from the documentation, this adapter passed it on every scheduled spawn, and every one of those
 *    spawns would have died on an argument error. `exec` offers `--approve-for-me` instead.
 *  - ⛔ **`-p` is `--profile`, not `--print`.** It layers `$CODEX_HOME/<name>.config.toml`. On `agy`
 *    the same flag means print mode. Two CLIs, one letter, opposite meanings.
 *  - `--json` is right, and `codex doctor --json` turns out to be a free, redacted, machine-readable
 *    health report — a better identity probe than looking for a credential file, and the vendor's own
 *    output rather than agentyard's inference.
 *  - `--skip-git-repo-check` exists because `exec` refuses to run outside a git repository. agentyard
 *    works in pooled worktrees, so this only bites on a project with `vcs: none`.
 *
 * The instructive part is the contrast with Antigravity, because it is the whole reason
 * `maxAccounts` had to become a capability rather than an assumption:
 *
 * | | Antigravity | Codex |
 * |---|---|---|
 * | Credential | OS keyring | `$CODEX_HOME/` |
 * | Config dir override | ⛔ none | `CODEX_HOME` |
 * | Accounts per machine | **1** | unlimited |
 *
 * Two CLIs, both without a classifier and both without a permission callback, and yet one can hold a
 * fleet and the other cannot. That difference is invisible in a feature table and decisive in a
 * scheduler, which is why it is a capability the scheduler can read rather than a paragraph in a
 * README.
 */

const run = promisify(execFile)

const info: AdapterInfo = {
  id: 'openai-compatible',
  label: 'Codex CLI',
  command: 'codex',
  // ✔ The thing Antigravity lacks. One directory per account, so a fleet is just directories.
  isolationEnvVar: 'CODEX_HOME',
  capabilities: {
    transports: ['pty', 'stream'],
    // Measured from `codex exec --help`. ⛔ These are *sandbox* policies, not approval policies:
    // `exec` has no approval prompt at all, so the sandbox is the only thing standing between the
    // agent and the machine.
    permissionModes: ['read-only', 'workspace-write', 'danger-full-access'],
    classifierBackedAuto: false,
    approvalChannel: 'settings_rules',
    // ⚠️ Codex does have compaction in its session lifecycle, but whether it can be driven from a
    // headless run is undocumented. Set false deliberately: claiming a capability that is absent
    // costs a stalled session at a window boundary, while omitting one that is present costs only a
    // missed optimisation. Conservative is the cheap direction of the error.
    manualCompact: false,
    resumeSession: true,
    forkSession: true,
    nativeWorktree: false,
    multimodalInput: true,
    mcp: true,
    // No non-interactive status command exists; openai/codex#10233 is the open request for one.
    quotaProbe: 'none',
    // `codex exec resume <SESSION_ID>` takes an id, but the id is codex's to create - there is no
    // flag that supplies one for a *new* session.
    mintsSessionId: false,
    // ⚠️ Rollout files are JSONL, but transcript.ts parses Anthropic's record shape, not codex's.
    // The stream carries usage - including cache reads and writes - so that is the route taken.
    // Reading the rollout files instead is HANDOFF R10.
    metering: 'stream',
    maxAccounts: null
  },
  policy: {
    // ⛔ `workspace-write`, not `danger-full-access`. With no classifier and no approval callback the
    // sandbox is the only remaining boundary, and the agent works in a pooled worktree that is meant
    // to be writable and nothing else.
    defaultPermissionMode: 'workspace-write',
    interruptSequence: '\x1b',
    costModelId: 'openai.codex.2026-08',
    wrapUpProtocol: 'handoff',
    needsExplicitBudget: true
  },
  verification: {
    level: 'measured',
    asOf: '2026-08-25',
    note:
      'codex-cli 0.149.1 on Windows. Flag surface, CODEX_HOME, doctor JSON shape and the model list ' +
      'in models_cache.json all read from the running CLI. ⚠️ Still unmeasured: the JSONL event ' +
      'shapes under --json, whether rollout files carry meterable usage (HANDOFF R10), and anything ' +
      'about quota.'
  }
}

function envFor(isolationRoot: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  env.CODEX_HOME = isolationRoot
  // ⛔ Same rule as every other adapter: a key in the environment silently outranks the account this
  // worker was commissioned with and bills somewhere else.
  delete env.OPENAI_API_KEY
  delete env.CODEX_API_KEY
  return env
}

/**
 * Codex's stream dialect.
 *
 * Keyed on `type` like Claude Code, and shares not one value with it. Verbatim from a real run:
 *
 * ```
 * {"type":"thread.started","thread_id":"..."}
 * {"type":"turn.started"}
 * {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ok"}}
 * {"type":"turn.completed","usage":{"input_tokens":13249,"cached_input_tokens":11008,
 *                                   "cache_write_input_tokens":0,"output_tokens":5,
 *                                   "reasoning_output_tokens":0}}
 * ```
 *
 * ⚠️ Note what `turn.completed` carries: **cached_input_tokens and cache_write_input_tokens**. Codex
 * reports cache reads *and* writes, which is more cost visibility than Antigravity gives. It still
 * does not make the cache *steerable* - there is no client-controlled TTL to extend, which is why the
 * cost model stays `unpriced` (D24). Observing a cost and having a lever on it are different things.
 */
function decodeStream(record: Record<string, unknown>): StreamEvent | StreamEvent[] | null {
  const type = typeof record.type === 'string' ? record.type : ''

  if (type === 'thread.started') {
    return {
      kind: 'init',
      sessionId: typeof record.thread_id === 'string' ? record.thread_id : null,
      model: null,
      permissionMode: null
    }
  }

  if (type === 'item.completed') {
    const item = asRecord(record.item)
    if (item?.type === 'agent_message' && typeof item.text === 'string' && item.text) {
      return { kind: 'assistant_text', text: item.text }
    }
    return { kind: 'other', type }
  }

  if (type === 'turn.completed' || type === 'turn.failed') {
    const usage = asRecord(record.usage)
    const failed = type === 'turn.failed'
    // ⛔ Usage first: `turn.completed` is both the terminal record and the only usage record, and a
    // caller that saw only the result would never learn what the turn cost.
    if (usage && !failed) return { kind: 'usage', usage: readUsage(usage), final: true }
    return {
      kind: 'result',
      text: null,
      costUsd: null,
      isError: failed,
      terminalReason: type
    }
  }

  return type ? { kind: 'other', type } : null
}

/** `{input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens}` */
function readUsage(usage: Record<string, unknown>): StreamUsage {
  const cacheRead = num(usage.cached_input_tokens)
  return {
    // ⚠️ `input_tokens` is the total and *includes* the cached part. Adding them would double-count
    // the prefix - which on this sample was 11,008 of 13,249 tokens.
    input: Math.max(0, num(usage.input_tokens) - cacheRead),
    output: num(usage.output_tokens),
    thinking: num(usage.reasoning_output_tokens),
    cacheRead,
    cacheWrite: num(usage.cache_write_input_tokens)
  }
}

export const openaiCompatible: AgentAdapter = {
  info,
  decodeStream,

  isInstalled(): boolean {
    return which(info.command) !== null
  },

  async detect(): Promise<AdapterDetection> {
    const resolved = which(info.command)
    if (!resolved) {
      return {
        adapterId: info.id,
        found: false,
        path: null,
        version: null,
        error: `'${info.command}' is not on PATH. Install with: npm install -g @openai/codex`
      }
    }
    try {
      const probe = launchArgs(resolved, ['--version'])
      const { stdout } = await run(probe.command, probe.args, { timeout: 15_000 })
      return {
        adapterId: info.id,
        found: true,
        path: resolved,
        version: stdout.trim().split(/\s+/).pop() ?? stdout.trim()
      }
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
   * Read the isolation root for evidence of a sign-in.
   *
   * ⛔ Presence of an auth file, never its contents. agentyard does not read, copy or proxy a
   * credential; it looks at whether the vendor put one there and reports the filename.
   */
  async probeIdentity(isolationRoot: string): Promise<IdentityProbe> {
    // ⛔ `codex doctor --json` describes itself as a *redacted* machine-readable report, and it is
    // free and local. Using the vendor's own answer beats agentyard inferring one from the presence
    // of a file - and it means agentyard never opens `auth.json`, which holds a real token.
    const resolved = which(info.command)
    if (resolved) {
      try {
        const probe = launchArgs(resolved, ['doctor', '--json'])
        const { stdout } = await run(probe.command, probe.args, {
          timeout: 60_000,
          env: envFor(isolationRoot)
        })
        const report = JSON.parse(stdout) as {
          codexVersion?: string
          checks?: Record<string, { status?: string; details?: Record<string, string> }>
        }
        const auth = report.checks?.['auth.credentials']
        if (auth) {
          const mode = auth.details?.['stored auth mode'] ?? 'unknown'
          return {
            loggedIn: auth.status === 'ok',
            ...(report.codexVersion ? { cliVersion: report.codexVersion } : {}),
            raw: JSON.stringify({
              loggedIn: auth.status === 'ok',
              authMode: mode,
              source: 'codex doctor --json'
            })
          }
        }
      } catch (err) {
        // Doctor is a diagnostic and may fail for reasons that have nothing to do with sign-in.
        // Falling back beats reporting "probe failed" for an account that is perfectly fine.
        log.debug('codex doctor --json unavailable, falling back to a file check:', err)
      }
    }

    // ⛔ Presence, never contents. agentyard does not read, copy or proxy a credential.
    const auth = join(isolationRoot, 'auth.json')
    return existsSync(auth)
      ? { loggedIn: true, raw: JSON.stringify({ loggedIn: true, source: 'auth.json exists' }) }
      : {
          loggedIn: false,
          raw: JSON.stringify({ loggedIn: false, reason: `no auth.json in ${isolationRoot}` })
        }
  },

  /** ⛔ No non-interactive usage command exists. Reported as unknown rather than guessed. */
  async probeQuota(): Promise<Omit<QuotaSnapshot, 'workerId'>> {
    return {
      windows: [],
      sampledAt: Date.now(),
      source: 'unknown',
      error:
        'Codex has no non-interactive usage command (openai/codex#10233). This worker has no quota ' +
        'reading, so its runs are marked unverified.'
    }
  },

  loginArgv(): string[] {
    return ['login']
  },

  /**
   * Write the project's rules into this worker's own `config.toml`.
   *
   * Unlike Antigravity this touches **only the isolation root agentyard created**, never a shared
   * user-level file — which is what `CODEX_HOME` buys.
   */
  writePermissions(isolationRoot: string, rules: PermissionRules): WrittenPermissions {
    const path = join(isolationRoot, 'multi_agent_controller.config.toml')
    try {
      mkdirSync(isolationRoot, { recursive: true })
      const lines = [
        '# Written by Multi Agent Controller before each session. Edits are overwritten.',
        '# ⛔ Rules only. It never writes a credential.',
        '',
        '[approval]',
        `allow = [${rules.allow.map((r) => JSON.stringify(r)).join(', ')}]`,
        `deny = [${rules.deny.map((r) => JSON.stringify(r)).join(', ')}]`,
        ''
      ]
      writeFileSync(path, lines.join('\n'))
      return { path }
    } catch (err) {
      return { path: null, error: err instanceof Error ? err.message : String(err) }
    }
  },

  plan(req: SpawnRequest): SpawnPlan {
    const env = envFor(req.isolationRoot)
    const resolved = which(info.command)
    if (!resolved) throw new Error(`'${info.command}' is not on PATH`)
    const { command, prefixArgs } = launchable(resolved)

    if (req.argv) return { command, args: [...prefixArgs, ...req.argv], env }

    const args: string[] = []
    if (req.transport === 'stream') {
      // `codex exec` is the headless entry point; the interactive TUI has no subcommand.
      // ⛔ `--json`, not `--output-format`: measured, `exec` has no `--output-format` flag.
      args.push('exec', '--json')
      args.push('--sandbox', req.permissionMode ?? info.policy.defaultPermissionMode)
      args.push('--cd', req.cwd)
      // `exec` refuses to start outside a git repository. agentyard's pooled worktrees are git, but a
      // project declared `vcs: none` is not, and refusing to start is a worse failure than running.
      args.push('--skip-git-repo-check')
      // ⛔ Deliberately absent: `--ask-for-approval` is interactive-only and would be an argument
      // error here, and `--dangerously-bypass-approvals-and-sandbox` removes the only boundary left.
    }
    if (req.model) args.push('--model', req.model)
    if (req.mcpConfig) {
      // Codex registers MCP servers with `codex mcp add` into its own config rather than by path, so
      // there is no way to give one a per-session identity. Recorded rather than faked.
      log.warn(
        'openai-compatible sessions run without controller tools: its MCP registration is global, ' +
          'so a per-session identity cannot be passed'
      )
    }
    return { command, args: [...prefixArgs, ...args], env }
  },

  /** ⛔ Null: codex names its own rollout file. See discoverTranscript. */
  transcriptPath(): string | null {
    return null
  },

  /**
   * `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<session-id>.jsonl`.
   *
   * ⛔ Created after `startedAt`. Here the isolation root makes this safer than it is for Antigravity
   * — this directory belongs to one agentyard worker — but the rule is the adapter contract's, not a
   * convenience, and a worker adopted from an existing `~/.codex` would otherwise pick up the
   * operator's own session.
   */
  discoverTranscript(isolationRoot: string, _cwd: string, startedAt: number): string | null {
    const root = join(isolationRoot, 'sessions')
    try {
      if (!existsSync(root)) return null
      const found: Array<{ path: string; ts: number }> = []

      const walk = (dir: string, depth: number): void => {
        // Codex nests by YYYY/MM/DD. Four is enough for that and stops a symlink loop from becoming
        // an infinite scan of the filesystem.
        if (depth > 4) return
        for (const name of readdirSync(dir)) {
          const full = join(dir, name)
          let stat
          try {
            stat = statSync(full)
          } catch {
            continue
          }
          if (stat.isDirectory()) {
            walk(full, depth + 1)
          } else if (name.startsWith('rollout-') && name.endsWith('.jsonl')) {
            // ⛔ Two seconds of slack for clock granularity, and no more: the point is to exclude
            // sessions that already existed, not to widen until something matches.
            if (stat.birthtimeMs >= startedAt - 2000) found.push({ path: full, ts: stat.birthtimeMs })
          }
        }
      }
      walk(root, 0)

      found.sort((a, b) => b.ts - a.ts)
      return found[0]?.path ?? null
    } catch (err) {
      log.warn('openai-compatible could not discover a transcript:', err)
      return null
    }
  }

}
