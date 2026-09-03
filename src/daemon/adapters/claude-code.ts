import type { Attachment } from '@shared/tasks.js'
import { attachmentBytes, attachmentDirs } from '../attachments.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AdapterDetection, AdapterInfo, QuotaSnapshot } from '@shared/protocol.js'
import type { AgentAdapter, IdentityProbe, SpawnPlan, SpawnRequest } from './types.js'
import { asRecord, textBlocks, type StreamEvent } from '../stream.js'
import { log } from '../log.js'
import { launchArgs, launchable, spawnEnv, which } from '../which.js'
import { APPROVE_TOOL } from '../mcpconfig.js'
import { paths } from '../paths.js'

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
    imageInput: 'inline',
    mcp: true,
    // ⭐ **A flag exists as of claude 2.1.250**, which the note here promised to watch for: `--effort
    // <level>` taking `low, medium, high, xhigh, max` — the same five this cost model lists for
    // opus-5 and sonnet-5, and none for haiku-4-5, which takes no effort at all.
    // ⭐ Measured 2026-08-29, not read off `--help`: a headless run with `--effort low` came back
    // with `effort: "low"` on the assistant record of its own transcript, which is the field
    // transcript.ts already parses. The flag is set *and* observable, so the loop closes.
    // ⚠️ Chosen at launch, per session. `/effort` mid-session still works and still costs the
    // messages cache — see docs/cost-model.md §11 for why that is a different decision.
    selectableEffort: true,
    quotaProbe: 'cli',
    // stdin stays open and takes prompt after prompt; that is what the stream transport is for.
    streamPrompts: 'conversation',
    // `--session-id` takes a uuid we choose, which is what makes the transcript path knowable before
    // the file exists and what lets orphan reaping prove a pid is ours.
    mintsSessionId: true,
    // JSONL, one record per event, summing usage.iterations[]. The exactness the cost model is built on.
    metering: 'transcript',
    // CLAUDE_CONFIG_DIR points the CLI at one account's directory, so a fleet is just directories.
    maxAccounts: null
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
  },
  login: { kind: 'cli', argv: ['auth', 'login'] },
  // ⭐ Measured 2026-08-27 on 2.1.223: driving `/usage` into a PTY moved `fetchedAtMs` from
  // 2026-08-06T23:35Z to 2026-08-27T00:16Z and spent nothing. 9s was enough for the TUI to accept
  // input and 14s for the answer to reach disk; both are padded here, because being early means
  // reading the old number and believing it.
  usageRefresh: { command: '/usage', readyMs: 12_000, settleMs: 16_000 },
  // ⛔ Measured 2026-08-27. Signing in is not being set up: the credential lands in the isolation
  // root and `hasCompletedOnboarding` does not, so the first interactive session there shows the
  // theme picker and the login-method chooser instead of a prompt. Print mode never sees them,
  // which is why a worker can run scheduled work for days and still fail to answer `/usage`.
  firstRun: {
    argv: [],
    completedKey: 'hasCompletedOnboarding',
    reason:
      'This account is signed in, but the CLI has not finished its first-run questions in this ' +
      "worker's own directory: a theme, a login method, and whether it trusts the folder the " +
      'session opened in. They only appear in a real terminal, only a person can answer them, and ' +
      'until they are answered the CLI swallows anything typed at it - which is why a quota probe ' +
      'reports nothing while scheduled work carries on fine.'
  },
  verification: {
    level: 'measured',
    asOf: '2026-08-25',
    note:
      'Every capability here was exercised against Claude Code 2.1.223 on this machine during M1-M4. ' +
      'Three corrected a written assumption: `claude -p /usage` spends a real turn, `--print` will ' +
      'not start under a PTY, and `auth status` exits 1 while printing valid JSON.'
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

/**
 * Has this root been through the CLI's first-run screens?
 *
 * ⚠️ Reads the config **inside the isolation root only**, never the sibling one level up. A worker
 * adopting an existing directory can see somebody else's completed onboarding through that sibling
 * and report itself ready when its own root is not - and the failure it hides is silent, because
 * print mode works either way.
 */
function firstRunComplete(isolationRoot: string): boolean | null {
  const file = join(isolationRoot, '.claude.json')
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSafe(file)) as {
      hasCompletedOnboarding?: unknown
      projects?: Record<string, { hasTrustDialogAccepted?: unknown }>
      oauthAccount?: { billingType?: string | null }
    }
    // An account whose subscription has lapsed/expired cannot complete onboarding;
    // reporting it as setupComplete: false triggers "setup unfinished" and "Finish setup" buttons
    // that immediately fail.
    if (parsed.oauthAccount && parsed.oauthAccount.billingType === 'none') {
      return null
    }
    if (parsed.hasCompletedOnboarding !== true) return false

    // ⛔ Two questions, not one. Measured 2026-08-27: after onboarding was finished the usage probe
    // *still* failed, because the CLI then asks whether it trusts the folder it was opened in - per
    // account, once per folder - and swallows every keystroke until somebody answers. `/usage` was
    // being typed into that dialog and the Enter after it was accepting the folder. A worker is only
    // ready when both have been answered, and the folder that matters is the one a projectless
    // session runs in.
    const trusted = parsed.projects?.[normaliseProjectKey(paths.scratch)]?.hasTrustDialogAccepted
    return trusted === true
  } catch {
    return null
  }
}

/** The CLI keys its project map by the path as it saw it, with forward slashes. */
function normaliseProjectKey(dir: string): string {
  return dir.split('\\').join('/')
}

function readFileSafe(file: string): string {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

function envFor(isolationRoot: string): Record<string, string> {
  // ⛔ `spawnEnv` first: it drops the whole `CLAUDE*` namespace, so a daemon started from
  // inside a Claude Code session cannot hand this worker the operator's session id, messaging socket
  // or bridge id. `CLAUDE_CONFIG_DIR` is then set to the root this worker was commissioned with -
  // the inherited one would have pointed at the operator's own credentials.
  const env = spawnEnv()
  env.CLAUDE_CONFIG_DIR = isolationRoot
  // ⛔ An API key in the environment outranks the subscription login this worker was commissioned
  // with, silently billing a different account. The isolation root is the only credential we honour.
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  delete env.CLAUDE_CODE_OAUTH_TOKEN
  return env
}

/**
 * Claude Code's stream-json dialect.
 *
 * The only one of the three that carries a **free live rate-limit record** - a status and a real
 * reset time, riding a turn already being paid for. It is the signal preemption runs on.
 *
 * ⚠️ And the only one that does *not* report usage in the stream. Its numbers come from the
 * transcript, which is exact and includes the compaction sampling iteration (cost-model.md §6).
 */
function decodeStream(record: Record<string, unknown>): StreamEvent | StreamEvent[] | null {
  const type = typeof record.type === 'string' ? record.type : ''

  if (type === 'rate_limit_event') {
    const info = asRecord(record.rate_limit_info)
    if (!info) return null
    return {
      kind: 'rate_limit',
      info: {
        status: typeof info.status === 'string' ? info.status : 'unknown',
        // The CLI reports seconds; everything in agentyard is epoch milliseconds.
        resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt * 1000 : null,
        rateLimitType: typeof info.rateLimitType === 'string' ? info.rateLimitType : 'unknown',
        ...(typeof info.overageStatus === 'string' ? { overageStatus: info.overageStatus } : {}),
        ...(typeof info.isUsingOverage === 'boolean' ? { isUsingOverage: info.isUsingOverage } : {})
      }
    }
  }

  if (type === 'result') {
    return {
      kind: 'result',
      text: typeof record.result === 'string' ? record.result : null,
      costUsd: typeof record.total_cost_usd === 'number' ? record.total_cost_usd : null,
      isError: record.is_error === true,
      terminalReason: typeof record.terminal_reason === 'string' ? record.terminal_reason : null
    }
  }

  if (type === 'assistant') {
    const text = textBlocks(record.message)
    // A tool-use-only turn carries no prose. Reporting it as empty text would make a chat pane look
    // like the controller answered with nothing.
    return text ? { kind: 'assistant_text', text } : { kind: 'other', type }
  }

  // ⛔ The record that says the agent stopped *for a person* rather than because it was finished.
  // Measured 2026-08-30 on 2.1.251 (R14.c): an `AskUserQuestion` that went unanswered produced
  // `status_category: "blocked"` with `needs_action` naming what was wanted — beside a `result` that
  // was indistinguishable from success. Decoded as `other` until then, so the reason existed on the
  // wire and never reached the operator.
  if (type === 'system' && record.subtype === 'post_turn_summary') {
    const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)
    return {
      kind: 'turn_status',
      category: typeof record.status_category === 'string' ? record.status_category : 'unknown',
      detail: str(record.status_detail),
      needsAction: str(record.needs_action)
    }
  }

  if (type === 'system' && record.subtype === 'init') {
    return {
      kind: 'init',
      sessionId: typeof record.session_id === 'string' ? record.session_id : null,
      model: typeof record.model === 'string' ? record.model : null,
      permissionMode: typeof record.permissionMode === 'string' ? record.permissionMode : null
    }
  }

  return type ? { kind: 'other', type } : null
}

export const claudeCode: AgentAdapter = {
  info,
  decodeStream,
  /**
   * ⭐ The envelope agentyard already sent takes an image block today with no change to its shape —
   * measured 2026-08-31 against claude 2.1.251, with a 64×64 four-quadrant PNG whose colours came
   * back named correctly and in order.
   *
   * ⛔ Images **before** the text, which is the order the measurement used and the order the vendor
   * documents. A question asked before the picture arrives is a question about nothing.
   */
  encodeStreamPrompt: (text: string, attachments: Attachment[] = []) => {
    const images = attachments.flatMap((a) => {
      const bytes = attachmentBytes(a)
      if (!bytes) return []
      return [
        {
          type: 'image',
          source: { type: 'base64', media_type: a.mediaType, data: bytes.toString('base64') }
        }
      ]
    })
    return JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [...images, { type: 'text', text }] }
    })
  },

  /**
   * ⚠️ Measured: When Claude Code's Pro/Team subscription expires or access is revoked, it outputs:
   * "Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access"
   * or "subscription has expired".
   */
  subscriptionExpired: (reason: string): boolean => {
    const said = reason.toLowerCase()
    return (
      said.includes('disabled claude subscription access') ||
      said.includes('subscription has expired') ||
      said.includes('subscription expired') ||
      said.includes('subscription access for claude code')
    )
  },

  /**
   * ⚠️ Measured, not imagined: the first sentence is verbatim what this CLI answered on 2026-08-27
   * on an account whose subscription had lapsed, and it is the case that started all of this.
   * The others are the same class of failure with different wording, and every one of them means
   * the same thing to an operator - press Sign in, nothing else will help.
   *
   * ⛔ Anchored on the phrases, and case-insensitively, but never on `api_error` alone: that code
   * covers everything from a lapsed plan to the vendor having a bad afternoon, and telling
   * somebody to re-authenticate through an outage is how a good account gets signed out.
   */
  needsReauth: (reason: string): boolean => {
    const said = reason.toLowerCase()
    return (
      said.includes('disabled claude subscription access') ||
      said.includes('subscription has expired') ||
      said.includes('subscription expired') ||
      said.includes('please run /login') ||
      said.includes('invalid api key') ||
      said.includes('oauth token has expired') ||
      said.includes('authentication_error')
    )
  },

  /**
   * ⚠️ Measured, not imagined: the first phrase is verbatim what this CLI answered on ClaudeSecond
   * on 2026-09-02 (t108) — `api_error: You've hit your session limit · resets 4am
   * (America/Los_Angeles)` — on an account whose five-hour window had run out mid-run. The others
   * are the same event in this vendor's other wordings.
   *
   * ⛔ Anchored on "limit" beside a pool this vendor actually meters, never on the word alone: a
   * tool that reports "line limit exceeded" is an agent having a bad turn, and parking the task
   * against a quota window would hide a real failure behind a five-hour clock.
   *
   * ⛔ And never on `api_error` alone, for the reason `needsReauth` gives above.
   */
  outOfQuota: (reason: string): boolean => {
    const said = reason.toLowerCase()
    return (
      said.includes('session limit') ||
      said.includes('usage limit') ||
      said.includes('rate limit exceeded') ||
      said.includes('5-hour limit') ||
      said.includes('five-hour limit') ||
      said.includes('weekly limit') ||
      said.includes('rate_limit_error')
    )
  },

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
        error: `'${info.command}' is not on PATH`
      }
    }
    try {
      // ⛔ Through launchArgs, not directly: this machine resolves a .EXE, but an npm global install
      // leaves a .cmd that Node will not execFile without a shell.
      const probe = launchArgs(resolved, ['--version'])
      const { stdout } = await run(probe.command, probe.args, { timeout: 15_000 })
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
  /**
   * ⚠️ Read-modify-write, never a replacement. This file is the vendor's, it holds an account's
   * `oauthAccount`, its onboarding state and every project it has seen, and this app did not create
   * it. Rewriting it wholesale to set one boolean would destroy configuration nothing here can
   * reconstruct.
   */
  trustDirectory(isolationRoot: string, dir: string): void {
    const file = join(isolationRoot, '.claude.json')
    let existing: Record<string, unknown> = {}
    if (existsSync(file)) {
      try {
        existing = JSON.parse(readFileSafe(file)) as Record<string, unknown>
      } catch {
        // Unparseable is the operator's to fix. Overwriting it would lose their credential.
        log.warn(`${file} is not valid JSON; leaving it untouched`)
        return
      }
    }
    const key = normaliseProjectKey(dir)
    const projects = (existing.projects ?? {}) as Record<string, Record<string, unknown>>
    if (projects[key]?.hasTrustDialogAccepted === true) return

    projects[key] = { ...(projects[key] ?? {}), hasTrustDialogAccepted: true }
    existing.projects = projects
    try {
      writeFileSync(file, JSON.stringify(existing, null, 2))
      log.info(`pre-trusted ${key} for this worker so a projectless session is not stopped by a dialog`)
    } catch (err) {
      log.warn(`could not record folder trust in ${file}:`, err)
    }
  },

  async probeIdentity(isolationRoot: string): Promise<IdentityProbe> {
    // ⚠️ `auth status` exits 1 when nobody is logged in but still prints valid JSON on stdout.
    // Measured 2026-08-25. Treating the exit code as the answer would report every un-commissioned
    // worker as "probe failed" instead of the true and far more useful "not logged in".
    let stdout: string
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
    const file = join(isolationRoot, '.claude.json')
    let isExpired = false
    if (existsSync(file)) {
      try {
        const cj = JSON.parse(readFileSafe(file)) as {
          oauthAccount?: { billingType?: string | null }
        }
        if (cj.oauthAccount && cj.oauthAccount.billingType === 'none') {
          isExpired = true
        }
      } catch {
        // .claude.json unreadable or malformed
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
        setupComplete: isExpired ? null : firstRunComplete(isolationRoot),
        subscriptionType: isExpired ? 'expired' : (parsed.subscriptionType ?? null),
        subscriptionExpired: isExpired,
        raw: stdout.trim()
      }
    } catch {
      return {
        loggedIn: null,
        setupComplete: isExpired ? null : firstRunComplete(isolationRoot),
        subscriptionExpired: isExpired,
        raw: stdout.slice(0, 400)
      }
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
        oauthAccount?: {
          billingType?: string | null
        }
      }
      if (parsed.oauthAccount && parsed.oauthAccount.billingType === 'none') {
        return {
          windows: [],
          sampledAt: Date.now(),
          source: 'config-cache',
          error: 'Subscription expired'
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
      const formatClaudeLabel = (kind: string, group?: string): string => {
        const k = (group ?? kind).toLowerCase()
        if (k === 'session' || k === '5h') return 'Claude 5h'
        if (k === 'weekly' || k === '7d' || k === 'weekly_all') return 'Claude 7d'
        if (k === 'weekly_opus' || k === '7d_opus') return 'Claude 7d Opus'
        return `Claude ${group ?? kind}`
      }

      const claudeWindowRank = (kind: string, group?: string): number => {
        const k = (group ?? kind).toLowerCase()
        if (k === 'session' || k === '5h') return 0
        if (k === 'weekly' || k === '7d' || k === 'weekly_all') return 1
        if (k === 'weekly_opus' || k === '7d_opus') return 2
        return 3
      }

      const sortedLimits = [...limits].sort(
        (a, b) => claudeWindowRank(a.kind, a.group) - claudeWindowRank(b.kind, b.group)
      )

      return {
        windows: sortedLimits.map((l) => ({
          id: l.kind,
          label: formatClaudeLabel(l.kind, l.group),
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
  plan(req: SpawnRequest): SpawnPlan {
    const env = envFor(req.isolationRoot)
    const resolved = which(info.command)
    if (!resolved) throw new Error(`'${info.command}' is not on PATH`)
    const { command, prefixArgs } = launchable(resolved)

    if (req.argv) return { command, args: [...prefixArgs, ...req.argv], env }

    // ⛔ `--resume <id>` **reuses the original session id** rather than minting a new one - the
    // CLI says so itself, and `--fork-session` is the flag that opts out. That is what makes resuming
    // safe here: the transcript path stays `<id>.jsonl`, orphan reaping can still prove the pid is
    // ours from its command line, and the row this session already had is the row it comes back to.
    // ⚠️ Passing `--session-id` alongside it would be asking for two different ids at once.
    //
    // ⚠️ Resuming re-reads the transcript from the top, so every turn already recorded arrives
    // again. That is absorbed by the unique index on (session_id, request_id) in `recordTurn`, which
    // exists because this CLI writes duplicate usage records anyway - see cost-model.md §6.
    const args = req.resumeFrom
      ? ['--resume', req.resumeFrom, '--permission-mode', req.permissionMode ?? info.policy.defaultPermissionMode]
      : [
          // Minted before the process starts, so the transcript path is known before there is a file.
          '--session-id',
          req.sessionId,
          '--permission-mode',
          req.permissionMode ?? info.policy.defaultPermissionMode
        ]
    if (req.model) args.push('--model', req.model)
    // ⚠️ Only ever set when this adapter declares `selectableEffort` — the scheduler drops it
    // otherwise (adapters/types.ts), so this line is inert until the capability is promoted on
    // measured evidence rather than on the flag existing in `--help`.
    if (req.effort) args.push('--effort', req.effort)
    for (const dir of attachmentDirs(req.attachments ?? [])) args.push('--add-dir', dir)
    if (req.mcpConfig) {
      args.push('--mcp-config', req.mcpConfig)
      if (req.transport === 'stream') {
        // ⚠️ Non-interactive only. A PTY session has no such channel, which is why §9.2 has two
        // transports rather than one and a screen parser.
        args.push('--permission-prompt-tool', APPROVE_TOOL)
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
