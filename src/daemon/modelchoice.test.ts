import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveModelChoice } from '@shared/tasks.js'
import type { TaskConstraints } from '@shared/tasks.js'

/**
 * Which model and effort a dispatch actually reaches for.
 *
 * ⭐ Two tiers - task, then worker, then the CLI's own choice - and deliberately not the three that
 * finish policy uses. A model id belongs to one CLI: `opus` means nothing to Antigravity and
 * `gemini-3.1-pro-high` means nothing to Claude Code, so a default held at the project or the fleet
 * would be invalid for every task that routed to a different adapter, which on a mixed fleet is most
 * of them.
 *
 * ⚠️ The resolver lives in `@shared` and is called by both the scheduler and the New Task form, so
 * the form cannot promise an inheritance the scheduler does not perform. These tests are the
 * definition both sides are held to.
 */

/** Only the two fields the resolver reads; a real TaskConstraints carries six more that do not. */
const constraints = (
  over: Partial<Pick<TaskConstraints, 'model' | 'effort'>> = {}
): Pick<TaskConstraints, 'model' | 'effort'> => ({ ...over })

const account = (defaultModel: string | null, defaultEffort: string | null = null) => ({
  defaultModel,
  defaultEffort
})

describe('resolving the model a task runs on', () => {
  it('takes the task pin over everything, because somebody chose it for this task', () => {
    const r = resolveModelChoice(constraints({ model: 'claude-opus-5' }), account('claude-sonnet-5'), true)
    expect(r.model).toBe('claude-opus-5')
    expect(r.modelSource).toBe('task')
  })

  it('falls to the account default when the task says nothing', () => {
    const r = resolveModelChoice(constraints(), account('claude-sonnet-5'), true)
    expect(r.model).toBe('claude-sonnet-5')
    expect(r.modelSource).toBe('worker')
  })

  it('leaves it to the CLI when neither says anything, which is an answer', () => {
    // ⛔ `null` is not "unset, keep looking" — there is no further tier. It is the state every
    //    install ran in before this control existed, and the one clearing the box returns to.
    const r = resolveModelChoice(constraints(), account(null), true)
    expect(r.model).toBeNull()
    expect(r.modelSource).toBe('cli')
  })

  it('says where the answer came from, not just what it is', () => {
    // ⚠️ A setting whose origin is invisible is one nobody trusts and everybody overrides — the same
    //    argument `resolveFinishPolicy` makes for carrying its `source`.
    expect(resolveModelChoice(constraints(), null, true).modelSource).toBe('cli')
    expect(resolveModelChoice(constraints(), account('x'), true).modelSource).toBe('worker')
    expect(resolveModelChoice(constraints({ model: 'y' }), account('x'), true).modelSource).toBe('task')
  })

  it('survives a worker that is not there at all', () => {
    const r = resolveModelChoice(constraints({ model: 'claude-opus-5' }), null, true)
    expect(r.model).toBe('claude-opus-5')
  })
})

describe('resolving effort, where the CLI can be told one', () => {
  it('inherits the account default the same way the model does', () => {
    const r = resolveModelChoice(constraints(), account('claude-opus-5', 'xhigh'), true)
    expect(r.effort).toBe('xhigh')
    expect(r.effortSource).toBe('worker')
  })

  it('lets the task override just the effort, keeping the account model', () => {
    // ⚠️ The two resolve independently, because the CLI takes them as two separate flags. A task
    //    that wants "the usual model, but think harder" must not have to restate the model.
    const r = resolveModelChoice(constraints({ effort: 'max' }), account('claude-opus-5', 'low'), true)
    expect(r.model).toBe('claude-opus-5')
    expect(r.modelSource).toBe('worker')
    expect(r.effort).toBe('max')
    expect(r.effortSource).toBe('task')
  })

  it('drops effort entirely where the adapter cannot be told one', () => {
    // ⛔ Dropped, not defaulted and not passed hopefully. Measured 2026-08-29: agy *refuses*
    //    `--effort` for every model this fleet dispatches, so sending it fails the dispatch outright
    //    rather than being politely ignored.
    const r = resolveModelChoice(
      constraints({ model: 'gemini-3.1-pro-high', effort: 'low' }),
      account(null, 'high'),
      false
    )
    expect(r.effort).toBeNull()
    expect(r.effortSource).toBe('cli')
  })

  it('still resolves the model normally on an adapter with no effort flag', () => {
    // ⛔ The guard. Antigravity has no effort control and must still inherit its account's model —
    //    collapsing the two would leave the whole provider unable to hold a default.
    const r = resolveModelChoice(constraints(), account('gemini-3.1-pro-high', 'ignored'), false)
    expect(r.model).toBe('gemini-3.1-pro-high')
    expect(r.modelSource).toBe('worker')
    expect(r.effort).toBeNull()
  })
})

let dir: string
let db: typeof import('./db.js')
let workers: typeof import('./workers.js')
let api: typeof import('./api.js')

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-modelchoice-'))
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
  db = await import('./db.js')
  workers = await import('./workers.js')
  api = await import('./api.js')
  db.openDb(join(dir, 'modelchoice.db'))
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    // A held handle on Windows is not a test failure.
  }
})

describe('what an account is allowed to default to', () => {
  it('stores a model its own CLI can be priced for', () => {
    const w = workers.createWorker({ adapterId: 'claude-code', label: 'defaults-1' })
    const saved = workers.updateWorker(w.id, { defaultModel: 'claude-opus-5', defaultEffort: 'xhigh' })
    expect(saved.defaultModel).toBe('claude-opus-5')
    expect(saved.defaultEffort).toBe('xhigh')
  })

  it('refuses a model that CLI has never heard of', () => {
    // ⛔ A wrong default is worse than a wrong pin: nobody chose it at dispatch time, so it fails
    //    *every* task routed here with an error about something set days ago and forgotten.
    const w = workers.createWorker({ adapterId: 'claude-code', label: 'defaults-2' })
    expect(() => api.checkWorkerDefaults('claude-code', { defaultModel: 'gemini-3.1-pro-high' })).toThrow(
      /not a model/
    )
    expect(workers.getWorker(w.id)?.defaultModel).toBeNull()
  })

  it('refuses an effort on a CLI that takes no effort flag', () => {
    expect(() => api.checkWorkerDefaults('antigravity-cli', { defaultEffort: 'low' })).toThrow(
      /no effort flag/
    )
  })

  it('refuses an effort level the chosen model does not have', () => {
    // `claude-haiku-4-5` lists no effort levels at all — the API rejects effort on it.
    expect(() =>
      api.checkWorkerDefaults('claude-code', {
        defaultModel: 'claude-haiku-4-5',
        defaultEffort: 'high'
      })
    ).toThrow(/no effort level/)
  })

  it('always allows clearing back to the CLI’s own choice', () => {
    // ⚠️ `null` is never validated, because it is not a value — it is the absence of one.
    const w = workers.createWorker({ adapterId: 'claude-code', label: 'defaults-3' })
    workers.updateWorker(w.id, { defaultModel: 'claude-opus-5' })
    const cleared = workers.updateWorker(w.id, { defaultModel: null, defaultEffort: null })
    expect(cleared.defaultModel).toBeNull()
    expect(cleared.defaultEffort).toBeNull()
  })

  it('leaves a default alone when the patch does not mention it', () => {
    // ⛔ The guard that separates "not mentioned" from "clear it". Every worker mutation writes all
    //    seven columns in one statement, so a rename must not blank the model.
    const w = workers.createWorker({ adapterId: 'claude-code', label: 'defaults-4' })
    workers.updateWorker(w.id, { defaultModel: 'claude-sonnet-5', defaultEffort: 'low' })
    const renamed = workers.updateWorker(w.id, { label: 'renamed' })
    expect(renamed.defaultModel).toBe('claude-sonnet-5')
    expect(renamed.defaultEffort).toBe('low')
  })
})
