import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AdapterDetection, AdapterInfo, QuotaSnapshot } from '@shared/protocol.js'
import type {
  AgentAdapter,
  IdentityProbe,
  PermissionRules,
  SpawnPlan,
  SpawnRequest,
  WrittenPermissions
} from './types.js'
import { log } from '../log.js'
import { launchArgs, launchable, which } from '../which.js'

/**
 * Antigravity CLI (`agy`) — the Google adapter.
 *
 * Measured against **agy 1.1.20 on Windows, 2026-08-25**. It was written first from the vendor's
 * documentation and then corrected by running it, and the corrections are why this file is worth
 * reading:
 *
 *  - `--mode accept-edits|plan` **exists**. The documented headless surface did not mention it, and
 *    the adapter had been written with no auto-ish mode at all. This is exactly what plan §9.1
 *    predicted for a classifier-less CLI — *accept edits + allowlist* — and it is now the default.
 *  - `--input-format stream-json` **requires** `--output-format stream-json`. Passing one alone is an
 *    argument error, so the two are set together or not at all.
 *  - ⚠️ `--disable-slash-commands` exists, described as disabling slash-command expansion **in print
 *    mode** — which means slash commands *are* expanded there by default. That is the opposite of
 *    Claude Code, where `-p /usage` is taken as a prompt and spends a turn. It makes a free quota
 *    probe plausible here for the first time. ⛔ Not acted on: plausible is not measured, and the
 *    measurement costs a turn on a signed-in account. HANDOFF R9.
 *
 * Three capability gaps drive the scheduling behaviour, and none is a special case in the scheduler:
 *
 *  1. **No `/compact`.** Cache-clock moves 4 and 5 are unavailable and preemption falls back to the
 *     handoff protocol. Exactly as plan §9 predicted.
 *  2. **No classifier-backed auto mode.** Nobody but the operator reviews, so agentyard writes a
 *     narrower allowlist and expects a higher refusal rate (§9.1).
 *  3. ⛔ **No credential isolation.** Credentials go to the OS keyring and no environment variable
 *     relocates the config directory, so there is exactly **one** Antigravity identity per OS user.
 *     `maxAccounts: 1`, enforced at commissioning rather than discovered later as two workers
 *     quietly sharing one account's quota.
 *
 * And the one that cost the most to find: ⛔ **conversations are SQLite, not JSONL.** Every other
 * adapter writes a line-per-event transcript that agentyard tails to meter turns exactly. `agy`
 * writes `conversations/<uuid>.db`. So `meteredFromTranscript` is false and work on this adapter is
 * **unmetered** — its cost is unknown rather than zero, and everything downstream has to say so.
 */

const run = promisify(execFile)

/** Measured: the CLI's own home, distinct from `~/.gemini/antigravity{,-ide}` which the IDE uses. */
function cliHome(): string {
  return join(homedir(), '.gemini', 'antigravity-cli')
}

const info: AdapterInfo = {
  id: 'antigravity-cli',
  label: 'Antigravity CLI',
  command: 'agy',
  // ⛔ Not an oversight and not a TODO. There is no equivalent of CLAUDE_CONFIG_DIR, and the
  // credential is in the OS keyring rather than in a directory at all. See maxAccounts.
  isolationEnvVar: null,
  capabilities: {
    transports: ['pty', 'stream'],
    // Measured from `agy --help`: `--mode` accepts accept-edits and plan; `--dangerously-skip-
    // permissions` is separate. `default` means "the settings file decides".
    permissionModes: ['default', 'accept-edits', 'plan', 'dangerously-skip-permissions'],
    classifierBackedAuto: false,
    approvalChannel: 'settings_rules',
    manualCompact: false,
    resumeSession: true,
    forkSession: false,
    nativeWorktree: false,
    multimodalInput: true,
    // `agy mcp add|remove|list|enable|disable`. ⚠️ Registered globally rather than per session, so
    // agentyard does not use it: one shared registration cannot carry a per-session identity, and
    // AGENTYARD_SESSION_ID is how the MCP server knows who it is speaking for.
    mcp: false,
    quotaProbe: 'none',
    mintsSessionId: false,
    meteredFromTranscript: false,
    maxAccounts: 1
  },
  policy: {
    // Plan §9.1's prediction, now measurable: accept edits, and let the allowlist govern the rest.
    defaultPermissionMode: 'accept-edits',
    interruptSequence: '\x1b',
    costModelId: 'google.antigravity.2026-08',
    // ⛔ Falls out of manualCompact: false. Preemption writes a handoff instead of compacting.
    wrapUpProtocol: 'handoff',
    needsExplicitBudget: true
  },
  verification: {
    level: 'measured',
    asOf: '2026-08-25',
    note:
      'agy 1.1.20 on Windows. Flag surface, subcommands, model list, settings path and conversation ' +
      'storage all read from the running CLI. ⚠️ Still unmeasured, because each needs a signed-in ' +
      'account and a real turn: the stream-json record shapes, whether print mode expands slash ' +
      'commands (HANDOFF R9), and anything about quota.'
  }
}

function envFor(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  // ⛔ An API key in the environment silently outranks the subscription this worker was commissioned
  // with and bills somewhere else. The commissioned identity is the only one honoured.
  delete env.GEMINI_API_KEY
  delete env.GOOGLE_API_KEY
  delete env.GOOGLE_GEMINI_BASE_URL
  return env
}

/**
 * Measured: the installer drops `agy.exe` in `%LOCALAPPDATA%\agy\bin` and only puts it on PATH when
 * `agy install` is run. A fresh install is therefore *present but unfindable*, and reporting "not
 * installed" would send somebody to reinstall something they already have.
 */
function fallbackPaths(): string[] {
  const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  return [
    join(local, 'agy', 'bin', 'agy.exe'),
    join(local, 'agy', 'bin', 'agy'),
    join(homedir(), '.agy', 'bin', 'agy')
  ]
}

function resolveCommand(): string | null {
  return which(info.command) ?? fallbackPaths().find((p) => existsSync(p)) ?? null
}

export const antigravityCli: AgentAdapter = {
  info,

  async detect(): Promise<AdapterDetection> {
    const resolved = resolveCommand()
    if (!resolved) {
      return {
        adapterId: info.id,
        found: false,
        path: null,
        version: null,
        error:
          `'${info.command}' is not on PATH. Antigravity CLI replaced Gemini CLI for individual ` +
          'accounts on 2026-06-18; install from antigravity.google/docs/cli/install.'
      }
    }
    try {
      const probe = launchArgs(resolved, ['--version'])
      const { stdout } = await run(probe.command, probe.args, { timeout: 15_000 })
      const version = stdout.trim().split(/\s+/)[0] ?? stdout.trim()
      const onPath = which(info.command) !== null
      return {
        adapterId: info.id,
        found: true,
        path: resolved,
        version,
        // Found, usable, and worth saying: agentyard will run it by full path, but the operator's own
        // shell will not find it until they run `agy install`.
        ...(onPath ? {} : { error: `found at ${resolved} but not on PATH - run: ${resolved} install` })
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
   * ⚠️ There is no non-interactive identity command, and the credential is in the OS keyring where
   * agentyard will not look. So this reports what it can see — whether the CLI has been run on this
   * machine — and is honest that it cannot say *who* is signed in.
   *
   * ⛔ It must never spend a turn to find out. `agy -p "who am i"` would answer, and would bill.
   */
  async probeIdentity(): Promise<IdentityProbe> {
    const home = cliHome()
    if (!existsSync(join(home, 'settings.json'))) {
      return {
        loggedIn: null,
        raw:
          `no Antigravity CLI settings at ${home}. Either it has never been run, or it is signed in ` +
          'and keeps nothing here - agentyard cannot tell the difference without spending a turn.'
      }
    }
    return {
      loggedIn: null,
      raw:
        `Antigravity CLI is configured at ${home}, but its credential lives in the OS keyring, which ` +
        'agentyard does not read. Sign-in state is unknown by design; a failed run will say so.'
    }
  },

  /**
   * ⛔ Always unknown, and deliberately so.
   *
   * `/usage` is a slash command. ⚠️ Measured 2026-08-25, `agy --help` documents
   * `--disable-slash-commands` as disabling expansion *in print mode* — which implies `agy -p /usage`
   * would really run it, unlike Claude Code where the identical-looking command is taken as a prompt
   * and spends a turn (docs/cost-model.md §5). That would be the first free quota probe agentyard has
   * ever had. It is **not** used here: the implication is from a help string, the confirmation costs a
   * turn on a signed-in account, and the last time this was assumed rather than measured it was
   * wrong. HANDOFF R9.
   */
  async probeQuota(): Promise<Omit<QuotaSnapshot, 'workerId'>> {
    return {
      windows: [],
      sampledAt: Date.now(),
      source: 'unknown',
      error:
        'Antigravity exposes usage only as a slash command. Whether print mode runs it for free is ' +
        'plausible but unmeasured (HANDOFF R9), so this worker has no quota reading and its runs ' +
        'are marked unverified.'
    }
  },

  loginArgv(): string[] {
    return ['login']
  },

  /**
   * Write the project's allowlist where `agy` reads it.
   *
   * ⚠️ This is what `approvalChannel: 'settings_rules'` costs: there is no callback, so everything a
   * run may need must be anticipated *before* it starts, and anything else is refused mid-run with
   * nobody to ask. Rules are shaped `command(git)`, `write_file(src/)`, `mcp(linter/*)`.
   *
   * ⛔ Merges rather than replaces. Measured: this file already holds the operator's own
   * `enableTelemetry` and `trustedWorkspaces`, it is shared with their interactive sessions, and
   * agentyard did not create it.
   */
  writePermissions(_isolationRoot: string, rules: PermissionRules): WrittenPermissions {
    const path = join(cliHome(), 'settings.json')
    try {
      mkdirSync(dirname(path), { recursive: true })
      let existing: Record<string, unknown> = {}
      if (existsSync(path)) {
        try {
          existing = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
        } catch {
          // A settings file we cannot parse is the operator's to fix. Overwriting it would destroy
          // configuration agentyard did not create and cannot reconstruct.
          return { path: null, error: `${path} exists but is not valid JSON; left untouched` }
        }
      }
      const permissions = (existing.permissions ?? {}) as { allow?: string[]; deny?: string[] }
      const merged = {
        ...existing,
        permissions: {
          ...permissions,
          allow: [...new Set([...(permissions.allow ?? []), ...rules.allow])],
          deny: [...new Set([...(permissions.deny ?? []), ...rules.deny])]
        }
      }
      writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`)
      return { path }
    } catch (err) {
      return { path: null, error: err instanceof Error ? err.message : String(err) }
    }
  },

  plan(req: SpawnRequest): SpawnPlan {
    const env = envFor()
    const resolved = resolveCommand()
    if (!resolved) throw new Error(`'${info.command}' is not on PATH`)
    const { command, prefixArgs } = launchable(resolved)

    if (req.argv) return { command, args: [...prefixArgs, ...req.argv], env }

    // ⛔ No `--session-id` exists. agentyard's id stays its own handle rather than being passed as a
    // flag the CLI would reject.
    const args: string[] = []
    if (req.model) args.push('--model', req.model)

    const mode = req.permissionMode ?? info.policy.defaultPermissionMode
    if (mode === 'dangerously-skip-permissions') {
      args.push('--dangerously-skip-permissions')
    } else if (mode === 'accept-edits' || mode === 'plan') {
      args.push('--mode', mode)
    }

    if (req.mcpConfig) {
      // ⚠️ `agy mcp add` registers servers globally, not per session, so there is no way to tell the
      // server which session it is speaking for. Recorded rather than faked: a session that believed
      // it could call `task_complete` and could not would finish and report nothing, which looks
      // exactly like a hang.
      log.warn(
        'antigravity-cli sessions run without agentyard tools: its MCP registration is global, ' +
          'so a per-session identity cannot be passed'
      )
    }

    if (req.transport === 'stream') {
      // Measured: `--input-format stream-json` *requires* `--output-format stream-json`. Setting one
      // without the other is an argument error, so they move together.
      args.push('-p', '--input-format', 'stream-json', '--output-format', 'stream-json')
    }
    return { command, args: [...prefixArgs, ...args], env }
  },

  /** ⛔ Null: `agy` names its own conversations. See discoverTranscript. */
  transcriptPath(): string | null {
    return null
  },

  /**
   * Find the conversation this session wrote.
   *
   * ⚠️ Returns a path to a **SQLite database**, not a JSONL transcript — measured: conversations are
   * `~/.gemini/antigravity-cli/conversations/<uuid>.db`. agentyard's tailer reads lines and cannot
   * meter this, which is why `meteredFromTranscript` is false. The path is still worth having: it is
   * what an operator opens when they want to see what the agent actually did.
   *
   * ⛔ Created after `startedAt`, never merely newest. The operator has only one Antigravity identity
   * and may be using it by hand on this machine, so "newest" would point at their conversation.
   */
  discoverTranscript(_isolationRoot: string, _cwd: string, startedAt: number): string | null {
    const dir = join(cliHome(), 'conversations')
    try {
      if (!existsSync(dir)) return null
      const found: Array<{ path: string; ts: number }> = []
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.db')) continue
        const full = join(dir, name)
        try {
          const stat = statSync(full)
          // Two seconds of slack for clock granularity, and no more: the point is to exclude
          // conversations that already existed, not to widen until something matches.
          if (stat.isFile() && stat.birthtimeMs >= startedAt - 2000) {
            found.push({ path: full, ts: stat.birthtimeMs })
          }
        } catch {
          // A file that vanished between listing and stat is not worth failing a spawn over.
        }
      }
      found.sort((a, b) => b.ts - a.ts)
      return found[0]?.path ?? null
    } catch (err) {
      log.warn('antigravity-cli could not discover a conversation:', err)
      return null
    }
  }
}
