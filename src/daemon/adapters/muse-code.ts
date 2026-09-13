import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AdapterDetection, AdapterInfo, QuotaSnapshot, QuotaWindow } from '@shared/protocol.js'
import type { AgentAdapter, IdentityProbe, SpawnPlan, SpawnRequest } from './types.js'
import type { TranscriptDecoded } from '../transcript.js'
import type { StreamEvent } from '../stream.js'
import { asRecord } from '../stream.js'
import { log } from '../log.js'
import { spawnEnv } from '../which.js'
import { paths } from '../paths.js'
import {
  gitEnvFor,
  honoursPosixModes,
  hostExec,
  hostFor,
  hostPath,
  hostPlan,
  type CliHost
} from './clihost.js'
import { errorMessage } from '@shared/errors.js'

const run = promisify(execFile)

/**
 * Muse Code — Meta's terminal coding agent.
 *
 * ⛔ **The first adapter whose CLI does not have to live on this machine.** Muse ships for Linux and
 * macOS; on Windows the operator installs it inside WSL. Everything that follows from that lives in
 * `clihost.ts` — this file asks for a host and never asks what platform it is on, which is the only
 * way the macOS and Linux builds stay free of Windows code.
 *
 * Three of its differences from every adapter here are structural rather than cosmetic:
 *
 *  1. ⛔ **`muse exec` has no stdin prompt channel.** Measured 2026-09-06: a piped prompt answers
 *     `missing prompt` and exits 1. The prompt has to be a `--prompt-file`, so the host script
 *     drains stdin into one first — which turns the EOF the `once` transport already sends into the
 *     go signal, and leaves the scheduler untouched.
 *  2. ⛔ **Usage is in the session log and nowhere on the `--json` stream.** A full real run was
 *     captured and carries no usage record at all. So `metering: 'transcript'`, and because the
 *     record shape is muse's rather than Claude Code's, this adapter brings its own
 *     `decodeTranscript`.
 *  3. ⛔ **The quota reading exists only as rendered text**, the same position Antigravity is in:
 *     `/usage` draws a panel and writes the numbers to no file. `parseUsage` is the reader and it is
 *     allowed to produce a quota reading and nothing else.
 */

/** The four models the running CLI's own catalogue lists, most capable first. */
const MODELS = [
  'muse-spark-1.3-contributor',
  'muse-spark-1.3',
  'muse-spark-1.2-contributor',
  'muse-spark-1.2'
] as const

const info: AdapterInfo = {
  id: 'muse-code',
  label: 'Muse Code',
  command: 'muse',
  // ⛔ Not a vendor variable — muse has none. It reads XDG, and the binary honours only
  // `XDG_CONFIG_HOME`/`XDG_DATA_HOME`: the launcher's `MUSE_AUTH_PATH` is not read by the real
  // binary (grep: 0 hits, measured 2026-09-06), so isolation is by directory or not at all. This
  // field names the one that carries the credential; `envFor` sets both.
  isolationEnvVar: 'XDG_CONFIG_HOME',
  capabilities: {
    transports: ['pty', 'stream'],
    // ⚠️ Names for *this app's* modes, not muse's flag values — `read-only` is three flags together
    // and has no single spelling on the CLI. `plan()` is where each becomes argv.
    permissionModes: ['on-request', 'untrusted', 'never', 'read-only'],
    // `--approval-mode never --disable-write --disable-shell`: it may read the repository and has no
    // channel through which to change it. That is what a quality review in the operator's own trunk
    // needs, and it is the only mode this adapter is ever offered one in.
    readOnlyPermissionMode: 'read-only',
    // ⚠️ `--approval-judge on` is a real LLM reviewer and is the default — but unattended work runs
    // `--approval-mode never`, where there is nothing left for it to judge. Declaring `true` would
    // tell the scheduler a reviewer is watching a run that has none, which is the mistake t251 cost
    // this project nine approvals to find on the other adapter.
    classifierBackedAuto: false,
    // No callback and no rules file this app writes: approvals are settled by the flags on the
    // process, before it starts.
    approvalChannel: 'none',
    // ⛔ Muse compacts on its own thresholds (`--context-compaction-*`). There is no `/compact` this
    // app can send, so the cache clock's manual moves are unavailable and `wrapUpProtocol` is a
    // handoff instead.
    manualCompact: false,
    // ⭐ Measured: a second `muse exec --session-id <same uuid>` appended to the same conversation
    // and wrote `session.resumed` with `prior_turn_count: 1`. The vendor's handle for a conversation
    // is therefore the id this app minted for it.
    resumeSession: true,
    forkSession: false,
    // `-w/--worktree` exists and this adapter never passes it: the pool hands out its own.
    nativeWorktree: false,
    // `--image <PATH>` is repeatable on `exec` and there is no stdin channel to send a second one
    // down — initial prompt only, exactly Codex's shape. ⭐ Flown 2026-09-07: the model answered a
    // prompt carrying a real PNG.
    // ⚠️ **A claim about the CLI, and the CLI is not always able to honour it here.** muse installs
    // the image into an asset store under `XDG_DATA_HOME` that it requires to be `0700`, and on a
    // WSL bridge whose data home sits on a Windows volume no such mode can exist. `plan()` drops
    // `--image` in that case rather than spending a run on a turn that cannot start — see there,
    // and `honoursPosixModes` in clihost.ts. The capability stays `spawn-flag` because it describes
    // the CLI; a native install, or a data home inside the distribution, takes images.
    imageInput: 'spawn-flag',
    // ⛔ Muse reads `mcpServers` out of `settings.json`, which belongs to the **isolation root** and
    // not to one session — so a per-session identity token, which is what `task_complete` needs,
    // has nowhere to live. Same answer as codex, for the same reason, and the prompt builder reads
    // this so a muse run is never told to call a tool it does not have.
    mcp: false,
    // ⭐ `--reasoning-effort` is a real flag on `exec`, and the catalogue lists which tiers each
    // model accepts.
    selectableEffort: true,
    quotaProbe: 'cli',
    // Nothing muse writes reports money. ⚠️ Which is *this adapter reports none*, not *this account
    // spends none*: a subscription is being billed and no local file names a figure.
    spendProbe: 'none',
    // One prompt, then the process runs that turn and exits — like `codex exec`, but arriving as a
    // file rather than on stdin. See the note at the top of this file.
    streamPrompts: 'once',
    // `run.output.delta`, and it is the stream that named this capability: t272 read one word per
    // line before anything reassembled it.
    outputFraming: 'delta',
    // `run.output.delta` is already every few tokens. Nothing to ask for.
    streamsPartialOutput: false,
    // `--session-id <UUID>` takes an id we choose, which is what makes the session log's path
    // knowable before the file exists and lets orphan reaping prove a pid is ours.
    mintsSessionId: true,
    metering: 'transcript',
    // XDG directories, one set per account. A fleet is just directories.
    maxAccounts: null
  },
  policy: {
    // What a person at the keyboard gets, and muse's own default.
    defaultPermissionMode: 'on-request',
    // ⛔ Nobody is there to answer. `on-request` unattended is a run that stalls on its first shell
    // command; the same call this project already made for antigravity and claude-code, quarantined
    // inside an isolated pooled worktree and gated by the mandate and the landing checks.
    headlessPermissionMode: 'never',
    // ⛔ `never` here means never *ask*, not never act — the same call as claude-code and
    // antigravity above, and it carries the same authority.
    headlessAuthority: 'full-user',
    interruptSequence: '\x1b',
    costModelId: 'meta.muse.2026-09',
    // No `/compact` to send, so a run that has to wrap up says so in words.
    wrapUpProtocol: 'handoff',
    needsExplicitBudget: true,
    defaultModel: MODELS[0]
  },
  // ⭐ Measured 2026-09-06: `muse login` is a plain, non-TUI device-code flow — it prints the URL and
  // the code, waits, and exits on its own. Nothing here ever sees the credential; the CLI writes it
  // into the isolation root's own `auth.json`.
  login: { kind: 'cli', argv: ['login'] },
  // ⭐ Measured 2026-09-06 under a 100x30 terminal against the live account. Two findings shaped
  // this: the panel exists only on screen, and **the slash-command popup swallows the first Enter**
  // — a trailing space closes it, so `'/usage '` submits with the single carriage return quota.ts
  // already appends. ⚠️ `readyMs` is padded because being early means reading a screen that has not
  // drawn yet, which parses as *no reading* rather than as a wrong one.
  // ⛔ `submitDelayMs` is not a nicety: measured 2026-09-07 through this app's own PTY, `'/usage \r'`
  // written in one go leaves the text in the composer unsent — four attempts, eighteen seconds,
  // nothing — while the same text with the return 400ms behind it draws the panel first time.
  usageRefresh: {
    command: '/usage ',
    readyMs: 14_000,
    settleMs: 18_000,
    answer: 'screen',
    cols: 100,
    rows: 30,
    submitDelayMs: 400
  },
  // ⛔ Measured on a fresh config root, 2026-09-06: a bare `muse` opens **"Do you trust this
  // workspace?"** and then the login chooser, and swallows every keystroke until both are answered.
  // That is the same coupling claude-code has and the same cost — `/usage` typed into a dialog
  // vanishes, and the probe reports nothing forever while scheduled work carries on fine.
  //
  // ⚠️ Both are normally answered without a person: `muse login` handles the second and
  // `trustDirectory` pre-writes the first for the scratch directory a projectless session runs in.
  // This exists for the root where one of them did not take, which is what `completedKey` names —
  // `projects` in the isolation root's own `trust.json`.
  firstRun: {
    argv: [],
    completedKey: 'projects',
    reason:
      'This account is signed in, but Muse Code has not been told it trusts the folder this ' +
      "worker's projectless sessions open in. That question only appears in a real terminal, it " +
      'swallows anything typed at it until it is answered, and until then the `/usage` probe reads ' +
      'nothing while scheduled work carries on unaffected.'
  },
  verification: {
    level: 'measured',
    asOf: '2026-09-06',
    note:
      'Exercised against Muse Code 1.0.3 (1.0.3-R2198.1) in WSL2 Ubuntu from a Windows host on ' +
      '2026-09-06, on a live "Everyday Usage" account: real `exec --json` runs (native and with ' +
      'both XDG roots on a Windows drive), session-id resume, the `/usage` panel, `muse login`, ' +
      'the fresh-root first-run screens, and the full Windows-spawn bridge end to end. ' +
      '⭐ `--image` flown 2026-09-07, in both directions: it answers a prompt carrying a real PNG ' +
      'with the XDG data home on ext4, and refuses with exit 1 — *asset directory permissions must ' +
      'be 0700, got 0777* — with the data home on a Windows volume, which is how this fleet runs it.'
  }
}

// ---------------------------------------------------------------------------- host

/**
 * Where muse runs, cached.
 *
 * ⛔ `isInstalled()` is asked on every candidate on every tick and must not spawn a process — but a
 * bridged CLI cannot be found with a filesystem lookup, because it is not on this filesystem. So the
 * answer is cached and refreshed in the background, and until the first probe returns the answer is
 * **no**: a worker nobody has checked is not dispatched to. ⚠️ That costs one tick, not a Doctor run.
 */
const PROBE_TTL_MS = 5 * 60_000
let installedCache: { at: number; found: boolean; version: string | null } | null = null
let probing = false

function refreshInstalled(): void {
  if (probing) return
  const host = hostFor(info.command)
  if (!host) {
    installedCache = { at: Date.now(), found: false, version: null }
    return
  }
  if (host.kind === 'native') {
    // ⚠️ Found is enough here — the binary is on this filesystem, and asking it its version is a
    // process spawn nobody is waiting on. `detect()` fills the version in when somebody asks.
    installedCache = { at: Date.now(), found: true, version: installedCache?.version ?? null }
    return
  }
  probing = true
  void version(host)
    .then((v) => {
      installedCache = { at: Date.now(), found: v !== null, version: v }
    })
    .catch(() => {
      installedCache = { at: Date.now(), found: false, version: null }
    })
    .finally(() => {
      probing = false
    })
}

async function version(host: CliHost): Promise<string | null> {
  try {
    // ⛔ Exported *inside* the script, not handed to the spawn: on a bridged host the environment
    // stops at `wsl.exe`. Without it the launcher may self-update mid-fleet — see `hostExec`.
    const probe = hostExec(host, info.command, ['--version'], { MUSE_NO_AUTO_UPDATE: '1' })
    const { stdout } = await run(probe.command, probe.args, {
      timeout: 30_000,
      env: { ...spawnEnv(), MUSE_NO_AUTO_UPDATE: '1' }
    })
    // `Muse Code 1.0.3 (1.0.3-R2198.1)` → `1.0.3 (1.0.3-R2198.1)`. ⚠️ WSL's pipe carries UTF-16 nulls
    // on some builds; they are stripped rather than left to poison a version string.
    const text = stdout.replace(/\0/g, '').trim()
    const match = /Muse Code\s+(.+)/i.exec(text)
    return match?.[1]?.trim() ?? (text || null)
  } catch {
    return null
  }
}

/** ⚠️ Throws where muse cannot be reached at all, which is what `plan()`'s callers already handle. */
function requireHost(): CliHost {
  const host = hostFor(info.command)
  if (!host) {
    throw new Error(
      `'${info.command}' is not on PATH and no WSL is available to reach it. Install Muse Code, or ` +
        'on Windows install it inside a WSL distribution.'
    )
  }
  return host
}

// ---------------------------------------------------------------------------- isolation root

/**
 * One account's two XDG directories, under the root this worker was commissioned with.
 *
 * ⛔ Two subdirectories rather than the root itself, because muse keeps the credential in one and
 * every session log in the other, and a probe that has to read `auth.json` should not have to walk
 * past a fortnight of transcripts to find it.
 */
function configHome(isolationRoot: string): string {
  return join(isolationRoot, 'config')
}
function dataHome(isolationRoot: string): string {
  return join(isolationRoot, 'data')
}
function authFile(isolationRoot: string): string {
  return join(configHome(isolationRoot), 'muse', 'auth.json')
}
function trustFile(isolationRoot: string): string {
  return join(configHome(isolationRoot), 'muse', 'trust.json')
}
/** Where a session's one prompt is put, since `muse exec` has no stdin to read it from. */
function promptFile(isolationRoot: string, sessionId: string): string {
  return join(isolationRoot, 'prompts', `${sessionId}.txt`)
}

/**
 * Has the workspace-trust question been answered for the folder a projectless session opens in?
 *
 * ⛔ Reads this root's own `trust.json` and nothing else. A worker adopting a directory somebody
 * else set up must not read *their* answer and report itself ready — the failure it would hide is
 * silent, because headless dispatch works either way and only the TUI probe stalls.
 *
 * ⚠️ `null`, not `false`, where the file does not exist yet: an un-commissioned root has not
 * declined the question, it has not been asked.
 */
function firstRunComplete(isolationRoot: string): boolean | null {
  const file = trustFile(isolationRoot)
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      projects?: Record<string, { decision?: unknown }>
    }
    const host = hostFor(info.command)
    const key = host ? hostPath(host, paths.scratch) : paths.scratch
    return parsed.projects?.[key]?.decision === 'trusted'
  } catch {
    return null
  }
}

function envFor(host: CliHost, isolationRoot: string, cwd: string): Record<string, string> {
  const env: Record<string, string> = {
    XDG_CONFIG_HOME: hostPath(host, configHome(isolationRoot)),
    XDG_DATA_HOME: hostPath(host, dataHome(isolationRoot)),
    // ⛔ A launcher that self-updates mid-fleet swaps a 263 MB binary under a running worker and
    // changes the capability table this adapter was measured against, without anybody asking.
    MUSE_NO_AUTO_UPDATE: '1',
    ...gitEnvFor(host, cwd)
  }
  return env
}

// ---------------------------------------------------------------------------- /usage panel

/**
 * Read the quota out of what `/usage` drew.
 *
 * Measured verbatim, 2026-09-06:
 * ```
 *   Subscription · Muse Code Everyday Usage
 *     Current        5% used · Resets at 1:38 AM
 *     Weekly         1% used · Resets Sep 13 at 5:00 PM
 *     as of 9:17 PM
 * ```
 * ⛔ **The provider can draw this block with no numbers at all** — it reads `Currently unavailable`
 * (measured first on a newly signed-in account on 2026-09-07, and again after completed work on
 * MuseFirst on 2026-09-08; see `usageUnavailable`). Either way this returns `null` rather than
 * zeroes: a missing reading is a state everything downstream already distrusts correctly, and a
 * 0% one would be believed.
 *
 * ⚠️ `Session usage` above it counts this session's tokens, not the subscription's window, and is
 * deliberately not read here — it is the number that is present when the one we want is not.
 *
 * ⛔ **Nothing here may be anchored to a line, because through a PTY there are no lines.** Measured
 * 2026-09-07 (t266) on the app's own probe session: muse paints with absolute cursor addressing and
 * emits no newline between the rows, so the backscroll this is handed — the raw stream with its
 * escapes stripped — carries the whole panel as *one* line:
 * ```
 * … Subscription · Muse Code Everyday Usage   Current   0% used · Resets at 1:55 PM   Weekly   2% …
 * ```
 * A `/^\s*Current\s+/` matched nothing on it, so a complete, correct panel read as no reading at
 * all, on every probe, for reasons that had nothing to do with the account. ⚠️ Antigravity's TUI
 * does emit newlines, which is why this went unnoticed until a second screen-answered adapter.
 *
 * ⚠️ **The last paint wins.** A TUI redraws, so the backscroll holds every frame it ever drew and
 * an account whose windows arrived mid-probe has both the empty panel and the filled one on it.
 */
function parseUsage(screen: string, now: number = Date.now()): QuotaWindow[] | null {
  if (!/\bSubscription\b/.test(screen)) return null

  const rows: Array<{ id: string; label: string; heading: string }> = [
    { id: '5h', label: 'Muse 5h', heading: 'Current' },
    { id: '7d', label: 'Muse 7d', heading: 'Weekly' }
  ]

  const windows: QuotaWindow[] = []
  for (const row of rows) {
    // `Current        0% used · Resets at 1:55 PM`, with the run of spaces being a cursor move.
    // ⚠️ The reset clause is bounded to the two shapes measured — `at 1:38 AM` and
    // `Sep 13 at 5:00 PM` — rather than *to the end of the line*, which on one line is the rest of
    // the panel. An unrecognised shape leaves `resetsAt` null and keeps the percentage.
    const pattern = new RegExp(
      String.raw`\b${row.heading}\s+(\d+(?:\.\d+)?)\s*%\s*used` +
        String.raw`(?:\s*·\s*Resets\s+((?:[A-Z][a-z]{2}\w*\s+\d{1,2}\s+)?at\s+\d{1,2}:\d{2}(?:\s*[AP]M)?))?`,
      'gi'
    )
    const seen = [...screen.matchAll(pattern)]
    const match = seen[seen.length - 1]
    if (!match?.[1]) continue
    windows.push({
      id: row.id,
      label: row.label,
      percent: Number(match[1]),
      resetsAt: match[2] ? parseResetTime(match[2], now) : null
    })
  }
  // ⛔ A panel that drew its header and no row it recognises is a rendering this parser does not
  // understand, not an account with no windows.
  return windows.length > 0 ? windows : null
}

/**
 * Why the panel drew no numbers, when it drew none — the sentence a person is shown.
 *
 * ⛔ **A real provider answer, distinct from both a reading and a screen that did not parse.** It
 * was first measured on a newly commissioned MuseFirst (2026-09-07), then recurred after that
 * account had completed work and its probes had read 35% through 80% (2026-09-08):
 * ```
 *   Subscription · Muse Code Everyday Usage
 *     Currently unavailable
 * ```
 * The panel is drawn and the slash command was accepted, but the provider has published no windows.
 * An early observation suggested that one completed turn on the credential ended this state; the
 * 2026-09-08 recurrence disproves that as a sufficient diagnosis. The cause is therefore unknown,
 * and the app must not tell an operator to dispatch paid work as a remedy.
 */
function usageUnavailable(screen: string): string | null {
  // ⚠️ Unanchored, for the reason `parseUsage` is: through a PTY this panel arrives on one line.
  if (!/\bSubscription\b/.test(screen)) return null
  if (!/currently unavailable/i.test(screen)) return null
  return (
    'Muse Code drew its `/usage` panel, but it reads "Currently unavailable" instead of publishing ' +
    'subscription windows. No quota reading is available from this probe; this can occur even after ' +
    'completed work, so the app does not infer a cause or ask you to spend a turn to clear it.'
  )
}

/**
 * `at 1:38 AM` and `Sep 13 at 5:00 PM`, in the operator's own timezone.
 *
 * ⚠️ The panel prints no year and no zone. A bare time is read as the **next** occurrence of it,
 * which is what a five-hour window means; a dated one takes the year that makes it fall ahead of
 * now. ⛔ Anything else returns `null` — an unparsed reset is unknown, and the staleness ladder is
 * built to handle that. A guessed one would park a task against a clock nobody set.
 */
export function parseResetTime(text: string, now: number): number | null {
  const clock = /(\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(text)
  if (!clock?.[1] || !clock[2]) return null
  let hour = Number(clock[1])
  const minute = Number(clock[2])
  const meridiem = clock[3]?.toUpperCase()
  if (meridiem === 'PM' && hour !== 12) hour += 12
  if (meridiem === 'AM' && hour === 12) hour = 0
  if (hour > 23 || minute > 59) return null

  const dated = /\b([A-Z][a-z]{2})\w*\s+(\d{1,2})\b/.exec(text)
  const base = new Date(now)
  if (dated?.[1] && dated[2]) {
    const month = [
      'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'
    ].indexOf(dated[1].toLowerCase())
    if (month < 0) return null
    const day = Number(dated[2])
    let at = new Date(base.getFullYear(), month, day, hour, minute, 0, 0).getTime()
    // A December reading naming a January date belongs to next year.
    if (at < now - 180 * 86_400_000) at = new Date(base.getFullYear() + 1, month, day, hour, minute).getTime()
    return at
  }

  const today = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, minute, 0, 0).getTime()
  return today > now ? today : today + 86_400_000
}

// ---------------------------------------------------------------------------- stream dialect

/**
 * Muse's `exec --json` dialect.
 *
 * Every line is an envelope — `{schema_version, id, stream, sequence, recorded_at, record_type,
 * payload_type, payload}` — and the type lives in `payload_type` rather than in `type`. ⚠️ There is
 * **no usage record here at all**; that is what `decodeTranscript` is for.
 */
/** How much of a failed tool's command a peephole line may carry before it stops being one line. */
const COMMAND_LINE = 120

/**
 * The command out of a tool result's own payload, or null for a tool that does not report one.
 *
 * ⚠️ `text` is a **string holding JSON**, not an object — measured on `tool.result` and on
 * `task.lifecycle.output`'s `chunk`. Anything unparseable is not an error worth reporting; it is a
 * tool whose result is shaped differently, and the caller simply says less about it.
 */
function commandIn(text: unknown): string | null {
  if (typeof text !== 'string') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const command = asRecord(parsed)?.command
  if (typeof command !== 'string') return null
  const oneLine = command.replace(/\s+/g, ' ').trim()
  if (!oneLine) return null
  return oneLine.length > COMMAND_LINE ? `${oneLine.slice(0, COMMAND_LINE)}…` : oneLine
}

/**
 * The useful subject from a completed tool result.
 *
 * Muse's proposal record says only `tool.bash`; the result record is where the CLI finally puts a
 * command or a file target. It is deliberately a small, explicit allowlist: result payloads also
 * carry arbitrary command output, which must never become a second, unbounded transcript in the
 * peephole.
 */
function activityDetailIn(text: unknown): string | null {
  const command = commandIn(text)
  if (command) return command
  if (typeof text !== 'string') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const payload = asRecord(parsed)
  if (!payload) return null
  for (const key of ['file_path', 'path', 'file', 'query', 'pattern']) {
    const value = payload[key]
    if (typeof value !== 'string') continue
    const oneLine = value.replace(/\s+/g, ' ').trim()
    if (oneLine) return oneLine.length > COMMAND_LINE ? `${oneLine.slice(0, COMMAND_LINE)}…` : oneLine
  }
  return null
}

function decodeStream(record: Record<string, unknown>): StreamEvent | null {
  const type = typeof record.payload_type === 'string' ? record.payload_type : ''
  if (!type) return null
  const payload = asRecord(record.payload) ?? {}

  if (type === 'run.model.configured') {
    const stream = asRecord(record.stream)
    return {
      kind: 'init',
      sessionId: typeof stream?.id === 'string' ? stream.id : null,
      model: typeof payload.model_id === 'string' ? payload.model_id : null,
      permissionMode: null
    }
  }

  if (type === 'run.output.delta') {
    const text = typeof payload.text === 'string' ? payload.text : ''
    return text ? { kind: 'assistant_text', text } : { kind: 'other', type }
  }

  // ⛔ The terminal record, and the process exits after it. `terminal` carries the verdict —
  // `completed` measured; anything else is this run reporting that it did not finish.
  if (type.startsWith('run.terminal.')) {
    const terminal = typeof payload.terminal === 'string' ? payload.terminal : type.slice('run.terminal.'.length)
    const reason = typeof payload.reason === 'string' ? payload.reason : null
    const text = typeof payload.text === 'string' ? payload.text : null
    return {
      kind: 'result',
      text: text ?? reason,
      costUsd: null,
      isError: terminal !== 'completed',
      terminalReason: terminal
    }
  }

  // ⛔ **t270: this record is a *step's* verdict and was being read as the *run's*.** It used to
  // decode to `error: <reason>`, and on the t267 dispatch the one line that reached the operator all
  // run was `error: process exited with status exit status: 1`. Nothing had failed. Reproduced
  // verbatim 2026-09-07 — the agent ran
  // `git log -2 --format=… && git config user.name; …; git config --global user.email`, whose *last*
  // member exits 1 on a machine with no global git config, having already printed the answer it
  // wanted. Muse emits `task.lifecycle.failed` for that, the agent reads the output and carries on,
  // and the run ends `run.terminal.completed` with the process exiting 0. So the operator was shown
  // an error for a shell command that did its job, on a task correctly still marked running, and
  // reasonably killed a healthy 24-minute run.
  //
  // ⛔ **Never the run's verdict, and nothing else here should imply otherwise.** What ends a muse
  // run is `run.terminal.*` above, which is decoded as a `result` and which `onStreamResult` turns
  // into a failed run and a closed session. A step failing is ordinary — a grep that matched
  // nothing, a test that is red, a `git config` that is unset — and the agent is the thing that
  // decides what it means.
  //
  // ⚠️ Silent rather than reworded, because it is the *contextless twin* of `tool.result` below:
  // measured, the two arrive back to back for the same `task_id` (sequences 29 and 30), and only
  // `tool.result` says which tool and which command. One line about a failed step is useful; this
  // one is the half of the pair that caused the false alarm. A step failure that genuinely stops the
  // run still reaches the operator through the terminal record, and a model step retrying is
  // narrated by `task.lifecycle.status` below.
  if (type === 'task.lifecycle.failed') return { kind: 'other', type }

  // ⛔ **The whole of t269, and the reason a working run read as a hung one.** Muse emits
  // `run.output.delta` for the *final answer only*: measured 2026-09-07 on a real run, the three
  // deltas of a two-tool turn arrived at sequences 47-49 of 67, after every tool had already
  // finished. The t267 dispatch ran 24 minutes over 42 tool batches and put **one** line in the
  // peephole — the `task.lifecycle.failed` above, then reading `error: …` — so the operator watching
  // the task saw an agent that had said nothing since it started except an error that turned out to
  // be a shell command doing its job, and reasonably called it stuck. That the two halves of t269
  // and t270 were the *same* line is the point: the records below are what a run is actually doing,
  // and without them the only voice the run had was its most alarming one.
  //
  // ⚠️ Prose, not a new event kind. `noteActivity` takes text and the pane renders text; what these
  // records describe — a tool starting, a provider retrying — is exactly the "what is it doing right
  // now" the peephole exists to answer, and it is never read back for state (activity.ts).
  if (type === 'task.lifecycle.proposed') {
    const event = asRecord(payload.event)
    const kind = typeof event?.task_kind === 'string' ? event.task_kind : ''
    // ⚠️ `tool.` and nothing else. The other `task_kind`s on this record are muse's own bookkeeping —
    // `model.meta.response` once per model call and `reminder.agent.plugin:…` several times per turn
    // (7 of 67 records in the measured capture) — and forwarding those would bury the tool lines
    // under scheduler noise a person cannot act on.
    if (!kind.startsWith('tool.')) return { kind: 'other', type }
    // ⚠️ The name only: this record carries no arguments, and the record that does (`tool.result`)
    // arrives when the tool has already finished. A tool that runs for three minutes should show
    // while it runs, so the early half-answer is the useful one.
    return { kind: 'assistant_text', text: `· ${kind.slice('tool.'.length)}\n` }
  }

  // The other half of the pair. A successful tool with no useful subject stays quiet: its proposal
  // is already visible while it runs. Where Muse supplies the command or target, retain it as the
  // completed step — a tail of `bash / read_file / edit_file` alone answers almost nothing.
  //
  // ⛔ **The command, not just the verdict** — this is the line that has to make t270 unrepeatable.
  // "a step failed" with no subject is what sent an operator to kill a working run; `· bash failed:
  // git config --global user.email` is a sentence they can judge in one glance. `text` is the tool's
  // own JSON and only bash was measured to carry `command`, so it is read defensively and the line
  // degrades to the verdict alone for any tool that spells its result differently.
  if (type === 'tool.result') {
    const facts = asRecord(payload.correlation_facts)
    const outcome = typeof facts?.outcome === 'string' ? facts.outcome : null
    const tool = typeof facts?.tool_name === 'string' ? facts.tool_name : 'tool'
    if (!outcome) return { kind: 'other', type }
    const detail = activityDetailIn(payload.text)
    if (outcome === 'success') {
      return detail ? { kind: 'assistant_text', text: `· ${tool}: ${detail}\n` } : { kind: 'other', type }
    }
    return { kind: 'assistant_text', text: `· ${tool} ${outcome}${detail ? `: ${detail}` : ''}\n` }
  }

  // ⛔ Provider retries, which are the one thing that makes a healthy run genuinely idle. Measured in
  // the same capture: a 429 answered with `retrying meta model stream in 5000ms (attempt 2/10)`, and
  // muse will do that ten times before it gives up. Without this the pane shows the tool that ran
  // before the stall and nothing else for as long as it lasts.
  //
  // ⚠️ Deliberately **not** a `rate_limit` event. That kind feeds `recordRateLimit` and the
  // preemption ladder, which are about the account's quota windows; this is a transient per-request
  // retry the CLI is already handling itself, and reporting it as a quota signal would bench a
  // worker whose account is fine.
  if (type === 'task.lifecycle.status') {
    const event = asRecord(payload.event)
    const message = typeof event?.message === 'string' ? event.message : null
    const details = asRecord(event?.details)
    const facets = Array.isArray(details?.facets) ? details.facets : []
    // `stream_succeeded` rides the same `error_kind` field as the real failures — it is how muse
    // reports that the attempt it opened is done — so an unfiltered "has an error_kind" test would
    // emit a line per model call and drown the retries this is here for.
    const failing = facets.some((facet) => {
      const kind = asRecord(facet)?.error_kind
      return typeof kind === 'string' && kind !== 'stream_succeeded'
    })
    if (!failing || !message) return { kind: 'other', type }
    return { kind: 'assistant_text', text: `· ${message}\n` }
  }

  return { kind: 'other', type }
}

// ---------------------------------------------------------------------------- transcript dialect

/**
 * Muse's session log, one record at a time.
 *
 * The metered record, measured verbatim:
 * ```
 * "payload_type":"runtime.session","payload":{"event":{"duration_ms":2155,"kind":"model_completed",
 *  "model":"muse-spark-1.3-contributor","usage":{"cache_read_tokens":0,"cache_write_tokens":0,
 *  "cached_tokens":0,"input_tokens":24532,"output_tokens":24,"reasoning_tokens":12}},
 *  "run_id":"…","source_run_record_id":"…"}
 * ```
 *
 * ⛔ **`input_tokens` includes the cached prefix** — measured, `input_tokens: 24679` beside
 * `cache_read_tokens: 24433`, so the model actually read 246 fresh tokens. Anthropic's convention,
 * which `contextOf` is written for, keeps the two apart. Adding them as they arrive would report a
 * context twice its real size and bill every cache read twice.
 *
 * ⚠️ `recorded_at` is **microseconds** since the epoch, not milliseconds.
 */
function decodeTranscript(record: unknown): TranscriptDecoded | null {
  const rec = asRecord(record)
  if (!rec) return null

  const micros = typeof rec.recorded_at === 'number' ? rec.recorded_at : null
  const ts = micros !== null ? Math.round(micros / 1000) : null

  const payload = asRecord(rec.payload)
  const event = asRecord(payload?.event)
  if (rec.payload_type !== 'runtime.session' || event?.kind !== 'model_completed') {
    return { kind: 'other', ts }
  }

  const usage = asRecord(event.usage)
  if (!usage) return { kind: 'other', ts }

  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const cacheRead = n(usage.cache_read_tokens) || n(usage.cached_tokens)
  const cacheWrite = n(usage.cache_write_tokens)
  // ⛔ Never below zero: a vendor that changes the convention must not turn into a negative context.
  const fresh = Math.max(0, n(usage.input_tokens) - cacheRead - cacheWrite)
  const at = ts ?? Date.now()

  return {
    kind: 'turn',
    turn: {
      // ⛔ The record id of the model call, not the run: a run holds several. It is the key
      // `recordTurn` dedupes on, and a resumed session re-reads its whole log from the top.
      requestId:
        typeof payload?.source_run_record_id === 'string' ? payload.source_run_record_id : null,
      ts: at,
      model: typeof event.model === 'string' ? event.model : null,
      // ⚠️ Muse does not name the effort back in its log; the level this app asked for is what the
      // session row already carries.
      effort: null,
      gitBranch: null,
      inputTokens: fresh,
      outputTokens: n(usage.output_tokens),
      thinkingTokens: n(usage.reasoning_tokens),
      cacheReadTokens: cacheRead,
      // ⚠️ Attributed to the long TTL because muse publishes no TTL at all and the cost model prices
      // its cache as `unpriced`; nothing downstream divides these two apart today.
      cacheWrite1hTokens: cacheWrite,
      cacheWrite5mTokens: 0,
      contextTokens: fresh + cacheRead + cacheWrite
    }
  }
}

// ---------------------------------------------------------------------------- permission modes

/**
 * One of this app's mode names as muse's own flags.
 *
 * ⛔ `never` is unattended work and it is three flags, not one: approvals off (nobody is there),
 * the sandbox off (a pooled worktree on a Windows drive reached through WSL is outside anything the
 * sandbox understands), and the workspace trusted **for this run only** — `--trust-workspace` does
 * not write `trust.json`, so a one-off dispatch never widens what the account trusts afterwards.
 */
function permissionArgs(mode: string): string[] {
  switch (mode) {
    case 'read-only':
      return [
        '--approval-mode', 'never',
        '--disable-approval',
        '--disable-write',
        '--disable-shell',
        '--trust-workspace'
      ]
    case 'never':
      return ['--approval-mode', 'never', '--disable-approval', '--disable-sandbox', '--trust-workspace']
    case 'untrusted':
      return ['--approval-mode', 'untrusted']
    default:
      return ['--approval-mode', 'on-request']
  }
}

// ---------------------------------------------------------------------------- adapter

export const museCode: AgentAdapter = {
  info,
  decodeStream,
  decodeTranscript,
  parseUsage,
  usageUnavailable,

  /** ⛔ The prompt is a file, so there is no envelope: what goes down stdin is the prompt itself. */
  encodeStreamPrompt: (text: string) => text,

  /**
   * ⚠️ Measured on this CLI's own wording where it exists, and left deliberately narrow where it does
   * not: `false` is always the safe answer, and the only thing a `true` changes is whether the
   * operator is sent to press *Sign in*.
   */
  needsReauth: (reason: string): boolean => {
    const said = reason.toLowerCase()
    return (
      said.includes('not logged in') ||
      said.includes('run `muse login`') ||
      said.includes('run muse login') ||
      said.includes('invalid api key') ||
      said.includes('unauthorized') ||
      said.includes('auth_rejected')
    )
  },

  /**
   * ⚠️ Anchored on the vendor's own token for the state — `usage_limited` appears in the binary's
   * run-terminal vocabulary (measured by inspection, 2026-09-06) — plus the wordings a subscription
   * limit is normally reported in. ⛔ Never on the word "limit" alone: a tool reporting "output
   * limit exceeded" is an agent having a bad turn, and parking that task on a five-hour clock would
   * hide a real failure.
   */
  outOfQuota: (reason: string): boolean => {
    const said = reason.toLowerCase()
    return (
      said.includes('usage_limited') ||
      said.includes('usage limit') ||
      said.includes('rate limit exceeded') ||
      said.includes('rate_limited') ||
      said.includes('quota exceeded')
    )
  },

  /** ⚠️ A provider having a bad afternoon spares the account: the run retries, the worker is untouched. */
  overloaded: (reason: string): boolean => {
    const said = reason.toLowerCase()
    return (
      said.includes('529') ||
      said.includes('overloaded') ||
      said.includes('service unavailable') ||
      said.includes('503') ||
      said.includes('temporarily unavailable')
    )
  },

  /**
   * ⛔ Free and synchronous, as the contract requires — see `refreshInstalled` for why a bridged CLI
   * cannot be answered by a filesystem lookup, and why the first answer is `false`.
   */
  isInstalled(): boolean {
    const cached = installedCache
    if (!cached || Date.now() - cached.at > PROBE_TTL_MS) refreshInstalled()
    return cached?.found ?? false
  },

  async detect(): Promise<AdapterDetection> {
    const host = hostFor(info.command)
    if (!host) {
      return {
        adapterId: info.id,
        found: false,
        path: null,
        version: null,
        error:
          `'${info.command}' is not on PATH` +
          (process.platform === 'win32'
            ? ' and wsl.exe was not found. Muse Code ships for Linux and macOS; on Windows, install ' +
              'it inside a WSL distribution.'
            : '')
      }
    }
    const found = await version(host)
    installedCache = { at: Date.now(), found: found !== null, version: found }
    if (!found) {
      return {
        adapterId: info.id,
        found: false,
        path: null,
        version: null,
        error:
          host.kind === 'wsl'
            ? 'wsl.exe is here but `muse --version` answered nothing. Is Muse Code installed inside ' +
              'the default distribution, and on its login PATH?'
            : '`muse --version` answered nothing'
      }
    }
    return {
      adapterId: info.id,
      found: true,
      path: host.kind === 'native' ? host.path : `${host.wsl} -- ${info.command}`,
      version: found
    }
  },

  /**
   * ⛔ A file read, and it spends nothing. `auth.json` carries `user_email`, `user_full_name` and
   * `mechanism` once `muse login` has completed — measured 2026-09-06 — so identity needs no command
   * and works identically whether muse is native or bridged.
   *
   * ⚠️ It says **who is signed in**, which is not the same question as whether the subscription is
   * live. Nothing free separates those on this CLI; only a run can.
   */
  async probeIdentity(isolationRoot: string): Promise<IdentityProbe> {
    // ⚠️ The version comes off the cache `isInstalled()` keeps rather than a spawn: identity is
    // probed per worker on a timer, and a WSL hop per worker per probe would be paid for nothing.
    const seen = installedCache?.version
    const cliVersion = seen ? { cliVersion: seen } : {}
    const file = authFile(isolationRoot)
    if (!existsSync(file)) {
      return { loggedIn: false, raw: `no ${file} yet`, ...cliVersion }
    }
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
        providers?: Record<string, { user_email?: string; user_full_name?: string; mechanism?: string }>
      }
      const meta = parsed.providers?.meta
      if (!meta) return { loggedIn: false, raw: 'auth.json holds no `meta` provider' }
      return {
        loggedIn: true,
        ...(meta.user_email ? { account: meta.user_email } : {}),
        ...(meta.user_full_name ? { organization: meta.user_full_name } : {}),
        // ⚠️ Not the plan. The plan's name is printed on the `/usage` panel and written to no file,
        // so it is `null` here rather than guessed - `mechanism` is oauth-versus-api-key.
        subscriptionType: null,
        setupComplete: firstRunComplete(isolationRoot),
        ...cliVersion,
        raw: JSON.stringify({ provider: 'meta', mechanism: meta.mechanism ?? null })
      }
    } catch (err) {
      return { loggedIn: null, raw: errorMessage(err) }
    }
  },

  /**
   * ⛔ There is no file to read. Muse writes its subscription percentages to the `/usage` panel and
   * nowhere else — which is why this adapter declares `usageRefresh.answer: 'screen'` and why this
   * says so rather than returning an empty reading that would look like an account with no windows.
   */
  async probeQuota(): Promise<Omit<QuotaSnapshot, 'workerId'>> {
    return {
      windows: [],
      sampledAt: Date.now(),
      source: 'unknown',
      error:
        'Muse Code reports its subscription windows only on the `/usage` panel; there is no file to ' +
        'read. The reading comes from driving that panel (usageRefresh.answer = screen).'
    }
  },

  /**
   * Pre-answer the workspace-trust question for one directory.
   *
   * ⛔ Read-modify-write, never a replacement: `trust.json` is the vendor's and holds every folder
   * this account has decided about. ⚠️ Only ever called with the empty scratch directory this app
   * created and owns — a dispatch trusts its own workspace with `--trust-workspace`, which lasts for
   * that run and writes nothing.
   */
  trustDirectory(isolationRoot: string, dir: string): void {
    const file = trustFile(isolationRoot)
    let existing: Record<string, unknown> = { schema_version: 1 }
    if (existsSync(file)) {
      try {
        existing = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
      } catch {
        log.warn(`${file} is not valid JSON; leaving it untouched`)
        return
      }
    }
    const host = hostFor(info.command)
    // ⚠️ Keyed by the path **muse will see**, which is the translated one on a bridged host. The
    // Windows spelling would sit in the file forever and never match.
    const key = host ? hostPath(host, dir) : dir
    const projects = (existing.projects ?? {}) as Record<string, Record<string, unknown>>
    if (projects[key]?.decision === 'trusted') return
    projects[key] = { ...(projects[key] ?? {}), decision: 'trusted' }
    existing.projects = projects
    try {
      mkdirSync(join(configHome(isolationRoot), 'muse'), { recursive: true })
      writeFileSync(file, JSON.stringify(existing, null, 2))
      log.info(`pre-trusted ${key} for this worker so a projectless session is not stopped by a dialog`)
    } catch (err) {
      log.warn(`could not record folder trust in ${file}:`, err)
    }
  },

  plan(req: SpawnRequest): SpawnPlan {
    const host = requireHost()
    const env = envFor(host, req.isolationRoot, req.cwd)
    // ⛔ The directories have to exist before the process does: muse creates its own XDG tree, but
    // the prompt file is written by a `cat` whose parent directory is ours to make.
    mkdirSync(join(req.isolationRoot, 'prompts'), { recursive: true })
    mkdirSync(configHome(req.isolationRoot), { recursive: true })
    mkdirSync(dataHome(req.isolationRoot), { recursive: true })

    const shell = (args: string[], stdin?: { path: string }): SpawnPlan => {
      const plan = hostPlan(host, {
        command: info.command,
        args,
        cwd: req.cwd,
        env,
        ...(stdin ? { stdin } : {})
      })
      // ⚠️ `spawnEnv()` and nothing else. It is the *host* process's environment — it reaches
      // `wsl.exe` and stops there on a bridged host, and is what a native `/bin/sh` inherits. Every
      // muse variable travels inside the script instead, so the two hosts behave identically and a
      // Windows path never ends up in a variable only a Linux process reads.
      return { command: plan.command, args: plan.args, env: spawnEnv() }
    }

    // A one-shot flow (login) supplies its own argv and wants a terminal, not a turn.
    if (req.argv) return shell(req.argv)

    if (req.transport !== 'stream') {
      // The TUI, for the `/usage` probe and for a person at the keyboard.
      const args: string[] = [...permissionArgs(req.permissionMode ?? info.policy.defaultPermissionMode)]
      if (req.model) args.push('--model', req.model)
      if (req.effort) args.push('--reasoning-effort', req.effort)
      return shell(args)
    }

    const prompt = promptFile(req.isolationRoot, req.sessionId)
    const args = [
      'exec',
      '--json',
      // ⛔ Reusing the id **is** the resume: measured, a second exec on the same id appended to the
      // conversation and logged `session.resumed`. So there is no `--resume` to pass, and
      // `resumeFrom` — which is this app's own id for the same conversation — simply wins. ⚠️ Not
      // *no flags*, though: see `--allow-workspace-switch` below, which a resume does need.
      '--session-id',
      req.resumeFrom ?? req.sessionId,
      '--prompt-file',
      hostPath(host, prompt),
      // Roots the policy-gated workspace tools at the worktree this run was given.
      '--workspace',
      hostPath(host, req.cwd),
      // ⛔ **A resume must say the workspace may move, or it is not a resume at all.** muse records
      // the workspace root a session was *opened* in and compares it to `--workspace` on every
      // later exec: `session <id> was created in workspace <A>; refusing to resume in workspace
      // <B>; pass --workspace <A> or --allow-workspace-switch`, then **exit 1** with an empty
      // stdout, before the model is called. Measured 2026-09-11 against muse 1.1.1 on a throwaway
      // `--provider echo` session (so the reading cost no tokens): two dirs, same id, refused
      // without the flag and resumed with it, re-rooting its tools at the new directory.
      //
      // ⚠️ This fleet hands a conversation whichever pooled worktree the run claimed, and a path
      // this app believes is the same directory can still be a different string to the vendor:
      // t364 (2026-09-11) died in 4.4s, read as *the session ended (exit 1) without reporting
      // completion*, because the conversation was opened on 2026-09-07 under
      // `multi_agent_controller_workspaces\ws1` and `repointIsolationRoots` rewrote **our** row to
      // `warmstart_workspaces\ws1` at the rename — it cannot reach inside the vendor's session log.
      // So the app's `samePath` gate passed and muse's own comparison did not. The same refusal
      // waits for any conversation revived into a different pool slot, rename or no rename.
      //
      // ⭐ The worktree the dispatch claimed is the authority on where this run works, which is why
      // the switch is allowed rather than the resume declined: declining pays a full cold start for
      // a prefix that is sitting right there.
      ...(req.resumeFrom ? ['--allow-workspace-switch'] : []),
      ...permissionArgs(
        req.permissionMode ?? info.policy.headlessPermissionMode ?? info.policy.defaultPermissionMode
      )
      // ⚠️ `--no-session-log` exists and must never be passed: that log **is** the meter on this
      // adapter (`metering: 'transcript'`), and a run without one reports as costing nothing.
    ]
    if (req.model) args.push('--model', req.model)
    if (req.effort) args.push('--reasoning-effort', req.effort)
    // ⛔ Images only, and only at spawn: `imageInput: 'spawn-flag'` because there is no stdin channel
    // to send a second one down. A folder or a non-image file travels as a path in the prompt text,
    // the way it does on every adapter.
    //
    // ⛔ **And only where muse can build its asset store**, which on this bridge it often cannot.
    // `--image` does not read the file and pass it on: muse *installs* it into a private asset
    // directory under `XDG_DATA_HOME` and refuses one whose mode is not `0700`. A Windows volume
    // seen from WSL is 9p without `metadata`, so that directory is `0777` and `chmod` does not
    // change it — measured 2026-09-07. The refusal is not a skipped attachment, it is
    // `runtime driver failed to plan turn.submit user intent: failed to install accepted image
    // asset: asset is corrupt: asset directory permissions must be 0700, got 0777` and **exit 1**
    // before the model is ever called (t289: a run that read as the agent having failed the task,
    // five seconds after dispatch). With the same account and the data home on ext4, the identical
    // command answers the prompt — so this is the host, not the CLI, and not the account.
    //
    // ⚠️ Dropped rather than deferred: the path is already in the prompt text on every adapter, so
    // the run proceeds with an agent that has been told where the file is instead of a turn that
    // died before it started.
    const images = (req.attachments ?? []).filter((file) => file.kind === 'image')
    if (images.length > 0 && !honoursPosixModes(host, dataHome(req.isolationRoot))) {
      log.warn(
        `${info.label} cannot take ${images.length} image(s) at spawn here: its asset store under ` +
          `${dataHome(req.isolationRoot)} is on a Windows volume, where muse's required 0700 ` +
          'permissions cannot be set. They travel as paths in the prompt text instead.'
      )
    } else {
      for (const file of images) args.push('--image', hostPath(host, file.file))
    }
    return shell(args, { path: hostPath(host, prompt) })
  },

  /**
   * `<root>/data/muse/sessions/<YYYY>/<MM>/<DD>/<session-id>/session.jsonl`.
   *
   * ⛔ A **local** date, measured — WSL and Windows agreed to the minute on this machine, and the
   * directory is named for the day the session opened. ⚠️ A session started in the last second
   * before midnight would land in the next day's directory and go unmetered; the failure is
   * *unmetered*, which Doctor reports, rather than metering somebody else's session.
   */
  transcriptPath(isolationRoot: string, _cwd: string, sessionId: string): string {
    const now = new Date()
    const pad = (n: number): string => String(n).padStart(2, '0')
    return join(
      dataHome(isolationRoot),
      'muse',
      'sessions',
      String(now.getFullYear()),
      pad(now.getMonth() + 1),
      pad(now.getDate()),
      sessionId,
      'session.jsonl'
    )
  }
}
