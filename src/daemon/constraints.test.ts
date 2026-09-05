import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Worker } from '@shared/protocol.js'

/**
 * What the New Task form is allowed to promise.
 *
 * The form grew three controls — an account to pin the task to, a model, and (where a CLI can be
 * told one) an effort level — and every one of them is a value typed on this side of the wire that
 * something on the far side has to honour. ⛔ The failure mode they share is **quiet**: a bad value
 * does not fail here, it fails minutes later as a CLI argument error on a real account's window, or
 * worse, it does not fail at all and produces a run that silently ignored what somebody asked for.
 *
 * So the checks below are all one shape: *the door said no*, or *the thing that cannot be honoured
 * was never sent*.
 */

let dir: string
let db: typeof import('./db.js')
let workers: typeof import('./workers.js')
let api: typeof import('./api.js')
let adapters: typeof import('./adapters/index.js')
let costmodel: typeof import('./costmodel.js')

let claude: Worker

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-constraints-'))
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
  db = await import('./db.js')
  workers = await import('./workers.js')
  api = await import('./api.js')
  adapters = await import('./adapters/index.js')
  costmodel = await import('./costmodel.js')
  db.openDb(join(dir, 'constraints.db'))
  // ⛔ `enabled: false`. Nothing here dispatches, and a worker that is open for work the instant the
  // row exists is a scheduler tick away from spending on a test.
  claude = workers.createWorker({ adapterId: 'claude-code', label: 'pin-me', enabled: false })
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

describe('pinning a task to an account', () => {
  it('carries the adapter with it rather than trusting a second field', () => {
    // Two fields that can disagree about which CLI will run this are two fields that will
    // eventually disagree, so the adapter is derived from the worker and overwrites what was sent.
    const checked = api.checkConstraints({ workerId: claude.id, adapterId: 'openai-compatible' })
    expect(checked.adapterId).toBe('claude-code')
  })

  it('refuses an account that does not exist', () => {
    // ⛔ The alternative is a task that no candidate loop can ever match, sitting in `ready` looking
    // exactly like a scheduling problem.
    expect(() => api.checkConstraints({ workerId: 'no-such-worker' })).toThrow()
  })

  it('refuses to pin work to an account that does not do work, and names the role', () => {
    // Both roles that cannot take work, checked at the door rather than at dispatch: a pin the
    // scheduler will silently never match is a task that looks stuck for no stated reason.
    for (const role of ['controller', 'none'] as const) {
      const w = workers.createWorker({ adapterId: 'claude-code', label: `no-work-${role}` })
      workers.updateWorker(w.id, { role })
      expect(() => api.checkConstraints({ workerId: w.id })).toThrow(
        new RegExp(`role '${role}'`)
      )
      expect(() => api.checkConstraints({ workerIds: [w.id] })).toThrow(
        new RegExp(`role '${role}'`)
      )
    }
  })
})

describe('choosing a model', () => {
  it('accepts one the account can be priced for', () => {
    const priced = costmodel
      .costModel(adapters.adapter('claude-code').info.policy.costModelId)
      .modelIds()
    expect(priced.length).toBeGreaterThan(0)
    expect(() =>
      api.checkConstraints({ workerId: claude.id, model: priced[0]! })
    ).not.toThrow()
  })

  it('refuses one the cost model has never heard of', () => {
    // A model agentyard cannot price is one it cannot gate, estimate for, or reason about the
    // context window of. `knownModels` in judgment.ts refuses one from the controller for the same
    // reasons; a person filing a task gets the same door.
    expect(() =>
      api.checkConstraints({ workerId: claude.id, model: 'claude-imaginary-9' })
    ).toThrow(/not a model/)
  })

  it('refuses a model with no account to price it against', () => {
    // ⛔ Not defaulted. Picking an adapter here would let a model chosen for one CLI be handed to
    // another, which fails at spawn on somebody's window instead of here for free.
    expect(() => api.checkConstraints({ model: 'claude-opus-5' })).toThrow(/choose a worker/)
  })
})

describe('choosing an effort level', () => {
  it('is refused for every adapter that cannot be told one', () => {
    // ⚠️ Today that is all of them, and this test is written to keep saying something useful when
    // that changes: it asserts the *rule*, not the current answer. An adapter that gains the flag
    // starts being skipped here and starts being exercised by the test below it.
    for (const a of adapters.adapters()) {
      if (a.info.capabilities.selectableEffort) continue
      const worker = workers.createWorker({
        adapterId: a.info.id,
        label: `effort-${a.info.id}`,
        enabled: false
      })
      const model = costmodel.costModel(a.info.policy.costModelId).modelIds()[0]
      if (!model) continue
      expect(() =>
        api.checkConstraints({ workerId: worker.id, model, effort: 'high' })
      ).toThrow(/no effort flag/)
    }
  })

  it('is refused when the model has no such level, wherever a CLI can take one', () => {
    for (const a of adapters.adapters()) {
      if (!a.info.capabilities.selectableEffort) continue
      const worker = workers.createWorker({
        adapterId: a.info.id,
        label: `levels-${a.info.id}`,
        enabled: false
      })
      const cm = costmodel.costModel(a.info.policy.costModelId)
      const model = cm.modelIds().find((id) => (cm.modelSpec(id)?.effort_levels.length ?? 0) > 0)
      if (!model) continue
      expect(() =>
        api.checkConstraints({ workerId: worker.id, model, effort: 'telepathy' })
      ).toThrow(/no effort level/)
      const real = cm.modelSpec(model)!.effort_levels[0]!
      expect(() =>
        api.checkConstraints({ workerId: worker.id, model, effort: real })
      ).not.toThrow()
    }
  })

  it('means nothing without a model *anywhere*, and says so', () => {
    // `claude` holds no default of its own, so nothing on either side names the model the level
    // would be sent with and the CLI would pick one at dispatch.
    expect(() => api.checkConstraints({ workerId: claude.id, effort: 'high' })).toThrow(
      /without a model/
    )
  })

  it('is checked against the account default when the task leaves the model on inherit', () => {
    // ⭐ The bug this pair exists for. The New Task form's model control offers *inherit
    // (claude-opus-5)* and lists that model's effort levels underneath it, then filed a task with an
    // effort and no model — and the door refused it for naming no model. It names one: the account's.
    const w = workers.createWorker({
      adapterId: 'claude-code',
      label: 'inherit-effort',
      enabled: false
    })
    workers.updateWorker(w.id, { defaultModel: 'claude-opus-5' })
    expect(() => api.checkConstraints({ workerId: w.id, effort: 'high' })).not.toThrow()
    expect(() => api.checkConstraints({ workerId: w.id, effort: 'telepathy' })).toThrow(
      /no effort level/
    )
  })

  it('holds an inherited level to every pool default, not just the one winning today', () => {
    // ⛔ A multi-pool account picks between its defaults at dispatch on live quota. A level legal for
    // one pool and not the other would file cleanly and then fail whenever the other pool won.
    const w = workers.createWorker({
      adapterId: 'claude-code',
      label: 'inherit-effort-pools',
      enabled: false
    })
    // `claude-haiku-4-5` lists no effort levels at all — see `checkWorkerDefaults`'s own test.
    workers.updateWorker(w.id, {
      defaultModels: { a: 'claude-opus-5', b: 'claude-haiku-4-5' }
    })
    expect(() => api.checkConstraints({ workerId: w.id, effort: 'high' })).toThrow(
      /'claude-haiku-4-5' has no effort level/
    )
  })
})

describe('the effort capability itself', () => {
  it('is declared by every adapter, so nothing falls through as undefined', () => {
    // ⛔ `undefined` is falsy, which means a missing declaration would read as "cannot set effort"
    // and be *right by accident*. The scheduler's gate would work and nobody would notice the
    // adapter had never answered the question — until one of them meant to say yes.
    for (const a of adapters.adapters()) {
      expect(typeof a.info.capabilities.selectableEffort, a.info.id).toBe('boolean')
    }
  })

  it('says what was measured against each real CLI, and nothing more', () => {
    // ⚠️ A record of what has been *run*, not a rule — the 2026-08-27 version of this list said all
    // three were false and told the next reader to change a line "the day one is exercised against a
    // real CLI, and not before". That day was 2026-08-29 for exactly one of them.
    //
    // ⭐ `claude-code` **true**: claude 2.1.250 takes `--effort low|medium|high|xhigh|max`, and a
    //    headless run with `--effort low` came back with `effort: "low"` on its transcript's
    //    assistant record — set *and* observable, which is what promoting a capability requires.
    // ⛔ `antigravity-cli` **false, and now for a measured reason rather than an argued one**. agy
    //    1.1.22 has the flag and refuses every combination this fleet would send:
    //    `gemini-3.1-pro-high` "conflicts with --effort=low", `claude-sonnet-4-6` "not supported for
    //    model", `gpt-oss-120b-medium` conflicts. Only a bare family — `gemini-3.1-pro` — accepts
    //    it, and `agy models` does not list the bare families. Two spellings, one choice.
    // ⚠️ `openai-compatible` **false, still unrun**. `model_reasoning_effort` is a documented config
    //    key and this adapter's verification says `measured`, so documentation alone is not enough.
    const expected: Record<string, boolean> = {
      'claude-code': true,
      'antigravity-cli': false,
      'openai-compatible': false
    }
    for (const [id, can] of Object.entries(expected)) {
      expect(adapters.adapter(id).info.capabilities.selectableEffort, id).toBe(can)
    }
  })
})

describe('what the form is offered', () => {
  it('offers only models the cost model that will price them can name', () => {
    // ⛔ The renderer holds no cost models and must not grow a second table of model facts. This is
    // the check that the served list and the pricing list are the same list.
    for (const a of adapters.adapters()) {
      const cm = costmodel.costModel(a.info.policy.costModelId)
      for (const id of cm.modelIds()) expect(cm.modelSpec(id), `${a.info.id}/${id}`).not.toBeNull()
    }
  })

  it('never offers an effort level the adapter could not pass on', () => {
    // The form's own rule, asserted against the data rather than against the JSX: where the CLI
    // cannot take a level, no level is offerable however many the model declares.
    for (const a of adapters.adapters()) {
      if (a.info.capabilities.selectableEffort) continue
      const cm = costmodel.costModel(a.info.policy.costModelId)
      const offerable = cm
        .modelIds()
        .filter(() => a.info.capabilities.selectableEffort)
        .flatMap((id) => cm.modelSpec(id)?.effort_levels ?? [])
      expect(offerable, a.info.id).toEqual([])
    }
  })
})

describe('task.setWorker RPC', () => {
  it('pins, switches, and unpins worker constraints cleanly', async () => {
    const tasks = await import('./tasks.js')
    const codex = workers.createWorker({
      adapterId: 'openai-compatible',
      label: 'codex-worker',
      enabled: false
    })
    const handlers = api.buildApi({
      version: '1.0.0',
      startedAt: Date.now(),
      port: 8080
    })

    const task = tasks.createTask({ title: 'switch worker test' })
    expect(task.constraints.workerId).toBeUndefined()

    // 1. Pin to claude
    const pinnedClaude = await handlers['task.setWorker']({ id: task.id, workerId: claude.id })
    expect(pinnedClaude.constraints.workerId).toBe(claude.id)
    expect(pinnedClaude.constraints.adapterId).toBe('claude-code')

    // 2. Set a model on claude
    await handlers['task.setModel']({ id: task.id, model: 'claude-sonnet-5', effort: null })
    expect(tasks.requireTask(task.id).constraints.model).toBe('claude-sonnet-5')

    // 3. Switch to Codex -> incompatible model is automatically cleared
    const switchedCodex = await handlers['task.setWorker']({ id: task.id, workerId: codex.id })
    expect(switchedCodex.constraints.workerId).toBe(codex.id)
    expect(switchedCodex.constraints.adapterId).toBe('openai-compatible')
    expect(switchedCodex.constraints.model).toBeUndefined()

    // 4. Unpin worker back to any eligible worker (scheduler decides)
    const unpinned = await handlers['task.setWorker']({ id: task.id, workerId: null })
    expect(unpinned.constraints.workerId).toBeUndefined()
    expect(unpinned.constraints.adapterId).toBeUndefined()
    expect(unpinned.constraints.model).toBeUndefined()
  })
})

