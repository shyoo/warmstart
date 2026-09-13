import type { Attachment } from '@shared/tasks.js'
import { attachmentBytes, attachmentDirs } from '../attachments.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AdapterDetection,
  AdapterInfo,
  CreditStatus,
  QuotaSnapshot,
  QuotaWindow,
  SpendMeter,
  SpendSnapshot
} from '@shared/protocol.js'
import type { AgentAdapter, IdentityProbe, SpawnPlan, SpawnRequest } from './types.js'
import { workspaceGrants } from './grants.js'
import {
  asRecord,
  num,
  textBlocks,
  toolBlocks,
  toolLine,
  type DecodeContext,
  type StreamEvent
} from '../stream.js'
import { log } from '../log.js'
import { launchArgs, launchable, spawnEnv, which } from '../which.js'
import { APPROVE_TOOL } from '../mcpconfig.js'
import { paths } from '../paths.js'
import { errorMessage } from '@shared/errors.js'

const run = promisify(execFile)

const info: AdapterInfo = {
  id: 'claude-code',
  label: 'Claude Code',
  command: 'claude',
  isolationEnvVar: 'CLAUDE_CONFIG_DIR',
  capabilities: {
    transports: ['pty', 'stream'],
    permissionModes: ['default', 'manual', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'],
    readOnlyPermissionMode: 'plan',
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
    // ⭐ **Money arrives unasked here too**, and both halves are kept. The `result` record carries
    // `total_cost_usd` and the `rate_limit_event` carries `isUsingOverage` / `overageStatus`, all of
    // which still ride a turn already being paid for and still feed `creditRunListUsd` and
    // `markRunOverage`. ⚠️ `total_cost_usd` on a subscription is the **API-equivalent list price**,
    // not money out of pocket — see `creditRunListUsd` in tasks.ts.
    //
    // ⛔ **`config-cache` rather than `stream`, since t271.** What the stream reports is *whether*
    // a turn was billed as extra usage; it never reports **how much**, and a boolean cannot answer
    // "what did these credits cost me". The amount is in `.claude.json` under
    // `cachedUsageUtilization.utilization.spend` — a file this adapter already opens for quota, on a
    // cache the `/usage` drive already refreshes — so the reading costs a `readFileSync` and no turn.
    // Measured 2026-09-07 on 2.1.263. See `probeSpend`.
    spendProbe: 'config-cache',
    // stdin stays open and takes prompt after prompt; that is what the stream transport is for.
    streamPrompts: 'conversation',
    // One `{"type":"assistant"}` record per message, its text blocks joined. Whole prose, own
    // linebreaks, and the next record is a new message rather than more of this one.
    outputFraming: 'message',
    // ⭐ Measured 2026-09-13 on 2.1.270: `--include-partial-messages` turned one seven-line turn into
    // eighty-one, carrying `content_block_delta` with `text_delta` for prose. ⚠️ It does **not**
    // carry the thinking words — `thinking_delta.thinking` is the empty string with the flag exactly
    // as without it — so what this capability buys is prose appearing as it is typed, and nothing else.
    streamsPartialOutput: true,
    // `--session-id` takes a uuid we choose, which is what makes the transcript path knowable before
    // the file exists and what lets orphan reaping prove a pid is ours.
    mintsSessionId: true,
    // JSONL, one record per event, summing usage.iterations[]. The exactness the cost model is built on.
    metering: 'transcript',
    // CLAUDE_CONFIG_DIR points the CLI at one account's directory, so a fleet is just directories.
    maxAccounts: null
  },
  policy: {
    // Plan §9.1. ⚠️ `auto` is the built-in start mode only for a terminal session on Pro/Max/Team,
    // so it has to be passed on every spawn or an interactive session silently runs Manual.
    defaultPermissionMode: 'auto',
    // ⛔ **`auto` does not survive `-p`, and passing it there was doing nothing.** The note above
    // used to end "so it has to be passed on every spawn", and it was — `--permission-mode auto`
    // went onto every headless dispatch and the CLI dropped it on the floor. Measured 2026-09-06 on
    // 2.1.263: the flag is a valid choice, the process starts without a word of complaint, and the
    // `init` record it prints says `"permissionMode":"default"`. `acceptEdits`, `plan`, `dontAsk`
    // and `bypassPermissions` all come back as themselves; `auto` alone does not — not by flag, and
    // not by a `permissions.defaultMode` in `--settings` either. t250 is what that cost: nine
    // approvals in one hour for `git log`, `npm test` and the project's own checks, two of them left
    // to time out into a deny, because the classifier this fleet was relying on had never run.
    //
    // ⚠️ `dontAsk` is not the substitute it sounds like. Measured the same day, it *denies* what it
    // will not ask about ("I don't have permission to run shell commands"), which is the stall again
    // with nobody there to end it. The mode named here is the only headless one that lets a worker
    // finish, and it is the call this project already made for antigravity (`docs/adapters.md`):
    // quarantined inside an isolated pooled worktree, gated by the mandate and by the landing
    // checks, on a branch nobody has to keep.
    headlessPermissionMode: 'bypassPermissions',
    // ⛔ There is no OS boundary here at all: a dispatched task runs with this user's full
    // authority. Stated so a project can refuse it, not as an aspiration to fix it in place.
    headlessAuthority: 'full-user',
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

// ------------------------------------------------------------------ usage credits ("extra usage")

/**
 * The parts of `.claude.json` this adapter reads for money, measured 2026-09-07 on 2.1.263.
 *
 * ⚠️ Every field optional and every value nullable, because that is how the vendor writes them: on
 * an account with credits off, `used_credits`, `monthly_limit`, `currency` and `balance` are all
 * `null` — which is *not reported*, and must never become `0`.
 *
 * ⭐ **Credits off is two different situations wearing one field, measured 2026-09-13 on 2.1.270
 * (`ClaudeFirst`).** There the numbers are *not* null: `used_credits: 2057` past
 * `monthly_limit: 1730`, `utilization: 100`, `spend_limit_reached: true`,
 * `disabled_reason: "org_level_disabled_until"` — while `hasExtraUsageEnabled: true` and
 * `user_disabled: false` say the operator's own switch is on. So the vendor turned credits off
 * because the month's allowance ran out, and an account that never had them is the same
 * `is_enabled: false`. `spend_limit_reached` is the only field that separates them; the reason
 * string is recorded and never matched on, which is why the `_until` suffix 2.1.270 added to
 * `org_level_disabled` changed no behaviour here.
 */
interface ClaudeConfigShape {
  cachedUsageUtilization?: {
    fetchedAtMs?: number
    utilization?: {
      spend?: ClaudeSpendShape
      extra_usage?: ClaudeExtraUsageShape
    }
  }
  oauthAccount?: { hasExtraUsageEnabled?: boolean | null; subscriptionCreatedAt?: string | null }
  cachedExtraUsageDisabledReason?: string | null
}

interface ClaudeMoneyShape {
  amount_minor?: number | null
  currency?: string | null
  exponent?: number | null
}

interface ClaudeSpendShape {
  /** ⛔ Minor units and an exponent, never a float: `{ amount_minor: 1234, exponent: 2 }` is $12.34. */
  used?: ClaudeMoneyShape | null
  limit?: ClaudeMoneyShape | number | null
  enabled?: boolean | null
  disabled_reason?: string | null
  /** A purse, where the vendor publishes one. ⚠️ `null` on both measured accounts. */
  balance?: number | null
  can_toggle?: boolean | null
}

interface ClaudeExtraUsageShape {
  is_enabled?: boolean | null
  monthly_limit?: number | null
  used_credits?: number | null
  currency?: string | null
  decimal_places?: number | null
  disabled_reason?: string | null
  user_disabled?: boolean | null
  /** ⛔ The vendor saying *the allowance ran out*, which `is_enabled: false` alone cannot say. */
  spend_limit_reached?: boolean | null
  credits_ever_enabled?: boolean | null
}

/** `{ amount_minor: 3787, exponent: 2 }` → `37.87`. Also handles raw numbers. ⚠️ `null` for anything not fully reported. */
function majorUnits(amount: ClaudeMoneyShape | number | null | undefined): number | null {
  if (amount === null || amount === undefined) return null
  if (typeof amount === 'number') return Number.isFinite(amount) ? amount : null
  const minor = amount.amount_minor
  if (typeof minor !== 'number' || !Number.isFinite(minor)) return null
  const exponent = typeof amount.exponent === 'number' ? amount.exponent : 2
  return minor / 10 ** exponent
}

/** Converts extra_usage amount which uses decimal_places. E.g. 4000 with decimal_places=2 → 40. */
function extraAmount(value: unknown, decimalPlaces?: number | null): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (typeof decimalPlaces === 'number' && Number.isFinite(decimalPlaces) && decimalPlaces > 0) {
    return value / 10 ** decimalPlaces
  }
  return value
}

/**
 * The meters `utilization.spend` describes.
 *
 * ⛔ Two shapes, and they move in opposite directions. `used` is a **cumulative counter** reset each
 * billing month — `direction: 'spend_rises'`, whose documented meaning is that *a fall is a
 * rollover*, which is exactly the monthly reset and is already handled by `price.ts::attribute()`.
 * `balance` is a **purse** drawn down by spending, where a rise is a top-up.
 *
 * ⚠️ A meter is emitted only where the vendor actually published a number. An absent meter is a
 * different statement from a meter reading zero, and only one of them is true here.
 */
function spendMeters(spend: ClaudeSpendShape | undefined, creditsEnabled?: boolean): SpendMeter[] {
  if (!spend) return []
  // ⛔ Claude keeps `spend.used.amount_minor: 0` in the usage cache after the operator turns
  // credits off. That is the shape of an unavailable balance, not evidence that the accumulated
  // counter reset: `extra_usage.is_enabled` is the vendor's direct statement of which one it is.
  // Reporting that zero would turn a previous $20.57 reading into a fabricated $0.00 run delta.
  //
  // ⭐ But *only* the zero. Credits off with a **non-zero** counter is the case measured
  // 2026-09-13 on 2.1.270: `used: 2057` (`$20.57`) with `is_enabled: false`, because the vendor
  // cut credits off when the allowance ran out. Dropping every meter on `enabled === false`
  // stopped metering overage cash at the exact moment the most of it had been spent — the last
  // run before the cut-off got one reading and no second, so it priced as `null` — and left the
  // strip drawing no credit gauge at all for an account with $20.57 on the clock.
  const suppressCounter = creditsEnabled === false && (majorUnits(spend.used) ?? 0) === 0
  const meters: SpendMeter[] = []
  const currency = spend.used?.currency ?? null
  // ⚠️ `usdPerUnit` is 1 only because the measured accounts bill in USD. A vendor reporting another
  // currency is **real but unpriceable** — `null`, which renders as `n/a` and never as $0.00.
  const usdPerUnit = currency === null || currency === 'USD' ? 1 : null

  const used = majorUnits(spend.used)
  if (used !== null && !suppressCounter) {
    meters.push({
      id: 'claude-extra-usage',
      label: 'Claude usage credits',
      unit: 'usd',
      balance: used,
      direction: 'spend_rises',
      usdPerUnit
    })
  }
  if (typeof spend.balance === 'number' && Number.isFinite(spend.balance)) {
    meters.push({
      id: 'claude-credit-balance',
      label: 'Claude credit balance',
      unit: 'usd',
      balance: spend.balance,
      direction: 'balance_falls',
      usdPerUnit
    })
  }
  return meters
}

/**
 * What the vendor says about this account spending past its plan limit.
 *
 * ⛔ **Precedence, not a vote.** Three fields describe this in three places, written by three code
 * paths: `extra_usage.is_enabled` is the vendor's direct statement, `spend.enabled` mirrors it on
 * the money block, and `oauthAccount.hasExtraUsageEnabled` is an account-level cache that can lag a
 * change made elsewhere. The first one actually present wins, and an explicit `false` from a
 * higher-precedence field is **not** overridden by a lower one saying `true`.
 *
 * ⛔ **Which way the doubt falls is a money decision.** This value is what stands the quota guards
 * down (`spendingCreditsOn`), so reading `true` when the truth is `false` pushes a run into an
 * exhausted window expecting a reprieve that is not there — it loses the wrap-up, the commit and
 * the handoff, and gets a hard vendor refusal instead. Reading `false` when the truth is `true`
 * costs one early wrap-up. An OR across all three would take the cheerful answer from whichever
 * field was most stale; precedence takes it from whichever field is most direct.
 *
 * ⚠️ `disabledReason` prefers the per-reading value and falls back to the top-level cache, which is
 * where 2.1.263 actually wrote `org_level_disabled` on both measured accounts.
 */
/**
 * When this account's monthly credits purse refills, as a timestamp — or `null` where unknown.
 *
 * ⛔ **Inferred, not published.** Measured 2026-09-07 across three live accounts: neither
 * `extra_usage`, `spend` nor `limits[]` carries a credits reset date (the limits carry only the 5h
 * and 7d windows). What the vendor *does* publish is `oauthAccount.subscriptionCreatedAt`, and
 * extra usage is a monthly allowance on a `stripe_subscription` — so the refill is taken to be the
 * subscription-month anniversary. If the vendor ever publishes the date itself, that replaces this.
 */
export function creditsResetAt(subscriptionCreatedAt: string | null | undefined, now: number): number | null {
  if (!subscriptionCreatedAt) return null
  const start = Date.parse(subscriptionCreatedAt)
  if (!Number.isFinite(start)) return null
  // ⚠️ UTC throughout: a billing anniversary is a calendar date, and local DST must not move it.
  const anchor = new Date(start)
  const day = anchor.getUTCDate()
  const time = [anchor.getUTCHours(), anchor.getUTCMinutes(), anchor.getUTCSeconds(), anchor.getUTCMilliseconds()]
  const at = (y: number, m: number): number => {
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
    return Date.UTC(y, m, Math.min(day, last), time[0], time[1], time[2], time[3])
  }
  const nowDate = new Date(now)
  let y = nowDate.getUTCFullYear()
  let m = nowDate.getUTCMonth()
  let candidate = at(y, m)
  // A refresh later today is still ahead; one already past rolls to next month. Twelve steps is
  // more than enough and bounds the loop absolutely.
  for (let i = 0; i < 12 && candidate <= now; i++) {
    m += 1
    if (m > 11) {
      m = 0
      y += 1
    }
    candidate = at(y, m)
  }
  return candidate > now ? candidate : null
}

function creditStatus(parsed: ClaudeConfigShape, now: number = Date.now()): CreditStatus | null {
  const spend = parsed.cachedUsageUtilization?.utilization?.spend
  const extra = parsed.cachedUsageUtilization?.utilization?.extra_usage
  const account = parsed.oauthAccount
  if (!spend && !extra && account?.hasExtraUsageEnabled === undefined) return null

  const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)

  return {
    enabled:
      bool(extra?.is_enabled) ??
      bool(spend?.enabled) ??
      bool(account?.hasExtraUsageEnabled) ??
      false,
    userDisabled: bool(extra?.user_disabled),
    disabledReason:
      str(extra?.disabled_reason) ?? str(spend?.disabled_reason) ?? str(parsed.cachedExtraUsageDisabledReason),
    canToggle: bool(spend?.can_toggle),
    everEnabled: bool(extra?.credits_ever_enabled),
    spendLimitReached: bool(extra?.spend_limit_reached),
    monthlyLimit: extraAmount(extra?.monthly_limit, extra?.decimal_places) ?? majorUnits(spend?.limit),
    used: extraAmount(extra?.used_credits, extra?.decimal_places) ?? majorUnits(spend?.used),
    currency: str(extra?.currency) ?? str(spend?.used?.currency),
    resetsAt: creditsResetAt(account?.subscriptionCreatedAt, now)
  }
}

/** Exported for the tests, which drive it with payloads captured off the live accounts. */
export const claudeCredits = { creditStatus, spendMeters, majorUnits, extraAmount, creditsResetAt }

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
/**
 * The five windows `unifiedWindows` can name, under the ids the config-cache probe already uses.
 *
 * ⛔ **The ids have to agree with `probeQuota`'s or the two readings are two accounts.** Every gate
 * downstream keys on the window id — `isSessionRateWindow`, `sessionWindowFor`, the reset countdown
 * — so a live reading calling the five-hour pool `five_hour` where the cache calls it `session`
 * would read as a *different* window that happened to be at the same percentage. Measured on this
 * install 2026-09-13: the cache publishes `session` / `weekly_all`, labelled `Claude 5h` / `Claude 7d`.
 *
 * ⚠️ A key this does not recognise is skipped rather than guessed at. `quota.ts` then declines to
 * publish the reading at all rather than losing a window nobody mapped — see `recordRateLimit`.
 */
const UNIFIED_WINDOWS: Record<string, { id: string; label: string }> = {
  five_hour: { id: 'session', label: 'Claude 5h' },
  seven_day: { id: 'weekly_all', label: 'Claude 7d' },
  seven_day_opus: { id: 'weekly_opus', label: 'Claude 7d Opus' }
}

/**
 * `{five_hour: {utilization: 0.12, resetsAt: 1789342200}}` → the fleet's own window shape.
 *
 * ⚠️ `utilization` is a **fraction**, not a percentage: measured 0.12 against a `/usage` reading of
 * 12%. Multiplying is the whole conversion, and getting it the wrong way round would put every
 * account at 0% of its window forever, which is the direction that spends quota rather than saving it.
 */
function unifiedWindows(value: unknown): QuotaWindow[] {
  const record = asRecord(value)
  if (!record) return []
  const windows: QuotaWindow[] = []
  for (const [key, raw] of Object.entries(record)) {
    const known = UNIFIED_WINDOWS[key]
    const window = asRecord(raw)
    if (!known || !window || typeof window.utilization !== 'number') continue
    windows.push({
      id: known.id,
      label: known.label,
      percent: Math.max(0, Math.min(100, window.utilization * 100)),
      resetsAt: typeof window.resetsAt === 'number' ? window.resetsAt * 1000 : null
    })
  }
  return windows
}

/**
 * One Claude Code tool call, as a line.
 *
 * ⚠️ The vocabulary is `antigravity-cli`'s, deliberately: `activity.proseOf` skips exactly these
 * prefixes when it pulls an agent's *prose* out of the peephole, and a line that spells itself
 * differently gets quoted back to a thread as though the agent had written it.
 */
function describeTool(tool: { name: string; input: Record<string, unknown> }): StreamEvent {
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
  const { name, input } = tool
  const command = str(input.command)
  const path = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path)
  const pattern = str(input.pattern)
  const url = str(input.url)
  const query = str(input.query)

  // ⛔ A shell command is the one argument worth carrying whole: it is what an operator watching a
  // run actually wants to read, and it is also the longest. The summary is capped by the peephole;
  // `detail` is what the session pane opens.
  if (command) return { kind: 'tool_use', name, summary: toolLine('run', command), detail: command }
  if (path) return { kind: 'tool_use', name, summary: toolLine('Tool', `${name} ${path}`), detail: path }
  if (pattern) return { kind: 'tool_use', name, summary: toolLine('search', pattern), detail: str(input.path) }
  if (url) return { kind: 'tool_use', name, summary: toolLine('fetch', url), detail: url }
  if (query) return { kind: 'tool_use', name, summary: toolLine('search', query), detail: null }
  // ⚠️ `description` last rather than first: several tools carry both a real argument and a prose
  // description of it, and the argument is the thing that can be checked.
  const description = str(input.description) ?? str(input.prompt)
  return {
    kind: 'tool_use',
    name,
    summary: toolLine('Tool', description ? `${name} — ${description}` : name),
    detail: description
  }
}

function decodeStream(
  record: Record<string, unknown>,
  ctx?: DecodeContext
): StreamEvent | StreamEvent[] | null {
  const type = typeof record.type === 'string' ? record.type : ''

  if (type === 'rate_limit_event') {
    const info = asRecord(record.rate_limit_info)
    if (!info) return null
    const windows = unifiedWindows(info.unifiedWindows)
    return {
      kind: 'rate_limit',
      info: {
        status: typeof info.status === 'string' ? info.status : 'unknown',
        // The CLI reports seconds; everything in agentyard is epoch milliseconds.
        resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt * 1000 : null,
        rateLimitType: typeof info.rateLimitType === 'string' ? info.rateLimitType : 'unknown',
        ...(typeof info.overageStatus === 'string' ? { overageStatus: info.overageStatus } : {}),
        ...(typeof info.isUsingOverage === 'boolean' ? { isUsingOverage: info.isUsingOverage } : {}),
        ...(typeof info.overageResetsAt === 'number'
          ? { overageResetsAt: info.overageResetsAt * 1000 }
          : {}),
        ...(windows.length > 0 ? { windows } : {})
      }
    }
  }

  // ⭐ The thinking phase, as a phase. There is nothing else to have — see `StreamEvent.thinking`.
  // ⚠️ Arrives with **no flag**: measured 2026-09-13 on 2.1.270, a plain `--output-format stream-json
  // --verbose` turn emitted two of these. `--include-partial-messages` makes them more frequent and
  // adds nothing they do not already carry.
  if (type === 'system' && record.subtype === 'thinking_tokens') {
    const tokens = num(record.estimated_tokens)
    const delta = num(record.estimated_tokens_delta)
    return { kind: 'thinking', tokens, start: tokens > 0 && tokens === delta }
  }

  // The partial-output rung. ⛔ Only the two deltas that say something a whole record does not:
  // prose as it is typed, and a thinking estimate that ticks while it is still thinking. Every
  // other `stream_event` is the framing of a record that arrives whole a moment later.
  if (type === 'stream_event') {
    const event = asRecord(record.event)
    if (event?.type !== 'content_block_delta') return { kind: 'other', type }
    const delta = asRecord(event.delta)
    if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
      return { kind: 'assistant_delta', text: delta.text }
    }
    if (delta?.type === 'thinking_delta') {
      // ⚠️ `delta.thinking` is the empty string here, every time. The estimate is the content.
      return { kind: 'thinking', tokens: num(delta.estimated_tokens), start: false }
    }
    return { kind: 'other', type }
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
    const events: StreamEvent[] = []
    const text = textBlocks(record.message)
    // A tool-use-only turn carries no prose. Reporting it as empty text would make a chat pane look
    // like the controller answered with nothing.
    // ⚠️ `streamed` when the caller asked for partial output: the words are already on the screen a
    // character at a time, and the peephole still needs this framed copy.
    if (text) {
      events.push({
        kind: 'assistant_text',
        text,
        ...(ctx?.partialMessages ? { streamed: true } : {})
      })
    }
    // ⛔ **What used to be dropped on the floor.** Measured 2026-09-13 on a real 1,679-record
    // session: 814 of these records carried a tool call and 1,310 carried no prose at all, so the
    // agent's whole working day was invisible between one paragraph and the next.
    for (const tool of toolBlocks(record.message)) events.push(describeTool(tool))
    return events.length === 0 ? { kind: 'other', type } : events.length === 1 ? events[0]! : events
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

  /**
   * ⚠️ Measured, not imagined: verbatim what this CLI answered on 2026-09-03 (t153):
   * `api_error: API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment. If it persists, check https://status.claude.com.`
   *
   * ⛔ Anchored on HTTP 529, "overloaded", "server-side issue, usually temporary", and
   * "status.claude.com". Never on `api_error` alone, for the reason `needsReauth` gives above.
   */
  overloaded: (reason: string): boolean => {
    const said = reason.toLowerCase()
    return (
      said.includes('529') ||
      said.includes('overloaded') ||
      said.includes('server-side issue, usually temporary') ||
      said.includes('status.claude.com')
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
        error: errorMessage(err)
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
        return { loggedIn: null, raw: errorMessage(err) }
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
        error: errorMessage(err)
      }
    }
  },

  /**
   * The money half of the same file the quota probe already opens.
   *
   * ⛔ **A file read, and that is the whole cost.** `cachedUsageUtilization` is refreshed by the
   * `/usage` PTY drive this adapter already performs for quota, so the credit numbers arrive on a
   * probe that has already been paid for. Measured 2026-09-07 on 2.1.263: `utilization.spend` and
   * `utilization.extra_usage` sit beside the `limits[]` array `probeQuota` reads, and were simply
   * being stepped over.
   *
   * ⚠️ Dated by `fetchedAtMs` — the **vendor's** clock — for the reason spend.ts gives: this cache
   * is only as fresh as the last `/usage`, and stamping it with ours would present a reading from
   * hours ago as one taken now.
   */
  async probeSpend(isolationRoot: string): Promise<Omit<SpendSnapshot, 'workerId'>> {
    const file = usageFileFor(isolationRoot)
    if (!file) {
      return { meters: [], sampledAt: Date.now(), source: 'unknown', error: 'no .claude.json yet' }
    }
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as ClaudeConfigShape
      const cached = parsed.cachedUsageUtilization
      const at = cached?.fetchedAtMs
      if (!at) {
        return {
          meters: [],
          sampledAt: Date.now(),
          source: 'unknown',
          error: 'no cachedUsageUtilization in .claude.json'
        }
      }
      const credits = creditStatus(parsed)
      return {
        meters: spendMeters(cached?.utilization?.spend, credits?.enabled),
        credits,
        sampledAt: at,
        source: 'config-cache'
      }
    } catch (err) {
      log.warn('claude-code probeSpend failed:', err)
      return {
        meters: [],
        sampledAt: Date.now(),
        source: 'unknown',
        error: errorMessage(err)
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
    // ⭐ **A fork takes both ids, and that is measured rather than assumed.** The note below says
    // asking for `--session-id` alongside `--resume` is asking for two ids at once, and it is — but
    // `--fork-session` makes it two *conversations*, and the new one is ours to name. Measured
    // 2026-09-13 on 2.1.270: `--resume <old> --fork-session --session-id <new>` printed an `init`
    // carrying the minted id and read 31,372 cached tokens. Naming it is what keeps the transcript
    // path knowable and the process provably ours.
    const args = req.forkFrom
      ? [
          '--resume',
          req.forkFrom,
          '--fork-session',
          '--session-id',
          req.sessionId,
          '--permission-mode',
          req.permissionMode ?? info.policy.defaultPermissionMode
        ]
      : req.resumeFrom
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
    // ⭐ The same grants codex gets, and for the same two reasons: a worktree's git metadata and
    // anything a link inside the workspace points out of it at (`adapters/grants.js`). ⛔ **Not the
    // trunk's working tree**, which is what "add the project directory" would mean and would hand a
    // worker the one directory the invariant says no agent may work in. `<trunk>/.git` and
    // `<trunk>/node_modules` are the mechanics; `<trunk>/src` is somebody else's checkout.
    //
    // ⚠️ **Precaution, not a measured fix, and the difference is worth keeping straight.** t171
    // (2026-09-03) measured this failing on *codex*, whose Windows sandbox refuses a write through a
    // junction it was not told about. Nothing here has been measured refusing Claude Code on this
    // platform — `--add-dir` on this CLI *widens tool access* rather than naming a workspace
    // (`docs/adapters.md`), so the cost is a wider grant and the benefit is that the same worktree
    // stops behaving differently depending on which account drew it.
    for (const dir of workspaceGrants(req.cwd)) args.push('--add-dir', dir)
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
      // ⚠️ Only when the caller asked and only on this transport — the flag's own help says it
      // works with `--print` and `--output-format=stream-json` and nowhere else.
      if (req.partialMessages) args.push('--include-partial-messages')
    }
    return { command, args: [...prefixArgs, ...args], env }
  },

  transcriptPath(isolationRoot: string, cwd: string, sessionId: string): string {
    return join(isolationRoot, 'projects', encodeProjectDir(cwd), `${sessionId}.jsonl`)
  }
}
