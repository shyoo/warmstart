import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AdapterDetection, AdapterInfo, QuotaSnapshot, QuotaWindow } from '@shared/protocol.js'
import type {
  AgentAdapter,
  IdentityProbe,
  PermissionRules,
  SpawnPlan,
  SpawnRequest,
  WrittenPermissions
} from './types.js'
import { asRecord, num, type StreamEvent, type StreamUsage } from '../stream.js'
import { attachmentDirs } from '../attachments.js'
import { log } from '../log.js'
import { launchArgs, launchable, spawnEnv, which } from '../which.js'

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
 *  - ⛔ **`-p` takes the prompt as its value.** `-p` / `--print` / `--prompt` are one *string* flag,
 *    not a boolean - `agy -p` alone answers *flag needs an argument: -p*. This adapter passed a bare
 *    `-p` before `--input-format` and so failed **every** dispatch it ever made, in zero seconds,
 *    with exit 2: measured 2026-08-27 on the operator's install, one work session, `in=0 out=0`,
 *    and a run note blaming the agent for ending "without reporting completion" on an account that
 *    was signed in throughout. Print mode is switched on with `--print=` and the prompt arrives as
 *    NDJSON on stdin, which is what `--input-format stream-json` is for.
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
 * writes `conversations/<uuid>.db`. ⚠️ Measuring the stream then corrected the conclusion: usage
 * records *are* emitted there, so `metering: 'stream'` and the work is metered after all — just only
 * while agentyard is attached to the process, rather than reconstructable from a file afterwards.
 */

const run = promisify(execFile)

/** Measured: the root ~/.gemini directory, home of google_accounts.json, oauth_creds.json, etc. */
export function geminiHome(): string {
  return join(homedir(), '.gemini')
}

/** Measured: the CLI's own home, distinct from `~/.gemini/antigravity{,-ide}` which the IDE uses. */
function cliHome(): string {
  return join(geminiHome(), 'antigravity-cli')
}

/**
 * Reads signed-in Google account and subscription tier from ~/.gemini configuration files.
 *
 * `google_accounts.json` stores `{ "active": "user@example.com", "old": [...] }`.
 * `oauth_creds.json` stores `{ "id_token": "<jwt>", ... }` containing the account email.
 */
export function readAntigravityIdentity(geminiDir = geminiHome()): {
  loggedIn: boolean | null
  account?: string
  subscriptionType?: string
} {
  let account: string | undefined
  let loggedIn: boolean | null = null

  // 1. Check google_accounts.json
  const accountsFile = join(geminiDir, 'google_accounts.json')
  if (existsSync(accountsFile)) {
    try {
      const data = JSON.parse(readFileSync(accountsFile, 'utf8')) as { active?: string }
      if (typeof data.active === 'string' && data.active.includes('@')) {
        account = data.active.trim()
        loggedIn = true
      }
    } catch {
      // Ignore unparseable accounts file
    }
  }

  // 2. Fall back to oauth_creds.json id_token JWT payload
  if (!account) {
    const oauthFile = join(geminiDir, 'oauth_creds.json')
    if (existsSync(oauthFile)) {
      try {
        const data = JSON.parse(readFileSync(oauthFile, 'utf8')) as { id_token?: string }
        if (typeof data.id_token === 'string') {
          const parts = data.id_token.split('.')
          if (parts.length >= 2) {
            const payload = JSON.parse(Buffer.from(parts[1]!, 'base64').toString('utf8')) as {
              email?: string
            }
            if (typeof payload.email === 'string' && payload.email.includes('@')) {
              account = payload.email.trim()
              loggedIn = true
            }
          }
        }
      } catch {
        // Ignore unparseable creds file
      }
    }
  }

  let subscriptionType: string | undefined
  if (account) {
    // Antigravity CLI on individual consumer accounts runs on Google AI Pro/Ultra.
    subscriptionType = 'Google AI Pro'
  } else {
    const cHome = join(geminiDir, 'antigravity-cli')
    if (existsSync(join(cHome, 'settings.json')) || existsSync(join(geminiDir, 'settings.json'))) {
      loggedIn = false
    }
  }

  return {
    loggedIn,
    ...(account ? { account } : {}),
    ...(subscriptionType ? { subscriptionType } : {})
  }
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
    /**
     * ⛔ `none`, and this is a measurement rather than caution. Sent the same base64 image block
     * Claude Code accepts, agy 1.1.22 answered `"status":"ERROR","num_turns":0,"error":"stream
     * input content block type \"image\" is not supported (only \"text\")"` — 2026-08-31. It does
     * not drop the image, it **fails the whole turn**, and a run that died that way would read as
     * this agent having failed the task.
     *
     * ⚠️ It reads a PNG off disk perfectly well with its own `view_file` tool, measured the same
     * day on the same image. That is why the file path travels in the prompt text regardless.
     */
    imageInput: 'none',
    // `agy mcp add|remove|list|enable|disable`. ⚠️ Registered globally rather than per session, so
    // agentyard does not use it: one shared registration cannot carry a per-session identity, and
    // MULTI_AGENT_CONTROLLER_SESSION_ID is how the MCP server knows who it is speaking for.
    mcp: false,
    // ⛔ Nothing to select: this vendor encodes effort in the model id itself, which is why its cost
    // model lists `gemini-3.1-pro-high` and `gemini-3.1-pro-low` as two models with one level each.
    // Choosing the model *is* choosing the effort here, and a second control would double-count it.
    //
    // ⭐ **`--effort` exists on agy 1.1.22 and this stays false anyway** — measured 2026-08-29, and
    // the CLI is the one refusing, which is stronger evidence than the argument above:
    //   `--model gemini-3.1-pro-high --effort low` → "conflicts with --effort=low"
    //   `--model claude-sonnet-4-6   --effort low` → "--effort is not supported for model"
    //   `--model gpt-oss-120b-medium --effort low` → "conflicts with --effort=low"
    //   `--model gemini-3.1-pro      --effort low` → runs
    // So the vendor has two spellings for one choice: a *family* plus `--effort`, or a pre-combined
    // id. `agy models` reports the combined form and this cost model prices it, so that is the one
    // spelling agentyard uses. ⛔ Declaring `selectableEffort` true would offer a second control for
    // a choice already made, and every operator who touched both would get a hard dispatch failure.
    selectableEffort: false,
    // ⭐ It has one after all, as of 2026-08-27. `/usage` typed into the TUI is a client-side
    // slash command - free, no turn - and the panel it draws is the only place the number exists.
    // See parseUsageScreen for why reading a screen is defensible here and nowhere else.
    quotaProbe: 'cli',
    // stdin stays open and takes prompt after prompt; that is what the stream transport is for.
    streamPrompts: 'conversation',
    mintsSessionId: false,
    // ⚠️ Not from a transcript: agy writes conversations as SQLite, which the line-oriented tailer
    // cannot read. But usage IS in the stream - measured 2026-08-25 - so the work is metered after
    // all, just only while agentyard is attached to the process.
    metering: 'stream',
    maxAccounts: 1
  },
  policy: {
    // ⛔ Headless print mode has no TUI prompt: `accept-edits` auto-denies commands (git, tests, etc.)
    // and causes immediate CANCELED turns. Work runs in an isolated pooled worktree governed by mandate.
    defaultPermissionMode: 'dangerously-skip-permissions',
    interruptSequence: '\x1b',
    costModelId: 'google.antigravity.2026-08',
    // ⛔ Falls out of manualCompact: false. Preemption writes a handoff instead of compacting.
    wrapUpProtocol: 'handoff',
    needsExplicitBudget: true,
    defaultModels: {
      gemini: 'gemini-3.7-flash-medium',
      claude: 'claude-sonnet-4-6'
    }
  },
  // ⭐ Measured 2026-08-27: `/usage` in the TUI costs nothing and renders both groups' windows.
  // `answer: 'screen'` because the panel is written to no file - see parseUsageScreen.
  // ⚠️ Startup duration measured 2026-09-03 at 1.5s–2.5s. The previous 20s readyMs caused every
  // probe to unconditionally wait 20.5s (and 50s on missed panels) before completing. readyMs is now
  // 5s, ensuring the CLI is fully ready for input before driving `/usage`, while settleMs is 15s to
  // bound retry attempts if an initial keystroke is swallowed.
  // 100 rows, not the default 30. Measured 2026-08-27: at 30 the panel scrolled and the last
  // group's five-hour window was below the fold, so the probe read three windows of four.
  // The panel's own footer said "(1-27 of 30 lines)".
  usageRefresh: {
    command: '/usage',
    readyMs: 5_000,
    settleMs: 15_000,
    answer: 'screen',
    cols: 120,
    rows: 100
  },
  // ⛔ Required by anything that drives a TUI, and this one earned it the hard way. Measured
  // 2026-08-27 while building the probe above: the first attempt's `/usage` was swallowed by
  // *"Do you trust the contents of this project?"* and its Enter selected "Yes, I trust this
  // folder". Same failure as Claude Code's, on a second CLI, found the same way.
  //
  // ⚠️ The two halves come apart here in a way they do not on Claude Code. `onboardingComplete`
  // is **global** to this machine - one account, one keyring, one config - so it is answered once
  // and stays answered. Folder trust is asked **per directory**, so a fully onboarded account still
  // meets the dialog in a folder it has not seen. `trustDirectory` pre-answers it for the scratch
  // directory this app owns, and never for a project, a worktree or anybody's home.
  firstRun: {
    argv: [],
    completedKey: 'onboardingComplete',
    reason:
      'Antigravity CLI has not finished its first-run questions on this machine. They only appear ' +
      'in a real terminal and only a person can answer them, and until they are answered the CLI ' +
      'swallows anything typed at it - which is why a usage probe reports nothing while scheduled ' +
      'work on the same account carries on fine. ⚠️ Separately, it asks whether it trusts each ' +
      'folder it opens: this app pre-answers that for its own scratch directory only.'
  },
  // ⛔ Measured on agy 1.1.20 (2026-08-26): `agy --help` lists agent, agents, changelog, help,
  // install, mcp, mic-serve, models, plugin, plugins and update. There is **no login and no auth**
  // subcommand, and `agy login` fails with *unexpected argument "login"* - which is exactly what
  // commissioning did until this field existed. The credential is in the OS keyring, put there by
  // the Antigravity app, and this app never touches a keyring.
  login: {
    kind: 'external',
    reason:
      'Antigravity has no CLI login. Sign in once with the Antigravity app on this machine; the ' +
      'credential goes to the OS keyring and `agy` reads it from there. That is also why one ' +
      'machine holds one Antigravity account. Verify with `agy models` - it lists models when ' +
      'signed in and costs nothing.'
  },
  verification: {
    level: 'measured',
    asOf: '2026-08-27',
    note:
      'agy 1.1.21 on Windows. Flag surface, subcommands, model list, settings path and conversation ' +
      'storage all read from the running CLI. ⛔ 2026-08-27 corrected the print flag: `-p` takes the ' +
      'prompt as its value, so the bare `-p` this adapter passed failed every dispatch with exit 2. ' +
      'The corrected argv was run against the signed-in account and returns a valid `init` record ' +
      'with no turn spent. ⚠️ Still unmeasured, because each needs a real turn: the stream-json ' +
      'record shapes beyond `init`, whether print mode expands slash commands (HANDOFF R9), and ' +
      'anything about quota.'
  }
}

function envFor(): Record<string, string> {
  // ⛔ See `spawnEnv`. ⚠️ This adapter has no isolation root to set - Antigravity keeps
  // its credential in the OS keyring - which makes it the one that inherits the most and can correct
  // the least, so dropping the host session's namespace matters here rather than less.
  const env = spawnEnv()
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

/**
 * Antigravity's stream dialect.
 *
 * ⛔ The envelope key is **`event`**, not `type`. Measured 2026-08-25 - a parser keyed on `type`
 * reads nothing here and says nothing about it, which is exactly the failure this function exists to
 * prevent.
 *
 * Shapes, verbatim from a real run:
 *
 * ```
 * {"event":"init","conversation_id":"...","init":{"cwd":"...","tools":[...],"permission_mode":"..."}}
 * {"event":"step_update","step_update":{"step_type":"agent_response","state":"DONE","usage":{...}}}
 * {"event":"result","result":{"status":"SUCCESS","response":"...","usage":{...},"num_turns":1}}
 * ```
 *
 * ⚠️ **Usage is in the stream, and it is the only place agentyard can get it** - `agy` writes its
 * conversations as SQLite, which the transcript tailer cannot read. So this adapter is metered from
 * here or not at all.
 */
function formatToolActivity(step: Record<string, unknown>): string | null {
  const toolName = typeof step.tool_name === 'string' ? step.tool_name : ''
  const toolInfo = asRecord(step.tool_info)
  const params =
    asRecord(toolInfo?.parameters) ??
    asRecord(step.parameters) ??
    asRecord(step.tool_input) ??
    asRecord(step.args)

  let summary: string | null = null

  if (params) {
    if (typeof params.toolAction === 'string' && params.toolAction.trim()) {
      const actionSummary =
        typeof params.toolSummary === 'string' && params.toolSummary.trim()
          ? ` — ${params.toolSummary.trim()}`
          : ''
      summary = `[Tool: ${params.toolAction.trim()}${actionSummary}]`
    } else if (typeof params.CommandLine === 'string' && params.CommandLine.trim()) {
      summary = `[run: ${params.CommandLine.trim()}]`
    } else if (typeof params.command === 'string' && params.command.trim()) {
      summary = `[run: ${params.command.trim()}]`
    } else if (typeof params.TargetFile === 'string' && params.TargetFile.trim()) {
      summary = `[${toolName || 'file'}: ${params.TargetFile.trim()}]`
    } else if (typeof params.AbsolutePath === 'string' && params.AbsolutePath.trim()) {
      summary = `[${toolName || 'file'}: ${params.AbsolutePath.trim()}]`
    } else if (typeof params.path === 'string' && params.path.trim()) {
      summary = `[${toolName || 'file'}: ${params.path.trim()}]`
    } else if (typeof params.Query === 'string' && params.Query.trim()) {
      summary = `[search: "${params.Query.trim()}"]`
    } else if (typeof params.Pattern === 'string' && params.Pattern.trim()) {
      summary = `[find: "${params.Pattern.trim()}"]`
    } else if (typeof params.DirectoryPath === 'string' && params.DirectoryPath.trim()) {
      summary = `[list: ${params.DirectoryPath.trim()}]`
    } else if (typeof params.Url === 'string' && params.Url.trim()) {
      summary = `[fetch: ${params.Url.trim()}]`
    } else if (typeof params.Description === 'string' && params.Description.trim()) {
      summary = `[${toolName || 'tool'}: ${params.Description.trim()}]`
    }
  }

  if (!summary && toolName) {
    summary = `[Tool: ${toolName}]`
  }

  return summary ? `${summary}\n` : null
}

function decodeStream(record: Record<string, unknown>): StreamEvent | StreamEvent[] | null {
  const event = typeof record.event === 'string' ? record.event : ''

  if (event === 'init') {
    const init = asRecord(record.init)
    return {
      kind: 'init',
      sessionId: typeof record.conversation_id === 'string' ? record.conversation_id : null,
      model: null,
      permissionMode: typeof init?.permission_mode === 'string' ? init.permission_mode : null
    }
  }

  if (event === 'step_update') {
    const step = asRecord(record.step_update)
    const events: StreamEvent[] = []
    let text = typeof step?.text_delta === 'string' ? step.text_delta : ''
    if (!text && typeof step?.text === 'string') text = step.text
    if (!text && typeof step?.thought_delta === 'string') text = step.thought_delta
    if (!text && typeof step?.thought === 'string') text = step.thought
    if (!text && step && step.step_type === 'tool' && step.state === 'ACTIVE') {
      text = formatToolActivity(step) ?? ''
    }
    if (text) events.push({ kind: 'assistant_text', text })
    // ⭐ One record per **model call**, and the only place the context window level is visible:
    // `input_tokens` here is the prompt this call sent. The terminal `result` sums them, so it
    // answers neither "what did the turn cost" nor "how full is the window" - see `streamusage.ts`.
    const usage = asRecord(step?.usage)
    if (usage) events.push({ kind: 'usage', usage: readUsage(usage), final: false })
    if (events.length > 0) return events.length === 1 ? events[0]! : events
    return { kind: 'other', type: 'step_update' }
  }

  if (event === 'result') {
    const result = asRecord(record.result)
    const status =
      typeof result?.status === 'string'
        ? result.status
        : typeof record.status === 'string'
          ? record.status
          : 'UNKNOWN'

    let text: string | null = null
    if (typeof result?.response === 'string' && result.response.trim()) {
      text = result.response
    } else if (typeof result?.text === 'string' && result.text.trim()) {
      text = result.text
    } else if (typeof result?.summary === 'string' && result.summary.trim()) {
      text = result.summary
    } else if (typeof result?.content === 'string' && result.content.trim()) {
      text = result.content
    } else if (typeof result?.output === 'string' && result.output.trim()) {
      text = result.output
    } else if (typeof result?.error === 'string' && result.error.trim()) {
      // ⛔ `agy` puts its explanation here when a terminal result has `status: "ERROR"`.
      // Dropping it leaves `onStreamResult` only the status, so a failed rebase, timeout or
      // argument error becomes "said nothing about it" even though the CLI did explain itself.
      text = result.error
    } else if (typeof record.response === 'string' && record.response.trim()) {
      text = record.response
    } else if (typeof record.result === 'string' && record.result.trim()) {
      text = record.result
    } else if (typeof record.error === 'string' && record.error.trim()) {
      text = record.error
    }

    const finished: StreamEvent = {
      kind: 'result',
      text,
      // ⛔ Not reported. Null rather than 0, which would read as "this turn was free".
      costUsd: null,
      isError: status !== 'SUCCESS',
      terminalReason: status
    }
    const usage = asRecord(result?.usage) ?? asRecord(record.usage)
    // ⚠️ Two events from one record: the terminal record carries usage as well as text, and the
    // stream is the only place agentyard can bill this adapter from - `agy` writes its conversations
    // as SQLite, which the transcript tailer cannot read.
    //
    // ⛔ **This usage is cumulative over the whole conversation, not the turn** - measured
    // 2026-09-03 on agy 1.1.25, three prompts down one conversation reporting 44,785 → 60,384 →
    // 76,209 input against per-call sums of 44,785 → 15,599 → 15,825. It is emitted verbatim
    // because a decoder's job is to report what the CLI said; `streamusage.ts` is where the run's
    // own step records are summed into the turn, and where the arithmetic is recorded.
    return usage ? [{ kind: 'usage', usage: readUsage(usage), final: true }, finished] : finished
  }

  return event ? { kind: 'other', type: event } : null
}

/**
 * Read the `/usage` panel.
 *
 * ⛔ **The one place in this codebase that turns rendered terminal text into state**, and it is
 * allowed to produce a quota reading and nothing else. The invariant it bends says usage, context
 * size, idle time and effort come from the transcript because the transcript is *exact* — and that
 * reasoning holds wherever there is a transcript to read. Here there is not: measured 2026-08-27 by
 * driving `/usage` in a real PTY and diffing every file under `~/.gemini` before and after, the
 * only things that moved were `cli.log` (which records `doRefreshQuota: starting reload` and no
 * numbers) and `history.jsonl` (which records the command text). The CLI holds the answer in
 * `quota_manager.go` in memory. So the choice is not screen-versus-file; it is screen-versus-nothing.
 *
 * What the panel looks like, verbatim from that run:
 *
 * ```
 * GEMINI MODELS
 *   Models within this group: Gemini Flash, Gemini Pro
 *   Weekly Limit Remaining
 *     [███████████████░░░] 94.52%
 *     95% remaining · Refreshes in 138h 0m
 *   Five Hour Limit Remaining
 *     [██████████░░░░░░░░] 67.20%
 *     67% remaining · Refreshes in 1h 51m
 * CLAUDE AND GPT MODELS
 *   ...
 *     [██████████████████] 100.00%
 *     Quota available
 * ```
 *
 * ⛔ **These are REMAINING percentages and `QuotaWindow.percent` is utilisation** — what has been
 * *used*. They are inverted here. Getting that backwards would report a nearly exhausted account as
 * nearly empty, which is the one direction of error the quota gate cannot survive: `QUOTA_HIGH_WATER`
 * would never trip.
 *
 * ⚠️ The bar's own figure is used (94.52%), not the rounded sentence beneath it (95%), because the
 * sentence rounds *up* on a remaining figure and so rounds *down* the utilisation.
 *
 * ⚠️ Returns null rather than a partial answer. Screen text is a rendering and fails like one — it
 * reflows, it truncates at the viewport, and this panel is scrollable, so a half-read set of windows
 * is a normal outcome and must never be stored as a reading.
 */
export interface ContextSnapshot {
  model: string | null
  usedTokens: number
  windowTokens: number
  percent: number
  breakdown?: {
    systemPrompt?: number
    systemTools?: number
    userMessages?: number
    agentResponses?: number
    toolCalls?: number
    skills?: number
    subagents?: number
    filesAndDirs?: number
  }
}

/** Parses token count representations e.g. "28.9k" -> 28900, "1.0M" -> 1000000, "1,048,576" -> 1048576 */
export function parseTokenCount(str: string): number {
  const cleaned = str.trim().replace(/,/g, '')
  const match = /^([\d.]+)\s*([kmgt])?$/i.exec(cleaned)
  if (!match) return 0
  const val = Number.parseFloat(match[1] ?? '0')
  const unit = (match[2] ?? '').toLowerCase()
  if (unit === 'k') return Math.round(val * 1_000)
  if (unit === 'm') return Math.round(val * 1_000_000)
  if (unit === 'g') return Math.round(val * 1_000_000_000)
  return Math.round(val)
}

/**
 * Parses the `/context` command modal output from Antigravity CLI.
 *
 * ⚠️ **The command is real and it cannot answer for a work session.** agy 1.1.25 carries `/context`
 * (*"Visualize current context usage"*, drawing the `└ Context Usage` panel below), confirmed
 * 2026-09-03. But a work session on this adapter is `--print` with no TUI to type into, and the one
 * place a slash command *can* be typed is the throwaway PTY the quota probe opens - whose context is
 * its own, near-empty one. So this parser is reached only if a panel already on screen contains the
 * block; the session's real window level comes from its per-call stream usage (`streamusage.ts`).
 *
 * Examples:
 * ```
 * └ Context Usage
 * ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □     Gemini 3.7 Flash (High) · 28.9k/1.0M tokens
 * □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □      (2.8%)
 * ```
 */
export function parseContextScreen(screen: string): ContextSnapshot | null {
  if (!/Context\s+(?:Usage|Breakdown)/i.test(screen)) return null

  let usedTokens = 0
  let windowTokens = 1_000_000
  let percent: number | null = null
  let model: string | null = null
  const breakdown: NonNullable<ContextSnapshot['breakdown']> = {}

  const lines = screen.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''

    // Match header: e.g. "Gemini 3.7 Flash (High) · 28.9k/1.0M tokens"
    const headerMatch = /([A-Za-z0-9. ()-]+?)\s*·\s*([0-9.,]+[kmgt]?)\s*\/\s*([0-9.,]+[kmgt]?)\s*tokens/i.exec(line)
    if (headerMatch?.[2] && headerMatch?.[3]) {
      model = headerMatch[1]?.trim() || null
      usedTokens = parseTokenCount(headerMatch[2])
      windowTokens = parseTokenCount(headerMatch[3])
    }

    // Match older/alternative format: "0 / 1,048,576 tokens used"
    const usedMatch = /([0-9.,]+[kmgt]?)\s*\/\s*([0-9.,]+[kmgt]?)\s*tokens\s+used/i.exec(line)
    if (usedMatch?.[1] && usedMatch?.[2]) {
      usedTokens = parseTokenCount(usedMatch[1])
      windowTokens = parseTokenCount(usedMatch[2])
    }

    // Match percentage in parentheses e.g. "(2.8%)" or bar percentage "0.00%"
    if (
      percent === null &&
      !/Free space|User messages|Agent responses|System prompt|System tools|Skills|Subagents|Tool definitions|Active files/i.test(
        line
      )
    ) {
      const pctMatch = /(?:\(([0-9.]+)%\)|\]\s*([0-9.]+)\s*%)/.exec(line)
      if (pctMatch) {
        const p = Number.parseFloat(pctMatch[1] ?? pctMatch[2] ?? '')
        if (Number.isFinite(p)) percent = p
      }
    }

    // Match breakdown items
    const systemPromptMatch = /System\s+prompt:\s*([0-9.,]+[kmgt]?)/i.exec(line)
    if (systemPromptMatch?.[1]) breakdown.systemPrompt = parseTokenCount(systemPromptMatch[1])

    const systemToolsMatch = /(?:System\s+tools|Tool\s+definitions)[:\s]+([0-9.,]+[kmgt]?)/i.exec(line)
    if (systemToolsMatch?.[1]) breakdown.systemTools = parseTokenCount(systemToolsMatch[1])

    const userMsgMatch = /User\s+messages[:\s]+([0-9.,]+[kmgt]?)/i.exec(line)
    if (userMsgMatch?.[1]) breakdown.userMessages = parseTokenCount(userMsgMatch[1])

    const agentRespMatch = /Agent\s+responses[:\s]+([0-9.,]+[kmgt]?)/i.exec(line)
    if (agentRespMatch?.[1]) breakdown.agentResponses = parseTokenCount(agentRespMatch[1])

    const toolCallsMatch = /Tool\s+calls[:\s]+([0-9.,]+[kmgt]?)/i.exec(line)
    if (toolCallsMatch?.[1]) breakdown.toolCalls = parseTokenCount(toolCallsMatch[1])

    const skillsMatch = /Skills(?: & Plugins)?[:\s]+([0-9.,]+[kmgt]?)/i.exec(line)
    if (skillsMatch?.[1]) breakdown.skills = parseTokenCount(skillsMatch[1])

    const subagentsMatch = /Subagents[:\s]+([0-9.,]+[kmgt]?)/i.exec(line)
    if (subagentsMatch?.[1]) breakdown.subagents = parseTokenCount(subagentsMatch[1])

    const filesMatch = /Active\s+files\s*&\s*directories[:\s]+([0-9.,]+[kmgt]?)/i.exec(line)
    if (filesMatch?.[1]) breakdown.filesAndDirs = parseTokenCount(filesMatch[1])
  }

  if (percent === null && windowTokens > 0) {
    percent = Math.round((usedTokens / windowTokens) * 10000) / 100
  }

  return {
    model,
    usedTokens,
    windowTokens,
    percent: percent ?? 0,
    breakdown: Object.keys(breakdown).length > 0 ? breakdown : undefined
  }
}

export function parseUsageScreen(screen: string, now = Date.now()): QuotaWindow[] | null {
  const hasUsage = /Models\s*&\s*Quota/.test(screen)
  const hasContext = /Context\s+(?:Usage|Breakdown)/i.test(screen)

  if (!hasUsage && !hasContext) return null

  // ⛔ Keyed by window id so repaints across backscroll do not duplicate windows.
  const windowsById = new Map<string, QuotaWindow>()
  const groupOrder = new Map<string, number>()

  if (hasUsage) {
    let group: { id: string; label: string } | null = null
    let kind: 'weekly' | '5h' | null = null

    const lines = screen.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ''

      const heading = /^\s*([A-Z][A-Z0-9 &]*?)\s+MODELS\s*$/.exec(line)
      if (heading?.[1]) {
        const name = heading[1].trim()
        const groupId = name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
        group = { id: groupId, label: formatGroupLabel(name) }
        if (!groupOrder.has(groupId)) {
          groupOrder.set(groupId, groupOrder.size)
        }
        kind = null
        continue
      }

      if (/Weekly Limit Remaining/.test(line)) kind = 'weekly'
      else if (/Five Hour Limit Remaining/.test(line)) kind = '5h'

      // ⭐ Measured 2026-09-03 on agy 1.1.25: once a model group's weekly pool is exhausted,
      // the CLI removes its five-hour bar and prints `Disabled: You have hit your weekly limit,
      // the 5-hour limit does not currently apply.` instead. That is a complete panel and a hard
      // gate, not a clipped reading. Encode the inapplicable shorter window as exhausted until the
      // weekly reset so consumers that only understand the five-hour gate cannot dispatch into it.
      if (
        kind === '5h' &&
        group &&
        /Disabled:\s*You have hit your weekly limit,\s*the 5-hour limit does not currently apply/i.test(
          line
        )
      ) {
        const weekly = windowsById.get(`weekly:${group.id}`)
        const id = `5h:${group.id}`
        windowsById.set(id, {
          id,
          label: `${group.label} 5h`,
          percent: 100,
          resetsAt: weekly?.resetsAt ?? null,
          group: group.id
        })
        kind = null
        continue
      }

      // The bar line carries the precise figure. A complete `Quota available` is the CLI's way of
      // writing 100% remaining with no reset worth stating. ⛔ A clipped `Quota ava…` is not that
      // value: t163 (2026-09-03) rendered both Gemini rows that way and the permissive old match
      // recorded a false 0% used, which then priced the next real reading as an enormous spend.
      // A screen rendering must be complete enough to prove its number or it is no reading at all.
      const bar = /\]\s*(?:([\d.]+)\s*%|(Quota\s+available))\s*$/i.exec(line)
      if (!bar || !group || !kind) continue

      const remaining = bar[1] !== undefined ? Number.parseFloat(bar[1]) : 100
      if (!Number.isFinite(remaining) || remaining < 0 || remaining > 100) continue

      const id = `${kind}:${group.id}`
      windowsById.set(id, {
        id,
        label: `${group.label} ${kind === 'weekly' ? '7d' : '5h'}`,
        percent: Math.round((100 - remaining) * 100) / 100,
        resetsAt: readReset(lines[i + 1] ?? '', now),
        // ⛔ Beside the id, because the id does not survive. The busiest five-hour window is aliased
        // to the bare `5h` below for consumers that cannot know a model, which overwrites `5h:gemini`
        // — and then a Gemini-pinned task could no longer find its own pool by id.
        group: group.id
      })
      kind = null
    }
  }

  if (hasContext) {
    const ctx = parseContextScreen(screen)
    if (ctx) {
      const windowLabel = ctx.windowTokens >= 1_000_000
        ? `${(ctx.windowTokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
        : `${Math.round(ctx.windowTokens / 1_000)}k`
      windowsById.set('context', {
        id: 'context',
        label: `Context · ${windowLabel}`,
        percent: Math.round(ctx.percent * 100) / 100,
        resetsAt: null
      })
    }
  }

  const windows = Array.from(windowsById.values()).sort((a, b) => {
    if (a.id === 'context') return 1
    if (b.id === 'context') return -1
    const groupA = a.group ?? a.id.slice(a.id.indexOf(':') + 1)
    const groupB = b.group ?? b.id.slice(b.id.indexOf(':') + 1)
    const orderA = groupOrder.get(groupA) ?? 0
    const orderB = groupOrder.get(groupB) ?? 0
    if (orderA !== orderB) return orderA - orderB
    const rankA = a.id.startsWith('5h') ? 0 : 1
    const rankB = b.id.startsWith('5h') ? 0 : 1
    return rankA - rankB
  })
  if (windows.length === 0) return null

  // ⛔ A group must contribute BOTH of its windows or the read is not trustworthy. This panel is
  // taller than a default terminal and scrolls - its own footer says "(1-27 of 30 lines)" - so a
  // viewport that cuts it mid-group is the normal failure, not an exotic one.
  if (hasUsage) {
    const perGroup = new Map<string, number>()
    for (const w of windows) {
      if (w.id === 'context') continue
      const group = w.id.slice(w.id.indexOf(':') + 1)
      perGroup.set(group, (perGroup.get(group) ?? 0) + 1)
    }
    // A heading is evidence that the group was on screen. It must contribute both rows, even when
    // neither malformed row made it through the bar parser; otherwise two clipped `Quota ava…`
    // strings look exactly like a missing group and the remaining old rows get stored as fresh.
    for (const group of groupOrder.keys()) {
      const count = perGroup.get(group) ?? 0
      if (count < 2) {
        return null
      }
    }

    // ⛔ Downstream asks for the five-hour window by the id `session` or `5h` - the reset countdown
    // and the reserve's sample query both do, and neither has a model in hand to choose a pool with.
    // Antigravity has **two**, because Gemini and Claude/GPT are metered separately, so the busiest
    // is aliased to the bare id and those two consumers get the pessimistic answer, which is the
    // right one when you cannot know.
    //
    // ⭐ **The dispatch gate no longer settles for that.** It resolves the task's model first
    // (`resolveModelChoice`, 2026-08-29) and asks for that model's pool by `group`, so a task pinned
    // to Gemini is no longer held out because the Claude/GPT pool is the emptier of the two. The
    // sentence that used to stand here - "nothing in a quota snapshot knows which group the next run
    // will use" - was true until the model became knowable before the spawn.
    const fiveHour = windows.filter((w) => w.id.startsWith('5h:'))
    if (fiveHour.length > 0) {
      const busiest = fiveHour.reduce((a, b) => (b.percent > a.percent ? b : a))
      busiest.id = '5h'
    }
  }

  return windows
}

/**
 * Parses Account and Subscription Tier / Plan from /usage screen text if present.
 *
 * Examples:
 * `└ Models & Quota  Account: user@example.com (Google AI Pro)`
 * `└ Models & Quota  Account: user@example.com`
 */
export function parseUsageScreenIdentity(screen: string): {
  account?: string
  subscriptionType?: string
} | null {
  const accountMatch = /Account:\s*([^\s\n()]+)(?:\s*(?:\(([^)]+)\)|·\s*([^\n]+)))?/i.exec(screen)
  const planMatch = /(?:Plan|Subscription|Tier):\s*([^\n]+)/i.exec(screen)

  const account = accountMatch?.[1]?.trim()
  let subscriptionType = accountMatch?.[2]?.trim() || accountMatch?.[3]?.trim() || planMatch?.[1]?.trim()

  if (!subscriptionType && /CLAUDE AND GPT MODELS/i.test(screen)) {
    subscriptionType = 'Google AI Pro'
  }

  if (!account && !subscriptionType) return null
  return {
    ...(account ? { account } : {}),
    ...(subscriptionType ? { subscriptionType } : {})
  }
}

/** `Refreshes in 138h 0m` → an absolute instant. Anything else, including `Quota available`, is null. */
function readReset(line: string, now: number): number | null {
  const found = /Refreshes in\s+(?:(\d+)h)?\s*(?:(\d+)m)?/.exec(line)
  if (!found || (!found[1] && !found[2])) return null
  const hours = Number.parseInt(found[1] ?? '0', 10)
  const minutes = Number.parseInt(found[2] ?? '0', 10)
  return now + (hours * 60 + minutes) * 60_000
}

function formatGroupLabel(heading: string): string {
  const norm = heading.trim().toUpperCase()
  if (norm === 'CLAUDE AND GPT' || norm === 'CLAUDE & GPT' || norm === 'CLAUDE/GPT') {
    return 'Claude/GPT'
  }
  return titleCase(heading)
}

function titleCase(heading: string): string {
  return heading
    .toLowerCase()
    .split(' ')
    .map((w) => (w === 'and' ? w : w === 'gpt' ? 'GPT' : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ')
}

/** `{input_tokens, output_tokens, thinking_tokens, cache_read_tokens, total_tokens}` */
function readUsage(usage: Record<string, unknown>): StreamUsage {
  return {
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    thinking: num(usage.thinking_tokens),
    cacheRead: num(usage.cache_read_tokens),
    // ⚠️ Not reported by this CLI. Zero here means "not measured", and because the provider's cache
    // is `unpriced` anyway (D24) nothing downstream multiplies it by a write cost.
    cacheWrite: 0
  }
}

export const antigravityCli: AgentAdapter = {
  info,
  decodeStream,
  encodeStreamPrompt: (text: string) =>
    JSON.stringify({
      event: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] }
    }),

  // ⚠️ Not just PATH: the installer leaves `agy` somewhere it does not add until `agy install`
  // runs, so a perfectly usable install would otherwise be invisible to the scheduler.
  isInstalled(): boolean {
    return resolveCommand() !== null
  },

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
   * Read signed-in identity from ~/.gemini configuration files.
   *
   * ⛔ It must never spend a turn to find out. `agy -p "who am i"` would answer, and would bill.
   */
  async probeIdentity(): Promise<IdentityProbe> {
    const home = cliHome()
    const gHome = geminiHome()
    if (!existsSync(join(home, 'settings.json')) && !existsSync(join(gHome, 'google_accounts.json'))) {
      return {
        loggedIn: null,
        raw:
          `no Antigravity CLI settings at ${home}. Either it has never been run, or it is signed in ` +
          'and keeps nothing here - there is no way to tell the difference without spending a turn.'
      }
    }

    const { loggedIn, account, subscriptionType } = readAntigravityIdentity()

    let setupComplete: boolean | null = null
    try {
      const onboarding = JSON.parse(
        readFileSync(join(home, 'cache', 'onboarding.json'), 'utf8')
      ) as Record<string, unknown>
      if (typeof onboarding.onboardingComplete === 'boolean') {
        setupComplete = onboarding.onboardingComplete
      }
    } catch {
      // Absent or unreadable is genuinely unknown, which is what null already means.
    }
    return {
      loggedIn,
      ...(account ? { account } : {}),
      ...(subscriptionType ? { subscriptionType } : {}),
      setupComplete,
      raw:
        `Antigravity CLI is configured at ${home}. Active account: ${account ?? 'none'}, ` +
        `tier: ${subscriptionType ?? 'unknown'}.`
    }
  },

  /**
   * Pre-answer the folder-trust dialog for one directory.
   *
   * ⛔ Not cosmetic - it is what makes the quota probe possible at all. `agy` asks *"Do you trust
   * the contents of this project?"* per directory, and **until it is answered it swallows every
   * keystroke**. Measured 2026-08-27: a probe that typed `/usage` before the dialog was answered
   * got no reading, and its Enter selected *"Yes, I trust this folder"* instead - the same failure
   * AGENTS.md already records against Claude Code, on a second CLI.
   *
   * ⚠️ Merges into the operator's own `trustedWorkspaces`, never replaces it: this file is shared
   * with their interactive sessions and this app did not create it.
   */
  trustDirectory(_isolationRoot: string, dir: string): void {
    const file = join(cliHome(), 'settings.json')
    try {
      mkdirSync(dirname(file), { recursive: true })
      let existing: Record<string, unknown> = {}
      if (existsSync(file)) {
        try {
          existing = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
        } catch {
          log.warn(`${file} is not valid JSON; leaving it untouched`)
          return
        }
      }
      const trusted = Array.isArray(existing.trustedWorkspaces)
        ? (existing.trustedWorkspaces as string[])
        : []
      if (trusted.some((t) => t.toLowerCase() === dir.toLowerCase())) return
      existing.trustedWorkspaces = [...trusted, dir]
      writeFileSync(file, `${JSON.stringify(existing, null, 2)}\n`)
      log.info(`pre-trusted ${dir} for agy so a projectless session is not stopped by a dialog`)
    } catch (err) {
      log.warn(`could not record folder trust in ${file}:`, err)
    }
  },

  parseUsage: parseUsageScreen,

  /**
   * ⛔ Always unknown, and deliberately so — after evaluating every alternative.
   *
   * 1. **`agy -p /usage` — measured 2026-08-25, and it does NOT work.** The slash command is taken as
   *    a prompt: the run spent 14,603 input and 264 output tokens and started listing directories
   *    trying to work out what "/usage" meant. Exactly the trap Claude Code set (docs/cost-model.md
   *    §5), sprung twice. `--disable-slash-commands` implies print mode expands them; it does not.
   * 2. **The local Antigravity Language Server**, which is what the community usage tools read.
   *    ⛔ Rejected: it only exists while the **IDE is running**, and agentyard's entire premise is
   *    unattended progress across hours-long windows with no GUI open. Verified on this machine —
   *    with the IDE closed, no such process is listening and no port file exists. A probe that works
   *    only when a window is open is not a probe for this product.
   * 3. **A community package** (`antigravity-usage` and friends). ⛔ Rejected on D7: external
   *    services are wrapped, never vendored, and an undocumented internal RPC surface behind a
   *    third-party wrapper is two things that can go stale rather than one.
   *
   * What agentyard does instead needs no probe at all: the stream carries per-turn usage, so spend is
   * accrued from work agentyard itself metered. That is a **floor**, not a percentage — it cannot see
   * what the vendor counted that never reached a stream — and `reserve.ts` already treats it as one.
   */
  async probeQuota(): Promise<Omit<QuotaSnapshot, 'workerId'>> {
    return {
      windows: [],
      sampledAt: Date.now(),
      source: 'unknown',
      error:
        'Antigravity writes no usage cache to disk, so there is nothing to read here. A reading ' +
        'comes from Probe, which opens a session and types `/usage` - free, no turn - and parses ' +
        'the panel. See parseUsageScreen.'
    }
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

    /**
     * ⭐ **Bind the workspace explicitly, on every spawn including a resume.**
     *
     * ⛔ The process `cwd` is a starting position, not a boundary, and this CLI does not treat it as
     * one. Measured 2026-08-28: t17 was spawned with `cwd` set to its pooled worktree and its
     * conversation store recorded **45 distinct absolute paths under the trunk and zero under any
     * workspace**. It edited and committed in `C:\Dev\multi_agent_controller` — with
     * `--dangerously-skip-permissions` — while its branch never received a commit, so every landing
     * gate reported success having validated nothing.
     *
     * The cause is that Agy's state outlives the process: a persistent per-machine "brain" under
     * `~/.gemini/antigravity/` carries absolute paths from earlier sessions, and a conversation
     * resumed by id arrives already pointed at wherever it was born.
     *
     * ⚠️ **Before `--conversation`, and always paired with it.** A resume is the case that needs this
     * most — it is the one where the CLI has its own opinion about where the work lives — and an
     * adapter that bound the workspace only on a fresh launch would fix the case that was never
     * broken. Untrivial-ai/agent-orchestrator's Agy adapter passes `--add-dir` from both its launch
     * and its restore path for the same reason.
     *
     * ⚠️ This is a request to a CLI, not a sandbox. It narrows what the agent is pointed at; it does
     * not stop one that decides to write elsewhere. The trunk tripwire is the check that does not
     * depend on the CLI cooperating.
     */
    if (req.cwd) args.push('--add-dir', req.cwd)
    for (const dir of attachmentDirs(req.attachments ?? [])) args.push('--add-dir', dir)

    // ⛔ `--conversation`, not `--continue`. Measured on agy 1.1.21: `-c` / `--continue` resumes
    // *the most recent* conversation on this machine, which on a fleet running several worktrees at
    // once - and on a machine whose operator uses `agy` by hand - is whichever one happened to speak
    // last. Resuming by id is the only form that names the conversation this task is actually in.
    //
    // ⚠️ The id is the vendor's `conversation_id` off the `init` record, never agentyard's session
    // id: this CLI names its own conversations, which is what `mintsSessionId: false` says.
    if (req.resumeFrom) args.push('--conversation', req.resumeFrom)
    if (req.model) args.push('--model', req.model)
    // ⚠️ Only ever set when this adapter declares `selectableEffort` — the scheduler drops it
    // otherwise (adapters/types.ts), so this line is inert until the capability is promoted on
    // measured evidence rather than on the flag existing in `--help`.
    if (req.effort) args.push('--effort', req.effort)

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
        'antigravity-cli sessions run without controller tools: its MCP registration is global, ' +
          'so a per-session identity cannot be passed'
      )
    }

    if (req.transport === 'stream') {
      // ⛔ `--print=`, with the equals and nothing after it. **`-p` on `agy` takes the prompt as its
      // value** - `-p` / `--print` / `--prompt` are one string flag, not a boolean - so the bare
      // `-p` this used to pass swallowed the next token. Measured on agy 1.1.21, 2026-08-27, the CLI
      // says so itself:
      //
      //   Error: -p took "--input-format" as its prompt, so the intended prompt was left as an
      //   argument and ignored.
      //
      // ⚠️ That is exit 2 in **zero seconds**, which is what every Antigravity work session in this
      // install had done: one run, `outcome=failed`, `in=0 out=0`, and a note blaming the *agent*
      // for ending "without reporting completion". The account was signed in the whole time.
      //
      // ⛔ Written as one token rather than `'-p', ''`. An empty string argument has to survive
      // node-pty, `launchable()`'s `cmd /d /c` shim path and Windows' own quoting rules to arrive as
      // an empty argv entry, and it is exactly the kind of thing that works here and vanishes
      // somewhere else. `--print=` cannot be dropped, split or re-quoted by anything.
      //
      // The prompt itself does not belong here at all: with `--input-format stream-json` the CLI
      // reads one NDJSON message per line from stdin and runs a turn for each. Print mode still has
      // to be *on*, which is all this flag is for.
      //
      // ⛔ Antigravity CLI's default print timeout is 5m (`--print-timeout (default 5m0s)`).
      // Measured 2026-08-27: complex tasks taking >5m timed out at 1497 polls and exited with ERROR.
      // Set to 24h so autonomous worktree tasks are never aborted mid-execution.
      args.push('--print-timeout', '24h', '--print=', '--input-format', 'stream-json', '--output-format', 'stream-json')
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
   * meter this, which is why `metering` is `'stream'` rather than `'transcript'`. The path is still
   * worth having: it is
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
