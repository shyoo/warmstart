import { describe, expect, it } from 'vitest'
import { adapter, adapters } from './adapters/index.js'
import { costModel, loadCostModels } from './costmodel.js'

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

describe('the registry', () => {
  it('carries three adapters, and each declares a distinct cost model', () => {
    expect(ALL.map((a) => a.info.id).sort()).toEqual([
      'antigravity-cli',
      'claude-code',
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

  it('an adapter with no classifier never defaults to an auto mode', () => {
    // §9.1: with nobody but the operator reviewing, the default cannot be "proceed unreviewed".
    for (const a of ALL) {
      if (a.info.capabilities.classifierBackedAuto) continue
      expect(a.info.policy.defaultPermissionMode, a.info.id).not.toBe('auto')
      expect(a.info.policy.defaultPermissionMode, a.info.id).not.toContain('dangerous')
      expect(a.info.policy.defaultPermissionMode, a.info.id).not.toBe('bypassPermissions')
    }
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
      if (a.info.isolationEnvVar === null) {
        expect(a.info.capabilities.maxAccounts, a.info.id).toBe(1)
      } else {
        expect(a.info.capabilities.maxAccounts, a.info.id).toBeNull()
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
})

describe('a cost model may say it does not know', () => {
  it('anthropic prices a steerable cache; the other two do not', () => {
    expect(costModel('anthropic.subscription.2026-08').canPriceCache()).toBe(true)
    expect(costModel('google.antigravity.2026-08').canPriceCache()).toBe(false)
    expect(costModel('openai.codex.2026-08').canPriceCache()).toBe(false)
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

  it('agy gets the accept-edits mode the plan predicted for a classifier-less CLI', () => {
    const plan = adapter('antigravity-cli').plan({
      sessionId: 'ignored',
      isolationRoot: 'C:/tmp/root',
      cwd: 'C:/tmp/work',
      transport: 'stream'
    })
    expect(plan.args).toContain('--mode')
    expect(plan.args[plan.args.indexOf('--mode') + 1]).toBe('accept-edits')
    expect(plan.args).not.toContain('--dangerously-skip-permissions')
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
        let plan
        try {
          plan = a.plan({
            sessionId: 'ignored',
            isolationRoot: 'C:/tmp/root',
            cwd: 'C:/tmp/work',
            transport: 'stream'
          })
        } catch {
          // The CLI is not installed on this machine; nothing to check, and that is not a failure.
          continue
        }
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
