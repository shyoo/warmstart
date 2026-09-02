import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Attachment } from '@shared/tasks.js'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { adapter, adapters } from './adapters/index.js'
import { gitWritableRoots } from './adapters/openai-compatible.js'
import { costModel, loadCostModels } from './costmodel.js'
import { spawnEnv } from './which.js'
import { APPROVE_TOOL, MCP_SERVER_NAME } from './mcpconfig.js'

/**
 * The claim M5 exists to test: **adding an adapter does not require touching the scheduler.**
 *
 * ⛔ These are not "does the object have the right fields" tests. Each one asserts a *consequence* —
 * that a missing capability produces different behaviour somewhere the scheduler reads, without any
 * code anywhere asking which adapter it is looking at. If one of these fails, something has been
 * branched on that should have been a capability.
 */

loadCostModels()

const ALL = adapters()

/**
 * Put an empty file named after each adapter's CLI at the front of PATH.
 *
 * ⚠️ `plan()` resolves the command through `which()` before it builds an argv, so every argv
 * assertion below used to require the real CLI to be installed — and passed on the author's machine
 * for exactly that reason. CI has none installed, which is how this was found: three of these threw
 * `'agy' is not on PATH`, and the API-key test quietly `continue`d past all three adapters and
 * asserted nothing at all. That last one is the worse failure, because it was green.
 *
 * ⛔ A stub proves nothing about the CLI and is not meant to. These tests are about the **argv
 * agentyard builds** — the flag that does not exist on `codex exec`, the input format that needs its
 * output format, the vendor key that must be stripped — and every one of those is a property of this
 * repository's code, provable on a machine that has never installed anything. Whether the binary
 * itself behaves as measured is a different question, asked by `npm run test:daemon`, which skips
 * visibly when the CLI is absent rather than pretending.
 *
 * The files are never executed. `which()` only needs a regular file, plus the executable bit off
 * Windows and a PATHEXT-matching extension on it, so both names are written.
 */
let stubDir: string | null = null
const realPath = process.env.PATH

beforeAll(() => {
  stubDir = mkdtempSync(join(tmpdir(), 'agentyard-stub-cli-'))
  for (const a of ALL) {
    for (const name of [a.info.command, `${a.info.command}.exe`]) {
      const file = join(stubDir, name)
      writeFileSync(file, '')
      chmodSync(file, 0o755)
    }
  }
  process.env.PATH = `${stubDir}${delimiter}${realPath ?? ''}`
})

afterAll(() => {
  if (realPath === undefined) delete process.env.PATH
  else process.env.PATH = realPath
  if (stubDir) rmSync(stubDir, { recursive: true, force: true })
})

describe('the registry', () => {
  it('carries four adapters, and each declares a distinct cost model', () => {
    expect(ALL.map((a) => a.info.id).sort()).toEqual([
      'antigravity-cli',
      'claude-code',
      'local-llm',
      'openai-compatible'
    ])
    const models = ALL.map((a) => a.info.policy.costModelId)
    expect(new Set(models).size).toBe(models.length)
  })

  it('every declared cost model actually loads', () => {
    // ⛔ A cost model referenced but absent is a scheduler that throws on its first tick with that
    // worker. The files are compiled in rather than read from disk precisely so this cannot happen
    // at packaging time, and this is what proves it.
    for (const a of ALL) {
      expect(() => costModel(a.info.policy.costModelId), a.info.id).not.toThrow()
    }
  })

  it('every adapter states how its capabilities were established', () => {
    for (const a of ALL) {
      expect(['measured', 'documented'], a.info.id).toContain(a.info.verification.level)
      expect(a.info.verification.asOf, a.info.id).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(a.info.verification.note.length, a.info.id).toBeGreaterThan(30)
    }
  })
})

describe('capability consequences, not capability fields', () => {
  it('an adapter without manual compaction declares a handoff wrap-up', () => {
    // Plan §9: "Antigravity having no /compact is not a special case - it makes moves 4 and 5 of the
    // cache clock unavailable, and preemption falls back to handoff. That is the whole change."
    for (const a of ALL) {
      if (!a.info.capabilities.manualCompact) {
        expect(a.info.policy.wrapUpProtocol, a.info.id).toBe('handoff')
      }
    }
  })

  it('an adapter with no classifier defaults to a safe unattended mode', () => {
    // ⛔ No fake auto modes. Codex sandboxes to workspace-write; Antigravity skips TUI prompts for
    // headless execution in pooled worktrees governed by mandate and landing checks.
    expect(adapter('openai-compatible').info.policy.defaultPermissionMode).toBe('workspace-write')
    expect(adapter('antigravity-cli').info.policy.defaultPermissionMode).toBe('dangerously-skip-permissions')
  })

  it('a settings-rules adapter can actually write rules, and a callback adapter does not', () => {
    for (const a of ALL) {
      if (a.info.capabilities.approvalChannel === 'settings_rules') {
        // ⛔ Declaring the channel without implementing it would mean every scheduled run on that
        // adapter is refused mid-flight with nobody to ask.
        expect(typeof a.writePermissions, a.info.id).toBe('function')
      } else {
        expect(a.writePermissions, a.info.id).toBeUndefined()
      }
    }
  })

  it('an adapter that cannot mint a session id can discover its transcript instead', () => {
    for (const a of ALL) {
      if (a.info.capabilities.mintsSessionId) {
        expect(a.transcriptPath('/root', '/cwd', 'abc'), a.info.id).toBeTruthy()
      } else {
        // Null, and a discovery function - otherwise the session is never metered at all.
        expect(a.transcriptPath('/root', '/cwd', 'abc'), a.info.id).toBeNull()
        expect(typeof a.discoverTranscript, a.info.id).toBe('function')
      }
    }
  })

  it('an adapter with no credential isolation is capped at one account', () => {
    // ⛔ The discovery that made maxAccounts a capability. Two workers on a keyring-backed CLI are
    // not two accounts; they are two rows sharing one window, each believing it has its own.
    for (const a of ALL) {
      if (a.info.id === 'local-llm') {
        expect(a.info.capabilities.maxAccounts).toBeNull()
      } else if (a.info.isolationEnvVar === null) {
        expect(a.info.capabilities.maxAccounts, a.info.id).toBe(1)
      } else {
        expect(a.info.capabilities.maxAccounts, a.info.id).toBeNull()
      }
    }
  })

  it('every adapter says where its token counts come from', () => {
    // ⛔ `none` would mean runs report as costing nothing rather than unknown. Nothing declares it
    // today; if something ever does, this is where the consequence has to be thought about again.
    for (const a of ALL) {
      expect(['transcript', 'stream', 'none'], a.info.id).toContain(a.info.capabilities.metering)
      if (a.info.capabilities.metering === 'stream') {
        // Metered from the stream means the decoder is the meter. No decoder, no numbers.
        expect(typeof a.decodeStream, a.info.id).toBe('function')
      }
    }
  })

  it('no adapter claims a quota probe it has not got', () => {
    // Every one of these reports `unknown` rather than a number, which the scheduler already handles
    // by marking the run quotaUnverified. Claiming `cli` without a free probe is what would hurt.
    for (const a of ALL) {
      expect(['cli', 'api', 'none'], a.info.id).toContain(a.info.capabilities.quotaProbe)
    }
  })

  it('stream-capable adapters declare the correct prompt wire format', () => {
    const agy = adapter('antigravity-cli')
    expect(agy.encodeStreamPrompt).toBeDefined()
    const agyEncoded = JSON.parse(agy.encodeStreamPrompt!('test prompt')) as {
      event: string
      message: { content: Array<{ text: string }> }
    }
    expect(agyEncoded.event).toBe('user')
    expect(agyEncoded.message.content[0]?.text).toBe('test prompt')

    const claude = adapter('claude-code')
    expect(claude.encodeStreamPrompt).toBeDefined()
    const claudeEncoded = JSON.parse(claude.encodeStreamPrompt!('test prompt')) as {
      type: string
      message: { content: Array<{ text: string }> }
    }
    expect(claudeEncoded.type).toBe('user')
    expect(claudeEncoded.message.content[0]?.text).toBe('test prompt')
  })
})

describe('a cost model may say it does not know', () => {
  it('anthropic and openai price a steerable cache; google does not', () => {
    // ⭐ Codex moved from `unpriced` to priced on 2026-09-02, and the two remaining `false`s are not
    // the same kind of gap. Google bills context caching as storage per token-hour, which is a
    // different formula this repo has no number for. OpenAI turned out to sell the *same* lever
    // Anthropic does — 0.1x reads, 1.25x writes, a TTL that reuse refreshes — only at 30 minutes
    // instead of 60. The old `false` here rested on "no client-controlled TTL", which the vendor's
    // own prompt-caching guide contradicts.
    expect(costModel('anthropic.subscription.2026-08').canPriceCache()).toBe(true)
    expect(costModel('openai.codex.2026-08').canPriceCache()).toBe(true)
    expect(costModel('google.antigravity.2026-08').canPriceCache()).toBe(false)
  })

  it('codex prices a thirty-minute prefix, and prices it from the request', () => {
    // ⛔ Half of Anthropic's hour, and the halving is the point: every window derived from a TTL has
    // to come out of the file rather than out of a constant somebody wrote when there was one
    // provider. Source: OpenAI *Prompt caching*, read 2026-09-02 — "remains eligible for reuse for
    // 30 minutes after its most recent write or reuse".
    const codex = costModel('openai.codex.2026-08')
    expect(codex.cacheTtlMs()).toBe(30 * 60 * 1000)
    expect(costModel('anthropic.subscription.2026-08').cacheTtlMs()).toBe(60 * 60 * 1000)

    // ⚠️ From the request that wrote it, not from the response that ended it. A four-minute turn has
    // already spent four of the thirty; measuring from the response would report a prefix as warm
    // for four minutes after it had gone.
    const startedAt = 1_000_000
    expect(codex.cacheExpiryFor({ contextTokens: 50_000, lastRequestStartedAt: startedAt })).toBe(
      startedAt + 30 * 60 * 1000
    )
  })

  it('codex can be priced for a keepalive and still never compacted', () => {
    // ⛔ The two questions are independent and codex answers them differently. Its cache is now
    // priceable, so a read costs 0.1·C and can be reasoned about; but `codex exec` is one-shot with
    // no way to drive compaction from a headless run, so `costOfCompact` must stay null. A cost
    // model that priced a compaction here would have the clock offer a move the adapter refuses.
    const codex = costModel('openai.codex.2026-08')
    const session = { contextTokens: 100_000, model: 'gpt-5.6-luna' }
    expect(codex.costOfKeepalive(session)).toBeCloseTo(10_000, 0)
    expect(codex.costOfColdStart(100_000)).toBeCloseTo(125_000, 0)
    expect(codex.costOfCompact(session)).toBeNull()
  })

  it('an unpriced cache returns null rather than zero', () => {
    // ⛔ The distinction the whole `unpriced` state exists for. Zero would read as "a keepalive is
    // free", and the clock would do it forever.
    const google = costModel('google.antigravity.2026-08')
    const session = { contextTokens: 120_000, model: 'gemini-3.1-pro-high' }
    expect(google.costOfKeepalive(session)).toBeNull()
    expect(google.costOfCompact(session)).toBeNull()
    expect(google.costOfColdStart(120_000)).toBeNull()
  })

  it('an unpriced cache has no expiry to reason about', () => {
    // Zero would read as "already lapsed" and have the clock act on it.
    const google = costModel('google.antigravity.2026-08')
    expect(google.cacheExpiryFor({ contextTokens: 1000, lastRequestStartedAt: Date.now() })).toBeNull()
  })

  it('anthropic still prices everything it did before', () => {
    const anthropic = costModel('anthropic.subscription.2026-08')
    const session = { contextTokens: 100_000, model: 'claude-opus-5' }
    expect(anthropic.costOfKeepalive(session)).toBeCloseTo(10_000, 0)
    expect(anthropic.costOfColdStart(100_000)).toBeCloseTo(200_000, 0)
    expect(anthropic.costOfCompact(session)).toBeGreaterThan(10_000)
  })

  it('a provider without compaction says so in the file as well as the adapter', () => {
    // Belt and braces on purpose: the adapter governs whether the move is offered, the cost model
    // governs whether it can be priced, and either alone being wrong would still refuse safely.
    expect(costModel('google.antigravity.2026-08').canCompact()).toBe(false)
    expect(costModel('openai.codex.2026-08').canCompact()).toBe(false)
    expect(costModel('anthropic.subscription.2026-08').canCompact()).toBe(true)
  })

  it('every model an adapter can be routed to is one its cost model can price', () => {
    // ⛔ The rule triage already enforces for escalation, checked here across the whole fleet: a model
    // agentyard cannot price is one it cannot gate, estimate for, or reason about the context of.
    for (const a of ALL) {
      const model = costModel(a.info.policy.costModelId)
      expect(model.modelIds().length, a.info.id).toBeGreaterThan(0)
    }
  })
})

describe('the measured surprises, kept as regressions', () => {
  it('codex exec is never given the interactive-only approval flag', () => {
    // ⛔ Measured 2026-08-25 against codex-cli 0.149.1: `--ask-for-approval` exists on `codex` and
    // NOT on `codex exec`. Written from the documentation, this adapter passed it on every scheduled
    // spawn - and every one of those spawns would have died on an argument error.
    const plan = adapter('openai-compatible').plan({
      sessionId: 'ignored',
      isolationRoot: 'C:/tmp/root',
      cwd: 'C:/tmp/work',
      transport: 'stream'
    })
    expect(plan.args).not.toContain('--ask-for-approval')
    expect(plan.args).toContain('exec')
    expect(plan.args).toContain('--json')
    // The sandbox is the only boundary left once there is no approval callback, so it must be set
    // and must not be the one that removes it.
    expect(plan.args).toContain('--sandbox')
    expect(plan.args).not.toContain('danger-full-access')
    expect(plan.args).not.toContain('--dangerously-bypass-approvals-and-sandbox')
  })

  it('agy is told which workspace it is in, not merely started inside it', () => {
    // ⭐ The flag whose absence let an agent commit to the trunk. Measured 2026-08-28: t17 was
    // spawned with `cwd` set to its pooled worktree and its conversation store recorded 45 distinct
    // absolute paths under `C:\Dev\multi_agent_controller` and zero under any workspace. The
    // process cwd is a starting position; `--add-dir` is what tells this CLI what its workspace is.
    const plan = adapter('antigravity-cli').plan({
      sessionId: 'ignored',
      isolationRoot: 'C:/tmp/root',
      cwd: 'C:/tmp/work',
      transport: 'stream'
    })
    const at = plan.args.indexOf('--add-dir')
    expect(at).toBeGreaterThan(-1)
    expect(plan.args[at + 1]).toBe('C:/tmp/work')
  })

  it('and is told again when resuming, which is the case that was actually broken', () => {
    // ⛔ The half that matters. A fresh launch was never the failure - the CLI has no opinion yet.
    // A conversation resumed by id arrives already pointed at wherever it was born, because Agy's
    // state outlives the process in `~/.gemini/antigravity/`. An adapter that bound the workspace
    // only on a cold start would fix the case that was never broken and leave this one exactly as
    // it was.
    const plan = adapter('antigravity-cli').plan({
      sessionId: 'ignored',
      isolationRoot: 'C:/tmp/root',
      cwd: 'C:/tmp/work',
      transport: 'stream',
      resumeFrom: 'conv-123'
    })
    const at = plan.args.indexOf('--add-dir')
    expect(at).toBeGreaterThan(-1)
    expect(plan.args[at + 1]).toBe('C:/tmp/work')
    // ⚠️ Both, not either. The point is the pairing: this run continues *that* conversation *here*.
    expect(plan.args).toContain('--conversation')
    expect(plan.args).toContain('conv-123')
  })

  it('agy is never given an input format without the output format it requires', () => {
    // Measured: `--input-format stream-json` requires `--output-format stream-json`. One without the
    // other is an argument error.
    const plan = adapter('antigravity-cli').plan({
      sessionId: 'ignored',
      isolationRoot: 'C:/tmp/root',
      cwd: 'C:/tmp/work',
      transport: 'stream'
    })
    const input = plan.args.indexOf('--input-format')
    const output = plan.args.indexOf('--output-format')
    expect(input).toBeGreaterThan(-1)
    expect(output).toBeGreaterThan(-1)
    expect(plan.args[input + 1]).toBe('stream-json')
    expect(plan.args[output + 1]).toBe('stream-json')
  })

  it('agy is never given a bare -p, because -p takes the prompt as its value there', () => {
    // ⛔ The bug that made this adapter fail 100% of its dispatches, measured 2026-08-27 on agy
    // 1.1.21. `-p` / `--print` / `--prompt` are one *string* flag on agy, not a boolean, so a bare
    // `-p` swallowed the next token. The CLI says so itself:
    //
    //   Error: -p took "--input-format" as its prompt, so the intended prompt was left as an
    //   argument and ignored.
    //
    // ⚠️ Exit 2 in **zero seconds**, which is exactly what this install's only Antigravity work
    // session had recorded: `outcome=failed`, `in=0 out=0`, and a note blaming the agent for
    // ending "without reporting completion" on an account that was signed in the whole time.
    //
    // The prompt is not passed here at all - with `--input-format stream-json` the CLI reads NDJSON
    // from stdin - so print mode is switched on with an empty value and nothing else.
    const plan = adapter('antigravity-cli').plan({
      sessionId: 'ignored',
      isolationRoot: 'C:/tmp/root',
      cwd: 'C:/tmp/work',
      transport: 'stream'
    })
    expect(plan.args).not.toContain('-p')
    expect(plan.args).not.toContain('--print')
    expect(plan.args).not.toContain('--prompt')
    // ⛔ One token, `--print=`. Not `['-p', '']`: an empty-string argv entry has to survive
    // node-pty, the `cmd /d /c` shim path and Windows quoting to arrive still empty, and this is
    // precisely the kind of thing that works on one path and vanishes on another.
    expect(plan.args).toContain('--print=')
    const print = plan.args.indexOf('--print=')
    expect(plan.args[print + 1]).toBe('--input-format')
  })

  it('agy passes dangerously-skip-permissions and print-timeout so headless work is not aborted', () => {
    const plan = adapter('antigravity-cli').plan({
      sessionId: 'ignored',
      isolationRoot: 'C:/tmp/root',
      cwd: 'C:/tmp/work',
      transport: 'stream'
    })
    expect(plan.args).toContain('--dangerously-skip-permissions')
    expect(plan.args).toContain('--print-timeout')
    expect(plan.args[plan.args.indexOf('--print-timeout') + 1]).toBe('24h')
  })

  it('no adapter leaks a vendor API key into a commissioned session', () => {
    // ⛔ A key in the environment silently outranks the subscription the worker was commissioned
    // with and bills a different account. Checked for all three because it is the failure nobody
    // notices until the invoice.
    const keys = [
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
      'OPENAI_API_KEY',
      'CODEX_API_KEY'
    ]
    const saved = { ...process.env }
    try {
      for (const k of keys) process.env[k] = 'leaked'
      for (const a of ALL) {
        // ⛔ No try/catch. This used to swallow a throw from `plan()` and `continue`, which on any
        // machine without the CLIs meant the test checked nothing and still reported green - the
        // exact shape of coverage draining away unnoticed. The PATH stub above removes the reason
        // it was there.
        const plan = a.plan({
          sessionId: 'ignored',
          isolationRoot: 'C:/tmp/root',
          cwd: 'C:/tmp/work',
          transport: 'stream'
        })
        for (const k of keys) {
          if (plan.env[k] === 'leaked') {
            // Only the vendor's own keys must be stripped, not every key in existence.
            const owns =
              (a.info.id === 'claude-code' && k.startsWith('ANTHROPIC')) ||
              (a.info.id === 'claude-code' && k.startsWith('CLAUDE')) ||
              (a.info.id === 'antigravity-cli' && (k.startsWith('GEMINI') || k.startsWith('GOOGLE'))) ||
              (a.info.id === 'openai-compatible' && (k.startsWith('OPENAI') || k.startsWith('CODEX')))
            expect(owns, `${a.info.id} leaked ${k}`).toBe(false)
          }
        }
      }
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      }
    }
  })
})

/**
 * The one string in this repository that is written out twice and must agree in both places.
 *
 * ⛔ `--permission-prompt-tool` is given `mcp__<server>__approve`, where `<server>` is the key the
 * daemon registers the MCP server under. The server itself declares that name in a separate bundle
 * (`src/mcp/index.ts`), spawned as its own process and deliberately sharing no daemon module - so a
 * type error cannot connect them. Renaming the project moved one and not the other, and the failure
 * mode is silent: the CLI asks a tool that does not exist and every approval hangs or denies.
 */
describe('a stream transport has two halves, and only one of them was wired', () => {
  /**
   * ⛔ The rule this whole block exists for. `decodeStream` is documented as required for any
   * adapter offering `stream`, and it was enforced by the fact that a missing decoder produces
   * visibly nothing. The *input* half had no such rule and no such symptom: `sendPrompt` fell
   * through to Claude Code's `{"type":"user",...}` envelope for any adapter that declared no
   * encoder, so codex received a prompt beginning with the literal text `{"type":"user"` and
   * nobody could tell, because it never got as far as reading it.
   */
  it('every adapter offering the stream transport can encode a prompt for it', () => {
    for (const ad of ALL) {
      if (!ad.info.capabilities.transports.includes('stream')) continue
      expect(
        ad.encodeStreamPrompt,
        `${ad.info.id} offers the stream transport with no encodeStreamPrompt; ` +
          "sendPrompt would silently send it another vendor's envelope"
      ).toBeTypeOf('function')
      expect(ad.decodeStream, `${ad.info.id} offers the stream transport with no decoder`).toBeTypeOf(
        'function'
      )
    }
  })

  it('codex takes its prompt as raw text, because stdin *is* the prompt', () => {
    // ⛔ Measured 2026-08-29, codex-cli 0.151.0. `codex exec --help`: "If not provided as an argument
    // (or if `-` is used), instructions are read from stdin." There is no envelope to speak - JSON
    // on stdin is not a protocol frame, it is a prompt that happens to look like JSON.
    const encode = adapter('openai-compatible').encodeStreamPrompt
    expect(encode).toBeTypeOf('function')
    expect(encode?.('fix the thing')).toBe('fix the thing')
    expect(encode?.('fix the thing')).not.toContain('"type"')
  })

  it('codex declares that its stdin takes one prompt and then must close', () => {
    // ⛔ The half that actually hung t52. Measured 2026-08-29: `codex exec` prints
    // `Reading prompt from stdin...` and blocks until EOF. Left open, the process sat for 50
    // minutes on 62ms of CPU - running, by every signal the daemon had, and never asked anything.
    expect(adapter('openai-compatible').info.capabilities.streamPrompts).toBe('once')
  })

  it('the CLIs that hold a conversation on stdin say so, and are not lumped in', () => {
    // ⚠️ The point of the field is that it discriminates. If every adapter answered the same way it
    // would be a constant, and the next one-shot CLI would hang exactly as codex did.
    expect(adapter('claude-code').info.capabilities.streamPrompts).toBe('conversation')
    expect(adapter('antigravity-cli').info.capabilities.streamPrompts).toBe('conversation')
    const answers = new Set(ALL.map((a) => a.info.capabilities.streamPrompts))
    expect(answers.size).toBeGreaterThan(1)
  })

  it('a successful codex turn produces a terminal record, not only a usage record', () => {
    // ⛔ `turn.completed` is both the only usage record and the last record `codex exec` writes.
    // Returning usage alone left a successful run with no terminal event: nothing completed the
    // task, and the process exit was then read as "ended without reporting completion" - a run that
    // did the work and was marked as having failed to finish. Measured 2026-08-29, codex-cli 0.151.0.
    const decode = adapter('openai-compatible').decodeStream
    expect(decode).toBeTypeOf('function')
    const out = decode?.({
      type: 'turn.completed',
      usage: {
        input_tokens: 13015,
        cached_input_tokens: 11008,
        cache_write_input_tokens: 0,
        output_tokens: 5,
        reasoning_output_tokens: 0
      }
    })
    const events = Array.isArray(out) ? out : out ? [out] : []
    // Usage first: a caller that stopped at the terminal record would never learn what it cost.
    expect(events.map((e) => e.kind)).toEqual(['usage', 'result'])
    const result = events[1]
    expect(result?.kind === 'result' && result.isError).toBe(false)
  })

  it('codex is not told to call a tool it was never given', () => {
    // ⛔ Codex has MCP; this adapter cannot pass a *per-session* registration, which is what
    // `task_complete` needs - `plan()` has said so since it was written while `capabilities.mcp`
    // said the opposite. The prompt builder reads this field, so `true` appended "call the MCP tool
    // `task_complete`" to every codex prompt for a tool that did not exist.
    expect(adapter('openai-compatible').info.capabilities.mcp).toBe(false)
  })

  it('a one-shot CLI resumes by respawning, and never by a second prompt', () => {
    // ⛔ **This assertion was `resumeSession === false` until 2026-09-02, and it conflated two
    // different things.** Its stated reason was that `codex exec` exits after its turn, "so there is
    // no conversation left to reuse". The *process* is gone; the *conversation* is not. Codex writes
    // a rollout file under `$CODEX_HOME` and `codex exec resume <thread_id>` reads it back —
    // measured against codex-cli 0.151.0, which answers a bad id with `no rollout found for thread
    // id <uuid>` rather than with "resume is not a thing".
    //
    // The half of that reasoning which is real — a prompt delivered into a pipe that closed when the
    // first one went out, the 50-minute hang measured on t52 — is about continuing a **live**
    // session, and it is enforced where it belongs: `warmSessionFor` returns null for any
    // `streamPrompts: 'once'` adapter whatever its state says. `resumeSession` governs a *respawn*
    // carrying prior context, which is one prompt into one fresh process: exactly what one-shot
    // means.
    const once = ALL.filter((a) => a.info.capabilities.streamPrompts === 'once')
    expect(once.length).toBeGreaterThan(0)
    for (const ad of once) {
      // A one-shot adapter that resumes must take its prompt at spawn, since there is no second
      // chance to send one. Both halves of that are declared, and either alone would be a trap.
      if (ad.info.capabilities.resumeSession) {
        expect(
          ad.info.capabilities.streamPrompts,
          `${ad.info.id} resumes by respawning, so its prompt must go in at spawn`
        ).toBe('once')
      }
    }
  })

  it('codex resume is the argv that was actually measured, in the order that parses', () => {
    // ⛔ Every flag here is positional in the clap sense, and the order is not cosmetic. Measured
    // 2026-09-02 against codex-cli 0.151.0: `--sandbox`, `--cd` and `--add-dir` are declared on
    // `exec` and **not** on the `resume` subcommand, so they must precede the word `resume` or the
    // process dies on an argument error. The trailing `-` is the PROMPT argument and means "read it
    // from stdin"; without it resume prints `No prompt provided via stdin` and exits **0** having
    // done nothing at all, which no caller would notice.
    const thread = '0199e5b1-6d2e-7a51-9c3f-1b2c3d4e5f60'
    const plan = adapter('openai-compatible').plan({
      sessionId: 'ours-not-codexs',
      isolationRoot: 'C:/tmp/root',
      cwd: 'C:/tmp/work',
      transport: 'stream',
      resumeFrom: thread
    })
    const at = (flag: string) => plan.args.indexOf(flag)
    expect(at('resume')).toBeGreaterThan(-1)
    expect(at('--sandbox')).toBeLessThan(at('resume'))
    expect(at('--cd')).toBeLessThan(at('resume'))
    expect(at('--skip-git-repo-check')).toBeLessThan(at('resume'))
    // The thread id, then the stdin marker, and nothing after them.
    expect(plan.args.slice(-2)).toEqual([thread, '-'])
    // ⛔ Codex's id, never ours. `sessionId` is this fleet's row key and codex has never heard of it.
    expect(plan.args).not.toContain('ours-not-codexs')
  })

  it('a codex spawn with nothing to resume is exactly the argv it always was', () => {
    // ⚠️ The regression guard on the common path: adding resume must not put a stray subcommand or a
    // stdin marker on an ordinary cold start.
    const plan = adapter('openai-compatible').plan({
      sessionId: 'ignored',
      isolationRoot: 'C:/tmp/root',
      cwd: 'C:/tmp/work',
      transport: 'stream'
    })
    expect(plan.args).not.toContain('resume')
    expect(plan.args).not.toContain('-')
  })

  it('a pty codex session ignores resumeFrom rather than mangling the TUI argv', () => {
    // ⛔ `exec resume` is the headless path. The interactive TUI takes its conversation back a
    // different way, and handing it `exec` would replace the terminal the operator asked for.
    const plan = adapter('openai-compatible').plan({
      sessionId: 'ignored',
      isolationRoot: 'C:/tmp/root',
      cwd: 'C:/tmp/work',
      transport: 'pty',
      resumeFrom: '0199e5b1-6d2e-7a51-9c3f-1b2c3d4e5f60'
    })
    expect(plan.args).not.toContain('resume')
    expect(plan.args).not.toContain('exec')
  })
})

describe('the MCP server is called the same thing at both ends', () => {
  it('the approve tool names the server the config registers', () => {
    expect(APPROVE_TOOL).toBe(`mcp__${MCP_SERVER_NAME}__approve`)
  })

  it('claude-code is told to call exactly that tool', () => {
    const claude = ALL.find((a) => a.info.id === 'claude-code')
    expect(claude).toBeDefined()
    const plan = claude?.plan({
      sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      isolationRoot: join(tmpdir(), 'mac-adapters-test'),
      cwd: tmpdir(),
      transport: 'stream',
      mcpConfig: join(tmpdir(), 'mcp.json')
    })
    const i = plan?.args.indexOf('--permission-prompt-tool') ?? -1
    expect(i, 'claude-code no longer passes --permission-prompt-tool').toBeGreaterThan(-1)
    expect(plan?.args[i + 1]).toBe(APPROVE_TOOL)
  })

  it('the standalone MCP bundle declares that same name', () => {
    // ⚠️ Read from source rather than imported: importing it would start a server on stdio.
    const src = readFileSync(join(import.meta.dirname, '..', 'mcp', 'index.ts'), 'utf8')
    const declared = /new McpServer\(\{\s*name:\s*'([^']+)'/.exec(src)?.[1]
    expect(declared, 'could not find the McpServer name in src/mcp/index.ts').toBeDefined()
    expect(declared).toBe(MCP_SERVER_NAME)
  })
})

/**
 * How an account gets signed in, as data.
 *
 * ⚠️ The renderer used to decide this with `id === 'claude-code' ? ['auth','login'] : ['login']` —
 * a branch on an adapter name, which this design forbids, and which was wrong the first time it met
 * a CLI that has no login subcommand. Commissioning an Antigravity account failed with *unexpected
 * argument "login"* (agy 1.1.20, 2026-08-26).
 */
describe('login', () => {
  it('every adapter declares how its accounts are signed in', () => {
    for (const a of ALL) {
      expect(['cli', 'external'], a.info.id).toContain(a.info.login.kind)
    }
  })

  it('a CLI login always has an argv — an empty one would open a billable session', () => {
    for (const a of ALL) {
      if (a.info.login.kind !== 'cli') continue
      expect(a.info.login.argv.length, a.info.id).toBeGreaterThan(0)
    }
  })

  it('an adapter whose credential is not in a directory declares no CLI login', () => {
    // ⛔ The real coupling: no isolation env var means the credential lives somewhere this app does
    // not manage — the OS keyring for Antigravity — and there is nothing for a terminal pane to run.
    for (const a of ALL) {
      if (a.info.isolationEnvVar !== null) continue
      if (a.info.capabilities.maxAccounts !== 1) continue
      expect(a.info.login.kind, `${a.info.id} claims a CLI login it cannot have`).toBe('external')
    }
  })

  it('says where the credential comes from when there is no CLI login', () => {
    for (const a of ALL) {
      if (a.info.login.kind !== 'external') continue
      // A reason nobody can act on is the same as no reason.
      expect(a.info.login.reason.length, a.info.id).toBeGreaterThan(40)
    }
  })
})

/**
 * Refreshing a usage cache without spending a turn.
 *
 * ⭐ Measured 2026-08-27: `/usage` typed into an interactive claude session rewrites
 * `cachedUsageUtilization` and costs nothing, where `-p /usage` spends a turn and answers in prose.
 * The difference is print mode versus the client, and the project believed the wrong half of it for
 * three months. See docs/cost-model.md §5.
 */
describe('usageRefresh', () => {
  it('is declared per adapter rather than inferred from a name', () => {
    for (const a of ALL) {
      const r = a.info.usageRefresh
      expect(r === null || typeof r === 'object', a.info.id).toBe(true)
    }
  })

  it('never declares an empty command — that would send a bare carriage return into a TUI', () => {
    for (const a of ALL) {
      if (!a.info.usageRefresh) continue
      expect(a.info.usageRefresh.command.trim().length, a.info.id).toBeGreaterThan(0)
    }
  })

  it('waits for the TUI before typing, and for the answer before reading', () => {
    // ⛔ Being early is the failure that looks like success: the file is read before the CLI has
    // rewritten it, so the *old* number comes back and is stamped with a fresh age.
    for (const a of ALL) {
      const r = a.info.usageRefresh
      if (!r) continue
      expect(r.readyMs, `${a.info.id} readyMs`).toBeGreaterThanOrEqual(5_000)
      expect(r.settleMs, `${a.info.id} settleMs`).toBeGreaterThanOrEqual(5_000)
    }
  })

  it('only an adapter that can be metered at all gets one', () => {
    // A refresh writes a percentage; a percentage is only useful next to tokens we measured
    // ourselves. An adapter we cannot meter would be pairing a real number with a guess.
    //
    // ⚠️ This said `transcript` until 2026-08-27, which was the right *reason* attached to too
    // narrow a test. `stream` metering is also measurement — Antigravity emits per-turn usage in
    // its own stream records, and `transcript.ts` bills from them exactly — it is simply only
    // available while this app is attached to the process, rather than reconstructable from a file
    // afterwards. The state the reason actually excludes is `none`: a declarative adapter, whose
    // runs cost an unknown amount, must not pair that unknown with a real percentage.
    for (const a of ALL) {
      if (!a.info.usageRefresh) continue
      expect(a.info.capabilities.metering, a.info.id).not.toBe('none')
    }
  })
})

/**
 * Signed in is not the same as set up.
 *
 * ⛔ Measured 2026-08-27: `claude auth login` writes `oauthAccount` and `userID` into an isolation
 * root but not `hasCompletedOnboarding`, so the first interactive session there opens the theme
 * picker and the login-method chooser. `-p` skips all of it, which is why a worker can run
 * scheduled work for days and still be unable to answer `/usage`.
 */
describe('firstRun', () => {
  it('an adapter that can refresh usage must say how its first-run screens get answered', () => {
    // ⛔ The coupling that this cost a day to learn: driving a slash command needs a TUI, and a TUI
    // that has never been set up shows onboarding instead of a prompt. Declaring one without the
    // other builds a probe that silently returns the same stale number forever.
    for (const a of ALL) {
      if (!a.info.usageRefresh) continue
      expect(a.info.firstRun, `${a.info.id} drives a TUI but declares no first-run`).not.toBeNull()
    }
  })

  it('names the config key that proves the screens were answered', () => {
    for (const a of ALL) {
      if (!a.info.firstRun) continue
      expect(a.info.firstRun.completedKey.length, a.info.id).toBeGreaterThan(0)
    }
  })

  it('explains itself to whoever has to click through it', () => {
    for (const a of ALL) {
      if (!a.info.firstRun) continue
      expect(a.info.firstRun.reason.length, a.info.id).toBeGreaterThan(40)
    }
  })
})

/**
 * Pre-answering the folder-trust dialog.
 *
 * ⛔ Measured 2026-08-27: an unanswered trust dialog swallows every keystroke sent to a session, so
 * the usage probe was typing `/usage` into it and pressing Enter on "Yes, I trust this folder" —
 * reporting "no fresher reading" every time, for weeks of wall-clock if nobody had looked.
 */
describe('trustDirectory', () => {
  it('merges into the vendor config instead of replacing it', () => {
    const a = ALL.find((x) => x.info.id === 'claude-code')
    if (!a?.trustDirectory) return

    const root = mkdtempSync(join(tmpdir(), 'agentyard-trust-'))
    const file = join(root, '.claude.json')
    // Everything here is the vendor's or the operator's, and none of it is ours to lose.
    writeFileSync(
      file,
      JSON.stringify({
        oauthAccount: { account: 'someone' },
        hasCompletedOnboarding: true,
        projects: { 'C:/Dev/theirs': { hasTrustDialogAccepted: true, other: 1 } }
      })
    )

    a.trustDirectory(root, join(root, 'scratch'))
    const after = JSON.parse(readFileSync(file, 'utf8')) as {
      oauthAccount: unknown
      hasCompletedOnboarding: unknown
      projects: Record<string, Record<string, unknown>>
    }

    expect(after.oauthAccount, 'the credential survived').toEqual({ account: 'someone' })
    expect(after.hasCompletedOnboarding).toBe(true)
    expect(after.projects['C:/Dev/theirs']).toEqual({ hasTrustDialogAccepted: true, other: 1 })
    const key = join(root, 'scratch').replace(/\\/g, '/')
    expect(after.projects[key]?.hasTrustDialogAccepted).toBe(true)

    rmSync(root, { recursive: true, force: true })
  })

  it('leaves a config it cannot parse alone', () => {
    const a = ALL.find((x) => x.info.id === 'claude-code')
    if (!a?.trustDirectory) return

    const root = mkdtempSync(join(tmpdir(), 'agentyard-trust-'))
    const file = join(root, '.claude.json')
    writeFileSync(file, '{ this is not json')
    a.trustDirectory(root, join(root, 'scratch'))
    // ⛔ Overwriting an unparseable config would destroy a credential nothing here can reconstruct.
    expect(readFileSync(file, 'utf8')).toBe('{ this is not json')
    rmSync(root, { recursive: true, force: true })
  })

  it('pre-configures sandbox and trusts directory for codex', () => {
    const a = ALL.find((x) => x.info.id === 'openai-compatible')
    if (!a?.trustDirectory) return

    const root = mkdtempSync(join(tmpdir(), 'agentyard-trust-'))
    const file = join(root, 'config.toml')
    const dir = join(root, 'scratch')

    a.trustDirectory(root, dir)
    const content = readFileSync(file, 'utf8')
    expect(content).toContain('[windows]')
    expect(content).toContain('sandbox = "elevated"')
    expect(content).toContain(`[projects.'${dir}']`)
    expect(content).toContain('trust_level = "trusted"')

    rmSync(root, { recursive: true, force: true })
  })
})

describe('probeQuota', () => {
  it('claude-code labels windows as Claude 5h / Claude 7d and orders 5h above 7d', async () => {
    const a = adapter('claude-code')
    const root = mkdtempSync(join(tmpdir(), 'agentyard-claude-quota-'))
    const file = join(root, '.claude.json')
    writeFileSync(
      file,
      JSON.stringify({
        cachedUsageUtilization: {
          fetchedAtMs: 1_700_000_000_000,
          utilization: {
            limits: [
              { kind: 'weekly', group: 'weekly', percent: 20, resets_at: '2026-09-03T00:00:00Z' },
              { kind: 'session', group: 'session', percent: 30, resets_at: '2026-08-30T05:30:00Z' }
            ]
          }
        }
      })
    )

    const res = await a.probeQuota(root)
    expect(res.windows.map((w) => w.label)).toEqual(['Claude 5h', 'Claude 7d'])
    expect(res.windows.map((w) => w.id)).toEqual(['session', 'weekly'])
    expect(res.windows[0]!.percent).toBe(30)
    expect(res.windows[1]!.percent).toBe(20)

    rmSync(root, { recursive: true, force: true })
  })
})

describe('probeIdentity', () => {
  it('antigravity-cli probes identity and returns valid structure', async () => {
    const a = adapter('antigravity-cli')
    const probe = await a.probeIdentity('/ignored')
    expect(typeof probe).toBe('object')
    expect(probe.loggedIn === null || typeof probe.loggedIn === 'boolean').toBe(true)
    if (probe.loggedIn) {
      expect(typeof probe.account).toBe('string')
      expect(probe.account).toContain('@')
      expect(probe.subscriptionType).toBe('Google AI Pro')
    }
  })
})

/**
 * What a spawned agent CLI inherits.
 *
 * ⛔ Measured 2026-08-30: a Claude Code session's environment carries around twenty `CLAUDE*`
 * variables — `CLAUDE_CODE_HOST_SESSION_ID`, `CLAUDE_CODE_MESSAGING_SOCKET`,
 * `CLAUDE_CODE_MESSAGING_TOKEN`, `CLAUDE_CODE_BRIDGE_SESSION_ID`, `CLAUDECODE=1` — and every adapter
 * built its environment by copying `process.env` wholesale. A daemon started from inside such a
 * session handed each worker the operator's own session handle and messaging socket, on an account
 * it was not commissioned with. An isolation root that inherits the host's identity is not isolated.
 */
describe('the environment a worker inherits', () => {
  const HOST = {
    CLAUDECODE: '1',
    CLAUDE_CODE_HOST_SESSION_ID: 'the-operators-session',
    CLAUDE_CODE_MESSAGING_TOKEN: 'a-secret',
    CLAUDE_CODE_ENTRYPOINT: 'claude-desktop',
    CLAUDE_CONFIG_DIR: 'C:/Users/operator/.claude',
    CLAUDE_AGENT_SDK_VERSION: '9.9.9',
    ANTHROPIC_API_KEY: 'sk-should-not-travel'
  }

  const withHostEnv = <T,>(run: () => T): T => {
    const saved: Record<string, string | undefined> = {}
    for (const [k, v] of Object.entries(HOST)) {
      saved[k] = process.env[k]
      process.env[k] = v
    }
    try {
      return run()
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  }

  it('carries none of the host session across', () => {
    const env = withHostEnv(() => spawnEnv())
    for (const key of Object.keys(HOST)) {
      expect(env[key], `${key} must not reach a worker`).toBeUndefined()
    }
  })

  it('still carries the operating system, because a spawn needs it', () => {
    // ⛔ The reason this is a deny by prefix and not a whitelist of what to keep. A whitelist has to
    // enumerate everything a CLI needs on three platforms, and one omission is a spawn that fails
    // in a way nobody can trace — which is exactly how a hand-set PATH broke a probe on 2026-08-30.
    const env = withHostEnv(() => spawnEnv())
    expect(Object.keys(env).length).toBeGreaterThan(5)
    // ⚠️ Looked up case-insensitively, because `process.env` on Windows is a case-insensitive
    // proxy while a plain object is not: `Object.keys` yields `SYSTEMROOT` and `process.env.SystemRoot`
    // still reads. Harmless for a spawn - the OS is case-insensitive when the child reads it back -
    // but it makes an exact-key assertion here a test of Windows trivia rather than of this function.
    const find = (name: string): string | undefined =>
      Object.entries(env).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1]
    const os = process.platform === 'win32' ? 'SystemRoot' : 'HOME'
    if (process.env[os]) expect(find(os)).toBe(process.env[os])
  })

  it('and a variable the vendor adds later is denied before anybody hears of it', () => {
    const saved = process.env.CLAUDE_CODE_SOMETHING_INVENTED_TOMORROW
    process.env.CLAUDE_CODE_SOMETHING_INVENTED_TOMORROW = 'x'
    try {
      expect(spawnEnv().CLAUDE_CODE_SOMETHING_INVENTED_TOMORROW).toBeUndefined()
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CODE_SOMETHING_INVENTED_TOMORROW
      else process.env.CLAUDE_CODE_SOMETHING_INVENTED_TOMORROW = saved
    }
  })

  it('every adapter that spawns a CLI goes through it', () => {
    // ⚠️ The drift guard. Each adapter built its own environment by hand, and all three had the same
    // hole; a fourth written from the pattern of the first would have had it too.
    for (const id of ['claude-code', 'antigravity-cli', 'openai-compatible', 'local-llm']) {
      const plan = withHostEnv(() =>
        adapter(id).plan({
          sessionId: '00000000-0000-4000-8000-000000000000',
          isolationRoot: 'http://127.0.0.1:8080',
          transport: 'stream',
          cwd: 'C:/anywhere'
        } as never)
      )
      for (const key of Object.keys(HOST)) {
        // ⚠️ Except the one each adapter sets for itself, which must be the *worker's* root and never
        // the inherited value.
        if (key === 'CLAUDE_CONFIG_DIR' && id === 'claude-code') {
          expect(plan.env?.CLAUDE_CONFIG_DIR).toBe('http://127.0.0.1:8080')
          continue
        }
        expect(plan.env?.[key], `${id} leaks ${key}`).toBeUndefined()
      }
    }
  })
})

describe('local-llm adapter', () => {
  const ad = adapter('local-llm')

  it('declares conservative capabilities appropriate for local inference', () => {
    const c = ad.info.capabilities
    expect(c.transports).toEqual(['stream'])
    expect(c.permissionModes).toEqual([])
    expect(c.classifierBackedAuto).toBe(false)
    expect(c.approvalChannel).toBe('none')
    expect(c.manualCompact).toBe(false)
    expect(c.resumeSession).toBe(false)
    expect(c.mcp).toBe(false)
    expect(c.quotaProbe).toBe('none')
    expect(c.streamPrompts).toBe('conversation')
    expect(c.metering).toBe('stream')
    expect(c.maxAccounts).toBeNull()
  })

  it('encodes stream prompts as Antigravity-style JSON', () => {
    const encoded = ad.encodeStreamPrompt?.('hello local model')
    expect(encoded).toBeDefined()
    const parsed = JSON.parse(encoded!) as { event: string; message: { content: Array<{ text: string }> } }
    expect(parsed.event).toBe('user')
    expect(parsed.message.content[0]?.text).toBe('hello local model')
  })

  it('decodes stream records from the bridge correctly', () => {
    const decode = ad.decodeStream!
    expect(decode).toBeTypeOf('function')

    // init record
    expect(decode({ type: 'init', model: 'qwen3-coder', session_id: 's1' })).toEqual({
      kind: 'init',
      sessionId: 's1',
      model: 'qwen3-coder',
      permissionMode: null
    })

    // assistant text
    expect(decode({ type: 'assistant_text', text: 'working on it...' })).toEqual({
      kind: 'assistant_text',
      text: 'working on it...'
    })

    // usage record
    expect(
      decode({
        type: 'usage',
        usage: { input_tokens: 150, output_tokens: 42, cache_read_tokens: 0, cache_write_tokens: 0 },
        final: true
      })
    ).toEqual({
      kind: 'usage',
      usage: { input: 150, output: 42, thinking: 0, cacheRead: 0, cacheWrite: 0 },
      final: true
    })

    // result record
    expect(decode({ type: 'result', text: 'All done', status: 'SUCCESS' })).toEqual({
      kind: 'result',
      text: 'All done',
      costUsd: null,
      isError: false,
      terminalReason: 'SUCCESS'
    })

    // task_complete tool result
    expect(
      decode({ type: 'tool_result', tool: 'task_complete', summary: 'Implemented feature X' })
    ).toEqual({
      kind: 'result',
      text: 'Implemented feature X',
      costUsd: null,
      isError: false,
      terminalReason: 'task_complete'
    })
  })

  it('plan configures endpoint URL and model in environment', () => {
    const plan = ad.plan({
      sessionId: 'sess-123',
      isolationRoot: 'http://127.0.0.1:9090',
      cwd: 'C:/test',
      transport: 'stream',
      model: 'qwen3-coder-30b-a3b'
    })

    expect(plan.env.LOCAL_LLM_ENDPOINT).toBe('http://127.0.0.1:9090')
    expect(plan.env.LOCAL_LLM_MODEL).toBe('qwen3-coder-30b-a3b')
    expect(plan.env.LOCAL_LLM_SESSION_ID).toBe('sess-123')
  })
})

/**
 * ⛔ The fault that made every codex worktree commit impossible.
 *
 * Measured on t56, 2026-08-30, across three runs and ~1.8M tokens: *"Could not commit: sandbox
 * denies writes to `.git/worktrees/ws1/index.lock`, so sync/rebase and staging both failed."*
 * `--sandbox workspace-write` makes `cwd` writable and a worktree keeps none of its git metadata
 * there — `<worktree>/.git` is a *file* pointing into the trunk. The agent could edit and could
 * never commit, on every pooled worktree, for every task.
 *
 * ⚠️ Built against a **real** `git worktree add`, not a fixture. The whole fault is the difference
 * between what a worktree's `.git` is and what everyone assumes it is, and a hand-written fixture
 * would encode the assumption rather than test it.
 */
describe('a worker that has to be able to commit', () => {
  let trunk: string
  let work: string
  let made = false

  beforeAll(() => {
    trunk = mkdtempSync(join(tmpdir(), 'agentyard-worktree-trunk-'))
    work = join(mkdtempSync(join(tmpdir(), 'agentyard-worktree-ws-')), 'ws1')
    const git = (args: string[], cwd: string): void => {
      execFileSync('git', args, { cwd, stdio: 'pipe' })
    }
    // ⛔ No try/catch. git is not optional here: this repo's entire workspace model is
    // `git worktree`, so a machine without it cannot run the thing under test at all — and a
    // swallowed failure would leave these four tests passing while asserting nothing, which is
    // precisely the `stall.test.ts` fault fixed earlier today.
    git(['init', '-q', '-b', 'main'], trunk)
    git(['config', 'user.email', 'test@example.com'], trunk)
    git(['config', 'user.name', 'test'], trunk)
    writeFileSync(join(trunk, 'a.txt'), 'a\n')
    git(['add', '-A'], trunk)
    git(['commit', '-qm', 'first'], trunk)
    git(['worktree', 'add', '-q', '-b', 'topic', work], trunk)
    made = true
  })

  afterAll(() => {
    try {
      rmSync(trunk, { recursive: true, force: true })
      rmSync(join(work, '..'), { recursive: true, force: true })
    } catch {
      // Windows file locks
    }
  })

  it('is given every directory its commit writes to, none of which is its own', () => {
    expect(made, 'the worktree fixture must actually have been built').toBe(true)
    const roots = gitWritableRoots(work)
    // ⛔ The three paths a commit on a worktree branch touches: the index in the slot directory, and
    //    the objects and the branch ref in the common `.git`. Asserted by *containment*, because
    //    which of the returned roots covers which path is an implementation detail and the
    //    requirement is only that each one is covered.
    const norm = (p: string): string => {
      try {
        return realpathSync.native(p).toLowerCase()
      } catch {
        return resolve(p).toLowerCase()
      }
    }
    const covered = (p: string): boolean =>
      roots.some((r) => norm(p).startsWith(norm(r)))
    const gitDir = resolve(work, /gitdir:\s*(.+)/.exec(readFileSync(join(work, '.git'), 'utf8'))![1]!.trim())
    expect(covered(join(gitDir, 'index.lock'))).toBe(true)
    expect(covered(join(trunk, '.git', 'objects'))).toBe(true)
    expect(covered(join(trunk, '.git', 'refs', 'heads', 'topic'))).toBe(true)
    // ⚠️ And `cwd` itself is not among them: `workspace-write` already grants it, and passing it
    //    again would say this function had found something it had not.
    expect(roots.map(norm)).not.toContain(norm(work))
  })

  it('asks for nothing extra in an ordinary clone, where the metadata is already inside', () => {
    expect(made, 'the worktree fixture must actually have been built').toBe(true)
    // ⛔ The guard against widening by habit. In a normal checkout `.git` is a directory under
    //    `cwd`, the sandbox already covers it, and granting the same path twice would be noise that
    //    hides the one case that matters.
    expect(gitWritableRoots(trunk)).toEqual([])
  })

  it('says nothing about a directory that is not a repository at all', () => {
    // ⚠️ `--skip-git-repo-check` means a `vcs: none` project runs here too.
    const bare = mkdtempSync(join(tmpdir(), 'agentyard-worktree-none-'))
    try {
      expect(gitWritableRoots(bare)).toEqual([])
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })

  it('puts them on the codex argv, so the sandbox actually hears about them', () => {
    expect(made, 'the worktree fixture must actually have been built').toBe(true)
    const plan = adapter('openai-compatible').plan({
      sessionId: 'ignored',
      isolationRoot: 'C:/tmp/root',
      cwd: work,
      transport: 'stream'
    })
    for (const root of gitWritableRoots(work)) {
      expect(plan.args[plan.args.indexOf(root) - 1]).toBe('--add-dir')
    }
    // ⛔ And the sandbox is still on. Widening the writable set is the fix; removing the boundary
    //    is the thing this must never quietly become.
    expect(plan.args).toContain('workspace-write')
    expect(plan.args).not.toContain('--dangerously-bypass-approvals-and-sandbox')
  })
})

/**
 * How an image reaches an agent, and how it must not.
 *
 * ⛔ These are the reason `imageInput` is data rather than a boolean. Three CLIs give three answers
 * — measured 2026-08-31 against claude 2.1.251, agy 1.1.22 and codex 0.151.0 — and one of them is
 * not "ignores it".
 */
describe('an image, and the three channels it can travel down', () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
  let store: string | null = null
  let image: Attachment

  beforeAll(async () => {
    store = mkdtempSync(join(tmpdir(), 'agentyard-adapter-image-'))
    process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = store
    const db = await import('./db.js')
    const attachments = await import('./attachments.js')
    db.openDb(join(store, 'images.db'))
    image = attachments.createAttachment(png, 'image/png', { width: 1, height: 1 })
  })

  afterAll(async () => {
    const db = await import('./db.js')
    db.closeDb()
    delete process.env.MULTI_AGENT_CONTROLLER_DATA_DIR
    if (store) rmSync(store, { recursive: true, force: true })
  })

  it('every adapter says how it takes one, and the answer is one of three', () => {
    for (const a of ALL) {
      expect(['inline', 'spawn-flag', 'none'], a.info.id).toContain(a.info.capabilities.imageInput)
    }
  })

  it('claude puts the bytes in its envelope, before the text', () => {
    const encode = adapter('claude-code').encodeStreamPrompt
    expect(encode).toBeTruthy()
    const payload = JSON.parse(encode!('look at this', [image])) as {
      type: string
      message: { content: { type: string; source?: { media_type: string; data: string } }[] }
    }
    expect(payload.type).toBe('user')
    const content = payload.message.content
    // ⛔ Order, not merely presence. A question asked before the picture arrives is a question
    // about nothing, and this is the order the 2026-08-31 measurement used.
    expect(content[0]?.type).toBe('image')
    expect(content[0]?.source?.media_type).toBe('image/png')
    expect(content[0]?.source?.data).toBe(png.toString('base64'))
    expect(content[1]?.type).toBe('text')
  })

  it('claude still sends a plain envelope when there is no image', () => {
    const encode = adapter('claude-code').encodeStreamPrompt
    const payload = JSON.parse(encode!('just words')) as {
      message: { content: { type: string }[] }
    }
    expect(payload.message.content.map((c) => c.type)).toEqual(['text'])
  })

  /**
   * ⛔ **The regression that matters.** agy does not drop an image block, it fails the whole turn on
   * one: `"status":"ERROR","num_turns":0,"error":"stream input content block type \"image\" is not
   * supported (only \"text\")"`, measured 2026-08-31. A run that died that way would be read as
   * the agent having failed the task.
   */
  it('antigravity is never handed an image block, even when one is offered', () => {
    const encode = adapter('antigravity-cli').encodeStreamPrompt
    const payload = encode!('look at this', [image])
    expect(payload).not.toContain('"image"')
    expect(payload).not.toContain('base64')
    expect(JSON.parse(payload)).toMatchObject({
      event: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'look at this' }] }
    })
  })

  it('and it says so as a capability, so nothing has to know its name', () => {
    expect(adapter('antigravity-cli').info.capabilities.imageInput).toBe('none')
  })

  it('codex takes its images at spawn, and is allowed to read them', () => {
    expect(adapter('openai-compatible').info.capabilities.imageInput).toBe('spawn-flag')
    const plan = adapter('openai-compatible').plan({
      sessionId: 'ignored',
      isolationRoot: 'C:/tmp/root',
      cwd: process.cwd(),
      transport: 'stream',
      attachments: [image]
    })
    expect(plan.args[plan.args.indexOf(image.file) - 1]).toBe('-i')
    // ⛔ And the sandbox is told about the directory. `workspace-write` does not reach the
    // attachment store, so without this codex is handed a path it is forbidden to open — which is
    // the one failure the file-path fallback exists to prevent.
    const dir = dirname(image.file)
    expect(plan.args[plan.args.indexOf(dir) - 1]).toBe('--add-dir')
  })

  /**
   * ⛔ The gate one layer above the encoder, and the one that decides whether a turn survives. The
   * encoder tests above prove antigravity's envelope is clean if it is called; this proves it is
   * never offered the bytes in the first place, which is what keeps the rule a capability rather
   * than a promise each adapter has to keep on its own.
   */
  it('offers the bytes only to the adapter that says it can take them', async () => {
    const { inlineImagesFor } = await import('./sessions.js')
    expect(inlineImagesFor('claude-code', [image])).toHaveLength(1)
    expect(inlineImagesFor('antigravity-cli', [image])).toEqual([])
    // ⚠️ Also none for codex, for the opposite reason: they went into its argv at spawn, and a
    // second copy down a channel it does not have would be paid for twice if it worked at all.
    expect(inlineImagesFor('openai-compatible', [image])).toEqual([])
    expect(inlineImagesFor('local-llm', [image])).toEqual([])
  })

  it('and adds neither flag on a run that carries nothing', () => {
    const plan = adapter('openai-compatible').plan({
      sessionId: 'ignored',
      isolationRoot: 'C:/tmp/root',
      cwd: process.cwd(),
      transport: 'stream'
    })
    expect(plan.args).not.toContain('-i')
  })
})
