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
    // MULTI_AGENT_CONTROLLER_SESSION_ID is how the MCP server knows who it is speaking for.
    mcp: false,
    // ⛔ Nothing to select: this vendor encodes effort in the model id itself, which is why its cost
    // model lists `gemini-3.1-pro-high` and `gemini-3.1-pro-low` as two models with one level each.
    // Choosing the model *is* choosing the effort here, and a second control would double-count it.
    selectableEffort: false,
    // ⭐ It has one after all, as of 2026-08-27. `/usage` typed into the TUI is a client-side
    // slash command - free, no turn - and the panel it draws is the only place the number exists.
    // See parseUsageScreen for why reading a screen is defensible here and nowhere else.
    quotaProbe: 'cli',
    mintsSessionId: false,
    // ⚠️ Not from a transcript: agy writes conversations as SQLite, which the line-oriented tailer
    // cannot read. But usage IS in the stream - measured 2026-08-25 - so the work is metered after
    // all, just only while agentyard is attached to the process.
    metering: 'stream',
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
  // ⭐ Measured 2026-08-27: `/usage` in the TUI costs nothing and renders both groups' windows.
  // `answer: 'screen'` because the panel is written to no file - see parseUsageScreen.
  // ⚠️ readyMs is generous on purpose. This CLI signs in, refreshes experiments and reloads its
  // slash commands before it will accept a keystroke, and anything typed earlier is swallowed.
  // 60 rows, not the default 30. Measured 2026-08-27: at 30 the panel scrolled and the last
  // group's five-hour window was below the fold, so the probe read three windows of four.
  // The panel's own footer said "(1-27 of 30 lines)".
  usageRefresh: {
    command: '/usage',
    readyMs: 20_000,
    settleMs: 15_000,
    answer: 'screen',
    cols: 110,
    rows: 60
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
    const usage = asRecord(step?.usage)
    if (usage) return { kind: 'usage', usage: readUsage(usage), final: false }
    const text = typeof step?.text_delta === 'string' ? step.text_delta : ''
    return text ? { kind: 'assistant_text', text } : { kind: 'other', type: 'step_update' }
  }

  if (event === 'result') {
    const result = asRecord(record.result)
    const status = typeof result?.status === 'string' ? result.status : 'UNKNOWN'
    const finished: StreamEvent = {
      kind: 'result',
      text: typeof result?.response === 'string' ? result.response : null,
      // ⛔ Not reported. Null rather than 0, which would read as "this turn was free".
      costUsd: null,
      isError: status !== 'SUCCESS',
      terminalReason: status
    }
    const usage = asRecord(result?.usage)
    // ⚠️ Two events from one record. The terminal record carries the turn's usage as well as its
    // text, and this is the only place agentyard can bill this adapter from - `agy` writes its
    // conversations as SQLite, which the transcript tailer cannot read.
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
export function parseUsageScreen(screen: string, now = Date.now()): QuotaWindow[] | null {
  if (!/Models\s*&\s*Quota/.test(screen)) return null

  const windows: QuotaWindow[] = []
  let group: { id: string; label: string } | null = null
  let kind: 'weekly' | '5h' | null = null

  const lines = screen.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''

    const heading = /^\s*([A-Z][A-Z0-9 &]*?)\s+MODELS\s*$/.exec(line)
    if (heading?.[1]) {
      const name = heading[1].trim()
      group = { id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), label: titleCase(name) }
      kind = null
      continue
    }

    if (/Weekly Limit Remaining/.test(line)) kind = 'weekly'
    else if (/Five Hour Limit Remaining/.test(line)) kind = '5h'

    // The bar line carries the precise figure. `Quota available` is the CLI's way of writing 100%
    // remaining with no reset worth stating.
    const bar = /\]\s*([\d.]+)\s*%/.exec(line)
    if (!bar?.[1] || !group || !kind) continue

    const remaining = Number.parseFloat(bar[1])
    if (!Number.isFinite(remaining) || remaining < 0 || remaining > 100) continue

    windows.push({
      id: `${kind}:${group.id}`,
      label: `${group.label} · ${kind === 'weekly' ? 'weekly' : '5-hour'}`,
      percent: Math.round((100 - remaining) * 100) / 100,
      resetsAt: readReset(lines[i + 1] ?? '', now)
    })
    kind = null
  }

  if (windows.length === 0) return null

  // ⛔ A group must contribute BOTH of its windows or the read is not trustworthy. This panel is
  // taller than a default terminal and scrolls - its own footer says "(1-27 of 30 lines)" - so a
  // viewport that cuts it mid-group is the normal failure, not an exotic one.
  //
  // ⚠️ Measured 2026-08-27 against the live account at 30 rows: this returned Gemini weekly, Gemini
  // 5-hour and Claude-and-GPT weekly, and silently dropped Claude-and-GPT's 5-hour window. That is
  // the worst possible thing to lose quietly, because the missing window is a candidate for the
  // `5h` promotion below - so the gate would have been handed Gemini's 33% while the group the run
  // actually used sat somewhere unmeasured. A short read must fail, not under-report.
  const perGroup = new Map<string, number>()
  for (const w of windows) {
    const group = w.id.slice(w.id.indexOf(':') + 1)
    perGroup.set(group, (perGroup.get(group) ?? 0) + 1)
  }
  for (const [group, count] of perGroup) {
    if (count < 2) {
      log.warn(
        `agy /usage panel was cut off: "${group}" showed ${count} of 2 windows. The probe session's ` +
          'viewport is too short for this panel - no reading is recorded rather than a partial one.'
      )
      return null
    }
  }

  // ⛔ Downstream asks for the five-hour window by the id `session` or `5h` - the quota gate, the
  // reset countdown and the reserve all do. Antigravity has **two**, because Gemini and Claude/GPT
  // are metered separately, and nothing in a quota snapshot knows which group the next run will use.
  // ⚠️ So the busiest one is promoted, which is the conservative direction: over-stating pressure
  // costs a delayed dispatch, under-stating it costs a run that dies at a window boundary holding
  // context it cannot save. The label still names the group, so the promotion is visible rather than
  // silently averaging two different accounts' worth of budget into one number.
  const fiveHour = windows.filter((w) => w.id.startsWith('5h:'))
  if (fiveHour.length > 0) {
    const busiest = fiveHour.reduce((a, b) => (b.percent > a.percent ? b : a))
    busiest.id = '5h'
  }
  return windows
}

/** `Refreshes in 138h 0m` → an absolute instant. Anything else, including `Quota available`, is null. */
function readReset(line: string, now: number): number | null {
  const found = /Refreshes in\s+(?:(\d+)h)?\s*(?:(\d+)m)?/.exec(line)
  if (!found || (!found[1] && !found[2])) return null
  const hours = Number.parseInt(found[1] ?? '0', 10)
  const minutes = Number.parseInt(found[2] ?? '0', 10)
  return now + (hours * 60 + minutes) * 60_000
}

function titleCase(heading: string): string {
  // "CLAUDE AND GPT" reads better as "Claude and GPT" in a table cell than as a shout.
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
   * ⚠️ There is no non-interactive identity command, and the credential is in the OS keyring where
   * agentyard will not look. So this reports what it can see — whether the CLI has been run on this
   * machine — and is honest that it cannot say *who* is signed in.
   *
   * ⛔ It must never spend a turn to find out. `agy -p "who am i"` would answer, and would bill.
   */
  /**
   * ⛔ Still unknown, and `agy models` is **not** the free sign-in check it looks like.
   *
   * Measured 2026-08-26 on agy 1.1.20. On a terminal it prints "Fetching available models…" and the
   * catalogue, exits 0, and spends no turn — which makes it look like this adapter's answer to
   * `claude auth status --json`. It is not: **with stdout on a pipe it produces nothing and hangs**.
   * Killed at 30s through `execFile`, and again at two minutes through `agy models | cat`. Every
   * probe this daemon runs is on a pipe, so shipping it would have hung identity refresh — the
   * commissioning path, the Probe button, and the post-login refresh — for its whole timeout, and
   * then returned the same `null` it starts with.
   *
   * ⚠️ Recorded rather than retried: this is the third Antigravity capability that reads as
   * available and is not (`agy -p /usage`, the missing `login` subcommand, and now this).
   */
  async probeIdentity(): Promise<IdentityProbe> {
    const home = cliHome()
    if (!existsSync(join(home, 'settings.json'))) {
      return {
        loggedIn: null,
        raw:
          `no Antigravity CLI settings at ${home}. Either it has never been run, or it is signed in ` +
          'and keeps nothing here - there is no way to tell the difference without spending a turn.'
      }
    }
    // ⭐ `setupComplete` is knowable even though `loggedIn` is not. Measured 2026-08-27:
    // `cache/onboarding.json` holds `{consumerOnboardingComplete, enterpriseOnboardingComplete,
    // onboardingComplete}`, written by the CLI itself. It was reported as `null` before, which cost
    // the operator nothing directly but left "Finish setup" unable to say whether there was
    // anything to finish.
    //
    // ⚠️ It answers the *onboarding* question and NOT the folder-trust one, and the difference is
    // the whole reason to spell it out: trust is asked **per directory**, so a fully onboarded
    // account still meets a dialog in a folder it has not seen - and until that is answered the CLI
    // swallows every keystroke. Measured the same day, on this very probe: the first attempt's
    // `/usage` was eaten by the dialog and its Enter answered *"Yes, I trust this folder"*. That is
    // what `trustDirectory` below exists to prevent.
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
      loggedIn: null,
      setupComplete,
      raw:
        `Antigravity CLI is configured at ${home}, but its credential lives in the OS keyring, which ` +
        'this app does not read. Sign-in state is unknown by design; a failed run will say so.'
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
      // Measured: `--input-format stream-json` *requires* `--output-format stream-json`. Setting one
      // without the other is an argument error, so they move together.
      args.push('--print=', '--input-format', 'stream-json', '--output-format', 'stream-json')
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
