import { attachmentDirs } from '../attachments.js'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AdapterDetection, AdapterInfo, QuotaSnapshot, SpendSnapshot } from '@shared/protocol.js'
import type {
  AgentAdapter,
  IdentityProbe,
  PermissionRules,
  SpawnPlan,
  SpawnRequest,
  WrittenPermissions
} from './types.js'
import { gitWritableRoots, linkedWritableRoots } from './grants.js'
import { asRecord, num, type StreamEvent, type StreamUsage } from '../stream.js'
import { log } from '../log.js'
import { formatCmdInvocation, launchArgs, launchable, spawnEnv, which } from '../which.js'
import { errorMessage } from '@shared/errors.js'

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
    readOnlyPermissionMode: 'read-only',
    classifierBackedAuto: false,
    approvalChannel: 'settings_rules',
    // ⚠️ Codex does have compaction in its session lifecycle, but whether it can be driven from a
    // headless run is undocumented. Set false deliberately: claiming a capability that is absent
    // costs a stalled session at a window boundary, while omitting one that is present costs only a
    // missed optimisation. Conservative is the cheap direction of the error.
    manualCompact: false,
    /**
     * ⭐ Promoted 2026-09-02, having been `false` since M5 with the note *"`codex exec resume`
     * exists and has not been run here"*. It has now been run here. Measured against codex-cli
     * 0.151.0 on Windows:
     *
     * ```
     * codex exec -s workspace-write -C <dir> --add-dir <dir> --skip-git-repo-check --json \
     *            resume -m <model> <THREAD_ID> -        (prompt on stdin)
     * -> Error: thread/resume: thread/resume failed: no rollout found for thread id <THREAD_ID>
     * ```
     *
     * Three facts fall out of that one line, and `plan` depends on all of them. The sandbox, `--cd`
     * and `--add-dir` flags exist **only on `exec`**, never on `resume`, and clap accepts them
     * ahead of the subcommand. A literal `-` as the PROMPT argument makes resume read stdin, which
     * is the same channel `streamPrompts: 'once'` already uses. And resume is keyed on the rollout
     * file under `$CODEX_HOME` — this fleet's per-worker isolation unit — so a thread is resumable
     * exactly where it was written and nowhere else.
     *
     * ⚠️ **What is still unmeasured is the far side of a successful resume**, because reaching it
     * needs a signed-in account: whether the resumed run re-emits `thread.started` carrying the
     * *same* `thread_id`. `onStreamEvent` writes whatever it is given, so if codex mints a fresh id
     * per resume this fleet would accumulate one session row per turn and stop finding the
     * conversation on the next dispatch. That degrades to today's behaviour — a cold start — rather
     * than to a wrong answer, which is why this ships ahead of the measurement. See HANDOFF.md.
     *
     * ⛔ **And what `false` cost, which is why t124 came looking.** `codex exec` is
     * `streamPrompts: 'once'` — one prompt, one turn, exit — so a codex conversation is *never* a
     * live idle session. With resume refused as well there was no route by which the scheduler could
     * reuse one at all, and every codex candidate scored `contextHeld 0 · cacheWarmth 0 · cold 1` however
     * recently it had done the very task being routed. Measured 2026-09-02: t123 ran on CodexFirst
     * 18:34–18:42 leaving **175,626** tokens of context in session `bffdc5d2`; the 19:02 retry
     * scored a cold ClaudeThird above it and rebuilt everything from nothing. The routing half of
     * that fix is `reopenableFor` in `scheduler.ts`, and it is dead code without this flag.
     */
    resumeSession: true,
    forkSession: true,
    nativeWorktree: false,
    /**
     * ⛔ `spawn-flag`, and therefore **initial prompt only**. `codex exec` reads stdin to EOF and
     * has no conversation channel at all (`streamPrompts: 'once'`), so `-i/--image` on the process
     * that runs the turn is the only way in. An image pasted into a note mid-task cannot reach a
     * codex run; the path in the prompt text is what it gets instead.
     *
     * ⚠️ The channel is measured (2026-08-31, codex 0.151.0) and works. What it answered about a
     * small synthetic image was wrong until it shelled out to sample the pixels — an agent-quality
     * fact, not a plumbing one, and one more reason the path travels alongside the bytes.
     */
    imageInput: 'spawn-flag',
    // ⛔ `false`, and it is a claim about **this adapter**, not about codex. Codex has MCP; what it
    // has no way to do is take a *per-session* registration - `codex mcp add` writes into the shared
    // config, so a session cannot be given the identity `task_complete` needs. `plan()` has warned
    // about that since it was written. Declaring `true` anyway put the sentence *"call the MCP tool
    // `task_complete`"* at the end of every codex prompt, for a tool that was never registered: the
    // agent finishes, hunts for a tool that is not there, and the run can only end in
    // `awaiting_human` however well the work went. The `false` branch tells it to commit and
    // summarise instead, and `onStreamResult` completes the task off the terminal record.
    mcp: false,
    // ⚠️ `model_reasoning_effort` is a documented config key and `-c key=value` is a real flag, but
    // the pair has not been run here, and this adapter's verification says `measured`. Declaring it
    // true on documentation alone is exactly the trade AGENTS.md forbids — it would present a
    // documented capability with the same confidence as a measured one. Left false until run.
    selectableEffort: false,
    // ⛔ `'none'` until 2026-08-29, on the grounds that no non-interactive *status command* exists
    // (openai/codex#10233, still open). That was a fact about commands mistaken for a fact about
    // readings: the server's `rate_limits` are written into every rollout, so the reading is a file
    // read like claude-code's. `'none'` made the poller skip codex workers entirely and the fleet
    // strip render `not reported` over a number that was on disk. See `probeQuota`.
    // ⚠️ Still no `usageRefresh`: making this reading current means spending a turn, so an idle
    // codex worker goes stale and the staleness ladder is the honest answer.
    quotaProbe: 'cli',
    // ⭐ **The balance was already on disk too.** Every rollout that records `rate_limits` records
    // `credits` beside it, and only `unlimited` was ever read — the number itself was parsed and
    // dropped. So the money rung is the same rung as the quota one: a file read, no process, no
    // token. See `rolloutSpend`.
    spendProbe: 'config-cache',
    /**
     * ⛔ `once`, measured 2026-08-29 against codex-cli 0.151.0. `codex exec` with no positional
     * PROMPT reads stdin **to EOF** — `exec --help` says so and the process says so, printing
     * `Reading prompt from stdin...` before it blocks. It is a one-shot: one prompt, one turn, exit.
     * This adapter declared nothing, `sendPrompt` therefore wrapped the text in Claude Code's
     * `{"type":"user",...}` envelope and left the pipe open, and every codex dispatch hung on a read
     * that would never return — 50 minutes and 62ms of CPU on t52, with no rollout file to meter and
     * no error anywhere to say so.
     */
    streamPrompts: 'once',
    // `item.completed` only — codex publishes an `agent_message` when it is finished writing one.
    outputFraming: 'message',
    // ⚠️ `codex exec --json` has no partial-message flag measured on it. Conservative is the cheap
    // direction: declaring one that does not exist would put an unknown flag on every spawn.
    streamsPartialOutput: false,
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
    // ⚠️ The one adapter with a real boundary — and `grants.ts` widens it to reach the shared
    // `.git`, which is wider than one task. A boundary that is not the whole user account is
    // still the distinction a project is choosing between.
    headlessAuthority: 'sandboxed',
    interruptSequence: '\x1b',
    costModelId: 'openai.codex.2026-08',
    wrapUpProtocol: 'handoff',
    needsExplicitBudget: true
  },
  // Not investigated on codex. ⚠️ Absent because nobody has measured it, not because it is known
  // to be impossible - which is the honest state and the reason this field is nullable.
  usageRefresh: null,
  // Not measured on codex.
  firstRun: null,
  login: { kind: 'cli', argv: ['login'] },
  verification: {
    level: 'measured',
    asOf: '2026-09-03',
    note:
      'codex-cli 0.151.0 on Windows. Flag surface, CODEX_HOME and doctor JSON shape; the running CLI ' +
      'refreshed models_cache.json on 2026-09-03, listing gpt-5.6-sol as a visible model. Quota, the --json event ' +
      'shapes and the stdin contract re-measured against 0.151.0 on 2026-08-29: exec reads its ' +
      'prompt from stdin to EOF and blocks until the pipe closes, and turn.completed is both the ' +
      'usage record and the terminal one.'
  }
}

function envFor(isolationRoot: string): Record<string, string> {
  // ⛔ See `spawnEnv`. A codex session has no business inheriting the host Claude session's
  // identity either, and `CODEX_HOME` is set below to the root this worker was commissioned with.
  const env = spawnEnv()
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
    if (item?.type === 'error' && typeof item.message === 'string' && item.message) {
      return { kind: 'assistant_text', text: item.message }
    }
    return { kind: 'other', type }
  }

  if (type === 'turn.completed' || type === 'turn.failed') {
    const usage = asRecord(record.usage)
    const failed = type === 'turn.failed'
    const errorRecord = asRecord(record.error)
    const errorInfo =
      typeof record.codex_error_info === 'string'
        ? record.codex_error_info
        : typeof errorRecord?.codex_error_info === 'string'
          ? errorRecord.codex_error_info
          : null
    const errorText =
      typeof record.message === 'string'
        ? record.message
        : typeof record.error === 'string'
          ? record.error
          : typeof errorRecord?.message === 'string'
            ? errorRecord.message
            : errorInfo
    const result: StreamEvent = {
      kind: 'result',
      text: errorText,
      costUsd: null,
      isError: failed,
      terminalReason: type
    }
    // ⛔ Usage **and** result, in that order, and the result half was missing. `turn.completed` is
    // both the only usage record and the terminal one - `codex exec` runs a single turn and exits -
    // so returning usage alone meant a successful codex run produced no terminal event at all.
    // Nothing called `onStreamResult`, nothing completed the task, and the process exit landed in
    // `onSessionExit`, which can only report "ended without reporting completion" and hand the task
    // to a person. Every codex run would have finished its work and then been marked as failing to
    // finish. Measured 2026-08-29 against codex-cli 0.151.0.
    if (usage && !failed) return [{ kind: 'usage', usage: readUsage(usage), final: true }, result]
    return result
  }

  if (type === 'error') {
    const errorRecord = asRecord(record.error)
    const errorInfo =
      typeof record.codex_error_info === 'string'
        ? record.codex_error_info
        : typeof errorRecord?.codex_error_info === 'string'
          ? errorRecord.codex_error_info
          : null
    const errorText =
      typeof record.message === 'string'
        ? record.message
        : typeof record.error === 'string'
          ? record.error
          : typeof errorRecord?.message === 'string'
            ? errorRecord.message
            : errorInfo
    return {
      kind: 'result',
      text: errorText,
      costUsd: null,
      isError: true,
      terminalReason: 'error'
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

/**
 * Codex's rate-limit reading, and where it actually lives.
 *
 * ⛔ **The old note here — "Codex has no non-interactive usage command" — was true and irrelevant.**
 * It is a fact about *commands*, and the reading is not behind a command. Measured 2026-08-29 against
 * codex-cli **0.151.0**: every turn writes an `event_msg` / `token_count` record into the session's
 * rollout JSONL, and that record carries `rate_limits` verbatim from the server:
 *
 * ```
 * "rate_limits": { "limit_id": "codex", "plan_type": "free",
 *   "primary":   { "used_percent": 0, "window_minutes": 43200, "resets_at": 1790645009 },
 *   "secondary": null,
 *   "credits":   { "has_credits": false, "unlimited": false, "balance": null } }
 * ```
 *
 * So this is the **cheap rung** `probeWorker` was built for: a file read, no process, no token. It is
 * the same shape of source as claude-code's `cachedUsageUtilization` and it is dated the same way —
 * by the vendor's own timestamp, never by ours, so the staleness ladder in `quota.ts` can do its job.
 *
 * ⚠️ **The reading is exactly as old as this worker's last turn**, because nothing else writes it.
 * An idle codex worker goes stale and *should*; `refreshUsage`'s trick of making the cache current
 * has no equivalent here, since making it current means spending a turn.
 *
 * ⚠️ **`used_percent` is the server's snapshot at request time, so it lags the turn it arrives on.**
 * The 0% above was written by a turn that had already been billed.
 *
 * ⛔ **Only the free shape has been measured.** `secondary` was `null` and `primary` was a 30-day
 * window — which is why the window id is derived from `window_minutes` below and never from which
 * slot it arrived in. Reading `primary` as "the 5h window" would be right on a paid plan and wrong
 * here, and the gates in `reserve.ts` and `controller.ts` key on that id.
 */

/**
 * How long the app-server gets to answer before the probe falls back to the rollout.
 *
 * ⚠️ Generous relative to the ~700ms measured, because this call reaches the network and the
 * fallback is a worse reading rather than no reading. The poller runs every five minutes.
 */
const APP_SERVER_TIMEOUT_MS = 15_000

/** Rollout files are per-day; this bounds how far back a probe will look for a turn that had one. */
const ROLLOUT_SCAN_LIMIT = 5

/**
 * A window's id, from its length rather than its slot.
 *
 * ⛔ `5h` and `session` are the ids the scheduler's gates recognise (`reserve.ts`, `controller.ts`),
 * so a five-hour window has to be called `5h` whichever slot the server put it in. Everything longer
 * is named for what it is; a 30-day window is not a weekly one and must not be mistaken for it.
 */
function windowIdFor(minutes: number): string {
  if (minutes <= 300) return '5h'
  const days = Math.round(minutes / 1440)
  if (days >= 1) return `${days}d`
  return `${Math.max(1, Math.round(minutes / 60))}h`
}

/** Names used in the quota view. Codex's 5h and 7d pools are GPT limits, not generic clocks. */
function windowLabelFor(id: string): string {
  if (id === '5h' || id === '7d') return `GPT ${id}`
  return id
}

/** Newest-first day directories under `<CODEX_HOME>/sessions/YYYY/MM/DD`. */
function rolloutDayDirs(sessionsDir: string): string[] {
  const descend = (dir: string): string[] => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
        .reverse()
        .map((n) => join(dir, n))
    } catch {
      return []
    }
  }
  const out: string[] = []
  for (const year of descend(sessionsDir))
    for (const month of descend(year)) out.push(...descend(month))
  return out
}

/** The most recently written rollout files, newest first, capped. */
function recentRollouts(isolationRoot: string): string[] {
  const sessionsDir = join(isolationRoot, 'sessions')
  if (!existsSync(sessionsDir)) return []
  const found: Array<{ path: string; mtime: number }> = []
  for (const day of rolloutDayDirs(sessionsDir)) {
    let names: string[]
    try {
      names = readdirSync(day)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue
      const path = join(day, name)
      try {
        found.push({ path, mtime: statSync(path).mtimeMs })
      } catch {
        // A file that vanished between listing and stat is a live session rotating, not an error.
      }
    }
    // Day directories are already newest-first, so one populated day is usually enough.
    if (found.length >= ROLLOUT_SCAN_LIMIT) break
  }
  return found
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, ROLLOUT_SCAN_LIMIT)
    .map((f) => f.path)
}

/**
 * One window, in either spelling.
 *
 * ⚠️ The rollout record is snake_case and the app-server response is camelCase. They are the same
 * server payload rendered by two writers, so the reader accepts both rather than the caller
 * remembering which source it came from.
 */
interface CodexRateWindow {
  used_percent?: number
  usedPercent?: number
  window_minutes?: number
  windowDurationMins?: number | null
  resets_at?: number | null
  resetsAt?: number | null
}

interface CodexRateLimits {
  primary?: CodexRateWindow | null
  secondary?: CodexRateWindow | null
  plan_type?: string | null
  planType?: string | null
  credits?: {
    has_credits?: boolean
    hasCredits?: boolean
    unlimited?: boolean
    balance?: number | string | null
  } | null
}

/** The last `token_count` record carrying `rate_limits` in one rollout, or null. */
export function lastRateLimits(
  jsonl: string
): { limits: CodexRateLimits; at: number } | null {
  const lines = jsonl.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim()
    // Cheap reject before parsing: these files are mostly message payloads, and most of them are big.
    if (!line || !line.includes('"rate_limits"')) continue
    let rec: unknown
    try {
      rec = JSON.parse(line)
    } catch {
      // ⛔ A truncated last line is normal while a session is still writing. Keep walking back.
      continue
    }
    const obj = asRecord(rec)
    const payload = asRecord(obj?.payload)
    if (payload?.type !== 'token_count') continue
    const limits = asRecord(payload.rate_limits) as CodexRateLimits | undefined
    if (!limits) continue
    const at = typeof obj?.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN
    return { limits, at: Number.isFinite(at) ? at : Date.now() }
  }
  return null
}

/** `rate_limits` → the fleet's windows. Empty when the plan meters nothing this probe can show. */
export function windowsFromRateLimits(limits: CodexRateLimits): QuotaSnapshot['windows'] {
  const windows: QuotaSnapshot['windows'] = []
  for (const w of [limits.primary, limits.secondary]) {
    if (!w) continue
    const percent = w.used_percent ?? w.usedPercent
    const minutes = w.window_minutes ?? w.windowDurationMins
    if (typeof percent !== 'number' || typeof minutes !== 'number') continue
    const id = windowIdFor(minutes)
    // Two slots can only collide if the server sent the same window twice; keep the first.
    if (windows.some((x) => x.id === id)) continue
    const resets = w.resets_at ?? w.resetsAt
    windows.push({
      id,
      label: windowLabelFor(id),
      percent,
      // Unix seconds here, milliseconds everywhere in this project.
      resetsAt: typeof resets === 'number' ? resets * 1000 : null
    })
  }
  return windows
}

/**
 * ⭐ **Ask the account, on demand, for nothing.** Measured 2026-08-29 against codex-cli 0.151.0.
 *
 * `codex app-server` speaks JSON-RPC over stdio and answers `account/rateLimits/read` — no params,
 * **~700ms**, no turn, no token. It is what the TUI's `/status` is showing, and it is a *live server
 * call* rather than a cached one: two readings taken minutes apart returned `resetsAt` values 1311s
 * apart, which a cache cannot do.
 *
 * ⛔ This is why the rollout read below is the **fallback** and not the probe. The rollout is only
 * ever as fresh as the worker's last turn — an idle worker's reading ages forever — whereas this is
 * current every time it is asked. The fallback still earns its place: this call needs the network
 * and a working sign-in, and a stale number that exists beats a fresh one that could not be fetched.
 *
 * ⚠️ The response is **camelCase** (`usedPercent`, `windowDurationMins`) where the rollout record is
 * snake_case (`used_percent`, `window_minutes`). Same data, two spellings, one normaliser.
 */

export function parseJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.')
    const payload = parts[1]
    if (parts.length !== 3 || !payload) return null
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

export function formatPlan(plan?: string | null): string | null {
  if (!plan) return null
  const lower = plan.toLowerCase().trim()
  if (lower === 'plus') return 'Plus'
  if (lower === 'pro') return 'Pro'
  if (lower === 'free') return 'Free'
  if (lower === 'team') return 'Team'
  if (lower === 'enterprise') return 'Enterprise'
  if (lower === 'business') return 'Business'
  return plan.charAt(0).toUpperCase() + plan.slice(1)
}

export interface CodexAuthFile {
  auth_mode?: string
  OPENAI_API_KEY?: string
  tokens?: {
    id_token?: string
    access_token?: string
    refresh_token?: string
    account_id?: string
  }
  last_refresh?: string
}

export async function refreshTokensIfExpired(isolationRoot: string): Promise<boolean> {
  const authPath = join(isolationRoot, 'auth.json')
  if (!existsSync(authPath)) return false
  try {
    const raw = readFileSync(authPath, 'utf8')
    const auth = JSON.parse(raw) as CodexAuthFile
    const rt = auth.tokens?.refresh_token
    if (!rt) return false

    const accessPayload = auth.tokens?.access_token ? parseJwtPayload(auth.tokens.access_token) : null
    const exp = typeof accessPayload?.exp === 'number' ? accessPayload.exp * 1000 : 0
    if (exp > Date.now() + 60_000) {
      return true
    }

    const res = await fetch('https://auth.openai.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
        refresh_token: rt
      }),
      signal: AbortSignal.timeout(10_000)
    })
    if (!res.ok) {
      log.debug(`codex token refresh failed: HTTP ${res.status}`)
      return false
    }
    const data = (await res.json()) as {
      access_token?: string
      id_token?: string
      refresh_token?: string
    }
    if (data.access_token) {
      auth.tokens = {
        ...auth.tokens,
        access_token: data.access_token,
        ...(data.id_token ? { id_token: data.id_token } : {}),
        ...(data.refresh_token ? { refresh_token: data.refresh_token } : {})
      }
      auth.last_refresh = new Date().toISOString()
      writeFileSync(authPath, JSON.stringify(auth, null, 2), 'utf8')
      log.debug('codex access token refreshed successfully')
      return true
    }
  } catch (err) {
    log.debug('codex token refresh error:', err)
  }
  return false
}

export function readCodexAuthIdentity(isolationRoot: string): {
  account?: string
  subscriptionType?: string
  loggedIn: boolean
} | null {
  const authPath = join(isolationRoot, 'auth.json')
  if (!existsSync(authPath)) return null
  try {
    const auth = JSON.parse(readFileSync(authPath, 'utf8')) as CodexAuthFile
    if (auth.OPENAI_API_KEY) {
      return { loggedIn: true, subscriptionType: 'API Key' }
    }
    const idPayload = auth.tokens?.id_token ? parseJwtPayload(auth.tokens.id_token) : null
    const accessPayload = auth.tokens?.access_token ? parseJwtPayload(auth.tokens.access_token) : null
    const profile = asRecord(accessPayload?.['https://api.openai.com/profile'])
    const authClaim =
      asRecord(idPayload?.['https://api.openai.com/auth']) ??
      asRecord(accessPayload?.['https://api.openai.com/auth'])

    const email =
      (typeof idPayload?.email === 'string' && idPayload.email) ||
      (typeof profile?.email === 'string' && profile.email) ||
      undefined

    const rawPlan =
      (typeof authClaim?.chatgpt_plan_type === 'string' && authClaim.chatgpt_plan_type) ||
      undefined

    const subscriptionType = formatPlan(rawPlan) ?? undefined

    return {
      loggedIn: true,
      ...(email ? { account: email } : {}),
      ...(subscriptionType ? { subscriptionType } : {})
    }
  } catch (err) {
    log.debug('codex auth.json identity parse error:', err)
    return null
  }
}

async function readAccountRateLimits(isolationRoot: string): Promise<CodexRateLimits | null> {
  await refreshTokensIfExpired(isolationRoot)
  const resolved = which(info.command)
  if (!resolved) return null
  const { command, prefixArgs } = launchable(resolved)

  return await new Promise<CodexRateLimits | null>((resolve) => {
    const invocation = formatCmdInvocation(command, [...prefixArgs, 'app-server'])
    const child = spawn(invocation.command, invocation.args, {
      env: envFor(isolationRoot),
      stdio: ['pipe', 'pipe', 'pipe'],
      // ⛔ `windowsHide`, because this runs on the poller's five-minute tick and a console flashing
      // on the operator's desktop twice a minute across a fleet is not acceptable.
      windowsHide: true,
      ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {})
    })
    let settled = false
    /** ⛔ One exit path, and it always kills the child. An app-server left running is an orphan. */
    const finish = (value: CodexRateLimits | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child.stdin.end()
        child.kill()
      } catch {
        // Already gone. Nothing to do and nothing worth reporting.
      }
      resolve(value)
    }
    const timer = setTimeout(() => {
      log.debug('codex app-server did not answer account/rateLimits/read in time')
      finish(null)
    }, APP_SERVER_TIMEOUT_MS)

    child.on('error', (err) => {
      log.debug('codex app-server could not be started:', err)
      finish(null)
    })
    child.on('exit', () => finish(null))
    // ⚠️ Read but not surfaced: the server writes its own diagnostics here, and a probe that logged
    // them at warn on every tick would bury the log this project just built a viewer for.
    child.stderr.on('data', (c: Buffer) => log.debug(`codex app-server: ${c.toString().trim()}`))

    let buf = ''
    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString()
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        let msg: Record<string, unknown> | undefined
        try {
          msg = asRecord(JSON.parse(line)) ?? undefined
        } catch {
          continue
        }
        if (!msg) continue
        if (msg.id === 1) {
          // The handshake is answered; ask the one question and nothing else.
          if (child.stdin.writable) {
            child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`)
            child.stdin.write(
              `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read' })}\n`
            )
          }
        } else if (msg.id === 2) {
          const result = asRecord(msg.result)
          const limits = asRecord(result?.rateLimits) as CodexRateLimits | undefined
          finish(limits ?? null)
        }
      }
    })

    if (child.stdin.writable) {
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { clientInfo: { name: 'warmstart', title: 'quota probe', version: '1' } }
        })}\n`
      )
    }
  })
}

/**
 * The fallback rung: the newest rollout that recorded a `rate_limits`.
 *
 * ⚠️ Separate from `probeQuota` so it can be tested without a codex on PATH. Spawning the
 * app-server inside a unit test would make the result depend on whether the machine running the
 * suite happens to be signed in, which is the opposite of what these tests are for.
 */
export function rolloutQuota(isolationRoot: string): Omit<QuotaSnapshot, 'workerId'> {
  const files = recentRollouts(isolationRoot)
  if (files.length === 0) {
    return {
      windows: [],
      sampledAt: Date.now(),
      source: 'unknown',
      error:
        `codex app-server returned no reading and there are no rollout files under ` +
        `${join(isolationRoot, 'sessions')} yet`
    }
  }
  for (const file of files) {
    let found: ReturnType<typeof lastRateLimits>
    try {
      found = lastRateLimits(readFileSync(file, 'utf8'))
    } catch (err) {
      log.debug(`codex probeQuota could not read ${file}:`, err)
      continue
    }
    if (!found) continue
    const windows = windowsFromRateLimits(found.limits)
    if (windows.length === 0) {
      // ⚠️ A reading that names no window is still a fact: this account is metered by credits, or
      // by nothing this probe can render. Saying so beats an empty snapshot the operator reads as
      // a broken poller.
      return {
        windows: [],
        sampledAt: found.at,
        source: 'config-cache',
        error: found.limits.credits?.unlimited
          ? 'codex reports unlimited credits and no metered window'
          : `codex reported no rate-limit window (plan ${found.limits.plan_type ?? 'unknown'})`
      }
    }
    // The vendor's timestamp, not ours — same rule as claude-code. An idle worker goes stale here
    // and should: nothing but a turn can refresh this.
    return { windows, sampledAt: found.at, source: 'config-cache' }
  }
  return {
    windows: [],
    sampledAt: Date.now(),
    source: 'unknown',
    error: `no rate_limits record in the ${files.length} newest codex rollout(s)`
  }
}

/**
 * A credit balance out of `credits.balance`, defensively.
 *
 * ⛔ **Unparseable is `null`, never `0`.** The field is typed `number | string | null` in the
 * records this fleet has seen — a paid account answered the string `'0'` — and a purse read as zero
 * says *this account is out of money*, which is a sentence that stops work. `null` says *nobody
 * knows*, which is the truth and which the pipeline renders `n/a`.
 */
export function creditBalance(raw: number | string | null | undefined): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Codex's money meter: the credit purse, read off the same rollout the quota comes from.
 *
 * ⭐ **It was on disk the whole time.** `lastRateLimits` has parsed `credits` since M5 and used
 * exactly one field of it — `unlimited`, for an error string. The balance beside it was dropped, so
 * a fleet that could tell you what percentage of a window an account had used could not tell you
 * that its purse had fallen by $4 doing it. This is that number, and it costs what the quota read
 * costs: one file, no process, no token.
 *
 * ⛔ `usdPerUnit: null`, and it stays null until a vendor publishes a conversion. A credit is not a
 * dollar, and inventing a rate would put a fabricated number into a bill — `price.ts` renders an
 * unpriceable meter `n/a` and must be allowed to.
 *
 * ⚠️ Dated by the **vendor's** timestamp, like `rolloutQuota`: the rollout is only ever as fresh as
 * the worker's last turn, and an idle account's reading has to be allowed to age visibly.
 *
 * ⚠️ Separate from `probeSpend` for the same reason `rolloutQuota` is separate from `probeQuota` —
 * so it can be tested without a codex on PATH or a signed-in account.
 */
export function rolloutSpend(isolationRoot: string): Omit<SpendSnapshot, 'workerId'> {
  const files = recentRollouts(isolationRoot)
  if (files.length === 0) {
    return {
      meters: [],
      sampledAt: Date.now(),
      source: 'unknown',
      error:
        'there are no codex rollout files under ' +
        `${join(isolationRoot, 'sessions')} yet, so no credit balance has been written`
    }
  }
  for (const file of files) {
    let found: ReturnType<typeof lastRateLimits>
    try {
      found = lastRateLimits(readFileSync(file, 'utf8'))
    } catch (err) {
      log.debug(`codex probeSpend could not read ${file}:`, err)
      continue
    }
    if (!found) continue
    const credits = found.limits.credits
    // ⛔ The same account state `probeQuota` already reports, reported the same way: an unlimited
    // account has no meter, and saying so is not a failed probe. A meter invented for it would read
    // as a purse that never moves, which is indistinguishable from one nobody is spending from.
    if (credits?.unlimited === true) {
      return {
        meters: [],
        sampledAt: found.at,
        source: 'config-cache',
        error: 'codex reports unlimited credits, so there is no purse to meter'
      }
    }
    if (!credits) {
      return {
        meters: [],
        sampledAt: found.at,
        source: 'config-cache',
        error: 'codex reported rate limits with no `credits` block'
      }
    }
    return {
      meters: [
        {
          id: 'codex_credits',
          label: 'Codex credits',
          unit: 'credits',
          // ⚠️ A row with a null balance is still written by the store: the probe ran, and *what it
          // found* is that this account publishes no number. See spend.ts.
          balance: creditBalance(credits.balance),
          // A purse. It falls as work is done, and a rise is a top-up — not spend. See `attribute`.
          direction: 'balance_falls',
          usdPerUnit: null
        }
      ],
      sampledAt: found.at,
      source: 'config-cache'
    }
  }
  return {
    meters: [],
    sampledAt: Date.now(),
    source: 'unknown',
    error: `no rate_limits record in the ${files.length} newest codex rollout(s)`
  }
}

export const openaiCompatible: AgentAdapter = {
  info,
  decodeStream,

  /**
   * ⛔ Raw text, and deliberately not JSON. `codex exec` treats **everything on stdin** as the
   * prompt — there is no envelope to speak, so a `{"type":"user",...}` wrapper is not a protocol
   * mismatch that fails, it is a prompt whose first characters are `{"type":"user"`. The vendors
   * agree on the output side no more than the input side; see `decodeStream`.
   *
   * ⚠️ The newline `sendPrompt` appends is harmless here and the EOF after it is what matters. See
   * `capabilities.streamPrompts`.
   */
  encodeStreamPrompt: (text: string) => text,

  subscriptionExpired: (reason: string): boolean => {
    const said = reason.toLowerCase()
    return said.includes('subscription expired') || said.includes('subscription has expired')
  },

  /**
   * Remote provider overload / temporary backend outage errors for OpenAI / ChatGPT Codex backend.
   *
   * ⚠️ Measured: ChatGPT backend returning HTTP 404 from backend-api/codex/responses or HTTP 5xx/529.
   */
  overloaded: (reason: string): boolean => {
    const said = reason.toLowerCase()
    return (
      said.includes('529') ||
      said.includes('overloaded') ||
      said.includes('server-side issue') ||
      said.includes('status.openai.com') ||
      said.includes('backend-api/codex/responses') ||
      said.includes('503 service unavailable') ||
      said.includes('502 bad gateway') ||
      said.includes('504 gateway timeout')
    )
  },

  /**
   * Does this failure mean the account is out of quota for now, rather than broken?
   *
   * ⚠️ Measured, not imagined: verbatim what this CLI answered on CodexFirst on 2026-09-03 (t168) —
   * `You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit
   * https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 12:03 PM.`
   * and the rollout event payload `codex_error_info: "usage_limit_exceeded"`.
   *
   * ⛔ Anchored on specific quota/usage limits, never on "error" alone: an ordinary tool error or
   * command failure must not be mistaken for a quota exhaustion.
   */
  outOfQuota: (reason: string): boolean => {
    const said = reason.toLowerCase()
    return (
      said.includes('usage limit') ||
      said.includes('usage_limit_exceeded') ||
      said.includes('rate limit exceeded') ||
      said.includes('rate_limit_exceeded') ||
      said.includes('rate limit reached') ||
      said.includes('hit your usage limit') ||
      said.includes('exceeded your current quota') ||
      said.includes('insufficient_quota') ||
      (said.includes('try again at') &&
        (said.includes('limit') || said.includes('quota') || said.includes('credits'))) ||
      (said.includes('purchase more credits') &&
        (said.includes('limit') || said.includes('usage') || said.includes('upgrade to pro')))
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
        error: errorMessage(err)
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
    await refreshTokensIfExpired(isolationRoot)
    const authIdent = readCodexAuthIdentity(isolationRoot)

    const resolved = which(info.command)
    let cliVersion: string | undefined
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
        if (report.codexVersion) {
          cliVersion = report.codexVersion
        }
      } catch (err) {
        log.debug('codex doctor --json unavailable, falling back to a file check:', err)
      }
    }

    if (authIdent) {
      return {
        loggedIn: authIdent.loggedIn,
        ...(authIdent.account ? { account: authIdent.account } : {}),
        ...(authIdent.subscriptionType ? { subscriptionType: authIdent.subscriptionType } : {}),
        ...(cliVersion ? { cliVersion } : {}),
        raw: JSON.stringify({
          loggedIn: authIdent.loggedIn,
          account: authIdent.account ?? null,
          subscriptionType: authIdent.subscriptionType ?? null,
          source: 'auth.json'
        })
      }
    }

    const auth = join(isolationRoot, 'auth.json')
    return existsSync(auth)
      ? {
          loggedIn: true,
          ...(cliVersion ? { cliVersion } : {}),
          raw: JSON.stringify({ loggedIn: true, source: 'auth.json exists' })
        }
      : {
          loggedIn: false,
          raw: JSON.stringify({ loggedIn: false, reason: `no auth.json in ${isolationRoot}` })
        }
  },

  /**
   * Ask the app-server; fall back to the newest rollout. Both free. See `readAccountRateLimits`.
   *
   * ⚠️ The two rungs report **different `source` values on purpose**, because they are not equally
   * trustworthy and `sampledAt` alone cannot say so. `'cli'` is a reading taken *now*; `'config-cache'`
   * is one left behind by a turn, dated when that turn happened, and the staleness ladder in
   * `quota.ts` treats it accordingly.
   */
  async probeQuota(isolationRoot: string): Promise<Omit<QuotaSnapshot, 'workerId'>> {
    const live = await readAccountRateLimits(isolationRoot)
    if (live) {
      const windows = windowsFromRateLimits(live)
      // ⚠️ An answer with no window still beats the rollout: it is current, and it is the account
      // saying it meters nothing rather than this worker never having run.
      if (windows.length > 0) return { windows, sampledAt: Date.now(), source: 'cli' }
      if (live.credits?.unlimited === true) {
        return {
          windows: [],
          sampledAt: Date.now(),
          source: 'cli',
          error: 'codex reports unlimited credits and no metered window'
        }
      }
    }

    return rolloutQuota(isolationRoot)
  },

  /**
   * The credit purse, off the newest rollout.
   *
   * ⛔ **The rollout only, deliberately, where `probeQuota` asks the app-server first.** The live
   * call answers `account/rateLimits/read` in ~700ms and spawns a process to do it; this reading is
   * in the same file the quota fallback already reads, and it rides beside a probe that has just run.
   * Spending a process on the second copy of a number the first one left on disk is the kind of cost
   * this whole adapter was written to avoid.
   */
  async probeSpend(isolationRoot: string): Promise<Omit<SpendSnapshot, 'workerId'>> {
    return rolloutSpend(isolationRoot)
  },

  /**
   * Write the project's rules into this worker's own `config.toml`.
   *
   * Unlike Antigravity this touches **only the isolation root agentyard created**, never a shared
   * user-level file — which is what `CODEX_HOME` buys.
   */
  writePermissions(isolationRoot: string, rules: PermissionRules): WrittenPermissions {
    const path = join(isolationRoot, 'warmstart.config.toml')
    try {
      mkdirSync(isolationRoot, { recursive: true })
      const lines = [
        '# Written by Warmstart before each session. Edits are overwritten.',
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
      return { path: null, error: errorMessage(err) }
    }
  },

  /**
   * Pre-answer Codex's "do you trust this directory?" dialog and sandbox configuration.
   *
   * ⛔ Codex asks both "Do you trust the contents of this directory?" and sandbox setup
   * on Windows in fresh CODEX_HOME roots. Unanswered, they swallow all input in interactive/PTY sessions.
   * Writing config.toml in CODEX_HOME pre-answers both.
   */
  trustDirectory(isolationRoot: string, dir: string): void {
    const file = join(isolationRoot, 'config.toml')
    try {
      mkdirSync(isolationRoot, { recursive: true })
      const content = existsSync(file) ? readFileSync(file, 'utf8') : ''
      const normalDir = dir.toLowerCase()

      let updated = content
      if (!content.includes('[windows]')) {
        updated = `[windows]\nsandbox = "elevated"\n\n` + updated
      }
      if (!content.includes(`[projects.'${normalDir}']`) && !content.includes(`[projects.'${dir}']`)) {
        updated = updated.trim() + `\n\n[projects.'${dir}']\ntrust_level = "trusted"\n`
      }
      if (updated.trim() !== content.trim()) {
        writeFileSync(file, updated.trim() + '\n')
        log.info(`pre-trusted ${dir} for codex in ${file}`)
      }
    } catch (err) {
      log.warn(`could not record folder trust in ${file}:`, err)
    }
  },

  plan(req: SpawnRequest): SpawnPlan {
    const env = envFor(req.isolationRoot)
    const resolved = which(info.command)
    if (!resolved) throw new Error(`'${info.command}' is not on PATH`)
    const { command, prefixArgs } = launchable(resolved)

    if (req.argv) return { command, args: [...prefixArgs, ...req.argv], env }

    const args: string[] = []
    // ⛔ Stream only. `resumeFrom` on a `pty` session would be handed to the interactive TUI, which
    // takes its conversation back a different way entirely; a headless resume is what the scheduler
    // is asking for, and `exec resume` is the only thing that provides one.
    const resumeId = req.transport === 'stream' ? req.resumeFrom : undefined
    if (req.transport === 'stream') {
      // `codex exec` is the headless entry point; the interactive TUI has no subcommand.
      // ⛔ `--json`, not `--output-format`: measured, `exec` has no `--output-format` flag.
      args.push('exec', '--json')
      args.push('--sandbox', req.permissionMode ?? info.policy.defaultPermissionMode)
      args.push('--cd', req.cwd)
      // ⛔ Without this the agent can edit and can never commit. `workspace-write` makes `cwd`
      // writable, and a pooled worktree keeps its index, objects and refs in the trunk's `.git`
      // — outside it. Measured on t56, 2026-08-30: three runs, ~1.8M tokens, every commit refused
      // at `.git/worktrees/ws1/index.lock`. See `gitWritableRoots` for what this grants and why
      // there is no narrower grant.
      for (const root of gitWritableRoots(req.cwd)) {
        if (process.platform === 'win32') {
          try {
            execFileSync('icacls', [root, '/reset', '/t', '/c'], {
              stdio: 'ignore',
              windowsHide: true,
              timeout: 5000
            })
          } catch {
            // Resetting inherited ACLs is a best-effort workaround for sandbox-created worktrees.
          }
        }
        args.push('--add-dir', root)
      }
      // ⛔ And the directories a link inside the workspace points *out* of it at — a
      // `node_modules` junction to the trunk's is the one this install has. Measured on t171,
      // 2026-09-03: `npm test` in `ws2` died at `EPERM` writing `node_modules/.vite-temp/…`, before
      // any test ran, while the same commands passed in `ws1` and `ws3`. See `linkedWritableRoots`.
      // ⚠️ No `icacls` reset for these, and here the asymmetry is a budget rather than a
      // preference: the call above is `/t` recursive and capped at 5s, and a shared `node_modules`
      // is six figures of files. It would time out on every spawn and fix nothing — what was
      // missing is the grant, not the ACLs.
      for (const root of linkedWritableRoots(req.cwd)) args.push('--add-dir', root)
      // ⛔ Here, ahead of any `resume`, rather than beside the `-i` flags they belong to.
      // `--add-dir` is declared on `exec` and **not on the `resume` subcommand** (measured against
      // `codex exec resume --help`, codex-cli 0.151.0), so a grant written after the subcommand
      // name is an argument error instead of a grant. Every directory this run may read has to be
      // named before it.
      // ⚠️ No `icacls` reset for these, and the asymmetry is deliberate: the grant above is for
      // worktrees this fleet created, which can inherit ACLs the sandbox cannot read past. The
      // attachment store is ours and was never made by a sandboxed process.
      for (const dir of attachmentDirs(req.attachments ?? [])) args.push('--add-dir', dir)
      // `exec` refuses to start outside a git repository. agentyard's pooled worktrees are git, but a
      // project declared `vcs: none` is not, and refusing to start is a worse failure than running.
      args.push('--skip-git-repo-check')
      // ⛔ Deliberately absent: `--ask-for-approval` is interactive-only and would be an argument
      // error here, and `--dangerously-bypass-approvals-and-sandbox` removes the only boundary left.
    }
    // ⭐ The subcommand, after everything `exec` owns and before everything `resume` owns.
    if (resumeId) args.push('resume')
    // ⛔ `-i` per image. The matching `--add-dir` grants went in above: the sandbox is
    // `workspace-write` and the attachment store is outside the worktree, so without the grant
    // codex can be handed a path it is then forbidden to read — which is the one failure the path
    // fallback exists to prevent.
    for (const attachment of req.attachments ?? []) {
      if (attachment.kind === 'image') args.push('-i', attachment.file)
    }
    if (req.model) args.push('--model', req.model)
    // ⛔ Last, and in this order: `exec resume [OPTIONS] [SESSION_ID] [PROMPT]`. The `-` is the
    // PROMPT and it means *read the prompt from stdin* — the same one-shot channel a fresh `exec`
    // uses, so `sendPrompt` needs no branch for this. Without it, resume prints `No prompt provided
    // via stdin` and exits **0** having done nothing, which is the quietest possible failure.
    if (resumeId) args.push(resumeId, '-')
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
